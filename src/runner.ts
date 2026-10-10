import { validateMonitors } from './config.ts';
import { notifyDiscord, webhookFor } from './discord.ts';
import { fetchQiita } from './sources/qiita.ts';
import { fetchWikipedia } from './sources/wikipedia.ts';
import { fetchArxiv } from './sources/arxiv.ts';
import { fetchZenn } from './sources/zenn.ts';
import { fetchYouTube } from './sources/youtube.ts';
import { d1ChannelCache } from './sources/youtube-cache.ts';
import {
  claim, completeFetch, ensureMonitor, getPending, getRunnableIds,
  getState, markSent, postponeFetch, release, retryLater, stage,
} from './state.ts';
import type { Env, Monitor, ContentItem } from './types.ts';

const MAX_NOTIFICATIONS_PER_TICK = 3;
export interface Dependencies {
  fetchItems(monitor: Monitor, env: Env): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }>;
  send(webhook: string, source: string, item: ContentItem): Promise<void>;
  randomId(): string;
}
const defaults: Dependencies = {
  fetchItems: (monitor, env) => {
    switch (monitor.source) {
      case 'qiita': return fetchQiita(monitor);
      case 'wikipedia': return fetchWikipedia(monitor);
      case 'arxiv': return fetchArxiv(monitor);
      case 'zenn': return fetchZenn(monitor);
      case 'youtube': return fetchYouTube(monitor, fetch, d1ChannelCache(env.DB));
    }
  },
  send: notifyDiscord,
  randomId: () => crypto.randomUUID(),
};

export async function runTick(
  env: Env, monitors: readonly Monitor[], now = Date.now(), deps: Dependencies = defaults,
): Promise<'idle' | 'processed' | 'busy'> {
  validateMonitors(monitors);
  const enabled = new Map(monitors.filter((monitor) => monitor.enabled).map((monitor) => [monitor.id, monitor]));
  if (!enabled.size) return 'idle';
  for (const id of enabled.keys()) await ensureMonitor(env.DB, id);
  const runnable = (await getRunnableIds(env.DB, now)).map((id) => enabled.get(id)).find(Boolean);
  if (!runnable) return 'idle';
  const token = deps.randomId();
  if (!await claim(env.DB, runnable.id, token, now)) return 'busy';
  try {
    const state = await getState(env.DB, runnable.id);
    if (state.next_due_at <= now) {
      webhookFor(runnable, env);
      try {
        const result = await deps.fetchItems(runnable, env);
        if (result.potentiallyTruncated) {
          console.warn('monitor ' + runnable.id + ': source page full; complete coverage not guaranteed');
        }
        await stage(env.DB, runnable.id, result.items, state.initialized_at, now);
        await completeFetch(env.DB, runnable.id, token, now, runnable.intervalMinutes);
      } catch (error) {
        await postponeFetch(env.DB, runnable.id, token, now);
        throw error;
      }
    }
    const webhook = webhookFor(runnable, env);
    const pending = await getPending(env.DB, runnable.id, now, MAX_NOTIFICATIONS_PER_TICK);
    for (const item of pending) {
      try {
        await deps.send(webhook, runnable.source, {
          id: item.item_id, title: item.title, url: item.url, publishedAt: item.published_at,
        });
        await markSent(env.DB, runnable.id, item.item_id, now);
      } catch {
        await retryLater(env.DB, runnable.id, item.item_id, item.attempts, now);
        console.error('Discord delivery failed for ' + runnable.id + '/' + item.item_id + '; retry scheduled');
      }
    }
    return 'processed';
  } finally {
    await release(env.DB, runnable.id, token);
  }
}

import { validateMonitors } from './config.ts';
import { notifyDiscord, webhookFor } from './discord.ts';
import { fetchQiita } from './sources/qiita.ts';
import { fetchWikipedia } from './sources/wikipedia.ts';
import { fetchArxiv } from './sources/arxiv.ts';
import { fetchZenn } from './sources/zenn.ts';
import { fetchYouTube } from './sources/youtube.ts';
import { d1ChannelCache } from './sources/youtube-cache.ts';
import {
  claim, completeFetch, getPending, getRunnableIds,
  getState, markSent, postponeFetch, release, retryLater, stage, saveScanCursor,
} from './state.ts';
import type { Env, Monitor, ContentItem } from './types.ts';

const MAX_NOTIFICATIONS_PER_TICK = 3;
const LOOKBACK_MS = 48 * 60 * 60_000;
export interface Dependencies {
  fetchItems(monitor: Monitor, env: Env, cursor?: string | null): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean; nextCursor?: string | null }>;
  send(webhook: string, source: string, item: ContentItem): Promise<void>;
  randomId(): string;
}
const defaults: Dependencies = {
  fetchItems: (monitor, env, cursor) => {
    switch (monitor.source) {
      case 'qiita': return fetchQiita(monitor, fetch, cursor);
      case 'wikipedia': return fetchWikipedia(monitor, fetch, cursor);
      case 'arxiv': return fetchArxiv(monitor, fetch, cursor);
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
  const runnable = (await getRunnableIds(env.DB, now, [...enabled.keys()]))
    .map((id) => enabled.get(id)).find(Boolean);
  if (!runnable) return 'idle';
  const token = deps.randomId();
  if (!await claim(env.DB, runnable.id, token, now)) return 'busy';
  try {
    const state = await getState(env.DB, runnable.id);
    let fetchError: unknown;
    if (state.next_due_at <= now) {
      webhookFor(runnable, env);
      try {
        const result = await deps.fetchItems(runnable, env, state.scan_cursor);
        if (result.potentiallyTruncated) {
          console.warn('monitor ' + runnable.id + ': source exhausted its paging limit; coverage incomplete');
        }
        await stage(env.DB, runnable.id, result.items, state.initialized_at, now);
        // Never stop Qiita query searches merely because an ID or timestamp is familiar:
        // relevance ordering is not guaranteed to be creation ordering.
        const chronologicallyOrdered = runnable.source === 'arxiv' || runnable.source === 'wikipedia';
        const reachedOverlap = chronologicallyOrdered && state.last_complete_at !== null &&
          result.items.some((item) => item.publishedAt <= state.last_complete_at! - LOOKBACK_MS);
        if (state.initialized_at !== null && result.nextCursor && !reachedOverlap) {
          await saveScanCursor(env.DB, runnable.id, token, now, state.scan_started_at ?? now, result.nextCursor);
        } else {
          await completeFetch(env.DB, runnable.id, token, now, runnable.intervalMinutes, state.scan_started_at ?? now);
        }
      } catch (error) {
        await postponeFetch(env.DB, runnable.id, token, now);
        // A source outage must not block already queued Discord notifications.
        fetchError = error;
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
    if (fetchError !== undefined) throw fetchError;
    return 'processed';
  } finally {
    await release(env.DB, runnable.id, token);
  }
}

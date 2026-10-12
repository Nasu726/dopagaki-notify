import { isJstNotificationTime } from './schedule.ts';
import { HttpStatusError, isRateLimited, isWebhookInvalid, suggestedRetryDelay } from './http.ts';
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
  getState, markSent, coolDownPending, blockWebhook, postponeFetch, release, retryLater, stage, saveScanCursor, assertMonitorIdentity,
} from './state.ts';
import type { Env, Monitor, ContentItem } from './types.ts';

const MAX_NOTIFICATIONS_PER_TICK = 3;
const LOOKBACK_MS = 48 * 60 * 60_000;
// Reserved scan checkpoint; never passed to a provider API.
const VERIFY_HEAD_CURSOR = '__verify_head__';
export interface Dependencies {
  fetchItems(monitor: Monitor, env: Env, cursor?: string | null, windowStart?: number | null): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean; nextCursor?: string | null }>;
  send(webhook: string, source: string, item: ContentItem): Promise<void>;
  randomId(): string;
  clock?(): number; // production: check actual time again before each Discord send
}
const defaults: Dependencies = {
  fetchItems: (monitor, env, cursor, windowStart) => {
    switch (monitor.source) {
      case 'qiita': return fetchQiita(monitor, fetch, cursor, windowStart);
      case 'wikipedia': return fetchWikipedia(monitor, fetch, cursor);
      case 'arxiv': return fetchArxiv(monitor, fetch, cursor);
      case 'zenn': return fetchZenn(monitor);
      case 'youtube': return fetchYouTube(monitor, fetch, d1ChannelCache(env.DB));
    }
  },
  send: notifyDiscord,
  randomId: () => crypto.randomUUID(),
  clock: () => Date.now(),
};

export async function runTick(
  env: Env, monitors: readonly Monitor[], now = Date.now(), deps: Dependencies = defaults,
): Promise<'idle' | 'processed' | 'busy'> {
  validateMonitors(monitors);
  const enabled = new Map(monitors.filter((monitor) => monitor.enabled).map((monitor) => [monitor.id, monitor]));
  if (!enabled.size) return 'idle';
  const runnable = (await getRunnableIds(env.DB, now, [...enabled.values()]))
    .map((id) => enabled.get(id)).find(Boolean);
  if (!runnable) return 'idle';
  const token = deps.randomId();
  if (!await claim(env.DB, runnable.id, runnable.source, token, now)) return 'busy';
  try {
    const state = await getState(env.DB, runnable.id, runnable.source);
    await assertMonitorIdentity(env.DB, runnable.id, token, runnable.source,
      runnable.query, state.config_identity, state.initialized_at);
    let fetchError: unknown;
    if (state.next_due_at <= now) {
      webhookFor(runnable, env);
      try {
        const windowStart = state.last_complete_at === null ? null : state.last_complete_at - LOOKBACK_MS;
        const verifyingHead = state.scan_cursor === VERIFY_HEAD_CURSOR;
        const sourceCursor = verifyingHead ? null : state.scan_cursor;
        const result = await deps.fetchItems(runnable, env, sourceCursor, windowStart);
        if (result.potentiallyTruncated) {
          console.warn('monitor ' + runnable.id + ': source exhausted its paging limit; coverage incomplete');
        }
        await stage(env.DB, runnable.id, result.items, state.initialized_at, now);
        // Qiita uses a documented created:>= query filter, but search may be relevance
        // ordered. Do not stop at a known ID; continue paging the filtered window.
        const chronologicallyOrdered = runnable.source === 'arxiv' || runnable.source === 'wikipedia';
        const reachedOverlap = chronologicallyOrdered && state.last_complete_at !== null &&
          result.items.some((item) => item.publishedAt <= state.last_complete_at! - LOOKBACK_MS);
        if (state.initialized_at !== null && result.nextCursor && !reachedOverlap && !verifyingHead) {
          await saveScanCursor(env.DB, runnable.id, token, now, state.scan_started_at ?? now, result.nextCursor);
        } else if (state.initialized_at !== null && state.scan_cursor !== null &&
            !verifyingHead && !result.potentiallyTruncated) {
          // Offset/search pages may shift as new items arrive during a multi-Cron scan.
          // Check the newest page once more before saving the full-scan watermark.
          await saveScanCursor(env.DB, runnable.id, token, now,
            state.scan_started_at ?? now, VERIFY_HEAD_CURSOR);
        } else {
          await completeFetch(env.DB, runnable.id, token, now, runnable.intervalMinutes,
            state.scan_started_at ?? now, !result.potentiallyTruncated);
        }
      } catch (error) {
        // A MediaWiki 403 may indicate upstream bot-policy rejection. Avoid
        // retrying a denied client every five minutes while the operator
        // investigates; a source outage must still preserve queued deliveries.
        const serverDelay = suggestedRetryDelay(error);
        const delay = error instanceof HttpStatusError && error.source === 'MediaWiki' &&
          error.status === 403 ? Math.max(60 * 60_000, serverDelay ?? 0) : serverDelay;
        await postponeFetch(env.DB, runnable.id, token, now, delay);
        // A source outage must not block already queued Discord notifications.
        fetchError = error;
      }
    }
    const webhook = webhookFor(runnable, env);
    // Continue polling sources at night, but leave outgoing notifications
    // queued until the next 09:00-20:00 JST delivery window.
    const deliveryNow = deps.clock?.() ?? now;
    const pending = !isJstNotificationTime(deliveryNow) || state.webhook_cooldown_until > now ||
      state.webhook_blocked_status !== null
      ? [] : await getPending(env.DB, runnable.id, now, MAX_NOTIFICATIONS_PER_TICK);
    for (const item of pending) {
      // A slow upstream fetch may have crossed 20:00 JST since the tick began.
      // Check again immediately before posting, not only at tick selection.
      if (!isJstNotificationTime(deps.clock?.() ?? now)) break;
      try {
        await deps.send(webhook, runnable.source, {
          id: item.item_id, title: item.title, url: item.url, publishedAt: item.published_at,
        });
        await markSent(env.DB, runnable.id, item.item_id, now);
      } catch (error) {
        if (isWebhookInvalid(error)) {
          await blockWebhook(env.DB, runnable.source, error.status, now);
          console.error('Discord webhook disabled for monitor ' + runnable.id +
            ' after HTTP ' + error.status + '; replace secret and explicitly reset source-level D1 block');
          break;
        }
        await retryLater(env.DB, runnable.id, item.item_id, item.attempts, now, suggestedRetryDelay(error));
        console.error('Discord delivery failed for ' + runnable.id + '/' + item.item_id + '; retry scheduled');
        // All items for this monitor share a webhook; a 429 must stop the burst.
        if (isRateLimited(error)) {
          await coolDownPending(env.DB, runnable.source, now, suggestedRetryDelay(error));
          break;
        }
      }
    }
    if (fetchError !== undefined) throw fetchError;
    return 'processed';
  } finally {
    await release(env.DB, runnable.id, token);
  }
}

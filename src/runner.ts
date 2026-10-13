import { isJstNotificationTime, isJstWeekday, nextHourlyJstWeekdayDue } from './schedule.ts';
import { HttpStatusError, isRateLimited, isWebhookInvalid, suggestedRetryDelay } from './http.ts';
import { validateMonitors } from './config.ts';
import { logFailure } from './observability.ts';
import { hasWebhookSecret, notifyDiscord, webhookFor } from './discord.ts';
import { fetchQiita } from './sources/qiita.ts';
import { fetchWikipedia, fetchWikipediaDiscovery } from './sources/wikipedia.ts';
import { fetchArxiv } from './sources/arxiv.ts';
import { fetchZenn } from './sources/zenn.ts';
import { fetchYouTube } from './sources/youtube.ts';
import { d1ChannelCache } from './sources/youtube-cache.ts';
import {
  claim, completeFetch, deferFetchUntil, getPending, getRunnableIds,
  getState, markSent, coolDownPending, blockWebhook, postponeFetch, release, retryLater, stage, saveScanCursor, assertMonitorIdentity,
  pruneStaleWikipediaPending, selectWikipediaDiscovery,
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
      case 'wikipedia': return monitor.query.endsWith(':discover') ?
        fetchWikipediaDiscovery(monitor, fetch) : fetchWikipedia(monitor, fetch, cursor);
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
  // An enabled monitor without its Cloudflare Discord Secret remains dormant:
  // no D1 initialization or recurrent failing lease attempts.
  const enabled = new Map(monitors.filter((monitor) => monitor.enabled && hasWebhookSecret(monitor, env))
    .map((monitor) => [monitor.id, monitor]));
  if (!enabled.size) return 'idle';
  const runnable = (await getRunnableIds(env.DB, now, [...enabled.values()]))
    .map((id) => enabled.get(id)).find(Boolean);
  if (!runnable) return 'idle';
  const token = deps.randomId();
  let claimed = false;
  let phase = 'claim';
  let retryAt: number | null = null;
  try {
    claimed = await claim(env.DB, runnable.id, runnable.source, token, now);
    if (!claimed) return 'busy';
    phase = 'load_state';
    const state = await getState(env.DB, runnable.id, runnable.source);
    phase = 'check_identity';
    await assertMonitorIdentity(env.DB, runnable.id, token, runnable.source,
      runnable.query, state.config_identity, state.initialized_at);
    let fetchError: unknown;
    let fetchErrorPhase: string | null = null;
    let wikipediaFetchSucceeded = false;
    const wikipedia = runnable.source === 'wikipedia';
    const discovery = wikipedia && runnable.query.endsWith(':discover');
    const wikipediaCutoff = now - runnable.intervalMinutes * 60_000;
    const due = state.next_due_at <= now;
    const onSelectedDay = runnable.weeklyJstDay === undefined ||
      isJstWeekday(now, runnable.weeklyJstDay);
    if (due && !onSelectedDay && runnable.weeklyJstDay !== undefined) {
      // A newly enabled monitor (or a retry interrupted across midnight)
      // must not fetch outside its specified JST weekday.
      phase = 'defer_weekday_fetch';
      await deferFetchUntil(env.DB, runnable.id, token,
        nextHourlyJstWeekdayDue(now, runnable.weeklyJstDay));
    }
    if (due && onSelectedDay) {
      webhookFor(runnable, env);
      try {
        const windowStart = state.last_complete_at === null ? null : state.last_complete_at - LOOKBACK_MS;
        const verifyingHead = !wikipedia && state.scan_cursor === VERIFY_HEAD_CURSOR;
        const sourceCursor = wikipedia || verifyingHead ? null : state.scan_cursor;
        phase = 'fetch_and_parse';
        const result = await deps.fetchItems(runnable, env, sourceCursor, windowStart);
        phase = 'stage_items';
        if (result.potentiallyTruncated) {
          console.warn('monitor ' + runnable.id + ': source exhausted its paging limit; coverage incomplete');
        }
        if (wikipedia) {
          await pruneStaleWikipediaPending(env.DB, runnable.id, wikipediaCutoff);
          const newest = discovery
            ? state.initialized_at === null ? [] :
              await selectWikipediaDiscovery(env.DB, runnable.id, result.items, now)
            : result.items
              .filter((item) => item.publishedAt > wikipediaCutoff && item.publishedAt <= now)
              .sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id))
              .slice(0, MAX_NOTIFICATIONS_PER_TICK);
          await stage(env.DB, runnable.id, newest, state.initialized_at, now);
        } else {
          await stage(env.DB, runnable.id, result.items, state.initialized_at, now);
        }
        // Qiita uses a documented created:>= query filter, but search may be relevance
        // ordered. Do not stop at a known ID; continue paging the filtered window.
        const chronologicallyOrdered = runnable.source === 'arxiv' || runnable.source === 'wikipedia';
        const reachedOverlap = chronologicallyOrdered && state.last_complete_at !== null &&
          result.items.some((item) => item.publishedAt <= state.last_complete_at! - LOOKBACK_MS);
        phase = 'save_checkpoint';
        if (!wikipedia && state.initialized_at !== null && result.nextCursor && !reachedOverlap && !verifyingHead) {
          await saveScanCursor(env.DB, runnable.id, token, now, state.scan_started_at ?? now, result.nextCursor);
        } else if (!wikipedia && state.initialized_at !== null && state.scan_cursor !== null &&
            !verifyingHead && !result.potentiallyTruncated) {
          // Offset/search pages may shift as new items arrive during a multi-Cron scan.
          // Check the newest page once more before saving the full-scan watermark.
          await saveScanCursor(env.DB, runnable.id, token, now,
            state.scan_started_at ?? now, VERIFY_HEAD_CURSOR);
        } else {
          const nextDueAt = runnable.weeklyJstDay === undefined ? undefined :
            nextHourlyJstWeekdayDue(now, runnable.weeklyJstDay);
          await completeFetch(env.DB, runnable.id, token, now, runnable.intervalMinutes,
            state.scan_started_at ?? now, !result.potentiallyTruncated, nextDueAt);
          if (wikipedia) wikipediaFetchSucceeded = true;
          if (state.initialized_at === null && !result.potentiallyTruncated)
            console.log('monitor ' + runnable.id + ': silent baseline initialized');
        }
      } catch (error) {
        // MediaWiki 403 and YouTube RSS 404 can persist for hours upstream.
        // Retrying every five minutes creates noise without improving coverage:
        // these monitors retain their queue and retry after at least one hour.
        // Other HTTP 404s (e.g. channel page or Discord) are not reclassified.
        const serverDelay = suggestedRetryDelay(error);
        const hourlyUpstreamBackoff = error instanceof HttpStatusError && (
          (error.source === 'MediaWiki' && error.status === 403) ||
          (error.source === 'YouTube RSS' && error.status === 404)
        );
        const delay = hourlyUpstreamBackoff ? Math.max(60 * 60_000, serverDelay ?? 0) : serverDelay;
        fetchErrorPhase = phase;
        phase = 'schedule_fetch_retry';
        retryAt = await postponeFetch(env.DB, runnable.id, token, now, delay);
        // A source outage must not block already queued Discord notifications.
        fetchError = error;
      }
    }
    phase = 'prepare_delivery';
    const webhook = webhookFor(runnable, env);
    // Continue polling sources at night, but leave outgoing notifications
    // queued until the next 09:00-20:00 JST delivery window.
    const deliveryNow = deps.clock?.() ?? now;
    const pending = !isJstNotificationTime(deliveryNow) || state.webhook_cooldown_until > now ||
      state.webhook_blocked_status !== null || (wikipedia && !wikipediaFetchSucceeded)
      ? [] : await getPending(env.DB, runnable.id, now, discovery ? 2 : MAX_NOTIFICATIONS_PER_TICK,
        wikipedia ? wikipediaCutoff : undefined);
    for (const item of pending) {
      // A slow upstream fetch may have crossed 20:00 JST since the tick began.
      if (!isJstNotificationTime(deps.clock?.() ?? now)) break;
      phase = 'discord_send';
      try {
        await deps.send(webhook, runnable.source, {
          id: item.item_id, title: item.title, url: item.url, publishedAt: item.published_at,
        });
      } catch (error) {
        if (isWebhookInvalid(error)) {
          phase = 'block_invalid_webhook';
          await blockWebhook(env.DB, runnable.source, error.status, now);
          logFailure({ event: 'monitor_failure', source: runnable.source, monitorId: runnable.id,
            phase: 'discord_send', itemId: item.item_id }, error);
          break;
        }
        phase = 'schedule_delivery_retry';
        const nextAttempt = await retryLater(env.DB, runnable.id, item.item_id,
          item.attempts, now, suggestedRetryDelay(error));
        logFailure({ event: 'monitor_failure', source: runnable.source, monitorId: runnable.id,
          phase: 'discord_send', itemId: item.item_id, retryAt: nextAttempt }, error);
        // All items for this monitor share a webhook; a 429 must stop the burst.
        if (isRateLimited(error)) {
          phase = 'cooldown_webhook';
          await coolDownPending(env.DB, runnable.source, now, suggestedRetryDelay(error));
          break;
        }
        continue;
      }
      // Sending succeeded; a D1 acknowledgement failure must not be logged as
      // a Discord failure. The pending receipt is retained for recovery.
      phase = 'ack_delivery';
      await markSent(env.DB, runnable.id, item.item_id, now);
    }
    if (fetchError !== undefined) {
      phase = fetchErrorPhase ?? 'fetch_and_parse';
      throw fetchError;
    }
    return 'processed';
  } catch (error) {
    logFailure({ event: 'monitor_failure', source: runnable.source, monitorId: runnable.id,
      phase, retryAt }, error);
    throw error;
  } finally {
    if (claimed) {
      try { await release(env.DB, runnable.id, token); }
      catch (error) {
        logFailure({ event: 'monitor_failure', source: runnable.source, monitorId: runnable.id,
          phase: 'release_lease' }, error);
        throw error;
      }
    }
  }
}

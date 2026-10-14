import { isJstNotificationTime, isJstWeekday, nextAllowedJstWeekdayDue } from './schedule.ts';
import { HttpStatusError, isRateLimited, isWebhookInvalid, suggestedRetryDelay } from './http.ts';
import { validateMonitors, resolveNotificationWindowJst } from './config.ts';
import { logFailure } from './observability.ts';
import { hasWebhookSecret, notifyDiscordWithArticleThumbnails, webhookFor } from './discord.ts';
import { fetchQiita } from './sources/qiita.ts';
import { fetchWikipedia, fetchWikipediaDiscovery } from './sources/wikipedia.ts';
import { fetchArxiv } from './sources/arxiv.ts';
import { fetchOpenAlex, OPENALEX_LOOKBACK_MS } from './sources/openalex.ts';
import { fetchZenn } from './sources/zenn.ts';
import { fetchYouTube } from './sources/youtube.ts';
import { fetchYouTubeDataApi } from './sources/youtube-api.ts';
import { d1ChannelCache } from './sources/youtube-cache.ts';
import {
  claim, completeFetch, deferFetchUntil, getPending, getRunnableIds,
  getState, markSent, coolDownPending, blockWebhook, postponeFetch, release, retryLater, stage, saveScanCursor, assertMonitorIdentity,
  pruneStaleWikipediaPending, selectWikipediaDiscovery, pruneUnselectedArticlePending,
  stageInitialIgnored,
} from './state.ts';
import type { Env, Monitor, ContentItem } from './types.ts';

const MAX_NOTIFICATIONS_PER_TICK = 3;
// Only these freshest candidates are eligible; already-sent ones do NOT
// open replacement slots for older posts.
export const LATEST_ARTICLES_PER_POLL = 3;
function latestArticles(items: readonly ContentItem[]): ContentItem[] {
  const seen = new Set<string>();
  const selected: ContentItem[] = [];
  const sorted = [...items].sort((a, b) =>
    b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  for (const item of sorted) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    selected.push(item);
    if (selected.length === LATEST_ARTICLES_PER_POLL) break;
  }
  return selected;
}
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
        fetchWikipediaDiscovery(monitor, fetch, env.WIKIMEDIA_CONTACT_URL) :
        fetchWikipedia(monitor, fetch, cursor, env.WIKIMEDIA_CONTACT_URL);
      case 'arxiv': return fetchArxiv(monitor, fetch, cursor);
      case 'openalex': return fetchOpenAlex(monitor, env.OPENALEX_API_KEY);
      case 'zenn': return fetchZenn(monitor);
      case 'youtube': return monitor.youtubeVideoType === 'videos'
        ? fetchYouTube(monitor, fetch, d1ChannelCache(env.DB))
        : env.YOUTUBE_API_KEY
          ? fetchYouTubeDataApi(monitor, env.YOUTUBE_API_KEY)
          : fetchYouTube(monitor, fetch, d1ChannelCache(env.DB));
    }
  },
  send: notifyDiscordWithArticleThumbnails,
  randomId: () => crypto.randomUUID(),
  clock: () => Date.now(),
};

export async function runTick(
  env: Env, monitors: readonly Monitor[], now = Date.now(), deps: Dependencies = defaults,
): Promise<'idle' | 'processed' | 'busy'> {
  validateMonitors(monitors);
  const deliveryWindow = resolveNotificationWindowJst(
    env.MONITOR_CONFIG_JSON, env.NOTIFICATION_WINDOW_JST,
  );
  // An enabled monitor without its Cloudflare Discord Secret remains dormant:
  // no D1 initialization or recurrent failing lease attempts.
  const enabled = new Map(monitors.filter((monitor) => monitor.enabled && hasWebhookSecret(monitor, env))
    .map((monitor) => [monitor.id, monitor]));
  if (!enabled.size) return 'idle';
  const runnable = (await getRunnableIds(env.DB, now, [...enabled.values()], deliveryWindow))
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
    // Images from this exact RSS poll can be used immediately without D1
    // schema changes or a second article-page request.
    const fetchedImages = new Map<string, string>();
    const fetchedThumbnails = new Map<string, string>();
    const wikipedia = runnable.source === 'wikipedia';
    const latestOnly = runnable.source === 'qiita' || runnable.source === 'zenn';
    // arXiv alone continues multi-page scans. Other feeds are snapshots.
    const paginated = runnable.source === 'arxiv';
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
        nextAllowedJstWeekdayDue(now, runnable.weeklyJstDay, 0));
    }
    if (due && onSelectedDay) {
      webhookFor(runnable, env);
      try {
        const windowStart = paginated && state.last_complete_at !== null
          ? state.last_complete_at - LOOKBACK_MS : null;
        const verifyingHead = paginated && state.scan_cursor === VERIFY_HEAD_CURSOR;
        // An old Qiita checkpoint is intentionally superseded by a fresh page-1
        // snapshot; completion clears it from D1.
        const sourceCursor = paginated && !verifyingHead ? state.scan_cursor : null;
        phase = 'fetch_and_parse';
        const result = await deps.fetchItems(runnable, env, sourceCursor, windowStart);
        if (runnable.source === 'zenn' || runnable.source === 'qiita') {
          for (const article of result.items) {
            if (article.imageUrl) fetchedImages.set(article.id, article.imageUrl);
            if (article.thumbnailUrl) fetchedThumbnails.set(article.id, article.thumbnailUrl);
          }
        }
        phase = 'stage_items';
        if (paginated && result.potentiallyTruncated) {
          console.warn('monitor ' + runnable.id + ': paginated scan hit its limit; coverage incomplete');
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
          await stage(env.DB, runnable.id, newest, state.initialized_at, now,
            { retentionDays: runnable.retentionDays });
        } else if (runnable.source === 'openalex') {
          // OpenAlex's publication_date lacks hour-level precision.
          // Persist initial IDs as 'ignored' to avoid a first-run flood, then
          // dedup by ID within a seven-day publication window. Later same-day
          // additions must not be discarded by the exact initial fetch hour.
          if (state.initialized_at === null)
            await stageInitialIgnored(env.DB, runnable.id, result.items, now);
          else
            await stage(env.DB, runnable.id, result.items,
              now - OPENALEX_LOOKBACK_MS, now, { retentionDays: runnable.retentionDays });
        } else if (latestOnly) {
          const selected = latestArticles(result.items);
          // Only successful polls may discard a prior alert backlog.
          // No refill from outside the top three if one is already sent.
          await pruneUnselectedArticlePending(env.DB, runnable.id, selected.map((item) => item.id));
          await stage(env.DB, runnable.id, selected, state.initialized_at, now,
            { imageSource: runnable.source as 'qiita' | 'zenn',
              retentionDays: runnable.retentionDays });
        } else if (runnable.source === 'youtube') {
          // Always notify the latest video if unseen, even when it predates
          // the baseline or our ten-day horizon. Keep sent YouTube receipts
          // indefinitely so this never repeats across future polls.
          // Other videos are eligible only when genuinely new.
          const sorted = [...result.items].sort((a, b) =>
            b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
          await stage(env.DB, runnable.id, sorted, state.initialized_at, now,
            { allowHistoricalFirstItem: true, retentionDays: runnable.retentionDays });
        } else {
          // arXiv retains its chronological multi-page scan.
          await stage(env.DB, runnable.id, result.items, state.initialized_at, now,
            { retentionDays: runnable.retentionDays });
        }
        const reachedOverlap = paginated && state.last_complete_at !== null &&
          result.items.some((item) => item.publishedAt <= state.last_complete_at! - LOOKBACK_MS);
        phase = 'save_checkpoint';
        if (paginated && state.initialized_at !== null && result.nextCursor && !reachedOverlap && !verifyingHead) {
          await saveScanCursor(env.DB, runnable.id, token, now, state.scan_started_at ?? now, result.nextCursor);
        } else if (paginated && state.initialized_at !== null && state.scan_cursor !== null &&
            !verifyingHead && !result.potentiallyTruncated) {
          // Offset/search pages may shift as new items arrive during a multi-Cron scan.
          // Check the newest page once more before saving the full-scan watermark.
          await saveScanCursor(env.DB, runnable.id, token, now,
            state.scan_started_at ?? now, VERIFY_HEAD_CURSOR);
        } else {
          const nextDueAt = runnable.weeklyJstDay === undefined ? undefined :
            nextAllowedJstWeekdayDue(now, runnable.weeklyJstDay, runnable.intervalMinutes);
          await completeFetch(env.DB, runnable.id, token, now, runnable.intervalMinutes,
            paginated ? state.scan_started_at ?? now : now,
            paginated ? !result.potentiallyTruncated : true, nextDueAt);
          if (wikipedia) wikipediaFetchSucceeded = true;
          if (state.initialized_at === null && (!paginated || !result.potentiallyTruncated))
            console.log('monitor ' + runnable.id + (runnable.source === 'youtube'
              ? ': initial scan initialized; latest video eligible for delivery'
              : ': silent baseline initialized'));
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
    // Poll sources independently of delivery hours. If an optional delivery
    // window is configured, preserve queued notifications until it reopens.
    const deliveryNow = deps.clock?.() ?? now;
    const pending = !isJstNotificationTime(deliveryNow, deliveryWindow) || state.webhook_cooldown_until > now ||
      state.webhook_blocked_status !== null || (wikipedia && !wikipediaFetchSucceeded)
      ? [] : await getPending(env.DB, runnable.id, now, discovery ? 2 : MAX_NOTIFICATIONS_PER_TICK,
        wikipedia ? wikipediaCutoff : undefined, runnable.source);
    for (const item of pending) {
      // A slow upstream fetch may have crossed the configured delivery cutoff.
      if (!isJstNotificationTime(deps.clock?.() ?? now, deliveryWindow)) break;
      phase = 'discord_send';
      try {
        await deps.send(webhook, runnable.source, {
          id: item.item_id, title: item.title, url: item.url, publishedAt: item.published_at,
          // Stored source images win over a newer truncated/changed RSS view.
          // Pre-migration rows still use the transient current-poll hints.
          ...(item.image_url || fetchedImages.has(item.item_id)
            ? { imageUrl: item.image_url || fetchedImages.get(item.item_id)! } : {}),
          ...(item.thumbnail_url || fetchedThumbnails.has(item.item_id)
            ? { thumbnailUrl: item.thumbnail_url || fetchedThumbnails.get(item.item_id)! } : {}),
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

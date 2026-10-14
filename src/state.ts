import type { Database, Delivery, MonitorState, ContentItem, SourceName } from './types.ts';
import { isJstNotificationTime } from './schedule.ts';
import type { NotificationWindowJst } from './schedule.ts';
import { DELIVERY_RETENTION_MS } from './maintenance.ts';
import { persistentMedia, missingDeliveryMediaColumns } from './persisted-media.ts';

export const LEASE_MS = 120_000;
const MIN_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const MAX_SERVER_RETRY_MS = 24 * 60 * 60_000;
function retryDelay(defaultMs: number, suggestedMs?: number | null): number {
  if (suggestedMs === null || suggestedMs === undefined || !Number.isFinite(suggestedMs) || suggestedMs < 0)
    return defaultMs;
  return Math.max(defaultMs, Math.min(MAX_SERVER_RETRY_MS, Math.ceil(suggestedMs)));
}

// One bounded D1 write for all enabled monitors, instead of a request for every ID.
export async function ensureMonitors(db: Database, ids: readonly string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const placeholders = chunk.map(() => '(?)').join(',');
    await db.prepare('INSERT OR IGNORE INTO monitor_state (id) VALUES ' + placeholders)
      .bind(...chunk).run();
  }
}
export async function ensureMonitor(db: Database, id: string): Promise<void> {
  await ensureMonitors(db, [id]);
}
export async function getState(db: Database, id: string, source: SourceName): Promise<MonitorState> {
  const state = await db.prepare(
    'SELECT m.id, m.initialized_at, m.next_due_at, m.scan_cursor, m.scan_started_at, ' +
    'm.last_complete_at, m.config_identity, m.last_incomplete_at, m.incomplete_count, ' +
    'COALESCE(w.cooldown_until, 0) AS webhook_cooldown_until, ' +
    'w.blocked_status AS webhook_blocked_status, w.blocked_at AS webhook_blocked_at ' +
    'FROM monitor_state m LEFT JOIN webhook_source_state w ON w.source = ? WHERE m.id = ?'
  ).bind(source, id).first<MonitorState>();
  if (!state) throw new Error('Missing monitor state for ' + id);
  return state;
}

// Pin each persistent monitor ID to its source and canonical query, not its interval.
// Silently reusing the old ID after changing its query would mix unrelated outbox histories.
export async function assertMonitorIdentity(
  db: Database, monitorId: string, leaseToken: string,
  source: string, query: string, recorded: string | null, initializedAt: number | null,
): Promise<void> {
  const identity = JSON.stringify([source, query.trim()]);
  if (recorded === identity) return;
  if (recorded !== null) {
    throw new Error('Monitor ' + monitorId + ' has a changed source/query. Use a new monitor ID to start a silent baseline.');
  }
  // Migration-safe: never silently approve an unknown historical source identity.
  if (initializedAt !== null) {
    throw new Error('Monitor ' + monitorId + ' has no stored source/query identity but is already initialized. Reset its state intentionally.');
  }
  const result = await db.prepare(
    'UPDATE monitor_state SET config_identity = ? WHERE id = ? AND lease_token = ? AND config_identity IS NULL AND initialized_at IS NULL'
  ).bind(identity, monitorId, leaseToken).run();
  if (result.meta.changes !== 1) throw new Error('Monitor identity could not be pinned under the active lease');
}
// D1 permits at most 100 SQL bindings. Each monitor uses two; reserve
// three additional bindings for the delivery-hours flag and current time; each read uses at most 83.
const MONITOR_SELECT_BATCH = 40;
export async function getRunnableIds(
  db: Database, now: number, enabled: readonly { id: string; source: SourceName }[],
  deliveryWindow: NotificationWindowJst | null = null,
): Promise<string[]> {
  if (!enabled.length) return [];
  type Row = {
    id: string; existing_id: string | null; next_due_at: number | null;
    lease_until: number | null; pending_due: number;
  };
  const deliveryAllowed = isJstNotificationTime(now, deliveryWindow);
  const all: Row[] = [];
  for (let offset = 0; offset < enabled.length; offset += MONITOR_SELECT_BATCH) {
    const batch = enabled.slice(offset, offset + MONITOR_SELECT_BATCH);
    const inputs = batch.map(() => '(?,?)').join(',');
    const params = batch.flatMap((monitor) => [monitor.id, monitor.source]);
    const rows = await db.prepare(
      'WITH enabled(id, source) AS (VALUES ' + inputs + ') ' +
      'SELECT e.id AS id, m.id AS existing_id, m.next_due_at, m.lease_until, ' +
      "CASE WHEN e.source <> 'wikipedia' AND ? = 1 " +
      'AND COALESCE(w.cooldown_until, 0) <= ? AND w.blocked_status IS NULL THEN ' +
      "EXISTS (SELECT 1 FROM deliveries d WHERE d.monitor_id = e.id AND d.status = 'pending' " +
      'AND d.next_attempt_at <= ?) ELSE 0 END AS pending_due ' +
      'FROM enabled e LEFT JOIN monitor_state m ON m.id = e.id ' +
      'LEFT JOIN webhook_source_state w ON w.source = e.source'
    ).bind(...params, deliveryAllowed ? 1 : 0, now, now).all<Row>();
    all.push(...rows.results);
  }
  const missing = all.filter((row) => row.existing_id === null).map((row) => row.id);
  if (missing.length) await ensureMonitors(db, missing);
  const runnable = all.filter((row) =>
    row.existing_id !== null &&
    (row.lease_until === null || row.lease_until <= now) &&
    ((row.next_due_at !== null && row.next_due_at <= now) || row.pending_due !== 0)
  );
  // The order must be global rather than each chunk's local SQL order.
  runnable.sort((a, b) => (a.next_due_at ?? 0) - (b.next_due_at ?? 0) ||
    a.id.localeCompare(b.id));
  return [...missing.sort(), ...runnable.map((row) => row.id)];
}
export async function claim(
  db: Database, id: string, source: SourceName, token: string, now: number,
): Promise<boolean> {
  // The due-fetch path is independent of Discord availability. Pending-only
  // delivery must check the CURRENT source-wide Webhook state, not legacy
  // monitor_state webhook columns retained by earlier migrations.
  const result = await db.prepare(
    "UPDATE monitor_state SET lease_token = ?, lease_until = ? WHERE id = ? " +
    "AND (lease_until IS NULL OR lease_until <= ?) AND (next_due_at <= ? OR (? <> 'wikipedia' AND (" +
    "EXISTS (SELECT 1 FROM deliveries d WHERE d.monitor_id = monitor_state.id " +
    "AND d.status = 'pending' AND d.next_attempt_at <= ?) " +
    "AND NOT EXISTS (SELECT 1 FROM webhook_source_state w " +
    "WHERE w.source = ? AND (w.cooldown_until > ? OR w.blocked_status IS NOT NULL)))))"
  ).bind(token, now + LEASE_MS, id, now, now, source, now, source, now).run();
  return result.meta.changes === 1;
}
export async function release(db: Database, id: string, token: string): Promise<void> {
  await db.prepare('UPDATE monitor_state SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?')
    .bind(id, token).run();
}
// D1 supports up to 100 bound parameters; each row binds 7 (12 * 7 = 84).
const OUTBOX_INSERT_BATCH = 12;
/** Suppress initial OpenAlex search results by ID, not publication clock time.
 * Date-only timestamps would otherwise drop later additions from the same day.
 * At most 12 INSERT binds per batch (=84 D1 parameters).
 */
export async function stageInitialIgnored(
  db: Database, monitorId: string, items: readonly ContentItem[], now: number,
): Promise<void> {
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  for (let offset = 0; offset < unique.length; offset += OUTBOX_INSERT_BATCH) {
    const chunk = unique.slice(offset, offset + OUTBOX_INSERT_BATCH);
    const vals: unknown[] = [];
    for (const item of chunk) {
      vals.push(monitorId, item.id, 'ignored', item.title, item.url, item.publishedAt, now);
    }
    await db.prepare(
      'INSERT OR IGNORE INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) VALUES ' +
      chunk.map(() => '(?,?,?,?,?,?,?)').join(',')
    ).bind(...vals).run();
  }
}

export async function stage(
  db: Database, monitorId: string, items: readonly ContentItem[], baselineAt: number | null, now: number,
  options: { allowHistoricalFirstItem?: boolean; imageSource?: 'qiita' | 'zenn' } = {},
): Promise<void> {
  // Usually the first observation is a silent time-based baseline.
  // For YouTube, always consider the freshest item even if it predates the
  // baseline. Older videos remain excluded unless published after baseline.
  if (baselineAt === null && !options.allowHistoricalFirstItem) return;
  // Normal non-YouTube receipts expire after ten days. YouTube sent receipts
  // are retained permanently to ensure even an old latest video is not
  // re-announced after a long interval or temporary feed regression.
  const retentionCutoff = now - DELIVERY_RETENTION_MS;
  const eligibleAfter = Math.max(baselineAt ?? now, retentionCutoff);
  const eligible = items.filter((item, index) =>
    (options.allowHistoricalFirstItem && index === 0) ||
    (baselineAt !== null && item.publishedAt > eligibleAfter));
  // Image-bearing rows use 9 SQL bindings; cap at 10 (90 <= D1's 100).
  // The original 12x7 batching remains for every other source.
  const batchSize = options.imageSource ? 10 : OUTBOX_INSERT_BATCH;
  for (let offset = 0; offset < eligible.length; offset += batchSize) {
    const chunk = eligible.slice(offset, offset + batchSize);
    // Read-before-write avoids D1 writes during the common "no new article" scan.
    // INSERT OR IGNORE still guarantees idempotence if a lease expires mid-scan.
    const placeholders = chunk.map(() => '?').join(',');
    const existingRows = await db.prepare(
      'SELECT item_id FROM deliveries WHERE monitor_id = ? AND item_id IN (' + placeholders + ')'
    ).bind(monitorId, ...chunk.map((item) => item.id)).all<{ item_id: string }>();
    const existing = new Set(existingRows.results.map((row) => row.item_id));
    const unseen = chunk.filter((item) => !existing.has(item.id));
    if (!unseen.length) continue;
    const values: unknown[] = [];
    for (const item of unseen) {
      values.push(monitorId, item.id, 'pending', item.title, item.url, item.publishedAt, now);
    }
    if (options.imageSource) {
      const media = unseen.map((item) => persistentMedia(options.imageSource!, item));
      if (media.some((m) => m.imageUrl || m.thumbnailUrl)) {
        const extendedValues: unknown[] = [];
        for (let i = 0; i < unseen.length; i++) {
          extendedValues.push(...values.slice(i * 7, i * 7 + 7),
            media[i]!.imageUrl, media[i]!.thumbnailUrl);
        }
        try {
          await db.prepare(
            'INSERT OR IGNORE INTO deliveries ' +
            '(monitor_id,item_id,status,title,url,published_at,discovered_at,image_url,thumbnail_url) VALUES ' +
            unseen.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')
          ).bind(...extendedValues).run();
          continue;
        } catch (error) {
          // A zero-downtime rollout: keep delivering text/link with the old
          // schema until the operator applies the new migration.
          if (!missingDeliveryMediaColumns(error)) throw error;
        }
      }
    }
    await db.prepare(
      'INSERT OR IGNORE INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) ' +
      'VALUES ' + unseen.map(() => '(?,?,?,?,?,?,?)').join(',')
    ).bind(...values).run();
  }
}
export async function saveScanCursor(
  db: Database, id: string, token: string, now: number, scanStartedAt: number, cursor: string,
): Promise<void> {
  if (!cursor || cursor.length > 512) throw new Error('Invalid scan cursor');
  const result = await db.prepare(
    'UPDATE monitor_state SET scan_cursor = ?, scan_started_at = ?, next_due_at = ? ' +
    'WHERE id = ? AND lease_token = ?'
  ).bind(cursor, scanStartedAt, now + 60_000, id, token).run();
  if (result.meta.changes !== 1) throw new Error('Lost lease while saving scan cursor');
}

export async function completeFetch(
  db: Database, id: string, token: string, now: number, intervalMinutes: number,
  scanStartedAt = now, complete = true, nextDueAt?: number,
): Promise<void> {
  const result = await db.prepare(
    'UPDATE monitor_state SET initialized_at = COALESCE(initialized_at, ?), next_due_at = ?, ' +
    'last_complete_at = CASE WHEN ? = 1 THEN ? ELSE last_complete_at END, ' +
    'last_incomplete_at = CASE WHEN ? = 1 THEN last_incomplete_at ELSE ? END, ' +
    'incomplete_count = incomplete_count + CASE WHEN ? = 1 THEN 0 ELSE 1 END, ' +
    'scan_cursor = NULL, scan_started_at = NULL WHERE id = ? AND lease_token = ?'
  ).bind(scanStartedAt, nextDueAt ?? now + intervalMinutes * 60_000,
    complete ? 1 : 0, scanStartedAt, complete ? 1 : 0, now, complete ? 1 : 0, id, token).run();
  if (result.meta.changes !== 1) throw new Error('Lost lease while saving fetch checkpoint');
}
// Defer an overdue calendar-restricted monitor until its next allowed day.
// This intentionally does not affect pending Discord deliveries or baselines.
export async function deferFetchUntil(
  db: Database, id: string, token: string, nextDueAt: number,
): Promise<void> {
  const result = await db.prepare(
    'UPDATE monitor_state SET next_due_at = ? WHERE id = ? AND lease_token = ?'
  ).bind(nextDueAt, id, token).run();
  if (result.meta.changes !== 1) throw new Error('Lost lease while deferring weekday fetch');
}
export async function postponeFetch(db: Database, id: string, token: string, now: number, suggestedMs?: number | null): Promise<number> {
  const nextDueAt = now + retryDelay(MIN_RETRY_MS, suggestedMs);
  await db.prepare('UPDATE monitor_state SET next_due_at = ? WHERE id = ? AND lease_token = ?')
    .bind(nextDueAt, id, token).run();
  return nextDueAt;
}
export async function coolDownPending(
  db: Database, source: SourceName, now: number, suggestedMs?: number | null,
): Promise<void> {
  const until = now + retryDelay(MIN_RETRY_MS, suggestedMs);
  await db.prepare(
    'INSERT INTO webhook_source_state (source, cooldown_until) VALUES (?,?) ' +
    'ON CONFLICT(source) DO UPDATE SET cooldown_until = MAX(webhook_source_state.cooldown_until, excluded.cooldown_until)'
  ).bind(source, until).run();
}

export async function blockWebhook(
  db: Database, source: SourceName, status: number, now: number,
): Promise<void> {
  // A deleted or unauthorized webhook affects every monitor of that source.
  await db.prepare(
    'INSERT INTO webhook_source_state (source, blocked_status, blocked_at) VALUES (?,?,?) ' +
    'ON CONFLICT(source) DO UPDATE SET blocked_status = excluded.blocked_status, blocked_at = excluded.blocked_at'
  ).bind(source, status, now).run();
}

export async function getPending(
  db: Database, id: string, now: number, limit: number, wikipediaCutoff?: number,
  imageSource?: SourceName,
): Promise<Delivery[]> {
  const sample = wikipediaCutoff !== undefined;
  const predicate = "WHERE monitor_id = ? AND status = 'pending' AND next_attempt_at <= ? " +
    (sample ? 'AND published_at > ? ' : '') +
    (sample ? 'ORDER BY published_at DESC, item_id DESC LIMIT ?' :
      'ORDER BY published_at, item_id LIMIT ?');
  const args = sample ? [id, now, wikipediaCutoff, limit] : [id, now, limit];
  const projection = 'SELECT item_id, title, url, published_at, attempts';
  if (imageSource === 'qiita' || imageSource === 'zenn') {
    try {
      const enriched = await db.prepare(projection + ', image_url, thumbnail_url FROM deliveries ' + predicate)
        .bind(...args).all<Delivery>();
      return enriched.results;
    } catch (error) {
      if (!missingDeliveryMediaColumns(error)) throw error;
    }
  }
  const rows = await db.prepare(projection + ' FROM deliveries ' + predicate)
    .bind(...args).all<Delivery>();
  return rows.results;
}

// A new high-volume source snapshot replaces the previous candidate window.
// Discard only pending older articles; preserve sent receipts and retries for
// articles that remain in the selected window. At most 4 SQL bindings.
export async function pruneUnselectedArticlePending(
  db: Database, monitorId: string, selectedIds: readonly string[],
): Promise<void> {
  if (selectedIds.length > 3) throw new Error('Latest candidate set exceeds three');
  const exclusion = selectedIds.length
    ? ' AND item_id NOT IN (' + selectedIds.map(() => '?').join(',') + ')' : '';
  await db.prepare(
    "DELETE FROM deliveries WHERE monitor_id = ? AND status = 'pending'" + exclusion
  ).bind(monitorId, ...selectedIds).run();
}

// One bounded delete every successful 2h Wikipedia check (0-12 rows).
// Old pending messages are intentionally discarded to stop backlog floods.
export async function pruneStaleWikipediaPending(
  db: Database, id: string, cutoff: number,
): Promise<void> {
  await db.prepare(
    "DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries " +
    "WHERE monitor_id = ? AND status = 'pending' AND published_at <= ? LIMIT 12)"
  ).bind(id, cutoff).run();
}

// Discovery reads at most 16 IDs, selects one unseen featured article and one
// unseen random article. No D1 write is made when the selection is exhausted;
// 10-day sent receipts provide bounded no-repeat behavior without a new table.
export async function selectWikipediaDiscovery(
  db: Database, id: string, candidates: readonly ContentItem[], now: number,
): Promise<ContentItem[]> {
  const pool = candidates.slice(0, 16);
  if (!pool.length) return [];
  const ids = [...new Set(pool.map((item) => item.id))];
  const seenRows = await db.prepare(
    'SELECT item_id FROM deliveries WHERE monitor_id = ? AND item_id IN (' +
    ids.map(() => '?').join(',') + ')'
  ).bind(id, ...ids).all<{ item_id: string }>();
  const seen = new Set(seenRows.results.map((row) => row.item_id));
  const selected: ContentItem[] = [];
  for (const kind of ['featured', 'random'] as const) {
    const candidate = pool.find((item) => item.discoveryKind === kind && !seen.has(item.id));
    if (candidate) {
      selected.push({ ...candidate,
        title: (kind === 'featured' ? '【秀逸な記事】' : '【ランダム】') + candidate.title,
        publishedAt: now,
      });
      seen.add(candidate.id); // A random pick must never repeat the featured one.
    }
  }
  return selected;
}

export async function markSent(db: Database, id: string, itemId: string, now: number): Promise<void> {
  await db.prepare(
    "UPDATE deliveries SET status = 'sent', sent_at = ? WHERE monitor_id = ? AND item_id = ? AND status = 'pending'"
  ).bind(now, id, itemId).run();
}
export async function retryLater(db: Database, id: string, itemId: string, attempts: number, now: number, suggestedMs?: number | null): Promise<number> {
  const backoff = retryDelay(Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempts, 5)), suggestedMs);
  const nextDueAt = now + backoff;
  await db.prepare(
    "UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ? " +
    "WHERE monitor_id = ? AND item_id = ? AND status = 'pending'"
  ).bind(nextDueAt, id, itemId).run();
  return nextDueAt;
}

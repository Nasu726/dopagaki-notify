import type { Database, Delivery, MonitorState, ContentItem } from './types.ts';

export const LEASE_MS = 120_000;
const MIN_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;

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
export async function getState(db: Database, id: string): Promise<MonitorState> {
  const state = await db.prepare('SELECT id, initialized_at, next_due_at, scan_cursor, scan_started_at, last_complete_at FROM monitor_state WHERE id = ?')
    .bind(id).first<MonitorState>();
  if (!state) throw new Error('Missing monitor state for ' + id);
  return state;
}
export async function getRunnableIds(
  db: Database, now: number, enabledIds: readonly string[],
): Promise<string[]> {
  if (!enabledIds.length) return [];
  // The enabled roster is the driving table. Missing monitor rows are bootstrapped
  // only once; otherwise a quiet Cron reads D1 without any initialization writes.
  const inputs = enabledIds.map(() => '(?)').join(',');
  const rows = await db.prepare(
    'WITH enabled(id) AS (VALUES ' + inputs + ') ' +
    'SELECT e.id AS id, m.id AS existing_id, m.next_due_at, m.lease_until, ' +
    "EXISTS (SELECT 1 FROM deliveries d WHERE d.monitor_id = e.id AND d.status = 'pending' " +
    'AND d.next_attempt_at <= ?) AS pending_due ' +
    'FROM enabled e LEFT JOIN monitor_state m ON m.id = e.id ' +
    'ORDER BY m.next_due_at, e.id'
  ).bind(...enabledIds, now).all<{
    id: string; existing_id: string | null; next_due_at: number | null;
    lease_until: number | null; pending_due: number;
  }>();
  const missing = rows.results.filter((row) => row.existing_id === null).map((row) => row.id);
  if (missing.length) await ensureMonitors(db, missing);
  const runnable = rows.results.filter((row) =>
    row.existing_id !== null &&
    (row.lease_until === null || row.lease_until <= now) &&
    ((row.next_due_at !== null && row.next_due_at <= now) || row.pending_due !== 0)
  ).map((row) => row.id);
  return [...missing, ...runnable];
}
export async function claim(db: Database, id: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE monitor_state SET lease_token = ?, lease_until = ? WHERE id = ? " +
    "AND (lease_until IS NULL OR lease_until <= ?) AND (next_due_at <= ? OR EXISTS " +
    "(SELECT 1 FROM deliveries d WHERE d.monitor_id = monitor_state.id " +
    "AND d.status = 'pending' AND d.next_attempt_at <= ?))"
  ).bind(token, now + LEASE_MS, id, now, now, now).run();
  return result.meta.changes === 1;
}
export async function release(db: Database, id: string, token: string): Promise<void> {
  await db.prepare('UPDATE monitor_state SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?')
    .bind(id, token).run();
}
const OUTBOX_INSERT_BATCH = 20;
export async function stage(
  db: Database, monitorId: string, items: readonly ContentItem[], baselineAt: number | null, now: number,
): Promise<void> {
  // The initial observation is a silent time-based baseline; there is no reason to
  // persist legacy content IDs. Older backfilled items are likewise never eligible.
  if (baselineAt === null) return;
  const eligible = items.filter((item) => item.publishedAt > baselineAt);
  for (let offset = 0; offset < eligible.length; offset += OUTBOX_INSERT_BATCH) {
    const chunk = eligible.slice(offset, offset + OUTBOX_INSERT_BATCH);
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
  db: Database, id: string, token: string, now: number, intervalMinutes: number, scanStartedAt = now,
): Promise<void> {
  const result = await db.prepare(
    'UPDATE monitor_state SET initialized_at = COALESCE(initialized_at, ?), next_due_at = ?, ' +
    'last_complete_at = ?, scan_cursor = NULL, scan_started_at = NULL WHERE id = ? AND lease_token = ?'
  ).bind(scanStartedAt, now + intervalMinutes * 60_000, scanStartedAt, id, token).run();
  if (result.meta.changes !== 1) throw new Error('Lost lease while saving fetch checkpoint');
}
export async function postponeFetch(db: Database, id: string, token: string, now: number): Promise<void> {
  await db.prepare('UPDATE monitor_state SET next_due_at = ? WHERE id = ? AND lease_token = ?')
    .bind(now + MIN_RETRY_MS, id, token).run();
}
export async function getPending(db: Database, id: string, now: number, limit: number): Promise<Delivery[]> {
  const rows = await db.prepare(
    "SELECT item_id, title, url, published_at, attempts FROM deliveries " +
    "WHERE monitor_id = ? AND status = 'pending' AND next_attempt_at <= ? " +
    "ORDER BY published_at, item_id LIMIT ?"
  ).bind(id, now, limit).all<Delivery>();
  return rows.results;
}
export async function markSent(db: Database, id: string, itemId: string, now: number): Promise<void> {
  await db.prepare(
    "UPDATE deliveries SET status = 'sent', sent_at = ? WHERE monitor_id = ? AND item_id = ? AND status = 'pending'"
  ).bind(now, id, itemId).run();
}
export async function retryLater(db: Database, id: string, itemId: string, attempts: number, now: number): Promise<void> {
  const backoff = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempts, 5));
  await db.prepare(
    "UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ? " +
    "WHERE monitor_id = ? AND item_id = ? AND status = 'pending'"
  ).bind(now + backoff, id, itemId).run();
}

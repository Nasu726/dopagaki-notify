import type { Database, Delivery, MonitorState, ContentItem } from './types.ts';

export const LEASE_MS = 120_000;
const MIN_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;

export async function ensureMonitor(db: Database, id: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO monitor_state (id) VALUES (?)').bind(id).run();
}
export async function getState(db: Database, id: string): Promise<MonitorState> {
  const state = await db.prepare('SELECT id, initialized_at, next_due_at FROM monitor_state WHERE id = ?')
    .bind(id).first<MonitorState>();
  if (!state) throw new Error('Missing monitor state for ' + id);
  return state;
}
export async function getRunnableIds(db: Database, now: number): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT m.id FROM monitor_state m WHERE (m.lease_until IS NULL OR m.lease_until <= ?) " +
    "AND (m.next_due_at <= ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.monitor_id = m.id " +
    "AND d.status = 'pending' AND d.next_attempt_at <= ?)) ORDER BY m.next_due_at, m.id"
  ).bind(now, now, now).all<{ id: string }>();
  return rows.results.map((row) => row.id);
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
export async function stage(
  db: Database, monitorId: string, items: readonly ContentItem[], baselineAt: number | null, now: number,
): Promise<void> {
  for (const item of items) {
    const status = baselineAt === null || item.publishedAt <= baselineAt ? 'ignored' : 'pending';
    await db.prepare(
      'INSERT OR IGNORE INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(monitorId, item.id, status, item.title, item.url, item.publishedAt, now).run();
  }
}
export async function completeFetch(
  db: Database, id: string, token: string, now: number, intervalMinutes: number,
): Promise<void> {
  const result = await db.prepare(
    'UPDATE monitor_state SET initialized_at = COALESCE(initialized_at, ?), next_due_at = ? WHERE id = ? AND lease_token = ?'
  ).bind(now, now + intervalMinutes * 60_000, id, token).run();
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

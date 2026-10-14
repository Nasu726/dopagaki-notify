import type { Database, Monitor } from './types.ts';

export const DELIVERY_RETENTION_MS = 10 * 24 * 60 * 60_000;
export const PRUNE_BATCH_SIZE = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Sent receipt retention is independent of any polling interval.
 * Unspecified monitors keep historical policy: 10 days except YouTube forever.
 * null explicitly means unlimited. Changing this never deletes pending/ignored
 * outbox rows. Finite YouTube retention also gates stale rediscovery in stage().
 */
export function receiptRetentionDays(monitor: Monitor): number | null {
  return monitor.retentionDays === undefined
    ? (monitor.source === 'youtube' ? null : 10)
    : monitor.retentionDays;
}

export async function pruneSentDeliveries(
  db: Database, now: number, monitors: readonly Monitor[] = [],
): Promise<number> {
  if (!Number.isFinite(now)) throw new Error('Invalid retention clock');
  const custom = monitors.filter(m => m.retentionDays !== undefined);
  // Build constant CASE arms from strictly validated IDs and integer ranges.
  // This avoids >100 D1 bind parameters for large (100s of monitors) configs,
  // without relying on JSON1 availability in every SQLite adapter.
  const cases: string[] = [];
  for (const monitor of custom) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(monitor.id) ||
        (monitor.retentionDays !== null &&
          (!Number.isSafeInteger(monitor.retentionDays) || monitor.retentionDays! < 1 ||
            monitor.retentionDays! > 36500)))
      throw new Error('Invalid monitor retention policy');
    const cutoff = monitor.retentionDays === null ? 'NULL'
      : String(Math.trunc(now - monitor.retentionDays! * DAY_MS));
    cases.push("WHEN '" + monitor.id + "' THEN " + cutoff);
  }
  const defaultCutoff = Math.trunc(now - DELIVERY_RETENTION_MS);
  const cutoffSql = cases.length
    ? '(CASE monitor_id ' + cases.join(' ') +
      " ELSE CASE WHEN item_id LIKE 'youtube:%' THEN NULL ELSE " + defaultCutoff + " END END)"
    : "(CASE WHEN item_id LIKE 'youtube:%' THEN NULL ELSE " + defaultCutoff + " END)";
  // Bounded one-statement pruning. The sent_at partial index (migration 0009)
  // preserves chronological candidate ordering; no source data is fetched.
  const result = await db.prepare(
    "DELETE FROM deliveries WHERE rowid IN (" +
    "SELECT rowid FROM deliveries WHERE status = 'sent' AND sent_at < " +
    cutoffSql + " ORDER BY sent_at LIMIT ?)"
  ).bind(PRUNE_BATCH_SIZE).run();
  return result.meta.changes ?? 0;
}

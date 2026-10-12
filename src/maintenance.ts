import type { Database } from './types.ts';

export const DELIVERY_RETENTION_MS = 10 * 24 * 60 * 60_000;
export const PRUNE_BATCH_SIZE = 20;

// A dedicated maintenance Cron issues one bounded DELETE and never touches
// pending retries or monitor scan checkpoints. The partial index in migration
// 0009 makes selecting expired sent rows independent of total outbox size.
export async function pruneSentDeliveries(db: Database, now: number): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM deliveries WHERE rowid IN (" +
    "SELECT rowid FROM deliveries WHERE status = 'sent' AND sent_at < ? " +
    "ORDER BY sent_at LIMIT ?)"
  ).bind(now - DELIVERY_RETENTION_MS, PRUNE_BATCH_SIZE).run();
  return result.meta.changes ?? 0;
}

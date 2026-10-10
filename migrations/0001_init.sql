-- Independent monitor leases, fetch deadlines, and durable notification outbox.
CREATE TABLE IF NOT EXISTS monitor_state (
  id TEXT PRIMARY KEY NOT NULL,
  initialized_at INTEGER,
  next_due_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS monitor_due_idx ON monitor_state(next_due_at, lease_until);

CREATE TABLE IF NOT EXISTS deliveries (
  monitor_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ignored','pending','sent')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  discovered_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(monitor_id, item_id)
);
CREATE INDEX IF NOT EXISTS deliveries_retry_idx
  ON deliveries(monitor_id, status, next_attempt_at, discovered_at);

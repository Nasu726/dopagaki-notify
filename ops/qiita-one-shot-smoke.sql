-- ONE-SHOT LIVE DELIVERY PROBE. Not a migration: run manually via Wrangler.
-- Queue a synthetic Qiita-channel notification only for the already initialized,
-- identity-verified qiita-rust monitor. Does not touch monitor_state or real items.
-- Stable synthetic ID + deliveries PK make repeated executions idempotent.
-- A failed Discord delivery remains pending and follows normal retry/cooldown rules.
INSERT OR IGNORE INTO deliveries (
  monitor_id, item_id, status, title, url, published_at, discovered_at
)
SELECT
  m.id,
  'smoke:qiita:discord-outbox:2026-10-12',
  'pending',
  '[TEST] dopagaki-notify - Qiita channel / D1 outbox delivery',
  'https://github.com/Nasu726/dopagaki-notify',
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
FROM monitor_state AS m
WHERE m.id = 'qiita-rust'
  AND m.initialized_at IS NOT NULL
  AND m.config_identity = '["qiita","tag:Rust"]';

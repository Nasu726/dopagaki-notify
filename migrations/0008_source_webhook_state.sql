-- One webhook secret per source; all monitors using that source share rate limits.
-- Store no webhook URLs, tokens, or hashes in D1.
CREATE TABLE IF NOT EXISTS webhook_source_state (
  source TEXT PRIMARY KEY NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  blocked_status INTEGER,
  blocked_at INTEGER
);
-- Preserve any previously saved per-monitor limits during an in-place migration.
INSERT INTO webhook_source_state (source, cooldown_until, blocked_status, blocked_at)
SELECT json_extract(config_identity, '$[0]'),
       MAX(webhook_cooldown_until), MAX(webhook_blocked_status), MAX(webhook_blocked_at)
FROM monitor_state
WHERE config_identity IS NOT NULL
GROUP BY json_extract(config_identity, '$[0]');

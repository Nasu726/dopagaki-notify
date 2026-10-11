-- Persist a monitor-wide webhook cooldown so newly discovered items cannot bypass a 429.
ALTER TABLE monitor_state ADD COLUMN webhook_cooldown_until INTEGER NOT NULL DEFAULT 0;

-- A deleted/unauthorized webhook must not be retried indefinitely.
-- Pending deliveries remain intact for an explicit operator recovery after secret rotation.
ALTER TABLE monitor_state ADD COLUMN webhook_blocked_status INTEGER;
ALTER TABLE monitor_state ADD COLUMN webhook_blocked_at INTEGER;

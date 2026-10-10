-- Persist an in-progress API scan across Cron invocations and retain its last completed window.
ALTER TABLE monitor_state ADD COLUMN scan_cursor TEXT;
ALTER TABLE monitor_state ADD COLUMN scan_started_at INTEGER;
ALTER TABLE monitor_state ADD COLUMN last_complete_at INTEGER;

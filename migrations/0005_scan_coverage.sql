-- Record non-exhaustive scans without pretending a complete catch-up checkpoint.
ALTER TABLE monitor_state ADD COLUMN last_incomplete_at INTEGER;
ALTER TABLE monitor_state ADD COLUMN incomplete_count INTEGER NOT NULL DEFAULT 0;

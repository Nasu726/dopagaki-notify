-- Prevent silent history reuse when a monitor ID is assigned to a new source or query.
ALTER TABLE monitor_state ADD COLUMN config_identity TEXT;

-- Supports bounded deletion of acknowledged notifications with no full table scan.
-- Pending retries must never be deleted by the maintenance Cron.
CREATE INDEX IF NOT EXISTS deliveries_sent_retention_idx
  ON deliveries(sent_at) WHERE status = 'sent';

-- Crash-recoverable webhook outbox dispatch state.
ALTER TABLE webhook_deliveries ADD COLUMN updated_at INTEGER;

UPDATE webhook_deliveries
SET updated_at = COALESCE(delivered_at, created_at)
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dispatch
ON webhook_deliveries(status, updated_at);

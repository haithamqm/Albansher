-- V66.14: idempotent complaint replies for reliable retries under weak connectivity.
ALTER TABLE complaint_messages ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_complaint_messages_idempotency
  ON complaint_messages(complaint_id,author_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE INDEX IF NOT EXISTS ix_complaint_messages_ordered
  ON complaint_messages(complaint_id,created_at,id);

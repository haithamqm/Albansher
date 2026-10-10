-- V65 Operational completion: richer delivery proof + browser notification subscriptions.
ALTER TABLE orders ADD COLUMN delivery_proof_file_id TEXT REFERENCES files(id);
ALTER TABLE orders ADD COLUMN delivery_proof_recipient_name TEXT;
ALTER TABLE orders ADD COLUMN delivery_proof_recipient_confirmed_at TEXT;

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  platform TEXT NOT NULL DEFAULT 'WEB',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS ix_notification_subscriptions_user ON notification_subscriptions(user_id, updated_at DESC);

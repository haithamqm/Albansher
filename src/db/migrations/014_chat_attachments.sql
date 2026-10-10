-- V66: attachments inside order-linked chat (image/file)
ALTER TABLE order_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS ix_order_messages_attachments ON order_messages(order_id, created_at);

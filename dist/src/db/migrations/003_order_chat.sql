-- 003: محادثة آمنة مرتبطة بالطلب بين أطراف الطلب فقط
CREATE TABLE order_messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('CUSTOMER','PROVIDER','ADMIN')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_order_messages_order ON order_messages(order_id, created_at, id);
CREATE INDEX ix_order_messages_sender ON order_messages(sender_id, created_at DESC);

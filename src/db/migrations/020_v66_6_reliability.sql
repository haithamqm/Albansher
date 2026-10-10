-- V66.6: reliable service opening, vehicle persistence, chat idempotency and push-ready indexes.
ALTER TABLE order_messages ADD COLUMN idempotency_key TEXT;
ALTER TABLE provider_vehicles ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_order_messages_idempotency ON order_messages(order_id,sender_id,idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_vehicles_idempotency ON provider_vehicles(provider_id,idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE INDEX IF NOT EXISTS ix_orders_customer_service_status_created ON orders(customer_id,service_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_order_assignments_provider_status_offer ON order_assignments(provider_id,status,offered_at DESC);
CREATE INDEX IF NOT EXISTS ix_notification_subscriptions_user ON notification_subscriptions(user_id,updated_at DESC);

-- V66.11: presence integrity + accepting-orders state + optional trip destination.
-- Additive migration only; existing rows/data are preserved.
ALTER TABLE service_providers ADD COLUMN accepting_orders INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_providers ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE service_providers ADD COLUMN last_location_at TEXT;
ALTER TABLE trip_orders ADD COLUMN destination_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_provider_presence_state ON service_providers(verification_status,is_online,accepting_orders,last_seen_at);
CREATE INDEX IF NOT EXISTS ix_provider_heartbeat ON service_providers(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS ix_trip_destination_pending ON trip_orders(destination_pending,updated_at);
-- Preserve the prior meaning for providers that were already online.



-- V66.11+ hardening: beneficiary idempotency / duplicate protection.
ALTER TABLE customer_beneficiaries ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_beneficiary_idempotency ON customer_beneficiaries(customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

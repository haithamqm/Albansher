-- V62: operational completion without replacing V60 Fixed.
ALTER TABLE services ADD COLUMN delivery_proof_type TEXT NOT NULL DEFAULT 'NONE' CHECK (delivery_proof_type IN ('NONE','PIN','RECIPIENT_CONFIRMATION','PHOTO'));
ALTER TABLE service_providers ADD COLUMN specialty TEXT;
ALTER TABLE orders ADD COLUMN delivery_proof_verified_at TEXT;
ALTER TABLE orders ADD COLUMN delivery_proof_verified_by TEXT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN delivery_proof_method TEXT;

CREATE TABLE IF NOT EXISTS service_area_rules (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(service_id, area_id)
);
CREATE INDEX IF NOT EXISTS ix_service_area_rules_area ON service_area_rules(area_id, service_id);

CREATE INDEX IF NOT EXISTS ix_customer_searches_customer_id ON customer_searches(customer_id, id DESC);



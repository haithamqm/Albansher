UPDATE services SET requires_vehicle=1,supports_waiting=1 WHERE slug='motorcycle-trips';
UPDATE services SET requires_vehicle=1 WHERE slug='car-with-driver';
UPDATE services SET requires_inspection=1,pricing_type='QUOTE',base_price=NULL WHERE slug IN ('mobile-car-wash','car-interior-deep-cleaning','car-battery-service','cleaning','carpentry','building-maintenance','freight-transport','furniture-moving');
CREATE TABLE IF NOT EXISTS purchase_change_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  requested_price REAL NOT NULL CHECK(requested_price>=0),
  requested_product TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  created_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_purchase_changes_order ON purchase_change_requests(order_id,status,created_at DESC);

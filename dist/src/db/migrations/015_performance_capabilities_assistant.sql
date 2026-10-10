-- V66.3 performance, provider capabilities, assistant conversation, and dispatch indexes
CREATE INDEX IF NOT EXISTS ix_orders_customer_status_created ON orders(customer_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_provider_status ON orders(provider_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_assign_order_status_expiry ON order_assignments(order_id,status,expires_at);
CREATE INDEX IF NOT EXISTS ix_assign_provider_status_expiry ON order_assignments(provider_id,status,expires_at);
CREATE INDEX IF NOT EXISTS ix_provider_live_fresh ON provider_live_locations(provider_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_provider_services_lookup ON provider_services(service_id,is_active,provider_id);
CREATE INDEX IF NOT EXISTS ix_provider_area_lookup ON provider_service_areas(area_id,provider_id);
CREATE INDEX IF NOT EXISTS ix_service_area_rules_lookup ON service_area_rules(service_id,area_id);
CREATE INDEX IF NOT EXISTS ix_notifications_user_created ON notifications(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS ix_customer_searches_customer_service ON customer_searches(customer_id,service_id,created_at DESC);

CREATE TABLE IF NOT EXISTS provider_capabilities (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, capability_key)
);
CREATE INDEX IF NOT EXISTS ix_provider_capabilities_key ON provider_capabilities(capability_key,is_active,provider_id);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONFIRMED','CANCELLED','EXPIRED')),
  draft_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assistant_sessions_customer ON assistant_sessions(customer_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('CUSTOMER','ASSISTANT','SYSTEM')),
  body TEXT NOT NULL,
  image_file_id TEXT REFERENCES files(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assistant_messages_session ON assistant_messages(session_id,created_at,id);

ALTER TABLE orders ADD COLUMN assistant_session_id TEXT REFERENCES assistant_sessions(id);
CREATE INDEX IF NOT EXISTS ix_orders_assistant_session ON orders(assistant_session_id);

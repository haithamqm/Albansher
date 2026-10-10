-- V60 Fixed update: customer experience, favorites, beneficiaries, trip expansion, service policies.
ALTER TABLE services ADD COLUMN requires_inspection INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN requires_vehicle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN supports_waiting INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN recipient_name TEXT;
ALTER TABLE orders ADD COLUMN recipient_phone TEXT;
ALTER TABLE orders ADD COLUMN recipient_user_id TEXT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN delivery_pin_hash TEXT;

ALTER TABLE trip_orders ADD COLUMN waiting_per_minute_fare REAL NOT NULL DEFAULT 0;
ALTER TABLE trip_orders ADD COLUMN waiting_total_minutes REAL NOT NULL DEFAULT 0;
ALTER TABLE trip_orders ADD COLUMN purchase_max_price REAL;
ALTER TABLE trip_orders ADD COLUMN purchase_quantity INTEGER;
ALTER TABLE trip_orders ADD COLUMN purchase_alternatives TEXT;
ALTER TABLE trip_orders ADD COLUMN purchase_requires_approval INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS favorite_providers (
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(customer_id, provider_id)
);
CREATE INDEX IF NOT EXISTS ix_favorite_provider ON favorite_providers(provider_id);

CREATE TABLE IF NOT EXISTS customer_beneficiaries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_beneficiary_customer ON customer_beneficiaries(customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS customer_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  service_id TEXT REFERENCES services(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_customer_searches ON customer_searches(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trip_stops (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  note TEXT,
  UNIQUE(order_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS ix_trip_stops_order ON trip_stops(order_id, sequence_no);

CREATE TABLE IF NOT EXISTS trip_wait_sessions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  minutes REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trip_wait_order ON trip_wait_sessions(order_id, started_at);

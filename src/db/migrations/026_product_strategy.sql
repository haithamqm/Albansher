-- V68: تحويل دراسة المنتج إلى قدرات تشغيلية فعلية.
-- مواقع ريفية بلا عناوين رسمية، قاموس المرادفات، وتسوية العمولة.
ALTER TABLE locations ADD COLUMN landmark_text TEXT;
ALTER TABLE locations ADD COLUMN locality_text TEXT;
ALTER TABLE locations ADD COLUMN access_notes TEXT;

ALTER TABLE orders ADD COLUMN commission_rate_snapshot REAL;
ALTER TABLE orders ADD COLUMN commission_amount REAL;
ALTER TABLE orders ADD COLUMN provider_payout_amount REAL;
ALTER TABLE orders ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE' CHECK (settlement_status IN ('NOT_APPLICABLE','DUE','PAID','WAIVED'));
ALTER TABLE orders ADD COLUMN completed_by TEXT;

CREATE TABLE IF NOT EXISTS service_aliases (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (source IN ('SEED','ADMIN','LEARNED')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(service_id, normalized_phrase)
);
CREATE INDEX IF NOT EXISTS ix_service_aliases_phrase ON service_aliases(normalized_phrase,is_active);
CREATE INDEX IF NOT EXISTS ix_service_aliases_service ON service_aliases(service_id,is_active);

CREATE TABLE IF NOT EXISTS provider_settlements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  gross_amount REAL NOT NULL DEFAULT 0,
  commission_rate REAL NOT NULL DEFAULT 0,
  commission_amount REAL NOT NULL DEFAULT 0,
  payout_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DUE' CHECK(status IN ('DUE','PAID','WAIVED')),
  due_at TEXT NOT NULL,
  paid_at TEXT,
  paid_by TEXT REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_settlements_provider_status ON provider_settlements(provider_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_settlements_status_due ON provider_settlements(status,due_at);

CREATE TABLE IF NOT EXISTS product_metrics_daily (
  metric_date TEXT PRIMARY KEY,
  orders_created INTEGER NOT NULL DEFAULT 0,
  orders_completed INTEGER NOT NULL DEFAULT 0,
  orders_cancelled INTEGER NOT NULL DEFAULT 0,
  orders_without_provider INTEGER NOT NULL DEFAULT 0,
  total_gross REAL NOT NULL DEFAULT 0,
  total_commission REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);


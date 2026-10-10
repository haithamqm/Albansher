-- V66.4: provider performance metrics and admin-controlled featured providers
CREATE TABLE IF NOT EXISTS featured_providers (
  provider_id TEXT PRIMARY KEY REFERENCES service_providers(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_featured_providers_order ON featured_providers(sort_order, created_at);

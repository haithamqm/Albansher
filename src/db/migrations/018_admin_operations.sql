-- V66.5: operational command center, provider presence, alerts, temporary services, campaigns and system health.
ALTER TABLE service_providers ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS ix_providers_online_seen ON service_providers(is_online,last_seen_at);

CREATE TABLE IF NOT EXISTS provider_presence_sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_presence_provider_time ON provider_presence_sessions(provider_id,started_at DESC);
CREATE INDEX IF NOT EXISTS ix_presence_open ON provider_presence_sessions(provider_id,ended_at,last_seen_at);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_alerts_status_time ON operational_alerts(status,severity,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_entity ON operational_alerts(entity_type,entity_id,status);

CREATE TABLE IF NOT EXISTS temporary_services (
  id TEXT PRIMARY KEY,
  linked_service_id TEXT NOT NULL REFERENCES services(id),
  name_i18n TEXT NOT NULL,
  title_i18n TEXT NOT NULL,
  description_i18n TEXT,
  icon TEXT,
  category_id TEXT REFERENCES categories(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  audience_json TEXT NOT NULL DEFAULT '{}',
  area_ids_json TEXT NOT NULL DEFAULT '[]',
  pricing_json TEXT NOT NULL DEFAULT '{}',
  max_orders INTEGER,
  action_label_i18n TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS ix_temp_services_active_dates ON temporary_services(is_active,start_at,end_at,sort_order);

CREATE TABLE IF NOT EXISTS admin_campaigns (
  id TEXT PRIMARY KEY,
  title_i18n TEXT NOT NULL,
  description_i18n TEXT,
  image_file_id TEXT REFERENCES files(id),
  button_label_i18n TEXT,
  action_type TEXT NOT NULL DEFAULT 'SERVICE' CHECK (action_type IN ('SERVICE','ORDER','INTERNAL','URL','NONE')),
  action_value TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  audience_json TEXT NOT NULL DEFAULT '{}',
  area_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS ix_campaigns_active_dates ON admin_campaigns(is_active,start_at,end_at,sort_order);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('INFO','WARNING','ERROR','CRITICAL')),
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_system_events_time ON system_events(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_system_events_level ON system_events(level,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_system_events_path ON system_events(path,created_at DESC);

INSERT INTO system_settings(key,value,description,updated_at)
VALUES ('presence.timeout_sec','300','عدد الثواني التي بعدها يعتبر مقدم الخدمة غير متصل إذا لم يرسل نبضة حياة',datetime('now'))
ON CONFLICT(key) DO NOTHING;
INSERT INTO system_settings(key,value,description,updated_at)
VALUES ('operations.acceptance_sla_sec','180','المدة التي بعدها يعتبر الطلب بانتظار القبول متأخرًا',datetime('now'))
ON CONFLICT(key) DO NOTHING;
INSERT INTO system_settings(key,value,description,updated_at)
VALUES ('operations.execution_sla_multiplier','2','معامل تقريبي للتنبيه عن الطلبات المتأخرة أثناء التنفيذ مقارنة بمهلة القبول',datetime('now'))
ON CONFLICT(key) DO NOTHING;

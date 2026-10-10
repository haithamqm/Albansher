-- V66.7: execution reliability, campaign routing/priority, compound tasks and smart timeline.
ALTER TABLE temporary_services ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE temporary_services ADD COLUMN request_flow TEXT NOT NULL DEFAULT 'SERVICE';
ALTER TABLE temporary_services ADD COLUMN action_value TEXT;
ALTER TABLE temporary_services ADD COLUMN target_capabilities_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS ix_temp_services_live_priority ON temporary_services(is_active,start_at,end_at,priority,sort_order);

CREATE TABLE IF NOT EXISTS order_tasks (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'GENERAL',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED')),
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,sequence_no)
);
CREATE INDEX IF NOT EXISTS ix_order_tasks_order ON order_tasks(order_id,sequence_no);

CREATE TABLE IF NOT EXISTS order_execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('CUSTOMER','PROVIDER','ADMIN','SYSTEM')),
  actor_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_execution_events_order ON order_execution_events(order_id,created_at,id);

CREATE TABLE IF NOT EXISTS provider_behavior_flags (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'REVIEW' CHECK(severity IN ('REVIEW','WARNING','CRITICAL')),
  count_value INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_behavior_flag ON provider_behavior_flags(provider_id,flag_type,status);
CREATE INDEX IF NOT EXISTS ix_provider_behavior_provider ON provider_behavior_flags(provider_id,status,last_seen_at DESC);
ALTER TABLE admin_campaigns ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_campaigns_live_priority ON admin_campaigns(is_active,start_at,end_at,priority,sort_order);

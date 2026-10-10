-- خدمات (Khadamat) — المخطط الأساسي. الأزمنة ISO-8601 UTC، المعرفات UUID، الحقول المرنة JSON (TEXT).

CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_i18n TEXT NOT NULL
);
INSERT INTO roles (id, code, name_i18n) VALUES
  (1, 'CUSTOMER', '{"ar":"عميل","en":"Customer"}'),
  (2, 'PROVIDER', '{"ar":"مقدم خدمة","en":"Service Provider"}'),
  (3, 'ADMIN',    '{"ar":"إدارة","en":"Admin"}');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  locale TEXT NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  avatar_file_id TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_users_role_status ON users(role_id, status);

CREATE TABLE admin_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  admin_level TEXT NOT NULL DEFAULT 'ADMIN' CHECK (admin_level IN ('SUPER_ADMIN','ADMIN','SUPPORT')),
  created_by TEXT REFERENCES users(id)
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_refresh_user ON refresh_tokens(user_id);
CREATE INDEX ix_refresh_family ON refresh_tokens(family_id);


CREATE TABLE files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('avatar','order_attachment','provider_document','work_photo','complaint_attachment','service_icon')),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_files_owner ON files(owner_id);

-- المناطق (شجرة)
CREATE TABLE service_areas (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES service_areas(id),
  name_i18n TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CITY' CHECK (type IN ('COUNTRY','CITY','DISTRICT')),
  center_lat REAL NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng REAL NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  radius_km REAL NOT NULL DEFAULT 25 CHECK (radius_km > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_areas_parent ON service_areas(parent_id);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m REAL,
  address_text TEXT,
  area_id TEXT REFERENCES service_areas(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('gps','map','manual')),
  created_at TEXT NOT NULL
);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_addresses_user ON addresses(user_id);

-- الكتالوج الديناميكي
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES categories(id),
  slug TEXT NOT NULL UNIQUE,
  name_i18n TEXT NOT NULL,
  description_i18n TEXT,
  icon TEXT,
  keywords TEXT NOT NULL DEFAULT '[]',
  module_type TEXT NOT NULL DEFAULT 'STANDARD',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_categories_parent ON categories(parent_id, sort_order);

CREATE TABLE cancellation_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  free_until_status TEXT NOT NULL DEFAULT 'ASSIGNED',
  allowed_until_status TEXT NOT NULL DEFAULT 'ON_THE_WAY',
  fee_percent REAL NOT NULL DEFAULT 0 CHECK (fee_percent BETWEEN 0 AND 100)
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  slug TEXT NOT NULL UNIQUE,
  name_i18n TEXT NOT NULL,
  description_i18n TEXT,
  icon TEXT,
  keywords TEXT NOT NULL DEFAULT '[]',
  pricing_type TEXT NOT NULL CHECK (pricing_type IN ('FIXED','QUOTE')),
  base_price REAL CHECK (base_price IS NULL OR base_price >= 0),
  form_schema TEXT NOT NULL DEFAULT '[]',
  cancellation_policy_id TEXT REFERENCES cancellation_policies(id),
  default_priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (default_priority IN ('LOW','NORMAL','URGENT')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (pricing_type = 'QUOTE' OR base_price IS NOT NULL)
);
CREATE INDEX ix_services_category ON services(category_id, is_active, sort_order);

-- مقدمو الخدمات
CREATE TABLE service_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('INDIVIDUAL','TECHNICIAN','DRIVER','WORKER','COMPANY')),
  display_name TEXT NOT NULL,
  bio TEXT,
  company_name TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verified_at TEXT,
  verified_by TEXT REFERENCES users(id),
  rejection_reason TEXT,
  suspension_reason TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  base_lat REAL, base_lng REAL,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  completed_orders_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_providers_status ON service_providers(verification_status, is_online);

CREATE TABLE provider_documents (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('ID','LICENSE','COMMERCIAL_REG','CERTIFICATE','PHOTO_WORK')),
  file_id TEXT NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_docs_provider ON provider_documents(provider_id, doc_type);

CREATE TABLE provider_services (
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id),
  custom_price REAL CHECK (custom_price IS NULL OR custom_price >= 0),
  experience_years INTEGER NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_id, service_id)
);
CREATE INDEX ix_pservices_service ON provider_services(service_id, is_active);

CREATE TABLE provider_service_areas (
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES service_areas(id),
  PRIMARY KEY (provider_id, area_id)
);
CREATE INDEX ix_pareas_area ON provider_service_areas(area_id);

CREATE TABLE provider_availability (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1,
  CHECK (start_time < end_time)
);
CREATE INDEX ix_avail_provider ON provider_availability(provider_id, weekday);

CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- الطلبات
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES users(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  provider_id TEXT REFERENCES service_providers(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS','COMPLETED','CANCELLED','DISPUTED')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','URGENT')),
  description TEXT NOT NULL,
  form_data TEXT NOT NULL DEFAULT '{}',
  location_id TEXT NOT NULL REFERENCES locations(id),
  area_id TEXT NOT NULL REFERENCES service_areas(id),
  contact_phone TEXT NOT NULL,
  scheduled_at TEXT,
  pricing_type TEXT NOT NULL CHECK (pricing_type IN ('FIXED','QUOTE')),
  price_snapshot REAL,
  agreed_price REAL,
  currency TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'CASH' CHECK (payment_method IN ('CASH','WALLET','CARD','BANK_TRANSFER','CREDIT')),
  customer_notes TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  cancelled_by_role TEXT,
  cancel_reason TEXT,
  cancellation_fee REAL,
  wave INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT, started_at TEXT, completed_at TEXT, cancelled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX ix_orders_provider ON orders(provider_id, status);
CREATE INDEX ix_orders_status ON orders(status, created_at DESC);
CREATE INDEX ix_orders_service_area ON orders(service_id, area_id, status);
CREATE UNIQUE INDEX ux_orders_idem ON orders(customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('CUSTOMER','PROVIDER','ADMIN','SYSTEM')),
  reason TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_history_order ON order_status_history(order_id, id);

CREATE TABLE order_assignments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  status TEXT NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED','ACCEPTED','REJECTED','EXPIRED','WITHDRAWN')),
  wave INTEGER NOT NULL DEFAULT 1,
  score REAL,
  distance_km REAL,
  offered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE (order_id, provider_id)
);
CREATE INDEX ix_assign_provider ON order_assignments(provider_id, status, expires_at);
CREATE INDEX ix_assign_order ON order_assignments(order_id, status);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  amount REAL NOT NULL CHECK (amount >= 0),
  message TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, provider_id)
);
CREATE INDEX ix_quotes_order ON quotes(order_id, status);

-- بنية الدفع (مفعّل: CASH فقط في MVP)
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_payments_order ON payments(order_id);

CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ratings_provider ON ratings(provider_id, created_at DESC);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  rating_id TEXT NOT NULL UNIQUE REFERENCES ratings(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE','HIDDEN')),
  created_at TEXT NOT NULL
);

CREATE TABLE customer_ratings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_custratings_customer ON customer_ratings(customer_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  data TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_notif_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE complaints (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  against_user_id TEXT REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('QUALITY','BEHAVIOR','PRICE','NO_SHOW','DAMAGE','OTHER')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PROVIDER_REPLIED','UNDER_REVIEW','RESOLVED','REJECTED','CLOSED')),
  resolution_action TEXT CHECK (resolution_action IN ('RESTORE_COMPLETED','CANCEL_ORDER','WARN_PROVIDER','SUSPEND_PROVIDER','DISMISS')),
  resolution_note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_complaints_status ON complaints(status, created_at DESC);
CREATE INDEX ix_complaints_order ON complaints(order_id);
CREATE UNIQUE INDEX ux_complaint_active ON complaints(order_id) WHERE status NOT IN ('RESOLVED','REJECTED','CLOSED');

CREATE TABLE complaint_messages (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_cmsg_complaint ON complaint_messages(complaint_id, created_at);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before TEXT,
  after TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX ix_audit_actor ON audit_logs(actor_id, created_at);
CREATE INDEX ix_audit_created ON audit_logs(created_at DESC);

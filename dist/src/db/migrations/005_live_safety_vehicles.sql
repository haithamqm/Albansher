CREATE TABLE IF NOT EXISTS provider_vehicles (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL DEFAULT 'MOTORCYCLE', make TEXT, model TEXT, year INTEGER, color TEXT, plate_number TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verified_at TEXT, verified_by TEXT REFERENCES users(id), rejection_reason TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_provider_vehicles_provider ON provider_vehicles(provider_id,is_active,status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_vehicle_plate ON provider_vehicles(plate_number) WHERE plate_number IS NOT NULL AND plate_number <> '';
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES provider_vehicles(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('REGISTRATION','INSURANCE','PHOTO')), file_id TEXT NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')), reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vehicle_docs ON vehicle_documents(vehicle_id,doc_type);
CREATE TABLE IF NOT EXISTS provider_live_locations (
  provider_id TEXT PRIMARY KEY REFERENCES service_providers(id) ON DELETE CASCADE,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180), accuracy_m REAL, heading REAL, speed_mps REAL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_location_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, provider_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy_m REAL, heading REAL, speed_mps REAL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trip_location_history ON trip_location_history(order_id,created_at);
CREATE TABLE IF NOT EXISTS trip_shares (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS safety_centers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, phone TEXT, emergency_phone TEXT, lat REAL NOT NULL, lng REAL NOT NULL, address_text TEXT,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_safety_centers_active ON safety_centers(is_active);
INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at)
SELECT lower(hex(randomblob(16))),c.id,'custom-request','{"ar":"طلب خدمة أخرى","en":"Custom service request"}','{"ar":"اطلب أي خدمة غير موجودة في القائمة مع وصف وصورة اختيارية","en":"Request any service not listed, with description and optional image"}','✨','["أخرى","خدمة أخرى","طلب خاص","غير موجودة"]','QUOTE',NULL,'[]','NORMAL',999,1,datetime('now'),datetime('now')
FROM categories c WHERE c.slug='delivery' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='custom-request') LIMIT 1;

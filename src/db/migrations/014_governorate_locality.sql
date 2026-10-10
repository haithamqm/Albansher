-- V66.2: add Yemen governorate as a first-class locality level.
PRAGMA foreign_keys=OFF;
CREATE TABLE service_areas_v014 (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES service_areas_v014(id),
  name_i18n TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CITY' CHECK (type IN ('COUNTRY','CITY','DISTRICT')),
  locality_type TEXT NOT NULL DEFAULT 'DISTRICT' CHECK (locality_type IN ('COUNTRY','GOVERNORATE','CITY','DISTRICT','DIRECTORATE','ISOLATION','VILLAGE','NEIGHBORHOOD')),
  center_lat REAL NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng REAL NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  radius_km REAL NOT NULL DEFAULT 25 CHECK (radius_km > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO service_areas_v014(id,parent_id,name_i18n,type,locality_type,center_lat,center_lng,radius_km,is_active,created_at,updated_at)
SELECT id,parent_id,name_i18n,type,locality_type,center_lat,center_lng,radius_km,is_active,created_at,updated_at FROM service_areas;
DROP TABLE service_areas;
ALTER TABLE service_areas_v014 RENAME TO service_areas;
CREATE INDEX IF NOT EXISTS ix_areas_parent ON service_areas(parent_id);
CREATE INDEX IF NOT EXISTS ix_areas_locality_parent ON service_areas(locality_type, parent_id, is_active);
PRAGMA foreign_keys=ON;

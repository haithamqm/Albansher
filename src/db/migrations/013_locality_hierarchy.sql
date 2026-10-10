-- V66: locality hierarchy for Yemen: directorate, isolation, village, neighborhood.
ALTER TABLE service_areas ADD COLUMN locality_type TEXT NOT NULL DEFAULT 'DISTRICT' CHECK (locality_type IN ('COUNTRY','CITY','DISTRICT','DIRECTORATE','ISOLATION','VILLAGE','NEIGHBORHOOD'));
UPDATE service_areas SET locality_type = type WHERE locality_type='DISTRICT';
CREATE INDEX IF NOT EXISTS ix_areas_locality_parent ON service_areas(locality_type, parent_id, is_active);

-- V63: optional location, seasonal services, request-linked location messages.
-- Additive migration: preserves all existing rows and features.
ALTER TABLE services ADD COLUMN seasonal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN season_start_at TEXT;
ALTER TABLE services ADD COLUMN season_end_at TEXT;
ALTER TABLE orders ADD COLUMN location_provided INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_messages ADD COLUMN location_lat REAL;
ALTER TABLE order_messages ADD COLUMN location_lng REAL;
ALTER TABLE order_messages ADD COLUMN location_accuracy_m REAL;
ALTER TABLE order_messages ADD COLUMN location_address_text TEXT;

CREATE INDEX IF NOT EXISTS ix_services_season ON services(seasonal_enabled, season_start_at, season_end_at, is_active);
CREATE INDEX IF NOT EXISTS ix_orders_location_provided ON orders(location_provided, status);


INSERT OR IGNORE INTO locations(id,lat,lng,accuracy_m,address_text,area_id,source,created_at)
VALUES('no-location',0,0,NULL,'لم يحدد العميل موقعًا بعد',NULL,'manual',datetime('now'));

-- Rural/seasonal catalog entries are created once but remain hidden until an admin sets a season window.
INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at)
SELECT lower(hex(randomblob(16))), c.id, 'seasonal-harvest', '{"ar":"الحصاد","en":"Harvesting"}', '{"ar":"عمالة موسمية للحصاد حسب الموسم الذي تحدده الإدارة","en":"Seasonal harvesting labor"}', '🌾', '["حصاد","حصد","محصول","محاصيل","حصيدة","موسم الحصاد"]', 'QUOTE', NULL, '[]', 'NORMAL', 200, 1, datetime('now'), datetime('now'), 1, 0, 0, 'NONE', 1, NULL, NULL
FROM categories c WHERE c.slug='on-demand-labor' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='seasonal-harvest') LIMIT 1;

INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at)
SELECT lower(hex(randomblob(16))), c.id, 'seasonal-plowing', '{"ar":"حرث وتجهيز الأرض","en":"Seasonal plowing"}', '{"ar":"حرث وتجهيز الأرض في الموسم الزراعي","en":"Seasonal land plowing and preparation"}', '🚜', '["حرث","حراثة","تلم","بتلة","تجهيز الأرض","حرث الأرض"]', 'QUOTE', NULL, '[]', 'NORMAL', 201, 1, datetime('now'), datetime('now'), 1, 1, 0, 'NONE', 1, NULL, NULL
FROM categories c WHERE c.slug='on-demand-labor' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='seasonal-plowing') LIMIT 1;

INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at)
SELECT lower(hex(randomblob(16))), c.id, 'seasonal-crop-transport', '{"ar":"نقل المحصول","en":"Crop transport"}', '{"ar":"نقل المحاصيل من المزرعة إلى السوق أو المخزن أو المدينة","en":"Transport crops from farms to markets, storage or cities"}', '🚚', '["نقل محصول","محصول","محاصيل","مزرعة","سوق","مخزن","نقل زراعي"]', 'QUOTE', NULL, '[]', 'NORMAL', 202, 1, datetime('now'), datetime('now'), 1, 1, 0, 'NONE', 1, NULL, NULL
FROM categories c WHERE c.slug='transport' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='seasonal-crop-transport') LIMIT 1;

INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at)
SELECT lower(hex(randomblob(16))), c.id, 'pharmacy-purchase', '{"ar":"شراء وإحضار دواء","en":"Pharmacy purchase and delivery"}', '{"ar":"شراء دواء من الصيدلية وإحضاره إلى المستفيد حسب وصف العميل","en":"Purchase medicine from a pharmacy and deliver it"}', '💊', '["دواء","دواء من الصيدلية","صيدلية","علاج","دوا","ادوية","دواء ويوصله"]', 'QUOTE', NULL, '[{"key":"medicine","type":"textarea","label":{"ar":"اسم الدواء أو الوصف","en":"Medicine"},"required":true},{"key":"quantity","type":"number","label":{"ar":"الكمية","en":"Quantity"},"min":1,"max":50},{"key":"max_price","type":"number","label":{"ar":"الحد الأقصى للسعر","en":"Maximum price"},"min":0},{"key":"alternatives","type":"textarea","label":{"ar":"البدائل المقبولة","en":"Accepted alternatives"}}]', 'NORMAL', 110, 1, datetime('now'), datetime('now'), 0, 1, 0, 'PIN', 0, NULL, NULL
FROM categories c WHERE c.slug='delivery' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='pharmacy-purchase') LIMIT 1;

INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at)
SELECT lower(hex(randomblob(16))), c.id, 'purchase-and-delivery', '{"ar":"شراء وإحضار غرض","en":"Buy and deliver an item"}', '{"ar":"شراء غرض من متجر أو سوق وإحضاره إلى المكان المطلوب","en":"Purchase an item from a store or market and deliver it"}', '🛒', '["اشتر لي","اشتري لي","شراء وإحضار","جيب لي","يجيب لي غرض","غرض من السوق","غرض من المدينة","شراء غرض"]', 'QUOTE', NULL, '[{"key":"item","type":"textarea","label":{"ar":"الغرض المطلوب","en":"Item"},"required":true},{"key":"quantity","type":"number","label":{"ar":"الكمية","en":"Quantity"},"min":1,"max":100},{"key":"max_price","type":"number","label":{"ar":"الحد الأقصى للسعر","en":"Maximum price"},"min":0},{"key":"alternatives","type":"textarea","label":{"ar":"البدائل المقبولة","en":"Accepted alternatives"}}]', 'NORMAL', 111, 1, datetime('now'), datetime('now'), 0, 1, 0, 'PIN', 0, NULL, NULL
FROM categories c WHERE c.slug='delivery' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='purchase-and-delivery') LIMIT 1;

-- V66.8: explicit shopping service + supervised intent analysis payload.
-- Additive migration only: preserves all existing rows and orders.
ALTER TABLE intent_audit ADD COLUMN analysis_json TEXT;
CREATE INDEX IF NOT EXISTS ix_intent_audit_parser_source ON intent_audit(parser_source,created_at DESC);
INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,cancellation_policy_id,default_priority,sort_order,is_active,created_at,updated_at,requires_vehicle,delivery_proof_type)
SELECT lower(hex(randomblob(16))), c.id, 'shopping-for-me',
       '{"ar":"تسوق لي","en":"Shop for me"}',
       '{"ar":"تسوق بالنيابة عنك وشراء الأغراض من المتجر أو البقالة أو السوق أو الصيدلية ثم إحضارها إليك","en":"Shop on your behalf and deliver the requested items"}',
       '🛍️',
       '["تسوق لي","تسوق عني","اشتر لي","اشترِ لي","اشتر لي بدلي","اشترِ بدلي","شراء بالنيابة","جيب لي غرض","تسوق","شراء غرض"]',
       'QUOTE', NULL,
       '[{"key":"shopping_type","type":"select","label":{"ar":"نوع التسوق","en":"Shopping type"},"required":false,"options":[{"value":"STORE","label":{"ar":"التسوق من متجر","en":"Store shopping"}},{"value":"GROCERY","label":{"ar":"التسوق من بقالة","en":"Grocery"}},{"value":"MARKET","label":{"ar":"التسوق من سوق","en":"Market"}},{"value":"PHARMACY","label":{"ar":"التسوق من صيدلية","en":"Pharmacy"}},{"value":"SPECIFIC_STORE","label":{"ar":"من محل معين","en":"Specific store"}},{"value":"ITEM","label":{"ar":"شراء غرض محدد","en":"Specific item"}},{"value":"OTHER","label":{"ar":"آخر","en":"Other"}}]},{"key":"items","type":"textarea","label":{"ar":"ما الذي تريد شراءه؟","en":"Items"},"required":true},{"key":"store","type":"text","label":{"ar":"اسم المتجر أو المحل","en":"Store"},"required":false},{"key":"quantity","type":"number","label":{"ar":"الكمية","en":"Quantity"},"required":false,"min":1,"max":100},{"key":"max_price","type":"number","label":{"ar":"الحد الأقصى للسعر","en":"Maximum price"},"required":false,"min":0},{"key":"alternatives","type":"textarea","label":{"ar":"البدائل المقبولة","en":"Accepted alternatives"},"required":false}]',
       'default','NORMAL',112,1,datetime('now'),datetime('now'),1,'PIN'
FROM categories c WHERE c.slug='delivery' AND NOT EXISTS(SELECT 1 FROM services WHERE slug='shopping-for-me') LIMIT 1;

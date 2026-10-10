CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('customer','provider','admin')), is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
 name TEXT NOT NULL DEFAULT '', phone TEXT, email TEXT UNIQUE, password_hash TEXT,
 avatar_url TEXT, status TEXT NOT NULL DEFAULT 'active', email_verified BOOLEAN NOT NULL DEFAULT FALSE,
 phone_verified BOOLEAN NOT NULL DEFAULT FALSE, must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_role_unique ON users(phone,role) WHERE phone IS NOT NULL;
CREATE TABLE IF NOT EXISTS provider_profiles (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 business_name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', vehicle_type TEXT NOT NULL DEFAULT '',
 vehicle_plate TEXT NOT NULL DEFAULT '', vehicle_description TEXT NOT NULL DEFAULT '',
 service_radius_km NUMERIC NOT NULL DEFAULT 35, availability TEXT NOT NULL DEFAULT 'offline',
 approved_at TIMESTAMPTZ, approved_by BIGINT REFERENCES users(id), rejection_reason TEXT,
 current_lat NUMERIC, current_lng NUMERIC, location_accuracy NUMERIC, location_updated_at TIMESTAMPTZ,
 rating_avg NUMERIC NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0,
 completed_count INTEGER NOT NULL DEFAULT 0, accepted_count INTEGER NOT NULL DEFAULT 0,
 rejected_count INTEGER NOT NULL DEFAULT 0, timeout_count INTEGER NOT NULL DEFAULT 0,
 response_seconds_avg NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS provider_documents (
 id BIGSERIAL PRIMARY KEY, provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 document_type TEXT NOT NULL, file_path TEXT NOT NULL, original_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', review_note TEXT, reviewed_by BIGINT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS services (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'vehicle', description TEXT NOT NULL DEFAULT '',
 pricing_mode TEXT NOT NULL DEFAULT 'quote' CHECK(pricing_mode IN ('fixed','distance','quote')),
 base_price NUMERIC NOT NULL DEFAULT 0, per_km_price NUMERIC NOT NULL DEFAULT 0, needs_location BOOLEAN NOT NULL DEFAULT TRUE,
 needs_equipment BOOLEAN NOT NULL DEFAULT FALSE, needs_qualification BOOLEAN NOT NULL DEFAULT FALSE,
 mobile_enabled BOOLEAN NOT NULL DEFAULT TRUE, shop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS provider_services (
 provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
 experience_note TEXT NOT NULL DEFAULT '', equipment_note TEXT NOT NULL DEFAULT '', approved BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY(provider_id, service_id)
);
CREATE TABLE IF NOT EXISTS vehicle_types (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS branches (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 lat NUMERIC, lng NUMERIC, opening_hours TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('tire','oil','battery','other')),
 brand TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 specs JSONB NOT NULL DEFAULT '{}'::jsonb, condition TEXT NOT NULL DEFAULT 'new', sale_price NUMERIC NOT NULL DEFAULT 0,
 cost_price NUMERIC NOT NULL DEFAULT 0, stock_qty INTEGER NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 3,
 branch_id BIGINT REFERENCES branches(id), active BOOLEAN NOT NULL DEFAULT TRUE, image_url TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customer_vehicles (
 id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vehicle_type TEXT NOT NULL DEFAULT '', make_model TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '',
 tire_spec TEXT NOT NULL DEFAULT '', plate TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY, order_code TEXT NOT NULL UNIQUE, idempotency_key TEXT UNIQUE, customer_id BIGINT NOT NULL REFERENCES users(id), branch_id BIGINT REFERENCES branches(id), requested_at TIMESTAMPTZ,
 service_id BIGINT REFERENCES services(id), service_name TEXT NOT NULL DEFAULT '', service_mode TEXT NOT NULL DEFAULT 'mobile',
 vehicle_type TEXT NOT NULL DEFAULT '', vehicle_make_model TEXT NOT NULL DEFAULT '', tire_spec TEXT NOT NULL DEFAULT '',
 issue_description TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '',
 customer_lat NUMERIC, customer_lng NUMERIC, location_text TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'new', dispatch_status TEXT NOT NULL DEFAULT 'pending',
 assigned_provider_id BIGINT REFERENCES users(id), estimated_minutes NUMERIC, estimated_distance_km NUMERIC, price_quote NUMERIC, travel_fee NUMERIC NOT NULL DEFAULT 0,
 final_price NUMERIC, quote_status TEXT NOT NULL DEFAULT 'not_required', quote_note TEXT NOT NULL DEFAULT '', quote_sent_at TIMESTAMPTZ, payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT NOT NULL DEFAULT 'cash', stock_reserved BOOLEAN NOT NULL DEFAULT FALSE, stock_committed BOOLEAN NOT NULL DEFAULT FALSE, cancellation_reason TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ, en_route_at TIMESTAMPTZ,
 arrived_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_items (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id BIGINT REFERENCES products(id), item_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
 unit_price NUMERIC NOT NULL DEFAULT 0, unit_cost NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dispatch_offers (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 provider_id BIGINT NOT NULL REFERENCES users(id), rank_position INTEGER NOT NULL DEFAULT 1,
 score NUMERIC NOT NULL DEFAULT 0, estimated_minutes NUMERIC, estimated_distance_km NUMERIC, status TEXT NOT NULL DEFAULT 'sent',
 sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
 responded_at TIMESTAMPTZ, response_note TEXT, UNIQUE(order_id, provider_id)
);
CREATE INDEX IF NOT EXISTS dispatch_offer_pending_idx ON dispatch_offers(status, expires_at);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id, created_at DESC);
CREATE TABLE IF NOT EXISTS order_events (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 actor_id BIGINT REFERENCES users(id), event_type TEXT NOT NULL, from_status TEXT, to_status TEXT,
 note TEXT NOT NULL DEFAULT '', metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id), body TEXT NOT NULL DEFAULT '', attachment_url TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS complaints (
 id BIGSERIAL PRIMARY KEY, complaint_code TEXT NOT NULL UNIQUE, order_id BIGINT NOT NULL REFERENCES orders(id),
 customer_id BIGINT NOT NULL REFERENCES users(id), provider_id BIGINT REFERENCES users(id), category TEXT NOT NULL,
 description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', outcome TEXT NOT NULL DEFAULT '',
 assigned_admin_id BIGINT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS complaint_messages (
 id BIGSERIAL PRIMARY KEY, complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id), audience TEXT NOT NULL CHECK(audience IN ('customer','provider','internal')),
 body TEXT NOT NULL, attachment_url TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ratings (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id), customer_id BIGINT NOT NULL REFERENCES users(id),
 provider_id BIGINT NOT NULL REFERENCES users(id), score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), comment TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS location_history (
 id BIGSERIAL PRIMARY KEY, provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL, lat NUMERIC NOT NULL, lng NUMERIC NOT NULL,
 accuracy NUMERIC, speed NUMERIC, heading NUMERIC, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS location_history_order_idx ON location_history(order_id, recorded_at);
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by BIGINT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id BIGSERIAL PRIMARY KEY, actor_id BIGINT REFERENCES users(id), action TEXT NOT NULL,
 entity_type TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
 details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promotions (
 id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 image_url TEXT NOT NULL DEFAULT '', link_url TEXT NOT NULL DEFAULT '', cta_text TEXT NOT NULL DEFAULT '',
 start_at TIMESTAMPTZ, end_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE,
 sort_order INTEGER NOT NULL DEFAULT 0, created_by BIGINT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS promotions_active_dates_idx ON promotions(active,start_at,end_at,sort_order);

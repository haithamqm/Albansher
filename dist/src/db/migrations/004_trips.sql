-- نظام المشاوير بالدباب: وجهة ثانية + تسعير محفوظ لكل مشوار
CREATE TABLE trip_orders (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  destination_location_id TEXT NOT NULL REFERENCES locations(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('PASSENGER','ITEM_PURCHASE','MEDICINE','PARCEL','OTHER')),
  purpose_note TEXT,
  distance_km REAL NOT NULL CHECK (distance_km >= 0),
  base_fare REAL NOT NULL CHECK (base_fare >= 0),
  per_km_fare REAL NOT NULL CHECK (per_km_fare >= 0),
  minimum_fare REAL NOT NULL CHECK (minimum_fare >= 0),
  fare REAL NOT NULL CHECK (fare >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_trip_destination ON trip_orders(destination_location_id);

PRAGMA foreign_keys=OFF;
CREATE TABLE trip_orders_new (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  destination_location_id TEXT NOT NULL REFERENCES locations(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('PASSENGER','ITEM_PURCHASE','MEDICINE','PARCEL','RESTAURANT_PICKUP','DOCUMENT_DELIVERY','TECHNICIAN_PICKUP','STORE_SHOPPING','SMALL_CARGO','HOME_PICKUP','OTHER')),
  purpose_note TEXT,
  distance_km REAL NOT NULL CHECK(distance_km >= 0),
  base_fare REAL NOT NULL CHECK(base_fare >= 0),
  per_km_fare REAL NOT NULL CHECK(per_km_fare >= 0),
  minimum_fare REAL NOT NULL CHECK(minimum_fare >= 0),
  fare REAL NOT NULL CHECK(fare >= 0),
  currency TEXT NOT NULL,
  waiting_per_minute_fare REAL NOT NULL DEFAULT 0,
  waiting_total_minutes REAL NOT NULL DEFAULT 0,
  purchase_max_price REAL,
  purchase_quantity INTEGER,
  purchase_alternatives TEXT,
  purchase_requires_approval INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO trip_orders_new(order_id,destination_location_id,purpose,purpose_note,distance_km,base_fare,per_km_fare,minimum_fare,fare,currency,waiting_per_minute_fare,waiting_total_minutes,purchase_max_price,purchase_quantity,purchase_alternatives,purchase_requires_approval,created_at,updated_at)
SELECT order_id,destination_location_id,purpose,purpose_note,distance_km,base_fare,per_km_fare,minimum_fare,fare,currency,waiting_per_minute_fare,waiting_total_minutes,purchase_max_price,purchase_quantity,purchase_alternatives,purchase_requires_approval,created_at,updated_at FROM trip_orders;
DROP TABLE trip_orders;
ALTER TABLE trip_orders_new RENAME TO trip_orders;
CREATE INDEX ix_trip_destination ON trip_orders(destination_location_id);
PRAGMA foreign_keys=ON;

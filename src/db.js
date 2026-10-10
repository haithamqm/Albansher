import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const railwayVolumeAvailable = fs.existsSync('/data');
const defaultDbPath = railwayVolumeAvailable ? '/data/ban-shar.db' : './data/ban-shar.db';
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE, email TEXT UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','provider','admin')),
 status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS provider_profiles (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 region TEXT, services_json TEXT NOT NULL DEFAULT '[]', availability TEXT NOT NULL DEFAULT 'offline',
 approved INTEGER NOT NULL DEFAULT 0, bio TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS provider_documents (
 id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 doc_type TEXT NOT NULL CHECK(doc_type IN ('identity','license')), original_name TEXT NOT NULL,
 stored_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(provider_id,doc_type)
);
CREATE TABLE IF NOT EXISTS services (
 id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT NOT NULL, description_ar TEXT DEFAULT '',
 description_en TEXT DEFAULT '', category TEXT NOT NULL DEFAULT 'general', pricing_type TEXT NOT NULL DEFAULT 'quote',
 price REAL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT NOT NULL, description_ar TEXT DEFAULT '',
 description_en TEXT DEFAULT '', category TEXT NOT NULL DEFAULT 'other', brand TEXT DEFAULT '', specs TEXT DEFAULT '',
 price REAL NOT NULL DEFAULT 0, old_price REAL, stock INTEGER NOT NULL DEFAULT 0, image_url TEXT DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS offers (
 id INTEGER PRIMARY KEY, title_ar TEXT NOT NULL, title_en TEXT NOT NULL, description_ar TEXT DEFAULT '',
 description_en TEXT DEFAULT '', image_url TEXT DEFAULT '', product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
 price REAL, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, order_code TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES users(id),
 provider_id INTEGER REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('service','product')),
 service_id INTEGER REFERENCES services(id), product_id INTEGER REFERENCES products(id), quantity INTEGER NOT NULL DEFAULT 1,
 description TEXT NOT NULL, latitude REAL, longitude REAL, location_text TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
 price_quote REAL, quote_status TEXT NOT NULL DEFAULT 'none', payment_status TEXT NOT NULL DEFAULT 'unpaid', stock_reserved INTEGER NOT NULL DEFAULT 0,
 cancel_reason TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_events (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 actor_id INTEGER REFERENCES users(id), from_status TEXT, to_status TEXT NOT NULL, note TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), customer_id INTEGER NOT NULL REFERENCES users(id),
 provider_id INTEGER REFERENCES users(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS complaints (
 id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), customer_id INTEGER NOT NULL REFERENCES users(id),
 subject TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', admin_reply TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL,
 entity_id TEXT, details TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS branches (
 id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT NOT NULL, address TEXT DEFAULT '',
 latitude REAL, longitude REAL, hours_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vehicle_types (
 id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE, name_en TEXT NOT NULL UNIQUE,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', entity_type TEXT DEFAULT '', entity_id TEXT DEFAULT '',
 read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id);
CREATE TABLE IF NOT EXISTS idempotency_keys (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_key TEXT NOT NULL,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id, request_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, id);
`);

const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!orderColumns.includes('stock_reserved')) db.exec('ALTER TABLE orders ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0');

const seedServices = [
 ['إصلاح بنشر متنقل','Mobile tire repair','إصلاح الإطار في موقعك','Repair a tire at your location','tires','quote',null],
 ['تغيير الإطارات','Tire replacement','تغيير إطار المركبة','Replace vehicle tires','tires','quote',null],
 ['تغيير زيت المحرك','Oil change','خدمة تغيير الزيت','Engine oil change service','maintenance','quote',null],
 ['خدمات البطاريات','Battery service','فحص البطارية أو استبدالها','Battery testing or replacement','battery','quote',null],
 ['مساعدة على الطريق','Roadside assistance','مساعدة عند تعطل المركبة','Help when your vehicle breaks down','roadside','quote',null],
 ['سطحة ونقل المركبات','Towing service','نقل المركبة إلى الموقع المطلوب','Transport your vehicle','towing','quote',null]
];
const addService = db.prepare('INSERT INTO services (name_ar,name_en,description_ar,description_en,category,pricing_type,price) VALUES (?,?,?,?,?,?,?)');
for (const row of seedServices) if (!db.prepare('SELECT 1 FROM services WHERE name_ar=?').get(row[0])) addService.run(...row);
const defaultSettings = {app_name:'البنشر الذكي', tagline:'خدمات مركبتك تصلك أينما كنت', currency:'YER', support_whatsapp:'', support_email:'', theme:'system'};
const putSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [k,v] of Object.entries(defaultSettings)) putSetting.run(k, String(v));

const seedVehicles = [['سيارة','Car'],['دراجة نارية','Motorcycle'],['شاحنة','Truck'],['حافلة','Bus'],['مركبة أخرى','Other vehicle']];
const addVehicle = db.prepare('INSERT OR IGNORE INTO vehicle_types(name_ar,name_en) VALUES (?,?)');
for (const row of seedVehicles) addVehicle.run(...row);

-- تسجيل العملاء والتحقق من الحساب عبر واتساب فقط.
CREATE TABLE whatsapp_otp_challenges (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_whatsapp_otp_phone_created ON whatsapp_otp_challenges(phone, created_at);

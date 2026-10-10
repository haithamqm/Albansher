-- V66.4: supervised intent/assistant audit trail. This is evidence/feedback only; it never self-trains.
CREATE TABLE IF NOT EXISTS intent_audit (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_session_id TEXT REFERENCES assistant_sessions(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  original_text TEXT NOT NULL,
  image_attached INTEGER NOT NULL DEFAULT 0,
  predicted_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  predicted_confidence REAL,
  parser_source TEXT,
  selected_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  selected_provider_id TEXT REFERENCES service_providers(id) ON DELETE SET NULL,
  assignment_result TEXT,
  outcome TEXT,
  correction_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  correction_note TEXT,
  corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  corrected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_intent_audit_customer_created ON intent_audit(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_intent_audit_order ON intent_audit(order_id);
CREATE INDEX IF NOT EXISTS ix_intent_audit_unreviewed ON intent_audit(correction_service_id,created_at DESC);

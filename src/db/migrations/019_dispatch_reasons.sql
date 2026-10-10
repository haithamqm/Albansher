-- V66.5: explicit routing/response reasons for operational auditability.
ALTER TABLE order_assignments ADD COLUMN decision_reason TEXT;
CREATE INDEX IF NOT EXISTS ix_assign_reason ON order_assignments(order_id,status,decision_reason);

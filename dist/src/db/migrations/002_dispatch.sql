-- 002: دعم الإسناد المتعدد الموجات وانتهاء المهل
ALTER TABLE orders ADD COLUMN search_exhausted_at TEXT;
CREATE INDEX ix_assign_expiry ON order_assignments(status, expires_at);
CREATE INDEX ix_quotes_expiry ON quotes(status, valid_until);

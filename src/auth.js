import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db } from './db.js';

// Keep the signing key stable across restarts without requiring a Railway variable.
function getJwtSecret() {
 if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
 let row = db.prepare("SELECT value FROM settings WHERE key='internal_jwt_secret'").get();
 if (!row) {
  const value = crypto.randomBytes(48).toString('base64url');
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('internal_jwt_secret',?)").run(value);
  row = db.prepare("SELECT value FROM settings WHERE key='internal_jwt_secret'").get();
 }
 return row.value;
}

export function hashPassword(password) { return bcrypt.hashSync(password, 12); }
export function verifyPassword(password, hash) { return bcrypt.compareSync(password, hash); }
export function createToken(user) {
 const secret = getJwtSecret();
 return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: '12h', issuer: 'albanshar-aldhaki' });
}
export function requireAuth(req, res, next) {
 const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
 if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول', code: 'AUTH_REQUIRED' });
 try {
  const payload = jwt.verify(token, getJwtSecret(), { issuer: 'albanshar-aldhaki' });
  const user = db.prepare('SELECT id,name,phone,email,role,status,must_change_password FROM users WHERE id=?').get(payload.sub);
  if (!user || (user.status !== 'active' && !(user.role === 'provider' && user.status === 'pending'))) return res.status(401).json({ error: 'الحساب غير متاح' });
  req.user = user; next();
 } catch { return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو منتهية' }); }
}
export function requireRole(...roles) { return (req,res,next) => { if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'ليست لديك صلاحية لهذه العملية' }); if (req.user.role === 'admin' && req.user.must_change_password && req.path !== '/api/admin/account' && !req.path.endsWith('/account')) return res.status(428).json({ error: 'يجب تغيير كلمة مرور المدير المؤقتة أولًا من قسم «تغيير بيانات حسابي الإداري».' }); return next(); }; }
export function audit(actorId, action, entityType, entityId = '', details = '') {
 db.prepare('INSERT INTO audit_log(actor_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)').run(actorId || null, action, entityType, String(entityId), String(details).slice(0,1000));
}

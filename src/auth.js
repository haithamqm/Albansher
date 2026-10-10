import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

export function hashPassword(password) { return bcrypt.hashSync(password, 12); }
export function verifyPassword(password, hash) { return bcrypt.compareSync(password, hash); }
export function createToken(user) {
 const secret = process.env.JWT_SECRET;
 if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters');
 return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: '12h', issuer: 'albanshar-aldhaki' });
}
export function requireAuth(req, res, next) {
 const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
 if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول', code: 'AUTH_REQUIRED' });
 try {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'albanshar-aldhaki' });
  const user = db.prepare('SELECT id,name,phone,email,role,status FROM users WHERE id=?').get(payload.sub);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'الحساب غير متاح' });
  req.user = user; next();
 } catch { return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو منتهية' }); }
}
export function requireRole(...roles) { return (req,res,next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'ليست لديك صلاحية لهذه العملية' }); }
export function audit(actorId, action, entityType, entityId = '', details = '') {
 db.prepare('INSERT INTO audit_log(actor_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)').run(actorId || null, action, entityType, String(entityId), String(details).slice(0,1000));
}

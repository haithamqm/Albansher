import { E } from '../core/errors.js';
import { verifyJwt } from '../core/security.js';
import type { Ctx } from '../core/http.js';
import type { AdminLevel, UserRow } from '../types/domain.js';

/** يستخرج المستخدم من Access Token ويتحقق من حالته في قاعدة البيانات في كل طلب (لا نثق بمحتوى التوكن وحده). */
export function auth(ctx: Ctx): void {
  const h = String(ctx.req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyJwt(token, ctx.app.config.jwtSecret, ctx.app.clock.now());
  if (!payload) throw E.unauthorized('جلسة غير صالحة أو منتهية', 'INVALID_TOKEN');
  const u = ctx.app.db.get<UserRow & { provider_id: string | null }>(
    `SELECT u.id, u.full_name, u.phone, u.email, u.status, u.locale, u.token_version, u.avatar_file_id, r.code AS role, au.admin_level, sp.id AS provider_id
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN admin_users au ON au.user_id = u.id
       LEFT JOIN service_providers sp ON sp.user_id = u.id WHERE u.id = ?`, payload.sub);
  if (!u || u.token_version !== payload.tv) throw E.unauthorized('جلسة غير صالحة أو منتهية', 'INVALID_TOKEN');
  if (u.status !== 'ACTIVE') throw E.forbidden('الحساب غير نشط', 'ACCOUNT_INACTIVE');
  ctx.user = { id: u.id, fullName: u.full_name, phone: u.phone, email: u.email, role: u.role, locale: u.locale, adminLevel: u.admin_level, providerId: u.provider_id, avatarFileId: u.avatar_file_id };
}

export const roles = (...allowed: string[]) => (ctx: Ctx): void => {
  if (!ctx.user) throw E.unauthorized();
  if (!allowed.includes(ctx.user.role)) throw E.forbidden();
};

const LEVEL_RANK: Record<AdminLevel, number> = { SUPPORT: 1, ADMIN: 2, SUPER_ADMIN: 3 };
/** الحد الأدنى لمستوى الإدارة: SUPPORT < ADMIN < SUPER_ADMIN */
export const adminLevel = (min: AdminLevel) => (ctx: Ctx): void => {
  if (!ctx.user || ctx.user.role !== 'ADMIN') throw E.forbidden();
  if (LEVEL_RANK[ctx.user.adminLevel as AdminLevel ?? 'SUPPORT'] < LEVEL_RANK[min]) throw E.forbidden('هذا الإجراء يتطلب صلاحية إدارية أعلى', 'INSUFFICIENT_ADMIN_LEVEL');
};

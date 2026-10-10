import { s, parse, type Schema } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import { locationSchema } from './locations.js';
import { serializeUser } from './auth.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';
import type { LocationRow } from '../types/domain.js';

interface AddressRow { id: string; user_id: string; label: string; location_id: string; is_default: 0 | 1; created_at: string }

export function registerUserRoutes(app: App, r: Router): void {
  const { db } = app;

  r.get('/me/profile', auth, (ctx: Ctx) => ({ user: serializeUser(app.authService.loadUser('u.id = ?', ctx.user!.id)) }));

  r.patch('/me/profile', auth, (ctx: Ctx) => {
    const b = parse<{ fullName?: string; email?: string; locale?: string; avatarFileId?: string }>(s.obj({
      fullName: s.str({ min: 2, max: 80, optional: true }),
      email: s.str({ max: 160, lower: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'بريد إلكتروني غير صالح', optional: true }),
      locale: s.oneOf(['ar', 'en'], { optional: true }),
      avatarFileId: s.str({ max: 64, optional: true }),
    }), ctx.body);
    return db.tx(() => {
      if (b.email && db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', b.email, ctx.user!.id)) throw E.conflict('البريد الإلكتروني مسجل مسبقًا', 'EMAIL_TAKEN');
      if (b.avatarFileId && !db.get(`SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND purpose = 'avatar'`, b.avatarFileId, ctx.user!.id)) throw E.unprocessable('ملف الصورة غير صالح', 'INVALID_FILE');
      db.run(`UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), locale = COALESCE(?, locale), avatar_file_id = COALESCE(?, avatar_file_id), updated_at = ? WHERE id = ?`,
        b.fullName ?? null, b.email ?? null, b.locale ?? null, b.avatarFileId ?? null, iso(app.clock.now()), ctx.user!.id);
      const out = { user: serializeUser(app.authService.loadUser('u.id = ?', ctx.user!.id)) }; app.sse.send(ctx.user!.id, 'sync', { scope: 'users' }); return out;
    });
  });

  const addrRow = (a: AddressRow, locale: Ctx['locale']) => ({ id: a.id, label: a.label, isDefault: !!a.is_default, location: app.locations.serialize(db.get<LocationRow>('SELECT * FROM locations WHERE id = ?', a.location_id)!, locale) });

  r.get('/me/addresses', auth, roles('CUSTOMER'), (ctx: Ctx) => ({
    addresses: db.all<AddressRow>('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', ctx.user!.id).map((a) => addrRow(a, ctx.locale)) }));

  const addrCreateSchema: Schema = s.obj({ label: s.str({ min: 1, max: 40 }), location: locationSchema, isDefault: s.bool({ optional: true, default: false }) });
  r.post('/me/addresses', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const b = parse<{ label: string; location: { lat: number; lng: number; accuracy?: number; addressText?: string; source?: string; areaId?: string }; isDefault: boolean }>(addrCreateSchema, ctx.body);
    return db.tx(() => {
      if ((db.get<{ c: number }>('SELECT COUNT(*) c FROM addresses WHERE user_id = ?', ctx.user!.id)?.c ?? 0) >= 20) throw E.unprocessable('وصلت للحد الأقصى من العناوين (20)', 'ADDRESS_LIMIT');
      const loc = app.locations.create(b.location);
      const id = uuid();
      const first = !db.get('SELECT 1 FROM addresses WHERE user_id = ?', ctx.user!.id);
      if (b.isDefault || first) db.run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', ctx.user!.id);
      db.run('INSERT INTO addresses(id,user_id,label,location_id,is_default,created_at) VALUES (?,?,?,?,?,?)', id, ctx.user!.id, b.label, loc.id, b.isDefault || first ? 1 : 0, iso(app.clock.now()));
      ctx.status = 201;
      const out = { address: addrRow(db.get<AddressRow>('SELECT * FROM addresses WHERE id = ?', id)!, ctx.locale) }; app.sse.send(ctx.user!.id, 'sync', { scope: 'addresses' }); return out;
    });
  });

  const addrUpdateSchema: Schema = s.obj({ label: s.str({ min: 1, max: 40, optional: true }), isDefault: s.bool({ optional: true }), location: { ...locationSchema, optional: true } as Schema });
  r.patch('/me/addresses/:id', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const b = parse<{ label?: string; isDefault?: boolean; location?: { lat: number; lng: number; accuracy?: number; addressText?: string; source?: string; areaId?: string } }>(addrUpdateSchema, ctx.body);
    return db.tx(() => {
      const a = db.get<AddressRow>('SELECT * FROM addresses WHERE id = ? AND user_id = ?', ctx.params['id'], ctx.user!.id);
      if (!a) throw E.notFound('العنوان غير موجود');
      if (b.location) { const loc = app.locations.create(b.location); db.run('UPDATE addresses SET location_id = ? WHERE id = ?', loc.id, a.id); }
      if (b.label) db.run('UPDATE addresses SET label = ? WHERE id = ?', b.label, a.id);
      if (b.isDefault) { db.run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', ctx.user!.id); db.run('UPDATE addresses SET is_default = 1 WHERE id = ?', a.id); }
      const out = { address: addrRow(db.get<AddressRow>('SELECT * FROM addresses WHERE id = ?', a.id)!, ctx.locale) }; app.sse.send(ctx.user!.id, 'sync', { scope: 'addresses' }); return out;
    });
  });

  r.delete('/me/addresses/:id', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const res = db.run('DELETE FROM addresses WHERE id = ? AND user_id = ?', ctx.params['id'], ctx.user!.id);
    if (!res.changes) throw E.notFound('العنوان غير موجود');
    app.sse.send(ctx.user!.id, 'sync', { scope: 'addresses' }); return undefined;
  });
}

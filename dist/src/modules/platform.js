import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import { auth, adminLevel } from './auth.middleware.js';
const I18N = s.obj({ ar: s.str({ min: 1, max: 120 }), en: s.str({ max: 120, optional: true }) });
/** إعدادات المنصة العامة + إدارة الإعدادات والمناطق (بيانات في DB، بلا مدن أو عملة مبرمجة). */
export function registerPlatformRoutes(app, r) {
    const { db, settings, catalog } = app;
    r.get('/config', () => {
        const locale = settings.get('platform.default_locale');
        return { country: settings.get('platform.country'), currency: settings.get('platform.currency'), timezone: settings.get('platform.timezone'),
            defaultLocale: locale, supportedLocales: ['ar', 'en'], direction: locale === 'ar' ? 'rtl' : 'ltr', mapProvider: app.config.mapProvider };
    });
    r.get('/admin/settings', auth, adminLevel('ADMIN'), () => ({ settings: settings.all() }));
    r.put('/admin/settings/:key', auth, adminLevel('SUPER_ADMIN'), (ctx) => {
        const key = ctx.params['key'];
        const before = settings.all().find((x) => x.key === key);
        if (!before)
            throw E.notFound('إعداد غير معروف', 'UNKNOWN_SETTING');
        const b = parse(s.obj({ value: s.any() }), ctx.body);
        return db.tx(() => {
            const value = settings.set(key, b.value, ctx.user.id);
            app.sse.broadcast('sync', { scope: 'settings' });
            app.audit.log({ ctx, action: 'settings.update', entityType: 'setting', entityId: key, before: { value: before.value }, after: { value } });
            return { key, value };
        });
    });
    const areaOut = (id, locale) => catalog.serializeArea(db.get('SELECT * FROM service_areas WHERE id = ?', id), locale, true);
    r.get('/admin/areas', auth, adminLevel('SUPPORT'), (ctx) => ({ areas: catalog.all().areas.map((a) => catalog.serializeArea(a, ctx.locale, true)) }));
    r.post('/admin/areas', auth, adminLevel('ADMIN'), (ctx) => {
        const b = parse(s.obj({
            name: I18N, type: s.oneOf(['COUNTRY', 'CITY', 'DISTRICT']), localityType: s.oneOf(['COUNTRY', 'GOVERNORATE', 'CITY', 'DISTRICT', 'DIRECTORATE', 'ISOLATION', 'VILLAGE', 'NEIGHBORHOOD'], { optional: true, default: 'DISTRICT' }), parentId: s.str({ max: 64, optional: true }),
            centerLat: s.num({ min: -90, max: 90 }), centerLng: s.num({ min: -180, max: 180 }), radiusKm: s.num({ min: 0.1, max: 5000, optional: true, default: 25 }),
        }), ctx.body);
        return db.tx(() => {
            if (b.parentId && !db.get('SELECT 1 FROM service_areas WHERE id = ?', b.parentId))
                throw E.unprocessable('المنطقة الأم غير موجودة', 'INVALID_PARENT');
            const id = uuid(), now = iso(app.clock.now());
            db.run('INSERT INTO service_areas(id,parent_id,name_i18n,type,locality_type,center_lat,center_lng,radius_km,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, b.parentId || null, JSON.stringify(b.name), b.type, b.localityType || b.type, b.centerLat, b.centerLng, b.radiusKm, now, now);
            catalog.invalidate();
            app.audit.log({ ctx, action: 'area.create', entityType: 'area', entityId: id, after: { name: b.name, type: b.type } });
            ctx.status = 201;
            return { area: areaOut(id, ctx.locale) };
        });
    });
    r.patch('/admin/areas/:id', auth, adminLevel('ADMIN'), (ctx) => {
        const b = parse(s.obj({
            name: { ...I18N, optional: true }, localityType: s.oneOf(['COUNTRY', 'GOVERNORATE', 'CITY', 'DISTRICT', 'DIRECTORATE', 'ISOLATION', 'VILLAGE', 'NEIGHBORHOOD'], { optional: true }), isActive: s.bool({ optional: true }), centerLat: s.num({ min: -90, max: 90, optional: true }),
            centerLng: s.num({ min: -180, max: 180, optional: true }), radiusKm: s.num({ min: 0.1, max: 5000, optional: true }),
        }), ctx.body);
        return db.tx(() => {
            const a = db.get('SELECT * FROM service_areas WHERE id = ?', ctx.params['id']);
            if (!a)
                throw E.notFound('المنطقة غير موجودة');
            db.run(`UPDATE service_areas SET name_i18n = COALESCE(?, name_i18n), locality_type = COALESCE(?, locality_type), is_active = COALESCE(?, is_active), center_lat = COALESCE(?, center_lat),
              center_lng = COALESCE(?, center_lng), radius_km = COALESCE(?, radius_km), updated_at = ? WHERE id = ?`, b.name ? JSON.stringify(b.name) : null, b.localityType || null, b.isActive === undefined ? null : (b.isActive ? 1 : 0), b.centerLat ?? null, b.centerLng ?? null, b.radiusKm ?? null, iso(app.clock.now()), a.id);
            catalog.invalidate();
            app.sse.broadcast('sync', { scope: 'catalog' });
            app.audit.log({ ctx, action: 'area.update', entityType: 'area', entityId: a.id, before: { isActive: !!a.is_active, radiusKm: a.radius_km }, after: b });
            return { area: areaOut(a.id, ctx.locale) };
        });
    });
}
//# sourceMappingURL=platform.js.map
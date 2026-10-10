import { s } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, tr } from '../core/util.js';
export const locationSchema = s.obj({
    lat: s.num({ min: -90, max: 90 }),
    lng: s.num({ min: -180, max: 180 }),
    accuracy: s.num({ min: 0, max: 100000, optional: true }),
    addressText: s.str({ max: 300, optional: true }),
    landmarkText: s.str({ max: 200, optional: true }),
    localityText: s.str({ max: 200, optional: true }),
    accessNotes: s.str({ max: 500, optional: true }),
    source: s.oneOf(['gps', 'map', 'manual'], { optional: true, default: 'manual' }),
    areaId: s.str({ max: 64, optional: true }),
});
export function createLocations(app) {
    const { db, catalog } = app;
    return {
        /** ينشئ الموقع ويحدد المنطقة على الخادم (لا نثق بـ areaId القادم من الواجهة إلا للتحقق منه). */
        create(input, { requireArea = false } = {}) {
            let areaId = null;
            if (input.areaId) {
                const a = catalog.all().areas.find((x) => x.id === input.areaId && x.is_active);
                if (!a)
                    throw E.unprocessable('المنطقة غير صالحة', 'INVALID_AREA');
                areaId = a.id;
            }
            else {
                areaId = catalog.resolveArea(input.lat, input.lng)?.id || null;
                if (!areaId && app.settings.get('platform.country') === 'YE') {
                    const fallback = db.get("SELECT id FROM service_areas WHERE id IN ('system-yemen','yemen-unmapped') AND is_active=1 ORDER BY CASE id WHEN 'system-yemen' THEN 0 ELSE 1 END LIMIT 1");
                    if (fallback)
                        areaId = fallback.id;
                    else {
                        const now = iso(app.clock.now());
                        db.run('INSERT OR IGNORE INTO service_areas(id,parent_id,name_i18n,type,center_lat,center_lng,radius_km,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', 'yemen-unmapped', null, '{"ar":"موقع يمني غير مصنف","en":"Unmapped Yemen location"}', 'COUNTRY', 15.55, 48.52, 1200, 1, now, now);
                        areaId = 'yemen-unmapped';
                        catalog.invalidate();
                    }
                }
            }
            const id = uuid();
            db.run('INSERT INTO locations(id,lat,lng,accuracy_m,address_text,landmark_text,locality_text,access_notes,area_id,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, input.lat, input.lng, input.accuracy ?? null, input.addressText ?? null, input.landmarkText ?? null, input.localityText ?? null, input.accessNotes ?? null, areaId, input.source || 'manual', iso(app.clock.now()));
            return db.get('SELECT * FROM locations WHERE id = ?', id);
        },
        serialize(l, locale = 'ar', { approximate = false } = {}) {
            const area = l.area_id ? catalog.all().areas.find((a) => a.id === l.area_id) : null;
            const rnd = (n) => (approximate ? Math.round(n * 100) / 100 : n);
            return { id: l.id, lat: rnd(l.lat), lng: rnd(l.lng), accuracy: approximate ? null : l.accuracy_m, addressText: approximate ? null : l.address_text, landmarkText: approximate ? null : l.landmark_text, localityText: approximate ? null : l.locality_text, accessNotes: approximate ? null : l.access_notes,
                areaId: l.area_id, areaName: area ? tr(area.name_i18n, locale) : null, source: l.source, approximate };
        },
    };
}
//# sourceMappingURL=locations.js.map
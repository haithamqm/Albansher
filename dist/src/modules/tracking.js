import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import { auth, roles, adminLevel } from './auth.middleware.js';
const point = s.obj({ lat: s.num({ min: -90, max: 90 }), lng: s.num({ min: -180, max: 180 }), accuracy: s.num({ min: 0, max: 100000, optional: true }), heading: s.num({ min: 0, max: 360, optional: true }), speedMps: s.num({ min: 0, max: 100, optional: true }) });
function participant(app, id, ctx) { const o = app.db.get('SELECT * FROM orders WHERE id=?', id); if (!o)
    throw E.notFound('الطلب غير موجود'); if (ctx.user?.role === 'ADMIN' || ctx.user?.role === 'CUSTOMER' && o.customer_id === ctx.user.id || ctx.user?.role === 'PROVIDER' && o.provider_id === ctx.user.providerId)
    return o; throw E.forbidden('لا تملك صلاحية تتبع هذا المشوار'); }
function live(app, pid) { return app.db.get('SELECT lat,lng,accuracy_m accuracy,heading,speed_mps speedMps,updated_at updatedAt FROM provider_live_locations WHERE provider_id=?', pid) || null; }
export function registerTrackingRoutes(app, r) {
    const { db } = app;
    r.post('/provider/live-location', auth, roles('PROVIDER'), (ctx) => { const b = parse(point, ctx.body), pid = ctx.user.providerId; if (!pid)
        throw E.notFound('ملف مقدم الخدمة غير موجود'); const now = iso(app.clock.now()); db.run(`UPDATE service_providers SET last_seen_at=?, last_heartbeat_at=?, last_location_at=?, updated_at=? WHERE id=? AND is_online=1`, now, now, now, now, pid); db.run(`UPDATE provider_presence_sessions SET last_seen_at=? WHERE provider_id=? AND ended_at IS NULL`, now, pid); db.run(`INSERT INTO provider_live_locations(provider_id,lat,lng,accuracy_m,heading,speed_mps,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,accuracy_m=excluded.accuracy_m,heading=excluded.heading,speed_mps=excluded.speed_mps,updated_at=excluded.updated_at`, pid, b.lat, b.lng, b.accuracy ?? null, b.heading ?? null, b.speedMps ?? null, now); const activeOrders = db.all('SELECT id,customer_id FROM orders WHERE provider_id=? AND status IN (\'ACCEPTED\',\'ON_THE_WAY\',\'IN_PROGRESS\') ORDER BY updated_at DESC', pid); for (const active of activeOrders) {
        db.run('INSERT INTO trip_location_history(order_id,provider_id,lat,lng,accuracy_m,heading,speed_mps,created_at) VALUES(?,?,?,?,?,?,?,?)', active.id, pid, b.lat, b.lng, b.accuracy ?? null, b.heading ?? null, b.speedMps ?? null, now);
        app.sse.send(active.customer_id, 'trip_location', { orderId: active.id, location: live(app, pid) });
    } for (const a of db.all("SELECT u.id FROM users u JOIN admin_users au ON au.user_id=u.id WHERE u.status='ACTIVE'"))
        app.sse.send(a.id, 'sync', { scope: 'admin', providerId: pid, orderIds: activeOrders.map(x => x.id), locationUpdated: true }); return { location: live(app, pid) }; });
    r.get('/orders/:id/tracking', auth, (ctx) => { const o = participant(app, ctx.params.id, ctx), p = o.provider_id ? db.get('SELECT id,display_name,verification_status FROM service_providers WHERE id=?', o.provider_id) : null; return { orderId: o.id, code: o.code, status: o.status, provider: p ? { id: p.id, displayName: p.display_name, verified: p.verification_status === 'VERIFIED' } : null, location: p ? live(app, p.id) : null, history: db.all('SELECT lat,lng,accuracy_m accuracy,heading,speed_mps speedMps,created_at createdAt FROM trip_location_history WHERE order_id=? ORDER BY id DESC LIMIT 100', o.id).reverse() }; });
    r.post('/orders/:id/share', auth, (ctx) => { const o = participant(app, ctx.params.id, ctx); if (!o.provider_id)
        throw E.unprocessable('لا يمكن مشاركة مشوار لم يتم إسناده بعد', 'TRIP_NOT_ASSIGNED'); const existing = db.get('SELECT * FROM trip_shares WHERE order_id=?', o.id), now = app.clock.now(); if (existing && !existing.revoked_at && Date.parse(existing.expires_at) > now)
        return { url: '/share-trip.html?token=' + encodeURIComponent(existing.token), expiresAt: existing.expires_at }; const token = uuid() + uuid(), exp = new Date(now + 6 * 60 * 60 * 1000).toISOString(), id = uuid(); db.run('INSERT INTO trip_shares(id,order_id,token,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET token=excluded.token,created_by=excluded.created_by,expires_at=excluded.expires_at,revoked_at=NULL', id, o.id, token, ctx.user.id, exp, iso(now)); return { url: '/share-trip.html?token=' + encodeURIComponent(token), expiresAt: exp }; });
    r.post('/orders/:id/share/revoke', auth, (ctx) => { const o = participant(app, ctx.params.id, ctx); db.run('UPDATE trip_shares SET revoked_at=? WHERE order_id=?', iso(app.clock.now()), o.id); return { ok: true }; });
    r.get('/shared-trips/:token', (ctx) => { const sh = db.get('SELECT * FROM trip_shares WHERE token=? AND revoked_at IS NULL AND expires_at>?', ctx.params.token, iso(app.clock.now())); if (!sh)
        throw E.notFound('رابط المشاركة غير صالح أو منتهي'); const o = db.get('SELECT id,code,status,provider_id,location_id FROM orders WHERE id=?', sh.order_id); if (!o)
        throw E.notFound(); const p = o.provider_id ? db.get('SELECT display_name,verification_status,id FROM service_providers WHERE id=?', o.provider_id) : null; const t = db.get('SELECT destination_location_id,destination_pending FROM trip_orders WHERE order_id=?', o.id); const destination = t && !t.destination_pending && t.destination_location_id ? db.get('SELECT lat,lng,address_text addressText FROM locations WHERE id=?', t.destination_location_id) : null; const origin = o.location_id ? db.get('SELECT lat,lng,address_text addressText FROM locations WHERE id=?', o.location_id) : null; return { code: o.code, status: o.status, expiresAt: sh.expires_at, provider: p ? { displayName: p.display_name, verified: p.verification_status === 'VERIFIED' } : null, location: p ? live(app, p.id) : null, origin, destination, history: db.all('SELECT lat,lng,accuracy_m accuracy,heading,speed_mps speedMps,created_at createdAt FROM trip_location_history WHERE order_id=? ORDER BY id DESC LIMIT 300', o.id).reverse() }; });
    r.get('/shared-trips/:token/route', async (ctx) => { const sh = db.get('SELECT * FROM trip_shares WHERE token=? AND revoked_at IS NULL AND expires_at>?', ctx.params.token, iso(app.clock.now())); if (!sh)
        throw E.notFound('رابط المشاركة غير صالح أو منتهي'); const o = db.get('SELECT id,provider_id,location_id FROM orders WHERE id=?', sh.order_id); if (!o)
        throw E.notFound(); const history = db.all('SELECT lat,lng FROM trip_location_history WHERE order_id=? ORDER BY id DESC LIMIT 300', o.id).reverse(); const current = o.provider_id ? live(app, o.provider_id) : null; const t = db.get('SELECT destination_location_id,destination_pending FROM trip_orders WHERE order_id=?', o.id); const destination = t && !t.destination_pending && t.destination_location_id ? db.get('SELECT lat,lng FROM locations WHERE id=?', t.destination_location_id) : null; let points = []; if (history.length) {
        const step = Math.max(1, Math.ceil(history.length / 18));
        points = history.filter((_, i) => i % step === 0);
        const last = history[history.length - 1];
        if (!points.length || points[points.length - 1].lat !== last.lat || points[points.length - 1].lng !== last.lng)
            points.push(last);
    }
    else if (o.location_id) {
        const origin = db.get('SELECT lat,lng FROM locations WHERE id=?', o.location_id);
        if (origin)
            points = [origin];
    } if (current && (!points.length || points[points.length - 1].lat !== current.lat || points[points.length - 1].lng !== current.lng))
        points.push({ lat: current.lat, lng: current.lng }); if (destination)
        points.push(destination); points = points.filter((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng))); if (points.length < 2)
        return { coordinates: points.map((x) => [Number(x.lng), Number(x.lat)]), method: 'GPS_ONLY' }; const baseUrl = app.config.routingUrl.replace(/\/$/, ''); if (baseUrl === 'mock://straight-line')
        return { coordinates: points.map((x) => [Number(x.lng), Number(x.lat)]), method: 'GPS_ONLY' }; try {
        const coords = points.map((x) => `${encodeURIComponent(Number(x.lng))},${encodeURIComponent(Number(x.lat))}`).join(';');
        const url = `${baseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok)
            throw new Error('ROUTING_UNAVAILABLE');
        const data = await response.json();
        const route = data?.routes?.[0];
        if (data?.code !== 'Ok' || !route?.geometry?.coordinates?.length)
            throw new Error('ROUTE_NOT_FOUND');
        return { coordinates: route.geometry.coordinates, distanceKm: Number.isFinite(route.distance) ? Math.round(route.distance / 100) / 10 : null, durationMin: Number.isFinite(route.duration) ? Math.round(route.duration / 6) / 10 : null, method: 'ROAD_ROUTING' };
    }
    catch {
        return { coordinates: points.map((x) => [Number(x.lng), Number(x.lat)]), method: 'GPS_ONLY' };
    } });
    r.get('/admin/live-providers', auth, adminLevel('SUPPORT'), () => ({ providers: db.all(`SELECT sp.id,sp.display_name displayName,sp.verification_status verificationStatus,sp.is_online isOnline,sp.accepting_orders acceptingOrders,sp.last_seen_at lastSeenAt,sp.last_heartbeat_at lastHeartbeatAt,sp.last_location_at lastLocationAt,pl.lat,pl.lng,pl.accuracy_m accuracy,pl.heading,pl.speed_mps speedMps,pl.updated_at updatedAt,(SELECT o.code FROM orders o WHERE o.provider_id=sp.id AND o.status IN ('ACCEPTED','ON_THE_WAY','IN_PROGRESS') ORDER BY o.updated_at DESC LIMIT 1) currentOrderCode,(SELECT o.status FROM orders o WHERE o.provider_id=sp.id AND o.status IN ('ACCEPTED','ON_THE_WAY','IN_PROGRESS') ORDER BY o.updated_at DESC LIMIT 1) currentOrderStatus FROM service_providers sp LEFT JOIN provider_live_locations pl ON pl.provider_id=sp.id WHERE sp.verification_status='VERIFIED' ORDER BY sp.display_name`) }));
    r.get('/admin/trips', auth, adminLevel('SUPPORT'), () => ({ trips: db.all(`SELECT o.id,o.code,o.status,o.created_at createdAt,o.updated_at updatedAt,cu.full_name customerName,sp.display_name providerName,sp.verification_status providerVerification,t.distance_km distanceKm,t.fare,t.currency FROM orders o JOIN users cu ON cu.id=o.customer_id LEFT JOIN service_providers sp ON sp.id=o.provider_id JOIN trip_orders t ON t.order_id=o.id ORDER BY o.created_at DESC LIMIT 300`) }));
    r.get('/safety-centers', (ctx) => ({ centers: db.all('SELECT id,name,description,phone,emergency_phone emergencyPhone,lat,lng,address_text addressText FROM safety_centers WHERE is_active=1 ORDER BY name') }));
    r.post('/admin/safety-centers', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(s.obj({ name: s.str({ min: 2, max: 120 }), description: s.str({ max: 500, optional: true }), phone: s.str({ max: 30, optional: true }), emergencyPhone: s.str({ max: 30, optional: true }), lat: s.num({ min: -90, max: 90 }), lng: s.num({ min: -180, max: 180 }), addressText: s.str({ max: 300, optional: true }) }), ctx.body); const id = uuid(), now = iso(app.clock.now()); db.run('INSERT INTO safety_centers(id,name,description,phone,emergency_phone,lat,lng,address_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, b.name, b.description ?? null, b.phone ?? null, b.emergencyPhone ?? null, b.lat, b.lng, b.addressText ?? null, now, now); return { id }; });
    r.patch('/admin/safety-centers/:id', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(s.obj({ name: s.str({ min: 2, max: 120, optional: true }), description: s.str({ max: 500, optional: true }), phone: s.str({ max: 30, optional: true }), emergencyPhone: s.str({ max: 30, optional: true }), lat: s.num({ min: -90, max: 90, optional: true }), lng: s.num({ min: -180, max: 180, optional: true }), addressText: s.str({ max: 300, optional: true }), isActive: s.bool({ optional: true }) }), ctx.body); const old = db.get('SELECT * FROM safety_centers WHERE id=?', ctx.params.id); if (!old)
        throw E.notFound(); db.run(`UPDATE safety_centers SET name=COALESCE(?,name),description=COALESCE(?,description),phone=COALESCE(?,phone),emergency_phone=COALESCE(?,emergency_phone),lat=COALESCE(?,lat),lng=COALESCE(?,lng),address_text=COALESCE(?,address_text),is_active=COALESCE(?,is_active),updated_at=? WHERE id=?`, b.name ?? null, b.description ?? null, b.phone ?? null, b.emergencyPhone ?? null, b.lat ?? null, b.lng ?? null, b.addressText ?? null, b.isActive === undefined ? null : (b.isActive ? 1 : 0), iso(app.clock.now()), old.id); return { ok: true }; });
    r.get('/admin/vehicles', auth, adminLevel('SUPPORT'), () => ({ vehicles: db.all(`SELECT v.*,sp.display_name providerName,u.phone FROM provider_vehicles v JOIN service_providers sp ON sp.id=v.provider_id JOIN users u ON u.id=sp.user_id ORDER BY v.created_at DESC LIMIT 300`) }));
    const verifyVehicle = (ctx) => { const b = parse(s.obj({ status: s.oneOf(['VERIFIED', 'REJECTED', 'SUSPENDED']), reason: s.str({ max: 500, optional: true }) }), ctx.body); const v = db.get('SELECT * FROM provider_vehicles WHERE id=?', ctx.params.id); if (!v)
        throw E.notFound('المركبة غير موجودة', 'VEHICLE_NOT_FOUND'); const now = iso(app.clock.now()); db.run('UPDATE provider_vehicles SET status=?,rejection_reason=?,verified_at=?,verified_by=?,updated_at=? WHERE id=?', b.status, b.status === 'REJECTED' || b.status === 'SUSPENDED' ? (b.reason || null) : null, b.status === 'VERIFIED' ? now : null, b.status === 'VERIFIED' ? ctx.user.id : null, now, v.id); return { ok: true, vehicle: db.get('SELECT * FROM provider_vehicles WHERE id=?', v.id) }; };
    r.patch('/admin/vehicles/:id/verification', auth, adminLevel('ADMIN'), verifyVehicle);
    // توافق مع واجهات الإدارة القديمة التي كانت تستخدم /verify.
    r.patch('/admin/vehicles/:id/verify', auth, adminLevel('ADMIN'), verifyVehicle);
}
//# sourceMappingURL=tracking.js.map
import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, parseJson } from '../core/util.js';
import { auth, adminLevel } from './auth.middleware.js';
const I18N = s.obj({ ar: s.str({ min: 1, max: 240 }), en: s.str({ max: 240, optional: true }) });
const I18N_OPT = s.obj({ ar: s.str({ min: 1, max: 240 }), en: s.str({ max: 240, optional: true }) }, { optional: true });
const DATE_TIME = s.str({ min: 10, max: 40 });
const DATE_TIME_OPT = s.str({ min: 10, max: 40, optional: true });
const activeStatuses = `('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')`;
function bool(v) { return !!v; }
function json(v, fallback) { try {
    return parseJson(v);
}
catch {
    return fallback;
} }
function providerState(app, p) {
    const timeout = app.settings.get('presence.timeout_sec');
    const now = app.clock.now();
    const lastSeen = p.last_seen_at ?? p.lastSeenAt ?? null;
    const seen = lastSeen ? Date.parse(lastSeen) : 0;
    const online = !!(p.is_online ?? p.isOnline) && seen > now - timeout * 1000;
    const active = Number(app.db.get(`SELECT COUNT(*) n FROM orders WHERE provider_id=? AND status IN ('ACCEPTED','ON_THE_WAY','IN_PROGRESS')`, p.id)?.n || 0);
    const acceptingOrders = !!(p.accepting_orders ?? p.acceptingOrders) && online;
    const currentOrder = app.db.get(`SELECT id,code,status,updated_at FROM orders WHERE provider_id=? AND status IN ('ACCEPTED','ON_THE_WAY','IN_PROGRESS') ORDER BY updated_at DESC LIMIT 1`, p.id);
    return {
        online, isOnline: online, acceptingOrders,
        availability: online ? (active ? 'BUSY' : 'AVAILABLE') : 'OFFLINE',
        availabilityText: online ? (active ? 'مشغول' : 'متاح') : 'غير متاح',
        lastSeenAt: lastSeen, lastHeartbeatAt: p.last_heartbeat_at ?? p.lastHeartbeatAt ?? null, lastLocationAt: p.last_location_at ?? p.lastLocationAt ?? null,
        currentOrder: currentOrder ? { id: currentOrder.id, code: currentOrder.code, status: currentOrder.status, updatedAt: currentOrder.updated_at } : null,
    };
}
export function registerAdminOperationsRoutes(app, r) {
    const { db } = app;
    const refreshAlerts = () => {
        const now = iso(app.clock.now());
        const sla = app.settings.get('operations.acceptance_sla_sec');
        const add = (type, severity, title, message, entityType, entityId, fingerprint) => {
            const existing = db.get('SELECT id,status FROM operational_alerts WHERE fingerprint=?', fingerprint);
            if (existing) {
                db.run(`UPDATE operational_alerts SET severity=?,title=?,message=?,last_seen_at=?,updated_at=?,status=CASE WHEN status='RESOLVED' THEN 'OPEN' ELSE status END WHERE id=?`, severity, title, message, now, now, existing.id);
            }
            else
                db.run(`INSERT INTO operational_alerts(id,type,severity,title,message,entity_type,entity_id,fingerprint,status,first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), type, severity, title, message, entityType, entityId, fingerprint, 'OPEN', now, now, now, now);
        };
        const unaccepted = db.all(`SELECT o.id,o.code,CAST((julianday(?) - julianday(o.created_at))*86400 AS INTEGER) age FROM orders o WHERE o.status IN ('PENDING','SEARCHING') AND (julianday(?) - julianday(o.created_at))*86400 > ? LIMIT 100`, now, now, sla);
        for (const o of unaccepted)
            add('UNACCEPTED_ORDER', 'CRITICAL', 'طلب لم يقبله أحد', `الطلب ${o.code} ينتظر القبول منذ ${Math.max(0, o.age)} ثانية`, 'order', o.id, `UNACCEPTED:${o.id}`);
        const complaints = db.all(`SELECT id,code FROM complaints WHERE status NOT IN ('RESOLVED','REJECTED','CLOSED') ORDER BY created_at DESC LIMIT 100`);
        for (const c of complaints)
            add('NEW_COMPLAINT', 'CRITICAL', 'شكوى تحتاج متابعة', `الشكوى ${c.code} ما زالت مفتوحة`, 'complaint', c.id, `COMPLAINT:${c.id}`);
        const late = db.all(`SELECT id,code FROM orders WHERE status IN ('ON_THE_WAY','IN_PROGRESS') AND (julianday(?) - julianday(updated_at))*86400 > ? LIMIT 100`, now, sla * app.settings.get('operations.execution_sla_multiplier'));
        for (const o of late)
            add('LATE_ORDER', 'WARNING', 'طلب متأخر', `الطلب ${o.code} تجاوز مدة التشغيل المتوقعة`, 'order', o.id, `LATE:${o.id}`);
        const silent = db.all(`SELECT sp.id,sp.display_name FROM service_providers sp WHERE sp.verification_status='VERIFIED' AND sp.is_online=1 AND (sp.last_seen_at IS NULL OR (julianday(?) - julianday(sp.last_seen_at))*86400 > ?) LIMIT 100`, now, app.settings.get('presence.timeout_sec'));
        for (const p of silent)
            add('PROVIDER_NO_RESPONSE', 'WARNING', 'مقدم خدمة لا يستجيب', `${p.display_name} معلن كمتصل لكن آخر ظهور قديم`, 'provider', p.id, `SILENT_PROVIDER:${p.id}`);
        db.run(`UPDATE operational_alerts SET status='RESOLVED',resolved_at=?,updated_at=? WHERE status='OPEN' AND last_seen_at < ?`, now, now, new Date(app.clock.now() - 15 * 60_000).toISOString());
    };
    r.get('/admin/operations/overview', auth, adminLevel('SUPPORT'), () => {
        refreshAlerts();
        const timeout = app.settings.get('presence.timeout_sec');
        const now = iso(app.clock.now());
        const count = (sql, ...p) => Number(db.get(sql, ...p)?.n || 0);
        const onlineRows = db.all(`SELECT sp.* FROM service_providers sp WHERE sp.verification_status='VERIFIED' AND sp.is_online=1`);
        let online = 0, busy = 0, available = 0;
        for (const p of onlineRows) {
            const st = providerState(app, p);
            if (st.online) {
                online++;
                st.availability === 'BUSY' ? busy++ : available++;
            }
        }
        const orders = {
            new: count(`SELECT COUNT(*) n FROM orders WHERE status='PENDING'`), searching: count(`SELECT COUNT(*) n FROM orders WHERE status='SEARCHING'`), accepted: count(`SELECT COUNT(*) n FROM orders WHERE status='ACCEPTED'`), inProgress: count(`SELECT COUNT(*) n FROM orders WHERE status IN ('ON_THE_WAY','IN_PROGRESS')`), completed: count(`SELECT COUNT(*) n FROM orders WHERE status='COMPLETED'`), cancelled: count(`SELECT COUNT(*) n FROM orders WHERE status='CANCELLED'`), unaccepted: count(`SELECT COUNT(*) n FROM orders WHERE status IN ('PENDING','SEARCHING')`), overdue: count(`SELECT COUNT(*) n FROM orders WHERE status IN ('ON_THE_WAY','IN_PROGRESS') AND (julianday(?) - julianday(updated_at))*86400 > ?`, now, app.settings.get('operations.acceptance_sla_sec') * app.settings.get('operations.execution_sla_multiplier')),
        };
        const openAlerts = count(`SELECT COUNT(*) n FROM operational_alerts WHERE status='OPEN'`);
        const openComplaints = count(`SELECT COUNT(*) n FROM complaints WHERE status NOT IN ('RESOLVED','REJECTED','CLOSED')`);
        const errors = count(`SELECT COUNT(*) n FROM system_events WHERE level IN ('ERROR','CRITICAL') AND created_at >= ?`, new Date(app.clock.now() - 24 * 3600_000).toISOString());
        const critical = orders.unaccepted + orders.overdue + openComplaints + errors;
        const health = critical === 0 ? 'GOOD' : critical <= 3 ? 'ATTENTION' : 'PROBLEM';
        return { now, providers: { online, busy, available, offline: count(`SELECT COUNT(*) n FROM service_providers WHERE verification_status='VERIFIED' AND (is_online=0 OR last_seen_at IS NULL OR (julianday(?) - julianday(last_seen_at))*86400 > ?)`, now, timeout) }, orders, alerts: { open: openAlerts, complaints: openComplaints, errors24h: errors }, health, healthText: health === 'GOOD' ? 'جيد' : health === 'ATTENTION' ? 'يحتاج انتباه' : 'توجد مشاكل' };
    });
    r.get('/admin/operations/live', auth, adminLevel('SUPPORT'), () => {
        refreshAlerts();
        const now = iso(app.clock.now());
        const orders = db.all(`SELECT o.id,o.code,o.status,o.created_at createdAt,o.updated_at updatedAt,o.accepted_at acceptedAt,o.started_at startedAt,o.completed_at completedAt,o.cancelled_at cancelledAt, o.wave, cu.full_name customerName, s.name_i18n serviceName, sp.display_name providerName, sp.id providerId, l.lat,l.lng FROM orders o JOIN users cu ON cu.id=o.customer_id JOIN services s ON s.id=o.service_id LEFT JOIN service_providers sp ON sp.id=o.provider_id LEFT JOIN locations l ON l.id=o.location_id WHERE o.status IN ${activeStatuses} ORDER BY o.created_at ASC LIMIT 200`);
        const providers = db.all(`SELECT sp.id,sp.display_name displayName,sp.is_online isOnline,sp.accepting_orders acceptingOrders,sp.last_seen_at lastSeenAt,sp.last_heartbeat_at lastHeartbeatAt,sp.last_location_at lastLocationAt,sp.base_lat baseLat,sp.base_lng baseLng,u.full_name fullName FROM service_providers sp JOIN users u ON u.id=sp.user_id WHERE sp.verification_status='VERIFIED' ORDER BY sp.display_name LIMIT 300`).map((p) => ({ ...p, ...providerState(app, p) }));
        return { orders, providers };
    });
    r.get('/admin/operations/orders/:id', auth, adminLevel('SUPPORT'), (ctx) => {
        const o = db.get(`SELECT o.*,cu.full_name customer_name,cu.phone customer_phone,s.name_i18n service_name,sp.display_name provider_name,sp.id provider_id FROM orders o JOIN users cu ON cu.id=o.customer_id JOIN services s ON s.id=o.service_id LEFT JOIN service_providers sp ON sp.id=o.provider_id WHERE o.id=?`, ctx.params.id);
        if (!o)
            throw E.notFound('الطلب غير موجود');
        const history = db.all(`SELECT h.id,h.from_status fromStatus,h.to_status toStatus,h.actor_role actorRole,h.reason,h.metadata,h.created_at createdAt,u.full_name actorName FROM order_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.order_id=? ORDER BY h.id`, o.id).map((x) => ({ ...x, metadata: json(x.metadata, {}) }));
        const assignments = db.all(`SELECT a.id,a.provider_id providerId,sp.display_name providerName,a.status,a.wave,a.score,a.distance_km distanceKm,a.offered_at offeredAt,a.expires_at expiresAt,a.responded_at respondedAt FROM order_assignments a JOIN service_providers sp ON sp.id=a.provider_id WHERE a.order_id=? ORDER BY a.offered_at`, o.id);
        const timeline = [...history.map((h) => ({ type: 'STATUS', at: h.createdAt, title: `${h.fromStatus || '—'} → ${h.toStatus}`, detail: h.reason || h.actorName || h.actorRole })), ...assignments.map((a) => ({ type: 'ASSIGNMENT', at: a.offeredAt, title: `عرض على ${a.providerName}`, detail: a.status === 'ACCEPTED' ? 'تم القبول' : a.status === 'REJECTED' ? 'تم الرفض' : a.status === 'EXPIRED' ? 'انتهت المهلة' : 'بانتظار الاستجابة' }))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        return { order: o, history, assignments, timeline };
    });
    r.get('/admin/operations/alerts', auth, adminLevel('SUPPORT'), (ctx) => { refreshAlerts(); const status = String(ctx.query.status || 'OPEN'); return { alerts: db.all(`SELECT * FROM operational_alerts WHERE status=? ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT 200`, status) }; });
    r.patch('/admin/operations/alerts/:id', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(s.obj({ status: s.oneOf(['ACKNOWLEDGED', 'RESOLVED']) }), ctx.body); const row = db.get('SELECT * FROM operational_alerts WHERE id=?', ctx.params.id); if (!row)
        throw E.notFound('التنبيه غير موجود'); const now = iso(app.clock.now()); db.run(`UPDATE operational_alerts SET status=?,acknowledged_by=CASE WHEN ?='ACKNOWLEDGED' THEN ? ELSE acknowledged_by END,acknowledged_at=CASE WHEN ?='ACKNOWLEDGED' THEN ? ELSE acknowledged_at END,resolved_at=CASE WHEN ?='RESOLVED' THEN ? ELSE resolved_at END,updated_at=? WHERE id=?`, b.status, b.status, ctx.user.id, b.status, now, b.status, now, now, row.id); app.audit.log({ ctx, action: 'operational.alert_update', entityType: 'operational_alert', entityId: row.id, before: { status: row.status }, after: { status: b.status } }); return { ok: true }; });
    r.get('/admin/operations/providers/:id', auth, adminLevel('SUPPORT'), (ctx) => {
        const p = db.get(`SELECT sp.*,u.full_name fullName,u.phone FROM service_providers sp JOIN users u ON u.id=sp.user_id WHERE sp.id=?`, ctx.params.id);
        if (!p)
            throw E.notFound('مقدم الخدمة غير موجود');
        const st = providerState(app, p);
        const counts = db.get(`SELECT COUNT(*) received, SUM(CASE WHEN a.status='ACCEPTED' THEN 1 ELSE 0 END) accepted, SUM(CASE WHEN a.status='REJECTED' THEN 1 ELSE 0 END) rejected, SUM(CASE WHEN a.status='EXPIRED' THEN 1 ELSE 0 END) expired FROM order_assignments a WHERE a.provider_id=?`, p.id);
        const completed = db.get(`SELECT COUNT(*) n FROM orders WHERE provider_id=? AND status='COMPLETED'`, p.id)?.n || 0;
        const cancelled = db.get(`SELECT COUNT(*) n FROM orders WHERE provider_id=? AND status='CANCELLED'`, p.id)?.n || 0;
        const hours = db.all('SELECT weekday,start_time start,end_time end FROM provider_availability WHERE provider_id=? AND is_available=1 ORDER BY weekday,start_time', p.id);
        const presence = db.all('SELECT started_at startedAt,ended_at endedAt,last_seen_at lastSeenAt FROM provider_presence_sessions WHERE provider_id=? ORDER BY started_at DESC LIMIT 100', p.id);
        return { provider: { id: p.id, displayName: p.display_name, ...st }, metrics: { received: Number(counts?.received || 0), accepted: Number(counts?.accepted || 0), rejected: Number(counts?.rejected || 0), noResponse: Number(counts?.expired || 0), completed: Number(completed), cancelled: Number(cancelled), rating: Number(p.rating_avg || 0), complaints: Number(db.get('SELECT COUNT(*) n FROM complaints WHERE against_user_id=?', p.user_id)?.n || 0) }, hours, presence };
    });
    r.get('/admin/operations/reports', auth, adminLevel('SUPPORT'), (ctx) => {
        const from = ctx.query.from ? String(ctx.query.from) : new Date(app.clock.now() - 30 * 86400_000).toISOString();
        const to = ctx.query.to ? String(ctx.query.to) : nowIso(app.clock.now());
        const byService = db.all(`SELECT s.id serviceId,json_extract(s.name_i18n,'$.ar') service,COUNT(o.id) orders,SUM(CASE WHEN o.status='COMPLETED' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN o.status='CANCELLED' THEN 1 ELSE 0 END) cancelled,AVG(CASE WHEN o.accepted_at IS NOT NULL THEN (julianday(o.accepted_at)-julianday(o.created_at))*86400 END) acceptSec,AVG(CASE WHEN o.completed_at IS NOT NULL AND o.started_at IS NOT NULL THEN (julianday(o.completed_at)-julianday(o.started_at))*86400 END) executionSec FROM orders o JOIN services s ON s.id=o.service_id WHERE o.created_at BETWEEN ? AND ? GROUP BY s.id ORDER BY orders DESC LIMIT 100`, from, to);
        const summary = db.get(`SELECT COUNT(*) orders,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) cancelled,AVG(CASE WHEN accepted_at IS NOT NULL THEN (julianday(accepted_at)-julianday(created_at))*86400 END) acceptSec,AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN (julianday(completed_at)-julianday(started_at))*86400 END) executionSec FROM orders WHERE created_at BETWEEN ? AND ?`, from, to);
        const daily = db.all(`SELECT substr(created_at,1,10) day,COUNT(*) orders,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) cancelled FROM orders WHERE created_at BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, from, to);
        const topProviders = db.all(`SELECT sp.id,sp.display_name displayName,COUNT(o.id) orders,SUM(CASE WHEN o.status='COMPLETED' THEN 1 ELSE 0 END) completed,sp.rating_avg rating FROM orders o JOIN service_providers sp ON sp.id=o.provider_id WHERE o.created_at BETWEEN ? AND ? GROUP BY sp.id ORDER BY completed DESC,orders DESC LIMIT 50`, from, to);
        return { from, to, summary, daily, byService, topProviders };
    });
    const tempInput = s.obj({ linkedServiceId: s.str({ max: 64 }), name: I18N, title: I18N, description: I18N_OPT, icon: s.str({ max: 30, optional: true }), categoryId: s.str({ max: 64, optional: true }), startAt: DATE_TIME, endAt: DATE_TIME, isActive: s.bool({ optional: true }), sortOrder: s.int({ min: -10000, max: 10000, optional: true }), priority: s.int({ min: -10000, max: 10000, optional: true }), requestFlow: s.oneOf(['SERVICE', 'TRIP', 'ORDER', 'INTERNAL', 'URL'], { optional: true }), actionValue: s.str({ max: 500, optional: true }), targetCapabilities: s.arr(s.str({ max: 80 }), { max: 50, optional: true }), audience: s.any({ optional: true }), areaIds: s.arr(s.str({ max: 64 }), { max: 100, optional: true }), pricing: s.any({ optional: true }), maxOrders: s.int({ min: 1, max: 1000000, optional: true }), actionLabel: I18N_OPT });
    r.get('/admin/temporary-services', auth, adminLevel('SUPPORT'), () => { const now = iso(app.clock.now()); const items = db.all(`SELECT * FROM temporary_services ORDER BY CASE WHEN is_active=1 AND start_at<=? AND end_at>? THEN 0 WHEN start_at>? THEN 1 ELSE 2 END, priority DESC, start_at DESC, sort_order ASC`, now, now, now).map((x) => ({ ...x, state: x.is_active ? (x.start_at > now ? 'UPCOMING' : x.end_at <= now ? 'EXPIRED' : 'ACTIVE') : 'DISABLED' })); return { items }; });
    r.post('/admin/temporary-services', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(tempInput, ctx.body); if (!db.get('SELECT id FROM services WHERE id=?', b.linkedServiceId))
        throw E.notFound('الخدمة المرتبطة غير موجودة'); if (Date.parse(b.startAt) >= Date.parse(b.endAt))
        throw E.unprocessable('نهاية الحملة يجب أن تكون بعد بدايتها', 'INVALID_DATE_RANGE'); const id = uuid(), now = iso(app.clock.now()); db.run(`INSERT INTO temporary_services(id,linked_service_id,name_i18n,title_i18n,description_i18n,icon,category_id,start_at,end_at,is_active,sort_order,audience_json,area_ids_json,pricing_json,max_orders,action_label_i18n,created_by,created_at,updated_at,priority,request_flow,action_value,target_capabilities_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, b.linkedServiceId, JSON.stringify(b.name), JSON.stringify(b.title), b.description ? JSON.stringify(b.description) : null, b.icon || null, b.categoryId || null, b.startAt, b.endAt, b.isActive === false ? 0 : 1, b.sortOrder || 0, JSON.stringify(b.audience || {}), JSON.stringify(b.areaIds || []), JSON.stringify(b.pricing || {}), b.maxOrders || null, b.actionLabel ? JSON.stringify(b.actionLabel) : null, ctx.user.id, now, now, b.priority || 0, b.requestFlow || 'SERVICE', b.actionValue || b.linkedServiceId, JSON.stringify(b.targetCapabilities || [])); app.audit.log({ ctx, action: 'temporary_service.create', entityType: 'temporary_service', entityId: id, after: b }); app.sse.broadcast('sync', { scope: 'catalog' }); return { id }; });
    r.patch('/admin/temporary-services/:id', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(s.obj({ isActive: s.bool({ optional: true }), startAt: DATE_TIME_OPT, endAt: DATE_TIME_OPT, sortOrder: s.int({ min: -10000, max: 10000, optional: true }), priority: s.int({ min: -10000, max: 10000, optional: true }), requestFlow: s.oneOf(['SERVICE', 'TRIP', 'ORDER', 'INTERNAL', 'URL'], { optional: true }), actionValue: s.str({ max: 500, optional: true }), targetCapabilities: s.arr(s.str({ max: 80 }), { max: 50, optional: true }), title: I18N_OPT, description: I18N_OPT, maxOrders: s.int({ min: 1, max: 1000000, optional: true }) }), ctx.body); const old = db.get('SELECT * FROM temporary_services WHERE id=?', ctx.params.id); if (!old)
        throw E.notFound('الخدمة المؤقتة غير موجودة'); if (b.startAt && b.endAt && Date.parse(b.startAt) >= Date.parse(b.endAt))
        throw E.unprocessable('نهاية الحملة يجب أن تكون بعد بدايتها', 'INVALID_DATE_RANGE'); db.run(`UPDATE temporary_services SET is_active=COALESCE(?,is_active),start_at=COALESCE(?,start_at),end_at=COALESCE(?,end_at),sort_order=COALESCE(?,sort_order),priority=COALESCE(?,priority),request_flow=COALESCE(?,request_flow),action_value=COALESCE(?,action_value),target_capabilities_json=COALESCE(?,target_capabilities_json),title_i18n=COALESCE(?,title_i18n),description_i18n=COALESCE(?,description_i18n),max_orders=COALESCE(?,max_orders),updated_at=? WHERE id=?`, b.isActive === undefined ? null : b.isActive ? 1 : 0, b.startAt || null, b.endAt || null, b.sortOrder === undefined ? null : b.sortOrder, b.priority === undefined ? null : b.priority, b.requestFlow || null, b.actionValue || null, b.targetCapabilities ? JSON.stringify(b.targetCapabilities) : null, b.title ? JSON.stringify(b.title) : null, b.description ? JSON.stringify(b.description) : null, b.maxOrders || null, iso(app.clock.now()), old.id); app.audit.log({ ctx, action: 'temporary_service.update', entityType: 'temporary_service', entityId: old.id, before: { isActive: old.is_active }, after: b }); app.sse.broadcast('sync', { scope: 'catalog' }); return { ok: true }; });
    const campInput = s.obj({ title: I18N, description: I18N_OPT, imageFileId: s.str({ max: 64, optional: true }), buttonLabel: I18N_OPT, actionType: s.oneOf(['SERVICE', 'ORDER', 'INTERNAL', 'URL', 'NONE'], { optional: true }), actionValue: s.str({ max: 500, optional: true }), startAt: DATE_TIME, endAt: DATE_TIME, isActive: s.bool({ optional: true }), audience: s.any({ optional: true }), areaIds: s.arr(s.str({ max: 64 }), { max: 100, optional: true }), sortOrder: s.int({ min: -10000, max: 10000, optional: true }), priority: s.int({ min: -10000, max: 10000, optional: true }) });
    r.get('/admin/campaigns', auth, adminLevel('SUPPORT'), () => { const now = iso(app.clock.now()); return { items: db.all(`SELECT *,CASE WHEN is_active=0 THEN 'DISABLED' WHEN start_at>? THEN 'UPCOMING' WHEN end_at<=? THEN 'EXPIRED' ELSE 'ACTIVE' END state FROM admin_campaigns ORDER BY CASE WHEN is_active=1 AND start_at<=? AND end_at>? THEN 0 WHEN start_at>? THEN 1 ELSE 2 END,priority DESC,start_at DESC`, now, now, now, now, now) }; });
    r.post('/admin/campaigns', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(campInput, ctx.body); const id = uuid(), now = iso(app.clock.now()); db.run(`INSERT INTO admin_campaigns(id,title_i18n,description_i18n,image_file_id,button_label_i18n,action_type,action_value,start_at,end_at,is_active,audience_json,area_ids_json,sort_order,created_by,created_at,updated_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, JSON.stringify(b.title), b.description ? JSON.stringify(b.description) : null, b.imageFileId || null, b.buttonLabel ? JSON.stringify(b.buttonLabel) : null, b.actionType || 'SERVICE', b.actionValue || null, b.startAt, b.endAt, b.isActive === false ? 0 : 1, JSON.stringify(b.audience || {}), JSON.stringify(b.areaIds || []), b.sortOrder || 0, ctx.user.id, now, now, b.priority || 0); app.audit.log({ ctx, action: 'campaign.create', entityType: 'campaign', entityId: id, after: b }); app.sse.broadcast('sync', { scope: 'campaigns' }); return { id }; });
    r.patch('/admin/campaigns/:id', auth, adminLevel('ADMIN'), (ctx) => { const b = parse(s.obj({ isActive: s.bool({ optional: true }), startAt: DATE_TIME_OPT, endAt: DATE_TIME_OPT, title: I18N_OPT, description: I18N_OPT, actionType: s.oneOf(['SERVICE', 'ORDER', 'INTERNAL', 'URL', 'NONE'], { optional: true }), actionValue: s.str({ max: 500, optional: true }), sortOrder: s.int({ min: -10000, max: 10000, optional: true }), priority: s.int({ min: -10000, max: 10000, optional: true }) }), ctx.body); const old = db.get('SELECT * FROM admin_campaigns WHERE id=?', ctx.params.id); if (!old)
        throw E.notFound('الحملة غير موجودة'); db.run(`UPDATE admin_campaigns SET is_active=COALESCE(?,is_active),start_at=COALESCE(?,start_at),end_at=COALESCE(?,end_at),title_i18n=COALESCE(?,title_i18n),description_i18n=COALESCE(?,description_i18n),action_type=COALESCE(?,action_type),action_value=COALESCE(?,action_value),sort_order=COALESCE(?,sort_order),priority=COALESCE(?,priority),updated_at=? WHERE id=?`, b.isActive === undefined ? null : b.isActive ? 1 : 0, b.startAt || null, b.endAt || null, b.title ? JSON.stringify(b.title) : null, b.description ? JSON.stringify(b.description) : null, b.actionType || null, b.actionValue || null, b.sortOrder === undefined ? null : b.sortOrder, b.priority === undefined ? null : b.priority, iso(app.clock.now()), old.id); app.audit.log({ ctx, action: 'campaign.update', entityType: 'campaign', entityId: old.id, before: { isActive: old.is_active }, after: b }); app.sse.broadcast('sync', { scope: 'campaigns' }); return { ok: true }; });
    r.get('/admin/system-health', auth, adminLevel('SUPPORT'), (ctx) => { const since = new Date(app.clock.now() - 24 * 3600_000).toISOString(); return { api: { slow: db.all(`SELECT path,method,COUNT(*) count,AVG(duration_ms) avgMs,MAX(duration_ms) maxMs FROM system_events WHERE duration_ms IS NOT NULL AND duration_ms>=1000 AND created_at>=? GROUP BY path,method ORDER BY count DESC LIMIT 50`, since), errors: db.all(`SELECT level,event_type,message,path,status_code,duration_ms,created_at FROM system_events WHERE level IN ('ERROR','CRITICAL') AND created_at>=? ORDER BY created_at DESC LIMIT 100`, since) }, db: { ok: !!db.get('SELECT 1 ok') }, since }; });
    r.get('/admin/performance-diagnostics', auth, adminLevel('SUPPORT'), () => { const q = db.performanceSnapshot(); return { server: { database: q, sse: app.sse.stats() }, api: db.all(`SELECT path,method,COUNT(*) count,ROUND(AVG(duration_ms),1) avgMs,MAX(duration_ms) maxMs FROM system_events WHERE duration_ms IS NOT NULL GROUP BY path,method ORDER BY maxMs DESC LIMIT 50`) }; });
}
function nowIso(now) { return new Date(now).toISOString(); }
//# sourceMappingURL=admin.operations.js.map
import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, pageParams, cursorSql, finishPage } from '../core/util.js';
import { auth, roles, adminLevel } from './auth.middleware.js';
import { executionEvent } from './execution.js';
const CATEGORIES = ['QUALITY', 'BEHAVIOR', 'PRICE', 'NO_SHOW', 'DAMAGE', 'OTHER'];
const RESOLUTIONS = ['RESTORE_COMPLETED', 'CANCEL_ORDER', 'WARN_PROVIDER', 'SUSPEND_PROVIDER', 'DISMISS'];
function genComplaintCode(db, now) {
    const key = `complaint_seq_${now.getUTCFullYear()}`;
    db.run('INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', key);
    const n = db.get('SELECT value FROM counters WHERE name = ?', key).value;
    return `CMP-${now.getUTCFullYear()}-${String(n).padStart(5, '0')}`;
}
const complaintOut = (c) => ({
    id: c.id, code: c.code, orderId: c.order_id, category: c.category, description: c.description, status: c.status,
    resolutionAction: c.resolution_action, resolutionNote: c.resolution_note, resolvedAt: c.resolved_at, createdAt: c.created_at, updatedAt: c.updated_at,
});
/**
 * الشكاوى: العميل يفتح شكوى مرتبطة بطلب، المزود يرد، والإدارة تتخذ القرار وتُغلق.
 * شكوى نشطة واحدة كحد أقصى لكل طلب (قيد فريد جزئي في قاعدة البيانات).
 */
export function registerComplaintRoutes(app, r) {
    const { db, orders } = app;
    r.post('/orders/:id/complaints', auth, roles('CUSTOMER'), (ctx) => {
        const b = parse(s.obj({ category: s.oneOf(CATEGORIES), description: s.str({ min: 5, max: 1000 }) }), ctx.body);
        return db.tx(() => {
            const o = orders.getOwned(ctx.params['id'], ctx);
            if (!['IN_PROGRESS', 'COMPLETED', 'ON_THE_WAY', 'ACCEPTED'].includes(o.status))
                throw E.unprocessable('لا يمكن فتح شكوى على هذا الطلب في حالته الحالية', 'INVALID_ORDER_STATE');
            if (db.get(`SELECT 1 FROM complaints WHERE order_id = ? AND status NOT IN ('RESOLVED','REJECTED','CLOSED')`, o.id))
                throw E.conflict('توجد شكوى مفتوحة بالفعل على هذا الطلب', 'COMPLAINT_ALREADY_OPEN');
            const now = new Date(app.clock.now());
            const nowIso = iso(app.clock.now());
            const id = uuid();
            const code = genComplaintCode(db, now);
            let againstUserId = null;
            if (o.provider_id) {
                const p = db.get('SELECT user_id FROM service_providers WHERE id = ?', o.provider_id);
                againstUserId = p?.user_id ?? null;
            }
            db.run('INSERT INTO complaints(id,code,order_id,opened_by,against_user_id,category,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, code, o.id, ctx.user.id, againstUserId, b.category, b.description, 'OPEN', nowIso, nowIso);
            if (o.status !== 'COMPLETED')
                orders.applyTransition(o, 'DISPUTED', 'CUSTOMER', ctx, { reason: `complaint ${code}` });
            if (againstUserId)
                app.notifications.notify(againstUserId, 'COMPLAINT_OPENED', { code: o.code });
            app.notifications.notifyAdmins('COMPLAINT_OPENED_ADMIN', { complaint: code, code: o.code }, { complaintId: id });
            ctx.status = 201;
            return { complaint: complaintOut(db.get('SELECT * FROM complaints WHERE id = ?', id)) };
        });
    });
    const canView = (c, ctx) => ctx.user.role === 'ADMIN' || c.opened_by === ctx.user.id || c.against_user_id === ctx.user.id;
    r.get('/orders/:id/complaint', auth, (ctx) => {
        const o = orders.getOwned(ctx.params['id'], ctx);
        const c = db.get('SELECT * FROM complaints WHERE order_id = ? ORDER BY created_at DESC LIMIT 1', o.id);
        if (!c)
            return { complaint: null, messages: [] };
        if (!canView(c, ctx))
            throw E.notFound('الشكوى غير موجودة');
        const messages = db.all('SELECT id, author_id, author_role, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY created_at', c.id);
        return { complaint: complaintOut(c), messages: messages.map((m) => ({ id: m.id, authorId: m.author_id, authorRole: m.author_role, body: m.body, createdAt: m.created_at })) };
    });
    r.get('/complaints/:id', auth, (ctx) => {
        const c = db.get('SELECT * FROM complaints WHERE id = ?', ctx.params['id']);
        if (!c || !canView(c, ctx))
            throw E.notFound('الشكوى غير موجودة');
        const messages = db.all('SELECT id, author_id, author_role, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY created_at', c.id);
        return { complaint: complaintOut(c), messages: messages.map((m) => ({ id: m.id, authorId: m.author_id, authorRole: m.author_role, body: m.body, createdAt: m.created_at })) };
    });
    r.post('/complaints/:id/reply', auth, (ctx) => {
        const b = parse(s.obj({ body: s.str({ min: 1, max: 1000 }) }), ctx.body);
        return db.tx(() => {
            const c = db.get('SELECT * FROM complaints WHERE id = ?', ctx.params['id']);
            if (!c || !canView(c, ctx))
                throw E.notFound('الشكوى غير موجودة');
            if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(c.status))
                throw E.unprocessable('هذه الشكوى مغلقة', 'COMPLAINT_CLOSED');
            const idem = String(ctx.req.headers['idempotency-key'] || '').trim();
            if (idem) {
                const old = db.get('SELECT * FROM complaint_messages WHERE complaint_id=? AND author_id=? AND idempotency_key=?', c.id, ctx.user.id, idem);
                if (old) {
                    ctx.status = 200;
                    return { complaint: complaintOut(c), message: { id: old.id, authorId: old.author_id, authorRole: old.author_role, body: old.body, createdAt: old.created_at }, idempotent: true };
                }
            }
            const last = db.get('SELECT created_at FROM complaint_messages WHERE complaint_id=? ORDER BY created_at DESC,id DESC LIMIT 1', c.id);
            const nowMs = app.clock.now();
            const lastMs = last?.created_at ? Date.parse(last.created_at) : NaN;
            const now = new Date(Math.max(nowMs, Number.isFinite(lastMs) ? lastMs + 1 : nowMs)).toISOString();
            const messageId = uuid();
            db.run('INSERT INTO complaint_messages(id,complaint_id,author_id,author_role,body,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)', messageId, c.id, ctx.user.id, ctx.user.role, b.body, idem || null, now);
            if (c.status === 'OPEN' && ctx.user.id === c.against_user_id)
                db.run(`UPDATE complaints SET status='PROVIDER_REPLIED', updated_at=? WHERE id=?`, now, c.id);
            const notifyId = ctx.user.id === c.opened_by ? c.against_user_id : c.opened_by;
            if (notifyId) {
                app.notifications.notify(notifyId, 'COMPLAINT_REPLIED', { complaint: c.code }, { orderId: c.order_id, complaintId: c.id, open: 'complaint' });
                app.sse.send(notifyId, 'complaint_message', { orderId: c.order_id, complaintId: c.id });
            }
            if (ctx.user.role !== 'ADMIN') {
                const event = { orderId: c.order_id, complaintId: c.id };
                for (const a of db.all("SELECT u.id FROM users u JOIN admin_users au ON au.user_id=u.id WHERE u.status='ACTIVE'")) {
                    app.sse.send(a.id, 'complaint_message', event);
                }
                app.notifications.notifyAdmins('COMPLAINT_REPLIED', { complaint: c.code }, { orderId: c.order_id, complaintId: c.id, open: 'complaint' });
            }
            executionEvent(app, c.order_id, 'COMPLAINT_REPLY', 'رد جديد على الشكوى', `الشكوى ${c.code}`, 'SYSTEM', ctx.user.id, { complaintId: c.id });
            return { complaint: complaintOut(db.get('SELECT * FROM complaints WHERE id = ?', c.id)), message: { id: messageId, authorId: ctx.user.id, authorRole: ctx.user.role, body: b.body, createdAt: now } };
        });
    });
    r.get('/admin/complaints', auth, adminLevel('SUPPORT'), (ctx) => {
        const { limit, cursor } = pageParams(ctx.query);
        const c = cursorSql('c', cursor);
        const where = [];
        const params = [];
        if (ctx.query['status']) {
            where.push('c.status = ?');
            params.push(ctx.query['status']);
        }
        const rows = db.all(`SELECT c.* FROM complaints c WHERE 1=1 ${where.map((w) => 'AND ' + w).join(' ')}${c.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, ...params, ...c.params, limit + 1);
        const { items, nextCursor } = finishPage(rows, limit);
        return { complaints: items.map(complaintOut), nextCursor };
    });
    r.post('/admin/complaints/:id/action', auth, adminLevel('ADMIN'), (ctx) => {
        const b = parse(s.obj({ action: s.oneOf(RESOLUTIONS), note: s.str({ max: 500, optional: true }) }), ctx.body);
        return db.tx(() => {
            const c = db.get('SELECT * FROM complaints WHERE id = ?', ctx.params['id']);
            if (!c)
                throw E.notFound('الشكوى غير موجودة');
            if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(c.status))
                throw E.unprocessable('هذه الشكوى مغلقة بالفعل', 'COMPLAINT_CLOSED');
            const now = iso(app.clock.now());
            const status = b.action === 'DISMISS' ? 'REJECTED' : 'RESOLVED';
            db.run('UPDATE complaints SET status=?, resolution_action=?, resolution_note=?, resolved_by=?, resolved_at=?, updated_at=? WHERE id=?', status, b.action, b.note || null, ctx.user.id, now, now, c.id);
            const order = db.get('SELECT * FROM orders WHERE id = ?', c.order_id);
            if (b.action === 'RESTORE_COMPLETED' && order.status === 'DISPUTED')
                orders.applyTransition(order, 'COMPLETED', 'ADMIN', ctx, { reason: `complaint ${c.code} resolved` });
            if (b.action === 'CANCEL_ORDER' && order.status !== 'CANCELLED')
                orders.applyTransition(order, 'CANCELLED', 'ADMIN', ctx, { reason: `complaint ${c.code} resolved` });
            if (b.action === 'SUSPEND_PROVIDER' && order.provider_id)
                db.run(`UPDATE service_providers SET verification_status='SUSPENDED', suspension_reason=?, updated_at=? WHERE id=?`, `شكوى ${c.code}`, now, order.provider_id);
            app.audit.log({ ctx, action: 'complaint.resolve', entityType: 'complaint', entityId: c.id, before: { status: c.status }, after: { status, action: b.action } });
            for (const uid of [c.opened_by, c.against_user_id])
                if (uid)
                    app.notifications.notify(uid, 'COMPLAINT_CLOSED', { complaint: c.code, resolution: b.action });
            return { complaint: complaintOut(db.get('SELECT * FROM complaints WHERE id = ?', c.id)) };
        });
    });
}
//# sourceMappingURL=complaints.js.map
import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { pageParams, cursorSql, finishPage } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import { executionEvent } from './execution.js';
const bodySchema = s.obj({ body: s.str({ min: 0, max: 2000 }), attachmentFileIds: s.arr(s.str({ max: 64 }), { max: 5, optional: true }), location: s.obj({ lat: s.num({ min: -90, max: 90 }), lng: s.num({ min: -180, max: 180 }), accuracy: s.num({ min: 0, max: 100000, optional: true }), addressText: s.str({ max: 300, optional: true }) }, { optional: true }) });
function canAccess(app, orderId, ctx) {
    const o = app.db.get('SELECT id,customer_id,provider_id,status FROM orders WHERE id=?', orderId);
    if (!o)
        throw E.notFound('الطلب غير موجود');
    if (ctx.user?.role === 'ADMIN')
        return o;
    if (ctx.user?.role === 'CUSTOMER' && o.customer_id === ctx.user.id)
        return o;
    if (ctx.user?.role === 'PROVIDER') {
        if (o.provider_id === ctx.user.providerId)
            return o;
        const assigned = app.db.get("SELECT status FROM order_assignments WHERE order_id=? AND provider_id=? AND status IN ('OFFERED','ACCEPTED') LIMIT 1", orderId, ctx.user.providerId);
        if (assigned)
            return o;
    }
    throw E.forbidden('لا تملك صلاحية الوصول إلى محادثة هذا الطلب');
}
function out(app, m) {
    const u = app.db.get('SELECT full_name FROM users WHERE id=?', m.sender_id);
    return { id: m.id, orderId: m.order_id, senderId: m.sender_id, senderRole: m.sender_role, senderName: u?.full_name || '', body: m.body, attachments: JSON.parse(m.attachments || '[]').map(id => { const f = app.db.get('SELECT mime FROM files WHERE id=?', id); return { id, mime: f?.mime || '', url: `/api/v1/files/${id}` }; }), location: m.location_lat === null ? null : { lat: m.location_lat, lng: m.location_lng, accuracy: m.location_accuracy_m, addressText: m.location_address_text }, createdAt: m.created_at };
}
export function registerChatRoutes(app, r) {
    r.get('/orders/:id/messages', auth, (ctx) => {
        canAccess(app, ctx.params.id, ctx);
        const { limit, cursor } = pageParams(ctx.query);
        const c = cursorSql('m', cursor);
        const rows = app.db.all(`SELECT m.* FROM order_messages m WHERE m.order_id=?${c.sql} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`, ctx.params.id, ...c.params, limit + 1);
        const { items, nextCursor } = finishPage(rows, limit);
        return { messages: items.reverse().map(x => out(app, x)), nextCursor };
    });
    r.post('/orders/:id/messages', auth, roles('CUSTOMER', 'PROVIDER'), (ctx) => {
        const o = canAccess(app, ctx.params.id, ctx);
        if (['CANCELLED'].includes(o.status))
            throw E.unprocessable('لا يمكن مراسلة الطلب بعد إلغائه', 'ORDER_CLOSED');
        const b = parse(bodySchema, ctx.body);
        const idem = String(ctx.req.headers['idempotency-key'] || '').trim();
        return app.db.tx(() => {
            if (idem) {
                const old = app.db.get('SELECT * FROM order_messages WHERE order_id=? AND sender_id=? AND idempotency_key=?', o.id, ctx.user.id, idem);
                if (old) {
                    ctx.status = 200;
                    return { message: out(app, old), idempotent: true };
                }
            }
            const attachmentFileIds = (b.attachmentFileIds || []).filter((id) => !!app.db.get(`SELECT id FROM files WHERE id=? AND owner_id=? AND purpose='order_attachment'`, id, ctx.user.id));
            if ((b.attachmentFileIds || []).length !== attachmentFileIds.length)
                throw E.unprocessable('يوجد ملف مرفق غير صالح', 'INVALID_ATTACHMENT');
            if (!b.body?.trim() && !b.location && !attachmentFileIds.length)
                throw E.unprocessable('اكتب رسالة أو أرسل ملفًا أو أرسل موقعًا', 'MESSAGE_EMPTY');
            const last = app.db.get('SELECT created_at FROM order_messages WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 1', o.id);
            const nowMs = app.clock.now();
            const lastMs = last?.created_at ? Date.parse(last.created_at) : NaN;
            const createdAt = new Date(Math.max(nowMs, Number.isFinite(lastMs) ? lastMs + 1 : nowMs)).toISOString();
            const id = uuid();
            app.db.run('INSERT INTO order_messages(id,order_id,sender_id,sender_role,body,attachments,idempotency_key,location_lat,location_lng,location_accuracy_m,location_address_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, o.id, ctx.user.id, ctx.user.role, (b.body || '').trim() || (attachmentFileIds.length ? '📎 ملف مرفق' : '📍 الموقع المرسل'), JSON.stringify(attachmentFileIds), idem || null, b.location?.lat ?? null, b.location?.lng ?? null, b.location?.accuracy ?? null, b.location?.addressText ?? null, createdAt);
            executionEvent(app, o.id, 'CHAT_MESSAGE', 'رسالة جديدة في محادثة الطلب', undefined, ctx.user.role, ctx.user.id, { messageId: id });
            const senderName = app.db.get('SELECT full_name FROM users WHERE id=?', ctx.user.id)?.full_name || 'مشارك في الطلب';
            const targets = new Set();
            if (o.customer_id !== ctx.user.id)
                targets.add(o.customer_id);
            if (o.provider_id) {
                const p = app.db.get('SELECT user_id FROM service_providers WHERE id=?', o.provider_id);
                if (p && p.user_id !== ctx.user.id)
                    targets.add(p.user_id);
            }
            for (const uid of targets) {
                const code = app.db.get('SELECT code FROM orders WHERE id=?', o.id)?.code || '';
                app.notifications.notify(uid, 'CHAT_MESSAGE', { code, sender: senderName }, { orderId: o.id, open: 'chat' });
                app.sse.send(uid, 'chat_message', { orderId: o.id, message: out(app, app.db.get('SELECT * FROM order_messages WHERE id=?', id)) });
            }
            ctx.status = 201;
            return { message: out(app, app.db.get('SELECT * FROM order_messages WHERE id=?', id)) };
        });
    });
}
//# sourceMappingURL=chat.js.map
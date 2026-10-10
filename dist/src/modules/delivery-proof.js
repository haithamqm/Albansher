import crypto from 'node:crypto';
import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { auth, roles } from './auth.middleware.js';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const pin = () => String(crypto.randomInt(1_000_000)).padStart(6, '0');
export function registerDeliveryProofRoutes(app, r) {
    const { db } = app;
    r.post('/orders/:id/delivery-proof/issue', auth, roles('CUSTOMER'), (ctx) => {
        const o = db.get('SELECT o.*, s.delivery_proof_type FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=? AND o.customer_id=?', ctx.params.id, ctx.user.id);
        if (!o)
            throw E.notFound('الطلب غير موجود');
        if (o.delivery_proof_type !== 'PIN')
            throw E.unprocessable('هذا الطلب لا يحتاج رمز تسليم', 'PROOF_NOT_REQUIRED');
        if (['COMPLETED', 'CANCELLED'].includes(o.status))
            throw E.unprocessable('لا يمكن إنشاء رمز لطلب مكتمل أو ملغي', 'INVALID_ORDER_STATE');
        const code = pin();
        db.run('UPDATE orders SET delivery_pin_hash=?,delivery_proof_verified_at=NULL,delivery_proof_verified_by=NULL,delivery_proof_method=NULL,updated_at=? WHERE id=?', sha(code), new Date(app.clock.now()).toISOString(), o.id);
        return { pin: code };
    });
    r.post('/orders/:id/delivery-proof/recipient-confirm', auth, roles('CUSTOMER'), (ctx) => {
        const b = parse(s.obj({ recipientName: s.str({ min: 2, max: 120 }) }), ctx.body);
        const o = db.get('SELECT o.*, s.delivery_proof_type FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=? AND o.customer_id=?', ctx.params.id, ctx.user.id);
        if (!o)
            throw E.notFound('الطلب غير موجود');
        if (o.delivery_proof_type !== 'RECIPIENT_CONFIRMATION')
            throw E.unprocessable('هذا الطلب لا يستخدم تأكيد المستلم', 'PROOF_NOT_REQUIRED');
        if (!['ON_THE_WAY', 'IN_PROGRESS'].includes(o.status))
            throw E.unprocessable('لا يمكن تأكيد التسليم في هذه الحالة', 'INVALID_ORDER_STATE');
        const now = new Date(app.clock.now()).toISOString();
        db.run('UPDATE orders SET delivery_proof_verified_at=?,delivery_proof_verified_by=?,delivery_proof_method=?,delivery_proof_recipient_name=?,delivery_proof_recipient_confirmed_at=?,updated_at=?,version=version+1 WHERE id=?', now, ctx.user.id, 'RECIPIENT_CONFIRMATION', b.recipientName, now, now, o.id);
        const providerUser = o.provider_id ? db.get('SELECT user_id FROM service_providers WHERE id=?', o.provider_id) : null;
        app.notifications.notify(providerUser?.user_id || o.customer_id, 'DELIVERY_PROOF_VERIFIED', { code: o.code }, { orderId: o.id });
        return { ok: true, verifiedAt: now, method: 'RECIPIENT_CONFIRMATION', recipientName: b.recipientName };
    });
    r.post('/provider/orders/:id/delivery-proof/photo', auth, roles('PROVIDER'), (ctx) => {
        const b = parse(s.obj({ fileId: s.str({ min: 10, max: 64 }) }), ctx.body);
        const o = db.get('SELECT o.*, s.delivery_proof_type FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=? AND o.provider_id=?', ctx.params.id, ctx.user.providerId);
        if (!o)
            throw E.notFound('الطلب غير موجود');
        if (o.delivery_proof_type !== 'PHOTO')
            throw E.unprocessable('هذا الطلب لا يستخدم إثبات الصورة', 'PROOF_NOT_REQUIRED');
        const f = db.get("SELECT id FROM files WHERE id=? AND owner_id=? AND purpose='work_photo'", b.fileId, ctx.user.id);
        if (!f)
            throw E.unprocessable('الصورة غير صالحة أو لا تخص مقدم الخدمة', 'INVALID_PROOF_FILE');
        if (!['ON_THE_WAY', 'IN_PROGRESS'].includes(o.status))
            throw E.unprocessable('لا يمكن رفع إثبات التسليم في هذه الحالة', 'INVALID_ORDER_STATE');
        const now = new Date(app.clock.now()).toISOString();
        db.run('UPDATE orders SET delivery_proof_verified_at=?,delivery_proof_verified_by=?,delivery_proof_method=?,delivery_proof_file_id=?,updated_at=?,version=version+1 WHERE id=?', now, ctx.user.id, 'PHOTO', b.fileId, now, o.id);
        app.notifications.notify(o.customer_id, 'DELIVERY_PROOF_VERIFIED', { code: o.code }, { orderId: o.id });
        return { ok: true, verifiedAt: now, method: 'PHOTO', fileId: b.fileId };
    });
    r.post('/provider/orders/:id/delivery-proof/verify', auth, roles('PROVIDER'), (ctx) => {
        const b = parse(s.obj({ pin: s.str({ min: 6, max: 6, pattern: /^\d{6}$/ }) }), ctx.body);
        return db.tx(() => {
            const o = db.get('SELECT o.*, s.delivery_proof_type FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=? AND o.provider_id=?', ctx.params.id, ctx.user.providerId);
            if (!o)
                throw E.notFound('الطلب غير موجود');
            if (o.delivery_proof_type !== 'PIN')
                throw E.unprocessable('هذا الطلب لا يحتاج رمز تسليم', 'PROOF_NOT_REQUIRED');
            if (!o.delivery_pin_hash)
                throw E.unprocessable('لم يتم إصدار رمز التسليم للعميل بعد', 'PROOF_NOT_ISSUED');
            if (!crypto.timingSafeEqual(Buffer.from(o.delivery_pin_hash), Buffer.from(sha(b.pin))))
                throw E.unprocessable('رمز التسليم غير صحيح', 'INVALID_DELIVERY_PIN');
            const now = new Date(app.clock.now()).toISOString();
            db.run('UPDATE orders SET delivery_proof_verified_at=?,delivery_proof_verified_by=?,delivery_proof_method=?,updated_at=?,version=version+1 WHERE id=? AND version=?', now, ctx.user.id, 'PIN', now, o.id, o.version);
            app.notifications.notify(o.customer_id, 'DELIVERY_PROOF_VERIFIED', { code: o.code }, { orderId: o.id });
            return { ok: true, verifiedAt: now, method: 'PIN' };
        });
    });
}
//# sourceMappingURL=delivery-proof.js.map
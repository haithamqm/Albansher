import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, tr, pageParams, cursorSql, finishPage, parseJson } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import { locationSchema } from './locations.js';
import { validateFormData } from './catalog.js';
import { canTransition, CANCELLABLE_ORDER, statusIndex } from '../../shared/orderStateMachine.js';
import { serializeTrip } from './trips.js';
import { executionEvent } from './execution.js';
const createOrderSchema = s.obj({
    serviceId: s.str({ min: 1, max: 64 }),
    description: s.str({ min: 5, max: 1000 }),
    location: { ...locationSchema, optional: true },
    areaId: s.str({ max: 64, optional: true }),
    addressId: s.str({ max: 64, optional: true }),
    contactPhone: s.str({ min: 8, max: 24 }),
    scheduledAt: s.date({ optional: true }),
    priority: s.oneOf(['LOW', 'NORMAL', 'URGENT'], { optional: true }),
    formData: s.any({ optional: true }),
    notes: s.str({ max: 500, optional: true }),
    attachmentFileIds: s.arr(s.str({ max: 64 }), { max: 10, optional: true }),
    tasks: s.arr(s.obj({ title: s.str({ min: 2, max: 200 }), taskType: s.str({ min: 2, max: 50, optional: true }), details: s.str({ max: 1000, optional: true }) }), { max: 20, optional: true }),
    recipientName: s.str({ max: 80, optional: true }), recipientPhone: s.str({ max: 24, optional: true }), recipientUserId: s.str({ max: 64, optional: true }), assistantSessionId: s.str({ max: 64, optional: true }),
});
const isParticipant = (o, ctx) => {
    if (!ctx.user)
        return false;
    if (ctx.user.role === 'ADMIN')
        return true;
    if (ctx.user.role === 'CUSTOMER')
        return o.customer_id === ctx.user.id;
    if (ctx.user.role === 'PROVIDER') {
        if (o.provider_id === ctx.user.providerId)
            return true;
        return !!ctx.app.db.get('SELECT 1 FROM order_assignments WHERE order_id = ? AND provider_id = ?', o.id, ctx.user.providerId);
    }
    return false;
};
export function createOrders(app) {
    const { db, catalog } = app;
    const svc = {
        serialize(o, ctx) {
            const x = catalog.all().byService.get(o.service_id);
            const cat = catalog.all().byCategory.get(x.category_id);
            const loc = db.get('SELECT * FROM locations WHERE id = ?', o.location_id);
            const locationProvided = o.location_provided !== 0;
            const isOwnerCustomer = ctx.user?.role === 'CUSTOMER' && ctx.user.id === o.customer_id;
            const approx = ctx.user?.role === 'PROVIDER' && o.provider_id !== ctx.user.providerId; // مزود لم يُسند له بعد: موقع تقريبي فقط
            const out = {
                id: o.id, code: o.code, status: o.status, priority: o.priority, description: o.description, formData: parseJson(o.form_data, {}) ?? {},
                service: { id: x.id, name: tr(x.name_i18n, ctx.locale), icon: x.icon, categoryName: tr(cat?.name_i18n, ctx.locale) },
                location: locationProvided ? app.locations.serialize(loc, ctx.locale, { approximate: approx }) : null,
                contactPhone: (ctx.user?.role === 'PROVIDER' || approx) ? null : o.contact_phone, recipient: (!approx && (isOwnerCustomer || ctx.user?.role === 'ADMIN')) && o.recipient_name ? { fullName: o.recipient_name, phone: o.recipient_phone || '' } : null, scheduledAt: o.scheduled_at, pricingType: o.pricing_type, priceSnapshot: o.price_snapshot, agreedPrice: o.agreed_price,
                currency: o.currency, paymentMethod: o.payment_method, notes: isOwnerCustomer || ctx.user?.role === 'ADMIN' ? o.customer_notes : null,
                attachments: (parseJson(o.attachments, []) ?? []).map((id) => `/api/v1/files/${id}`), wave: o.wave,
                createdAt: o.created_at, acceptedAt: o.accepted_at, startedAt: o.started_at, completedAt: o.completed_at, cancelledAt: o.cancelled_at, cancelReason: o.cancel_reason, commissionRate: o.commission_rate_snapshot, commissionAmount: o.commission_amount, providerPayoutAmount: o.provider_payout_amount, settlementStatus: o.settlement_status,
            };
            if (ctx.user?.role === 'PROVIDER' || ctx.user?.role === 'ADMIN') {
                const cu = db.get('SELECT id, full_name, phone, avatar_file_id FROM users WHERE id = ?', o.customer_id);
                out.customer = { id: cu.id, fullName: cu.full_name, phone: ctx.user?.role === 'ADMIN' ? cu.phone : null, avatarUrl: cu.avatar_file_id ? `/api/v1/files/${cu.avatar_file_id}` : null };
            }
            const trip = serializeTrip(app, o.id, ctx.locale);
            if (trip)
                out.trip = trip;
            if (o.provider_id) {
                const p = app.providers.summary(o.provider_id, ctx.locale);
                out.provider = { id: p.id, displayName: p.displayName, avatarUrl: p.avatarUrl, rating: p.rating.avg };
            }
            else
                out.provider = null;
            return out;
        },
        getOwned(orderId, ctx) {
            const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
            if (!o || !isParticipant(o, ctx))
                throw E.notFound('الطلب غير موجود');
            return o;
        },
        applyTransition(o, to, actorRole, ctx, { reason, metadata } = {}) {
            if (!canTransition(o.status, to, actorRole))
                throw E.unprocessable(`لا يمكن الانتقال من ${o.status} إلى ${to}`, 'INVALID_TRANSITION');
            const now = iso(app.clock.now());
            const extra = { updated_at: now };
            if (to === 'ACCEPTED')
                extra['accepted_at'] = now;
            if (to === 'ON_THE_WAY') { /* لا حقل زمني مخصص */ }
            if (to === 'IN_PROGRESS')
                extra['started_at'] = now;
            if (to === 'COMPLETED')
                extra['completed_at'] = now;
            if (to === 'CANCELLED')
                extra['cancelled_at'] = now;
            const setSql = Object.keys(extra).map((k) => `${k} = ?`).concat('status = ?', 'version = version + 1').join(', ');
            const res = db.run(`UPDATE orders SET ${setSql} WHERE id = ? AND version = ?`, ...Object.values(extra), to, o.id, o.version);
            if (!res.changes)
                throw E.conflict('تم تعديل الطلب من عملية أخرى، أعد المحاولة', 'VERSION_CONFLICT');
            db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,reason,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)', o.id, o.status, to, ctx.user?.id ?? null, actorRole, reason ?? null, metadata ? JSON.stringify(metadata) : null, now);
            executionEvent(app, o.id, 'STATUS', `تغيرت حالة الطلب إلى ${to}`, reason, actorRole, ctx.user?.id, metadata || {});
            if (to === 'ACCEPTED' || to === 'CANCELLED' || to === 'COMPLETED')
                db.run('UPDATE intent_audit SET outcome=?,updated_at=? WHERE order_id=?', to, now, o.id);
            if (to === 'COMPLETED' && o.provider_id) {
                const gross = Number(o.agreed_price ?? o.price_snapshot ?? 0);
                const commissionRate = Number(app.settings.get('platform.commission_percent') || 0);
                const commissionAmount = Math.round(gross * commissionRate) / 100;
                const payoutAmount = Math.max(0, gross - commissionAmount);
                db.run(`UPDATE orders SET commission_rate_snapshot=?,commission_amount=?,provider_payout_amount=?,settlement_status=?,completed_by=?,updated_at=? WHERE id=?`, commissionRate, commissionAmount, payoutAmount, commissionAmount > 0 ? 'DUE' : 'WAIVED', ctx.user?.id ?? null, now, o.id);
                if (commissionAmount > 0)
                    db.run(`INSERT OR IGNORE INTO provider_settlements(id,order_id,provider_id,gross_amount,commission_rate,commission_amount,payout_amount,currency,status,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), o.id, o.provider_id, gross, commissionRate, commissionAmount, payoutAmount, o.currency, 'DUE', now, now, now);
            }
            return db.get('SELECT * FROM orders WHERE id = ?', o.id);
        },
    };
    return svc;
}
function genCode(db, now) {
    const year = now.getUTCFullYear();
    const key = `order_seq_${year}`;
    db.run('INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', key);
    const n = db.get('SELECT value FROM counters WHERE name = ?', key).value;
    return `KH-${year}-${String(n).padStart(6, '0')}`;
}
export function registerOrderRoutes(app, r) {
    const { db, catalog, orders } = app;
    r.post('/orders', auth, roles('CUSTOMER'), (ctx) => {
        const b = parse(createOrderSchema, ctx.body);
        const svc = catalog.getActiveService(b.serviceId);
        if (!svc)
            throw E.notFound('الخدمة غير موجودة أو غير متاحة', 'SERVICE_NOT_FOUND');
        const fields = parseJson(svc.form_schema, []) ?? [];
        const formData = validateFormData(fields, b.formData);
        if (b.scheduledAt && Date.parse(b.scheduledAt) <= app.clock.now())
            throw E.unprocessable('موعد التنفيذ يجب أن يكون في المستقبل', 'SCHEDULED_TIME_PAST', [{ path: 'scheduledAt', message: 'اختر وقتًا قادمًا' }]);
        const idemKey = String(ctx.req.headers['idempotency-key'] || '') || null;
        return db.tx(() => {
            if (idemKey) {
                const dup = db.get('SELECT * FROM orders WHERE customer_id = ? AND idempotency_key = ?', ctx.user.id, idemKey);
                if (dup) {
                    ctx.status = 200;
                    return { order: orders.serialize(dup, ctx), idempotent: true };
                }
            }
            const activeCount = db.get(`SELECT COUNT(*) c FROM orders WHERE customer_id = ? AND status IN ('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')`, ctx.user.id).c;
            if (b.assistantSessionId && !db.get("SELECT 1 FROM assistant_sessions WHERE id=? AND customer_id=?", b.assistantSessionId, ctx.user.id))
                throw E.unprocessable('جلسة مساعد الطلب غير صالحة', 'INVALID_ASSISTANT_SESSION');
            if (activeCount >= app.settings.get('orders.max_active_per_customer'))
                throw E.unprocessable('لديك عدد كبير من الطلبات النشطة حاليًا', 'TOO_MANY_ACTIVE_ORDERS');
            let locRow;
            let locationProvided = true;
            let selectedAreaId = null;
            if (b.areaId) {
                const area = catalog.all().areas.find((a) => a.id === b.areaId && a.is_active);
                if (!area)
                    throw E.unprocessable('القرية أو المنطقة المحددة غير صالحة', 'INVALID_AREA');
                selectedAreaId = area.id;
            }
            if (b.addressId) {
                const addr = db.get('SELECT location_id FROM addresses WHERE id = ? AND user_id = ?', b.addressId, ctx.user.id);
                if (!addr)
                    throw E.unprocessable('العنوان غير موجود', 'INVALID_ADDRESS');
                locRow = db.get('SELECT * FROM locations WHERE id = ?', addr.location_id);
            }
            else if (b.location) {
                locRow = app.locations.create({ ...b.location, areaId: b.location.areaId || selectedAreaId || undefined }, { requireArea: false });
                if (selectedAreaId)
                    locRow = { ...locRow, area_id: selectedAreaId };
            }
            else {
                locRow = db.get('SELECT * FROM locations WHERE id=?', 'no-location');
                const systemArea = db.get("SELECT id FROM service_areas WHERE id IN ('system-yemen','yemen-unmapped') AND is_active=1 ORDER BY CASE id WHEN 'system-yemen' THEN 0 ELSE 1 END LIMIT 1");
                if (locRow && selectedAreaId)
                    locRow = { ...locRow, area_id: selectedAreaId };
                else if (locRow && systemArea && locRow.area_id !== systemArea.id)
                    locRow = { ...locRow, area_id: systemArea.id };
                if (!locRow)
                    throw E.unprocessable('تعذر حفظ الطلب بدون موقع حاليًا', 'LOCATION_PLACEHOLDER_MISSING');
                locationProvided = false;
            }
            // حماية إضافية من الضغط/الإرسال المكرر: إذا أرسل العميل نفس الطلب فعليًا
            // مرتين خلال ثوانٍ قليلة بنفس الخدمة والوصف والبيانات والموقع، نعيد الطلب
            // الموجود بدل إنشاء طلب ثانٍ برقم KH مختلف. هذا لا يمنع طلبًا جديدًا متعمدًا
            // بعد مرور المهلة أو تغيّر الموقع/الوصف/البيانات.
            const duplicateWindowMs = 60_000;
            const recent = db.all(`SELECT o.*, l.lat loc_lat, l.lng loc_lng FROM orders o JOIN locations l ON l.id=o.location_id
         WHERE o.customer_id=? AND o.service_id=? AND o.status IN ('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')
           AND o.created_at >= ? ORDER BY o.created_at DESC LIMIT 10`, ctx.user.id, svc.id, iso(app.clock.now() - duplicateWindowMs));
            const same = recent.find((x) => {
                if (x.description !== b.description || (x.contact_phone || '') !== b.contactPhone)
                    return false;
                if ((x.form_data || '') !== JSON.stringify(formData))
                    return false;
                if (x.scheduled_at !== (b.scheduledAt || null))
                    return false;
                if (x.location_provided === 0 && !locationProvided)
                    return true;
                if (x.location_provided === 0 || !locationProvided)
                    return false;
                const latDiff = Math.abs(Number(x.loc_lat) - Number(locRow.lat));
                const lngDiff = Math.abs(Number(x.loc_lng) - Number(locRow.lng));
                return latDiff < 0.00015 && lngDiff < 0.00015; // قرابة عشرات الأمتار، وليس قيدًا على الاستخدام الطبيعي.
            });
            if (same) {
                ctx.status = 200;
                return { order: orders.serialize(same, ctx), idempotent: true, duplicatePrevented: true };
            }
            const id = uuid();
            const now = new Date(app.clock.now());
            const nowIso = iso(app.clock.now());
            const code = genCode(db, now);
            const attachments = (b.attachmentFileIds || []).filter((fid) => db.get(`SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND purpose = 'order_attachment'`, fid, ctx.user.id));
            db.run(`INSERT INTO orders(id,code,customer_id,service_id,status,priority,description,form_data,location_id,area_id,contact_phone,scheduled_at,
                pricing_type,price_snapshot,currency,customer_notes,attachments,idempotency_key,recipient_name,recipient_phone,recipient_user_id,location_provided,assistant_session_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, code, ctx.user.id, svc.id, 'PENDING', b.priority || svc.default_priority, b.description, JSON.stringify(formData), locRow.id, locRow.area_id, b.contactPhone, b.scheduledAt || null, svc.pricing_type, svc.pricing_type === 'FIXED' ? svc.base_price : null, app.settings.get('platform.currency'), b.notes || null, JSON.stringify(attachments), idemKey, b.recipientName || null, b.recipientPhone || null, b.recipientUserId || null, locationProvided ? 1 : 0, b.assistantSessionId || null, nowIso, nowIso);
            db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,created_at) VALUES (?,?,?,?,?,?)', id, null, 'PENDING', ctx.user.id, 'CUSTOMER', nowIso);
            if (b.tasks?.length) {
                for (let i = 0; i < b.tasks.length; i++)
                    db.run('INSERT INTO order_tasks(id,order_id,sequence_no,title,task_type,status,details,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', uuid(), id, i + 1, b.tasks[i].title, b.tasks[i].taskType || 'GENERAL', 'PENDING', b.tasks[i].details || null, nowIso, nowIso);
                executionEvent(app, id, 'COMPOUND_TASKS_CREATED', 'إنشاء طلب مركب', `تم إنشاء ${b.tasks.length} مهام مرتبطة بالطلب`, 'CUSTOMER', ctx.user.id, { count: b.tasks.length });
            }
            if (b.assistantSessionId)
                db.run("UPDATE assistant_sessions SET status='CONFIRMED',updated_at=? WHERE id=? AND customer_id=?", nowIso, b.assistantSessionId, ctx.user.id);
            if (b.assistantSessionId)
                db.run('UPDATE intent_audit SET order_id=?,selected_service_id=?,updated_at=? WHERE assistant_session_id=? AND order_id IS NULL', id, svc.id, nowIso, b.assistantSessionId);
            let o = db.get('SELECT * FROM orders WHERE id = ?', id);
            o = orders.applyTransition(o, 'SEARCHING', 'SYSTEM', ctx, { reason: 'auto' });
            app.notifications.notify(ctx.user.id, 'ORDER_RECEIVED', { code: o.code });
            app.assignment.assignWave(o.id);
            o = db.get('SELECT * FROM orders WHERE id = ?', id);
            ctx.status = 201;
            return { order: orders.serialize(o, ctx) };
        });
    });
    r.get('/orders', auth, roles('CUSTOMER'), (ctx) => {
        const { limit, cursor } = pageParams(ctx.query);
        const c = cursorSql('o', cursor);
        const st = ctx.query['status'] ? ` AND o.status = ?` : '';
        const params = [ctx.user.id];
        if (ctx.query['status'])
            params.push(ctx.query['status']);
        const rows = db.all(`SELECT o.* FROM orders o WHERE o.customer_id = ?${st}${c.sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, ...params, ...c.params, limit + 1);
        const { items, nextCursor } = finishPage(rows, limit);
        return { orders: items.map((o) => orders.serialize(o, ctx)), nextCursor };
    });
    r.get('/orders/:id', auth, (ctx) => ({ order: orders.serialize(orders.getOwned(ctx.params['id'], ctx), ctx) }));
    r.get('/orders/:id/history', auth, (ctx) => {
        const o = orders.getOwned(ctx.params['id'], ctx);
        const rows = db.all('SELECT id, from_status, to_status, changed_by, actor_role, reason, created_at FROM order_status_history WHERE order_id = ? ORDER BY id', o.id);
        return { history: rows.map((h) => ({ fromStatus: h.from_status, toStatus: h.to_status, actorRole: h.actor_role, reason: h.reason, createdAt: h.created_at })) };
    });
    r.post('/orders/:id/cancel', auth, (ctx) => {
        const b = parse(s.obj({ reason: s.str({ max: 300, optional: true }) }), ctx.body);
        return db.tx(() => {
            const o = orders.getOwned(ctx.params['id'], ctx);
            if (!CANCELLABLE_ORDER.includes(o.status))
                throw E.unprocessable('لا يمكن إلغاء الطلب في هذه الحالة', 'NOT_CANCELLABLE');
            const actorRole = ctx.user.role;
            if (ctx.user.role === 'PROVIDER' && o.provider_id !== ctx.user.providerId)
                throw E.forbidden();
            if (actorRole === 'PROVIDER' && o.status === 'ACCEPTED' && app.settings.get('assignment.auto_reassign_provider_cancel')) {
                const oldProvider = o.provider_id;
                const result = app.assignment.reassignAfterProviderCancellation(o.id, oldProvider, b.reason || 'provider_cancelled');
                const fresh = db.get('SELECT * FROM orders WHERE id=?', o.id);
                ctx.status = 200;
                return { order: orders.serialize(fresh, ctx), reassigned: result.offered > 0 };
            }
            const policy = db.get(`SELECT cp.free_until_status, cp.fee_percent FROM cancellation_policies cp JOIN services s ON s.cancellation_policy_id = cp.id WHERE s.id = ?`, o.service_id);
            let fee = null;
            if (policy && actorRole === 'CUSTOMER' && o.price_snapshot && statusIndex(o.status) > statusIndex(policy.free_until_status))
                fee = Math.round(o.price_snapshot * (policy.fee_percent / 100) * 100) / 100;
            const now = iso(app.clock.now());
            db.run(`UPDATE orders SET status='CANCELLED', cancelled_by_role=?, cancel_reason=?, cancellation_fee=?, cancelled_at=?, updated_at=?, version=version+1 WHERE id=? AND version=?`, actorRole, b.reason || null, fee, now, now, o.id, o.version);
            db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,reason,created_at) VALUES (?,?,?,?,?,?,?)', o.id, o.status, 'CANCELLED', ctx.user.id, actorRole, b.reason || null, now);
            db.run(`UPDATE order_assignments SET status='WITHDRAWN', responded_at=? WHERE order_id=? AND status='OFFERED'`, now, o.id);
            db.run(`UPDATE quotes SET status='WITHDRAWN', updated_at=? WHERE order_id=? AND status='SUBMITTED'`, now, o.id);
            if (o.provider_id)
                app.payment.onCancelled(db.get('SELECT * FROM orders WHERE id = ?', o.id));
            const notifyTargets = new Set([o.customer_id]);
            if (o.provider_id) {
                const pu = db.get('SELECT user_id FROM service_providers WHERE id = ?', o.provider_id);
                if (pu)
                    notifyTargets.add(pu.user_id);
            }
            for (const uid of notifyTargets)
                if (uid !== ctx.user.id)
                    app.notifications.notify(uid, 'ORDER_CANCELLED', { code: o.code, reason: b.reason || '' }, { orderId: o.id });
            return { order: orders.serialize(db.get('SELECT * FROM orders WHERE id = ?', o.id), ctx) };
        });
    });
    r.get('/orders/:id/payment', auth, (ctx) => {
        const o = orders.getOwned(ctx.params['id'], ctx);
        const p = db.get('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1', o.id);
        return { payment: p ? { id: p.id, method: p.method, status: p.status, amount: p.amount, currency: p.currency, providerRef: p.provider_ref, createdAt: p.created_at, updatedAt: p.updated_at } : null };
    });
    r.get('/admin/orders', auth, (ctx) => {
        if (ctx.user.role !== 'ADMIN')
            throw E.forbidden();
        const { limit, cursor } = pageParams(ctx.query);
        const c = cursorSql('o', cursor);
        const where = [];
        const params = [];
        if (ctx.query['status']) {
            where.push('o.status = ?');
            params.push(ctx.query['status']);
        }
        if (ctx.query['areaId']) {
            where.push('o.area_id = ?');
            params.push(ctx.query['areaId']);
        }
        if (ctx.query['providerId']) {
            where.push('o.provider_id = ?');
            params.push(ctx.query['providerId']);
        }
        if (ctx.query['categoryId']) {
            where.push('EXISTS (SELECT 1 FROM services s WHERE s.id = o.service_id AND s.category_id = ?)');
            params.push(ctx.query['categoryId']);
        }
        const rows = db.all(`SELECT o.* FROM orders o WHERE 1=1 ${where.map((w) => 'AND ' + w).join(' ')}${c.sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, ...params, ...c.params, limit + 1);
        const { items, nextCursor } = finishPage(rows, limit);
        return { orders: items.map((o) => orders.serialize(o, ctx)), nextCursor };
    });
}
//# sourceMappingURL=orders.js.map
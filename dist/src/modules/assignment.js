import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, tr } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import { canTransition, PROVIDER_STEPS } from '../../shared/orderStateMachine.js';
export function createAssignmentService(app) {
    const { db, catalog } = app;
    const notifiedExhausted = new Set(); // إزالة تكرار إشعار «لم نجد مقدم خدمة» لكل طلب — حالة عملية واحدة (تُعاد عند إعادة الإسناد يدويًا)
    const svc = {
        assignWave(orderId) {
            return db.tx(() => {
                const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
                if (!['SEARCHING', 'ASSIGNED'].includes(o.status) || o.provider_id)
                    return { offered: 0 };
                const excludeProviderIds = db.all("SELECT DISTINCT provider_id FROM order_assignments WHERE order_id = ? AND status IN ('REJECTED','EXPIRED','ACCEPTED')", orderId).map((x) => x.provider_id);
                // نرسل العرض إلى الأقرب فقط؛ عند الرفض/انتهاء المهلة ينتقل إلى التالي الأقرب.
                const batch = o.pricing_type === 'QUOTE' ? app.settings.get('assignment.batch_size') : 1;
                const candidates = app.matcher.findCandidates(o, { excludeProviderIds, limit: batch });
                if (!candidates.length)
                    return { offered: 0 };
                const wave = o.wave + 1;
                const ttlMs = app.settings.get('assignment.offer_ttl_sec') * 1000;
                const now = app.clock.now();
                const nowIso = iso(now);
                const expiresAt = iso(now + ttlMs);
                for (const c of candidates) {
                    const existing = db.get('SELECT id FROM order_assignments WHERE order_id=? AND provider_id=?', o.id, c.providerId);
                    if (existing)
                        db.run("UPDATE order_assignments SET status='OFFERED',wave=?,score=?,distance_km=?,offered_at=?,expires_at=?,responded_at=NULL,decision_reason=NULL WHERE id=?", wave, c.score, c.distanceKm, nowIso, expiresAt, existing.id);
                    else
                        db.run('INSERT INTO order_assignments(id,order_id,provider_id,status,wave,score,distance_km,offered_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', uuid(), o.id, c.providerId, 'OFFERED', wave, c.score, c.distanceKm, nowIso, expiresAt);
                }
                const wasSearching = o.status === 'SEARCHING';
                db.run('UPDATE orders SET status=?, wave=?, search_exhausted_at=NULL, updated_at=?, version=version+1 WHERE id=? AND version=?', 'ASSIGNED', wave, nowIso, o.id, o.version);
                if (wasSearching)
                    db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,reason,created_at) VALUES (?,?,?,?,?,?,?)', o.id, 'SEARCHING', 'ASSIGNED', null, 'SYSTEM', `wave ${wave}`, nowIso);
                const svcRow = catalog.all().byService.get(o.service_id);
                const areaRow = catalog.all().areas.find((a) => a.id === o.area_id);
                for (const c of candidates) {
                    const p = db.get('SELECT user_id FROM service_providers WHERE id = ?', c.providerId);
                    app.notifications.notify(p.user_id, 'NEW_OFFER', { service: tr(svcRow.name_i18n, 'ar'), area: areaRow ? tr(areaRow.name_i18n, 'ar') : '' }, { orderId: o.id });
                }
                notifiedExhausted.delete(o.id);
                return { offered: candidates.length };
            });
        },
        offerOpenOrdersToProvider(providerId) {
            // الطلبات المفتوحة لا تعتمد على وقت فتح مقدم الخدمة ولا على مهلة عمر للطلب.
            // إذا كان الطلب ما زال SEARCHING/ASSIGNED ولم يُسند، فيجب أن يدخل المطابقة
            // لمقدم خدمة مناسب حتى لو أُنشئ قبل دخوله استقبال الطلبات بوقت.
            const rows = db.all(`SELECT * FROM orders WHERE status IN ('SEARCHING','ASSIGNED') AND provider_id IS NULL ORDER BY created_at ASC LIMIT 500`);
            let offered = 0;
            for (const o of rows) {
                const excluded = db.all("SELECT provider_id FROM order_assignments WHERE order_id=? AND provider_id=? AND status IN ('REJECTED','EXPIRED','ACCEPTED')", o.id, providerId);
                if (excluded.length)
                    continue;
                const candidates = app.matcher.findCandidates(o, { excludeProviderIds: [], limit: 50 });
                const candidate = candidates.find((c) => c.providerId === providerId);
                if (!candidate)
                    continue;
                const nowIso = iso(app.clock.now());
                const expiresAt = iso(app.clock.now() + app.settings.get('assignment.offer_ttl_sec') * 1000);
                const wave = o.wave + 1;
                const existing = db.get('SELECT id FROM order_assignments WHERE order_id=? AND provider_id=?', o.id, providerId);
                if (existing)
                    db.run("UPDATE order_assignments SET status='OFFERED',wave=?,score=?,distance_km=?,offered_at=?,expires_at=?,responded_at=NULL,decision_reason=NULL WHERE id=?", wave, candidate.score, candidate.distanceKm, nowIso, expiresAt, existing.id);
                else
                    db.run('INSERT INTO order_assignments(id,order_id,provider_id,status,wave,score,distance_km,offered_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', uuid(), o.id, providerId, 'OFFERED', wave, candidate.score, candidate.distanceKm, nowIso, expiresAt);
                if (o.status === 'SEARCHING')
                    db.run("UPDATE orders SET status='ASSIGNED',wave=?,search_exhausted_at=NULL,updated_at=?,version=version+1 WHERE id=? AND version=?", wave, nowIso, o.id, o.version);
                app.notifications.notify(db.get('SELECT user_id FROM service_providers WHERE id=?', providerId).user_id, 'NEW_OFFER', { service: tr(catalog.all().byService.get(o.service_id).name_i18n, 'ar') }, { orderId: o.id });
                offered++;
            }
            return { offered };
        },
        reassignAfterProviderCancellation(orderId, providerId, reason = 'provider_cancelled') {
            const result = db.tx(() => {
                const o = db.get('SELECT * FROM orders WHERE id=?', orderId);
                if (!o || o.provider_id !== providerId || !['ACCEPTED'].includes(o.status))
                    return { offered: 0 };
                const nowIso = iso(app.clock.now());
                db.run(`UPDATE order_assignments SET status='WITHDRAWN', responded_at=?, decision_reason='انتقل العرض لمقدم خدمة آخر' WHERE order_id=? AND status='OFFERED'`, nowIso, orderId);
                db.run(`UPDATE order_assignments SET status='REJECTED', responded_at=?, decision_reason='رفض مقدم الخدمة' WHERE order_id=? AND provider_id=? AND status='ACCEPTED'`, nowIso, orderId, providerId);
                db.run(`UPDATE orders SET status='SEARCHING', provider_id=NULL, accepted_at=NULL, agreed_price=NULL, search_exhausted_at=NULL, wave=0, updated_at=?, version=version+1 WHERE id=? AND provider_id=? AND status='ACCEPTED'`, nowIso, orderId, providerId);
                db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,reason,created_at) VALUES (?,?,?,?,?,?,?)', orderId, 'ACCEPTED', 'SEARCHING', null, 'SYSTEM', reason, nowIso);
                app.notifications.notify(o.customer_id, 'PROVIDER_REASSIGNED', { code: o.code });
                const p = db.get('SELECT user_id FROM service_providers WHERE id=?', providerId);
                if (p)
                    app.notifications.notify(p.user_id, 'ORDER_REASSIGNED', { code: o.code }, { orderId });
                return { offered: 0 };
            });
            const r = svc.assignWave(orderId);
            return r.offered ? r : result;
        },
        acceptOffer(assignmentId, ctx) {
            const providerId = ctx.user.providerId;
            return db.tx(() => {
                const a = db.get('SELECT * FROM order_assignments WHERE id = ? AND provider_id = ?', assignmentId, providerId);
                if (!a)
                    throw E.notFound('العرض غير موجود');
                // Idempotency: if the same provider already accepted this offer, return the accepted order
                // instead of showing a false error after a duplicate/concurrent request.
                if (a.status === 'ACCEPTED') {
                    const already = db.get("SELECT * FROM orders WHERE id = ? AND provider_id = ? AND status = 'ACCEPTED'", a.order_id, providerId);
                    if (already)
                        return already;
                    throw E.conflict('هذا العرض لم يعد متاحًا', 'OFFER_NOT_AVAILABLE');
                }
                if (a.status !== 'OFFERED')
                    throw E.conflict('هذا العرض لم يعد متاحًا', 'OFFER_NOT_AVAILABLE');
                const now = app.clock.now();
                const nowIso = iso(now);
                if (Date.parse(a.expires_at) <= now) {
                    db.run(`UPDATE order_assignments SET status='EXPIRED', responded_at=?, decision_reason='انتهت مهلة الاستجابة' WHERE id=?`, nowIso, a.id);
                    throw E.conflict('انتهت مهلة هذا العرض', 'OFFER_EXPIRED');
                }
                const o = db.get('SELECT * FROM orders WHERE id = ?', a.order_id);
                const trip = db.get('SELECT s.slug service_slug FROM services s WHERE s.id=?', o.service_id);
                if (trip?.service_slug === 'motorcycle-trips' && !db.get('SELECT 1 FROM provider_vehicles WHERE provider_id=? AND status=\'VERIFIED\' AND is_active=1', providerId)) {
                    throw E.forbidden('لا يمكن قبول مشوار بالدباب قبل اعتماد مركبة صالحة', 'VERIFIED_VEHICLE_REQUIRED');
                }
                const existingQuote = db.get(`SELECT status FROM quotes WHERE order_id=? AND provider_id=? ORDER BY created_at DESC LIMIT 1`, o.id, providerId);
                if (existingQuote?.status === 'SUBMITTED')
                    throw E.conflict('تم تقديم عرض سعر لهذا الطلب بالفعل، اختر قرار العميل على العرض.', 'QUOTE_ALREADY_SUBMITTED');
                const res = db.run(`UPDATE orders SET status='ACCEPTED', provider_id=?, agreed_price=price_snapshot, accepted_at=?, search_exhausted_at=NULL, updated_at=?, version=version+1
                             WHERE id=? AND status IN ('SEARCHING','ASSIGNED') AND provider_id IS NULL`, providerId, nowIso, nowIso, o.id);
                if (!res.changes) {
                    db.run(`UPDATE order_assignments SET status='EXPIRED', responded_at=?, decision_reason='انتهت مهلة الاستجابة' WHERE id=?`, nowIso, a.id);
                    throw E.conflict('سبقك مقدم خدمة آخر إلى هذا الطلب', 'ORDER_ALREADY_TAKEN');
                }
                db.run(`UPDATE order_assignments SET status='ACCEPTED', responded_at=?, decision_reason='تم قبول العرض' WHERE id=?`, nowIso, a.id);
                db.run("UPDATE intent_audit SET selected_provider_id=?,assignment_result='ACCEPTED',updated_at=? WHERE order_id=?", providerId, nowIso, o.id);
                db.run(`UPDATE order_assignments SET status='WITHDRAWN', responded_at=?, decision_reason='انتقل العرض لمقدم خدمة آخر' WHERE order_id=? AND status='OFFERED' AND id != ?`, nowIso, o.id, a.id);
                db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,created_at) VALUES (?,?,?,?,?,?)', o.id, o.status, 'ACCEPTED', ctx.user.id, 'PROVIDER', nowIso);
                app.payment.onAccepted(db.get('SELECT * FROM orders WHERE id = ?', o.id));
                const p = app.providers.summary(providerId);
                app.notifications.notify(o.customer_id, 'ORDER_ACCEPTED', { code: o.code, provider: p.displayName }, { orderId: o.id });
                return db.get('SELECT * FROM orders WHERE id = ?', o.id);
            });
        },
        rejectOffer(assignmentId, ctx) {
            const providerId = ctx.user.providerId;
            const now = iso(app.clock.now());
            const res = db.run(`UPDATE order_assignments SET status='REJECTED', responded_at=?, decision_reason='رفض مقدم الخدمة' WHERE id=? AND provider_id=? AND status='OFFERED'`, now, assignmentId, providerId);
            if (!res.changes)
                throw E.notFound('العرض غير موجود');
            const assignment = db.get('SELECT order_id FROM order_assignments WHERE id = ?', assignmentId);
            if (assignment) {
                db.run("UPDATE intent_audit SET assignment_result='REJECTED',updated_at=? WHERE order_id=? AND (assignment_result IS NULL OR assignment_result<>'ACCEPTED')", now, assignment.order_id);
                svc.assignWave(assignment.order_id);
            }
        },
        listOffers(providerId) {
            const now = iso(app.clock.now());
            return db.all(`SELECT a.*, o.code, o.service_id, o.area_id, o.priority, u.avatar_file_id customer_avatar_file_id FROM order_assignments a JOIN orders o ON o.id = a.order_id JOIN users u ON u.id=o.customer_id
          WHERE a.provider_id = ? AND a.status = 'OFFERED' AND a.expires_at > ? ORDER BY a.offered_at`, providerId, now)
                .map((a) => {
                const svcRow = catalog.all().byService.get(a.service_id);
                const areaRow = catalog.all().areas.find((x) => x.id === a.area_id);
                return { ...a, orderCode: a.code, serviceName: svcRow ? tr(svcRow.name_i18n, 'ar') : '', areaName: areaRow ? tr(areaRow.name_i18n, 'ar') : '', priority: a.priority, customerAvatarUrl: a.customer_avatar_file_id ? `/api/v1/files/${a.customer_avatar_file_id}` : null };
            });
        },
        tick() {
            const now = app.clock.now();
            const nowIso = iso(now);
            const expired = Number(db.run(`UPDATE order_assignments SET status='EXPIRED', responded_at=?, decision_reason='انتهت مهلة الاستجابة' WHERE status='OFFERED' AND expires_at <= ?`, nowIso, nowIso).changes);
            db.run("UPDATE intent_audit SET assignment_result='EXPIRED',updated_at=? WHERE order_id IN (SELECT order_id FROM order_assignments WHERE status='EXPIRED' AND responded_at=?) AND (assignment_result IS NULL OR assignment_result<>'ACCEPTED')", nowIso, nowIso);
            const stuck = db.all(`SELECT o.id, o.wave, o.search_exhausted_at FROM orders o WHERE o.status IN ('SEARCHING','ASSIGNED') AND o.provider_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM order_assignments a WHERE a.order_id = o.id AND a.status = 'OFFERED')`);
            let waved = 0, exhausted = 0;
            const maxWaves = app.settings.get('assignment.max_waves');
            const retryMs = app.settings.get('assignment.search_retry_minutes') * 60_000;
            for (const o of stuck) {
                if (o.wave < maxWaves && !o.search_exhausted_at) {
                    const r = svc.assignWave(o.id);
                    if (r.offered > 0) {
                        waved++;
                        continue;
                    }
                }
                if (!o.search_exhausted_at) {
                    const full = db.get('SELECT * FROM orders WHERE id = ?', o.id);
                    // عدم وجود مقدم خدمة الآن لا يعني انتهاء الطلب. يبقى الطلب مفتوحًا،
                    // وسيُعاد عرضه تلقائيًا عندما يدخل مقدم خدمة مناسب وضع استقبال الطلبات.
                    continue;
                }
                if (Date.parse(o.search_exhausted_at) + retryMs <= now) {
                    const full = db.get('SELECT * FROM orders WHERE id = ?', o.id);
                    db.run('UPDATE orders SET wave=0, search_exhausted_at=NULL, updated_at=?, version=version+1 WHERE id=?', nowIso, o.id);
                    const r = svc.assignWave(o.id);
                    if (r.offered > 0) {
                        waved++;
                        app.notifications.notify(full.customer_id, 'SEARCH_RETRY', { code: full.code }, { orderId: full.id });
                    }
                }
            }
            return { expired, waved, exhausted };
        },
    };
    return svc;
}
export function registerAssignmentRoutes(app, r) {
    const { db, orders } = app;
    const isProvider = [auth, roles('PROVIDER')];
    r.get('/provider/offers', ...isProvider, (ctx) => ({
        offers: app.assignment.listOffers(ctx.user.providerId).map((a) => {
            const pricingType = app.db.get('SELECT pricing_type FROM orders WHERE id=?', a.order_id)?.pricing_type || 'FIXED';
            const quote = pricingType === 'QUOTE' ? app.db.get('SELECT id, amount, status FROM quotes WHERE order_id=? AND provider_id=?', a.order_id, ctx.user.providerId) : undefined;
            return { id: a.id, orderId: a.order_id, orderCode: a.orderCode, serviceName: a.serviceName, areaName: a.areaName, priority: a.priority, customerAvatarUrl: a.customerAvatarUrl, distanceKm: a.distance_km, offeredAt: a.offered_at, expiresAt: a.expires_at, pricingType, quoteStatus: quote?.status || null, quoteId: quote?.id || null, quoteAmount: quote?.amount ?? null };
        })
    }));
    r.post('/provider/offers/:id/accept', ...isProvider, (ctx) => ({ order: orders.serialize(app.assignment.acceptOffer(ctx.params['id'], ctx), ctx) }));
    r.post('/provider/offers/:id/reject', ...isProvider, (ctx) => { app.assignment.rejectOffer(ctx.params['id'], ctx); return { ok: true }; });
    r.get('/provider/orders', ...isProvider, (ctx) => {
        const where = ctx.query['status'] ? ' AND status = ?' : '';
        const params = [ctx.user.providerId];
        if (ctx.query['status'])
            params.push(ctx.query['status']);
        const rows = db.all(`SELECT * FROM orders WHERE provider_id = ?${where} ORDER BY created_at DESC LIMIT 100`, ...params);
        return { orders: rows.map((o) => orders.serialize(o, ctx)) };
    });
    r.post('/provider/orders/:id/status', ...isProvider, (ctx) => {
        const b = parse(s.obj({ to: s.oneOf(['ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED']) }), ctx.body);
        return db.tx(() => {
            const o = db.get('SELECT * FROM orders WHERE id = ? AND provider_id = ?', ctx.params['id'], ctx.user.providerId);
            if (!o)
                throw E.notFound('الطلب غير موجود');
            if (PROVIDER_STEPS[o.status] !== b.to || !canTransition(o.status, b.to, 'PROVIDER'))
                throw E.unprocessable(`لا يمكن الانتقال من ${o.status} إلى ${b.to}`, 'INVALID_TRANSITION');
            const updated = orders.applyTransition(o, b.to, 'PROVIDER', ctx);
            if (b.to === 'COMPLETED') {
                const tripRow = db.get(`SELECT t.* FROM trip_orders t JOIN orders oo ON oo.id=t.order_id JOIN services s ON s.id=oo.service_id WHERE t.order_id=? AND s.slug='motorcycle-trips'`, o.id);
                if (tripRow) {
                    const pts = db.all('SELECT lat,lng FROM trip_location_history WHERE order_id=? ORDER BY id', o.id);
                    let actualKm = 0;
                    for (let i = 1; i < pts.length; i++) {
                        const R = 6371;
                        const dLat = (Number(pts[i].lat) - Number(pts[i - 1].lat)) * Math.PI / 180;
                        const dLng = (Number(pts[i].lng) - Number(pts[i - 1].lng)) * Math.PI / 180;
                        const a = Math.sin(dLat / 2) ** 2 + Math.cos(Number(pts[i - 1].lat) * Math.PI / 180) * Math.cos(Number(pts[i].lat) * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
                        actualKm += 2 * R * Math.asin(Math.sqrt(a));
                    }
                    if (actualKm > 0.05) {
                        actualKm = Math.round(actualKm * 10) / 10;
                        const base = Math.max(Number(tripRow.minimum_fare), Number(tripRow.base_fare) + actualKm * Number(tripRow.per_km_fare));
                        const finalFare = Math.round((base + Number(tripRow.waiting_total_minutes || 0) * Number(tripRow.waiting_per_minute_fare || 0)) / 50) * 50;
                        db.run('UPDATE trip_orders SET distance_km=?,fare=?,updated_at=? WHERE order_id=?', actualKm, finalFare, iso(app.clock.now()), o.id);
                        db.run('UPDATE orders SET agreed_price=?,price_snapshot=?,updated_at=?,version=version+1 WHERE id=?', finalFare, finalFare, iso(app.clock.now()), o.id);
                    }
                }
                const proof = db.get('SELECT delivery_proof_type FROM services WHERE id=?', o.service_id);
                if (proof?.delivery_proof_type && proof.delivery_proof_type !== 'NONE' && !db.get('SELECT 1 FROM orders WHERE id=? AND delivery_proof_verified_at IS NOT NULL', o.id))
                    throw E.unprocessable('يجب إكمال إثبات التسليم قبل إنهاء الطلب', 'DELIVERY_PROOF_REQUIRED');
                db.run('UPDATE service_providers SET completed_orders_count = completed_orders_count + 1, updated_at = ? WHERE id = ?', iso(app.clock.now()), o.provider_id);
                app.payment.onCompleted(updated);
            }
            const map = { ON_THE_WAY: 'PROVIDER_ON_THE_WAY', IN_PROGRESS: 'SERVICE_STARTED', COMPLETED: 'ORDER_COMPLETED' };
            app.notifications.notify(o.customer_id, map[b.to], { code: o.code }, { orderId: o.id });
            return { order: orders.serialize(updated, ctx) };
        });
    });
}
//# sourceMappingURL=assignment.js.map
import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';
import type { OrderRow, QuoteRow } from '../types/domain.js';

/**
 * عروض الأسعار (Quotes): لخدمات نوع QUOTE — عدة مزودين يقدّمون عرضًا، والعميل يقبل واحدًا فيُسند الطلب لصاحبه.
 * مرتبط فعليًا بقاعدة البيانات: لا بيانات وهمية.
 */
const quoteOut = (q: QuoteRow, providerName?: string) => ({
  id: q.id, orderId: q.order_id, providerId: q.provider_id, providerName, amount: q.amount, message: q.message,
  validUntil: q.valid_until, status: q.status, createdAt: q.created_at,
});

export function registerQuoteRoutes(app: App, r: Router): void {
  const { db, orders } = app;

  // مزود يقدّم عرض سعر لطلب QUOTE مُسنَد له إسناد OFFERED (لا يمكن التقديم بلا عرض إسناد نشط)
  r.post('/provider/orders/:id/quote', auth, roles('PROVIDER'), (ctx: Ctx) => {
    const b = parse<{ amount: number; message?: string; validHours?: number }>(
      s.obj({ amount: s.num({ min: 0, max: 100_000_000 }), message: s.str({ max: 500, optional: true }), validHours: s.int({ min: 1, max: 720, optional: true }) }), ctx.body);
    const providerId = ctx.user!.providerId!;
    return db.tx(() => {
      const o = db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', ctx.params['id']);
      if (!o) throw E.notFound('الطلب غير موجود');
      if (o.pricing_type !== 'QUOTE') throw E.unprocessable('هذه الخدمة بسعر ثابت ولا تحتاج عرض سعر', 'NOT_A_QUOTE_SERVICE');
      if (!['SEARCHING', 'ASSIGNED'].includes(o.status)) throw E.unprocessable('لا يمكن تقديم عرض لهذا الطلب الآن', 'ORDER_NOT_OPEN');
      const offered = db.get('SELECT 1 FROM order_assignments WHERE order_id = ? AND provider_id = ?', o.id, providerId);
      if (!offered) throw E.forbidden('هذا الطلب لم يُعرض عليك', 'NOT_OFFERED');
      const now = iso(app.clock.now());
      const validHours = b.validHours || app.settings.get<number>('quotes.default_valid_hours');
      const validUntil = iso(app.clock.now() + validHours * 3600_000);
      const existing = db.get<QuoteRow>('SELECT * FROM quotes WHERE order_id = ? AND provider_id = ?', o.id, providerId);
      if (existing) {
        if (existing.status === 'SUBMITTED') throw E.conflict('تم تقديم عرض سعر لهذا الطلب بالفعل', 'QUOTE_ALREADY_SUBMITTED');
        throw E.conflict('تم التعامل مع عرض السعر لهذا الطلب ولا يمكن تقديم عرض آخر', 'QUOTE_LOCKED');
      } else {
        db.run('INSERT INTO quotes(id,order_id,provider_id,amount,message,valid_until,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          uuid(), o.id, providerId, b.amount, b.message || null, validUntil, 'SUBMITTED', now, now);
      }
      const p = app.providers.summary(providerId);
      ctx.status = existing ? 200 : 201;
      const q = db.get<QuoteRow>('SELECT * FROM quotes WHERE order_id = ? AND provider_id = ?', o.id, providerId)!;
      app.notifications.notify(o.customer_id, 'NEW_QUOTE', { provider: p.displayName, amount: String(b.amount), code: o.code }, { orderId: o.id, quoteId: q.id });
      return { quote: quoteOut(q, p.displayName) };
    });
  });

  r.post('/provider/quotes/:id/withdraw', auth, roles('PROVIDER'), (ctx: Ctx) => {
    const now = iso(app.clock.now());
    const res = db.run(`UPDATE quotes SET status='WITHDRAWN', updated_at=? WHERE id=? AND provider_id=? AND status='SUBMITTED'`, now, ctx.params['id'], ctx.user!.providerId);
    if (!res.changes) throw E.notFound('العرض غير موجود');
    return { ok: true };
  });

  // العميل: عرض كل عروض طلبه
  r.get('/orders/:id/quotes', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const o = orders.getOwned(ctx.params['id']!, ctx);
    const now = iso(app.clock.now());
    // عروض منتهية الصلاحية تُغلق كسولًا عند القراءة (نفس فكرة الجدولة، مضمونة الاتساق دون انتظار الـtick)
    db.run(`UPDATE quotes SET status='EXPIRED', updated_at=? WHERE order_id=? AND status='SUBMITTED' AND valid_until IS NOT NULL AND valid_until <= ?`, now, o.id, now);
    const rows = db.all<QuoteRow & { display_name: string }>(
      `SELECT q.*, sp.display_name FROM quotes q JOIN service_providers sp ON sp.id = q.provider_id WHERE q.order_id = ? ORDER BY q.amount ASC`, o.id);
    return { quotes: rows.map((q) => quoteOut(q, q.display_name)) };
  });

  // العميل يرفض عرضًا محددًا دون إلغاء الطلب؛ تبقى بقية العروض والبحث متاحين.
  r.post('/orders/:id/quotes/:quoteId/reject', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    return db.tx(() => {
      const o = orders.getOwned(ctx.params['id']!, ctx);
      if (!['SEARCHING', 'ASSIGNED'].includes(o.status)) throw E.unprocessable('لا يمكن رفض عرض لهذا الطلب الآن', 'ORDER_NOT_OPEN');
      const q = db.get<QuoteRow>('SELECT * FROM quotes WHERE id = ? AND order_id = ?', ctx.params['quoteId'], o.id);
      if (!q) throw E.notFound('العرض غير موجود');
      if (q.status !== 'SUBMITTED') throw E.conflict('هذا العرض لم يعد متاحًا', 'QUOTE_NOT_AVAILABLE');
      db.run(`UPDATE quotes SET status='REJECTED', updated_at=? WHERE id=? AND status='SUBMITTED'`, iso(app.clock.now()), q.id);
      return { ok: true };
    });
  });

  // العميل يقبل عرضًا: يُسند الطلب لصاحبه ذرّيًا، ويُغلق بقية العروض والعروض المفتوحة
  r.post('/orders/:id/quotes/:quoteId/accept', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    return db.tx(() => {
      const o = orders.getOwned(ctx.params['id']!, ctx);
      if (!['SEARCHING', 'ASSIGNED'].includes(o.status)) throw E.unprocessable('لا يمكن قبول عرض لهذا الطلب الآن', 'ORDER_NOT_OPEN');
      const q = db.get<QuoteRow>('SELECT * FROM quotes WHERE id = ? AND order_id = ?', ctx.params['quoteId'], o.id);
      if (!q) throw E.notFound('العرض غير موجود');
      if (q.status !== 'SUBMITTED') throw E.conflict('هذا العرض لم يعد متاحًا', 'QUOTE_NOT_AVAILABLE');
      if (q.valid_until && q.valid_until <= iso(app.clock.now())) { db.run(`UPDATE quotes SET status='EXPIRED' WHERE id=?`, q.id); throw E.conflict('انتهت صلاحية هذا العرض', 'QUOTE_EXPIRED'); }
      const now = iso(app.clock.now());
      const res = db.run(`UPDATE orders SET status='ACCEPTED', provider_id=?, agreed_price=?, accepted_at=?, updated_at=?, version=version+1
                           WHERE id=? AND status IN ('SEARCHING','ASSIGNED') AND provider_id IS NULL`, q.provider_id, q.amount, now, now, o.id);
      if (!res.changes) throw E.conflict('تعذّر قبول العرض، حاول تحديث الصفحة', 'ORDER_ALREADY_TAKEN');
      db.run(`UPDATE quotes SET status='ACCEPTED', updated_at=? WHERE id=?`, now, q.id);
      db.run(`UPDATE quotes SET status='REJECTED', updated_at=? WHERE order_id=? AND status='SUBMITTED' AND id != ?`, now, o.id, q.id);
      db.run(`UPDATE order_assignments SET status='WITHDRAWN', responded_at=? WHERE order_id=? AND status='OFFERED'`, now, o.id);
      db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,created_at) VALUES (?,?,?,?,?,?)', o.id, o.status, 'ACCEPTED', ctx.user!.id, 'CUSTOMER', now);
      app.payment.onAccepted(db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', o.id)!);
      const p = app.providers.summary(q.provider_id);
      app.notifications.notify(p.userId, 'QUOTE_ACCEPTED', { code: o.code });
      return { order: orders.serialize(db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', o.id)!, ctx) };
    });
  });
}

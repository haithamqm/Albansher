import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, round } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';
import { executionEvent } from './execution.js';
import type { OrderRow, RatingRow } from '../types/domain.js';

/**
 * التقييمات: 1–5 نجوم + تعليق اختياري. لا يُسمح بها إلا للعميل صاحب الطلب المكتمل، مرة واحدة لكل طلب (UNIQUE في DB).
 * يُحدَّث متوسط تقييم المزود (rating_avg/rating_count) في نفس المعاملة (متوسط تراكمي).
 */
export function registerRatingRoutes(app: App, r: Router): void {
  r.get('/orders/:id/rating', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const o = app.orders.getOwned(ctx.params['id']!, ctx);
    const rating = app.db.get<RatingRow>('SELECT * FROM ratings WHERE order_id = ?', o.id);
    return { order: { id: o.id, code: o.code, status: o.status, providerId: o.provider_id }, rating: rating ? { id: rating.id, orderId: rating.order_id, score: rating.score, comment: (app.db.get<{comment:string}>("SELECT comment FROM reviews WHERE rating_id = ? AND status = 'VISIBLE'", rating.id)?.comment || null), createdAt: rating.created_at } : null };
  });
  const { db, orders } = app;

  r.post('/orders/:id/rating', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const b = parse<{ score: number; comment?: string }>(s.obj({ score: s.int({ min: 1, max: 5 }), comment: s.str({ max: 500, optional: true }) }), ctx.body);
    return db.tx(() => {
      const o = orders.getOwned(ctx.params['id']!, ctx);
      if (o.status !== 'COMPLETED') throw E.unprocessable('لا يمكن التقييم إلا بعد اكتمال الطلب', 'ORDER_NOT_COMPLETED');
      if (!o.provider_id) throw E.unprocessable('لا يوجد مقدم خدمة لتقييمه', 'NO_PROVIDER');
      if (db.get('SELECT 1 FROM ratings WHERE order_id = ?', o.id)) throw E.conflict('تم تقييم هذا الطلب مسبقًا', 'ALREADY_RATED');
      const now = iso(app.clock.now());
      const ratingId = uuid();
      db.run('INSERT INTO ratings(id,order_id,customer_id,provider_id,score,created_at) VALUES (?,?,?,?,?,?)', ratingId, o.id, ctx.user!.id, o.provider_id, b.score, now);
      if (b.comment) db.run('INSERT INTO reviews(id,rating_id,comment,status,created_at) VALUES (?,?,?,?,?)', uuid(), ratingId, b.comment, 'VISIBLE', now);
      const sp = db.get<{ rating_sum: number; rating_count: number }>('SELECT rating_sum, rating_count FROM service_providers WHERE id = ?', o.provider_id)!;
      const newSum = sp.rating_sum + b.score, newCount = sp.rating_count + 1;
      db.run('UPDATE service_providers SET rating_sum = ?, rating_count = ?, rating_avg = ?, updated_at = ? WHERE id = ?', newSum, newCount, round(newSum / newCount, 3), now, o.provider_id);
      const p = db.get<{ user_id: string }>('SELECT user_id FROM service_providers WHERE id = ?', o.provider_id)!;
      app.notifications.notify(p.user_id, 'NEW_RATING', { score: String(b.score), code: o.code });
      executionEvent(app,o.id,'RATING','تم تسجيل تقييم مقدم الخدمة',`التقييم ${b.score}/5`,'CUSTOMER',ctx.user!.id,{ratingId});
      const rating = db.get<RatingRow>('SELECT * FROM ratings WHERE id = ?', ratingId)!;
      ctx.status = 201;
      return { rating: { id: rating.id, orderId: rating.order_id, score: rating.score, comment: b.comment || null, createdAt: rating.created_at } };
    });
  });

  // تقييم المزود للعميل (اتجاه معاكس) — نفس القواعد: طلب مكتمل، مرة واحدة، والمزود المُسنَد فقط
  r.post('/provider/orders/:id/rate-customer', auth, roles('PROVIDER'), (ctx: Ctx) => {
    const b = parse<{ score: number; comment?: string }>(s.obj({ score: s.int({ min: 1, max: 5 }), comment: s.str({ max: 500, optional: true }) }), ctx.body);
    return db.tx(() => {
      const o = db.get<OrderRow>('SELECT * FROM orders WHERE id = ? AND provider_id = ?', ctx.params['id'], ctx.user!.providerId);
      if (!o) throw E.notFound('الطلب غير موجود');
      if (o.status !== 'COMPLETED') throw E.unprocessable('لا يمكن التقييم إلا بعد اكتمال الطلب', 'ORDER_NOT_COMPLETED');
      if (db.get('SELECT 1 FROM customer_ratings WHERE order_id = ?', o.id)) throw E.conflict('تم تقييم هذا العميل مسبقًا لهذا الطلب', 'ALREADY_RATED');
      const now = iso(app.clock.now());
      const id = uuid();
      db.run('INSERT INTO customer_ratings(id,order_id,provider_id,customer_id,score,comment,created_at) VALUES (?,?,?,?,?,?,?)', id, o.id, o.provider_id, o.customer_id, b.score, b.comment || null, now);
      ctx.status = 201;
      return { rating: { id, orderId: o.id, score: b.score, comment: b.comment || null, createdAt: now } };
    });
  });
}

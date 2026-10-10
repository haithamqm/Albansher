import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser, type TestApp } from './helpers.js';
import { CATEGORIES } from '../src/db/seed-data.js';

let t: TestApp;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

test('كتالوج البنشر الذكي: قسم واحد وخدمات مركبات فقط', async () => {
  assert.equal(CATEGORIES.length, 1);
  assert.equal(CATEGORIES[0]?.slug, 'vehicle-services');
  const expected = new Set(['mobile-tire-repair','tire-replacement','car-battery-service','oil-change','mobile-mechanic','auto-electrician','vehicle-towing','vehicle-inspection','custom-request']);
  assert.deepEqual(new Set(CATEGORIES[0]!.services.map(s => s.slug)), expected);
  const r = await t.api('GET', '/api/v1/catalog/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.body.categories.length, 1);
  assert.equal(r.body.categories[0].slug, 'vehicle-services');
  assert.ok(r.body.services.length >= 9);
  assert.ok(r.body.services.every((s: any) => expected.has(s.slug)));
});

test('البحث التقليدي بالكلمات المفتاحية يقترح خدمة البنشر دون AI', async () => {
  const r = await t.api('POST', '/api/v1/search/intent', { body: { text: 'أحتاج بنشر متنقل وكفر السيارة مثقوب' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.matches.some((m: any) => m.serviceSlug === 'mobile-tire-repair'));
  assert.equal(r.body.matches.some((m: any) => m.serviceSlug === 'shopping-for-me'), false);
});

test('لا توجد واجهات HTTP للمساعد أو تحليل الصور بالذكاء الاصطناعي', async () => {
  assert.notEqual((await t.api('POST', '/api/v1/assist/session', { body: { text: 'بنشر' } })).status, 200);
  assert.notEqual((await t.api('POST', '/api/v1/assist/request', { body: { text: 'بنشر' } })).status, 200);
});


test('عميل مسجل يستطيع إنشاء طلب بنشر مع الحقول المطلوبة', async () => {
  const customer = await registerUser(t.api);
  assert.equal(customer.status, 201);
  const catalog = await t.api('GET', '/api/v1/catalog/bootstrap');
  const service = catalog.body.services.find((s: any) => s.slug === 'mobile-tire-repair');
  assert.ok(service);
  const order = await t.api('POST', '/api/v1/orders', {
    token: customer.body.accessToken,
    headers: { 'Idempotency-Key': 'banshar-mobile-tire-order-test' },
    body: { serviceId: service.id, description: 'بنشر متنقل، كفر السيارة مثقوب', contactPhone: customer.creds.phone, location: { lat: 13.9759, lng: 44.1709, source: 'gps' }, formData: { vehicle_type: 'sedan', tire_issue: 'puncture' }, priority: 'NORMAL' }
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.ok(order.body.order?.id);
  assert.equal(order.body.order.status, 'SEARCHING');
});

test('إعادة التشغيل لا تعيد تفعيل خدمة عطّلها المدير', async () => {
  const catalog = await t.api('GET', '/api/v1/catalog/bootstrap');
  const service = catalog.body.services.find((s: any) => s.slug === 'vehicle-inspection');
  assert.ok(service);
  t.app.db.run('UPDATE services SET is_active=0 WHERE id=?', service.id);
  const { seedBase } = await import('../src/db/seed.js');
  await seedBase(t.app.db, t.app.config);
  t.app.catalog.invalidate();
  const refreshed = await t.api('GET', '/api/v1/catalog/bootstrap');
  assert.equal(refreshed.body.services.some((s: any) => s.slug === 'vehicle-inspection'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp, loginAdmin, registerUser } from './helpers.js';

test('إدارة الكتالوج التشغيلية: قراءة وإنشاء وتعديل وتعطيل', async () => {
  const t = await startApp();
  try {
    const admin = await loginAdmin(t.api);
    const read = await t.api('GET', '/api/v1/admin/catalog', { token: admin });
    assert.equal(read.status, 200);
    const first = read.body.categories[0];
    assert.ok(first.id && first.services);

    const createdCat = await t.api('POST', '/api/v1/admin/categories', { token: admin, body: { slug: 'test-ops', name: { ar: 'اختبار تشغيل', en: 'Ops test' }, icon: '🧪' } });
    assert.equal(createdCat.status, 201);
    const catId = createdCat.body.category.id;

    const createdSvc = await t.api('POST', '/api/v1/admin/services', { token: admin, body: {
      categoryId: catId, slug: 'test-service', name: { ar: 'خدمة اختبار', en: 'Test service' }, description: { ar: 'وصف' },
      pricingType: 'FIXED', basePrice: 2500, formSchema: [{ key: 'note', type: 'text', label: { ar: 'ملاحظة' }, required: false }]
    }});
    assert.equal(createdSvc.status, 201);
    const serviceId = createdSvc.body.service.id;
    assert.equal(createdSvc.body.service.formSchema.length, 1);

    const badFixed = await t.api('POST', '/api/v1/admin/services', { token: admin, body: { categoryId: catId, slug: 'bad-fixed', name: { ar: 'س' }, pricingType: 'FIXED', formSchema: [] } });
    assert.equal(badFixed.status, 422);

    const updated = await t.api('PATCH', `/api/v1/admin/services/${serviceId}`, { token: admin, body: { basePrice: 3000, isActive: false } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.service.basePrice, 3000);

    const publicSvc = await t.api('GET', `/api/v1/services/${serviceId}`);
    assert.equal(publicSvc.status, 404);

    const updatedCat = await t.api('PATCH', `/api/v1/categories/${catId}`, { token: admin, body: { isActive: false } });
    assert.equal(updatedCat.status, 404);

    const customer = await registerUser(t.api);
    const forbidden = await t.api('POST', '/api/v1/admin/categories', { token: customer.body.accessToken, body: { slug: 'nope', name: { ar: 'لا' } } });
    assert.equal(forbidden.status, 403);
  } finally { await t.close(); }
});

test('إدارة المناطق والإعدادات: صلاحيات القراءة والتعديل محفوظة', async () => {
  const t = await startApp();
  try {
    const admin = await loginAdmin(t.api);
    assert.equal((await t.api('GET', '/api/v1/admin/areas', { token: admin })).status, 200);
    assert.equal((await t.api('GET', '/api/v1/admin/settings', { token: admin })).status, 200);
    const area = await t.api('POST', '/api/v1/admin/areas', { token: admin, body: { name: { ar: 'اختبار تشغيل' }, type: 'CITY', centerLat: 13, centerLng: 44, radiusKm: 10 } });
    assert.equal(area.status, 201);
    assert.equal((await t.api('PATCH', `/api/v1/admin/areas/${area.body.area.id}`, { token: admin, body: { isActive: false } })).status, 200);
  } finally { await t.close(); }
});

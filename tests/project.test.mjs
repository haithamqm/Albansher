import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('project contains separate customer/provider/admin and commerce UI surfaces', () => {
  const html = read('public/index.html');
  assert.match(html, /id="requestForm"/);
  assert.match(html, /id="providerPanel"/);
  assert.match(html, /id="adminPanel"/);
  assert.match(html, /id="offerGrid"/);
  assert.match(html, /id="productGrid"/);
  assert.match(html, /id="adminOrders"/);
});

test('authentication and role checks are implemented server-side', () => {
  const auth = read('src/auth.js');
  const server = read('src/server.js');
  assert.match(auth, /bcrypt\.hashSync/);
  assert.match(auth, /jwt\.verify/);
  assert.match(auth, /requireRole/);
  assert.match(server, /app\.post\('\/api\/auth\/register'/);
  assert.match(server, /app\.post\('\/api\/auth\/login'/);
});

test('order workflow, idempotency, quote approval, and notifications are present', () => {
  const server = read('src/server.js');
  const db = read('src/db.js');
  assert.match(server, /Idempotency-Key/);
  assert.match(server, /quote_status==='pending'/);
  assert.match(server, /\/api\/orders\/.*\/accept/);
  assert.match(server, /\/api\/notifications/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS idempotency_keys/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS order_events/);
});

test('administration endpoints cover products, offers, branches, vehicle types, payments, and reports', () => {
  const server = read('src/server.js');
  for (const route of [
    '/api/admin/products', '/api/admin/offers', '/api/admin/branches',
    '/api/admin/vehicle-types', '/api/admin/orders', '/api/admin/reports/summary',
    '/api/admin/orders/:id/payment', '/api/admin/audit'
  ]) assert.ok(server.includes(route), `Missing endpoint marker: ${route}`);
});

test('PWA shell and both language directions are configured', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /rel="manifest"/);
  assert.match(app, /state\.lang==='ar'\?'rtl':'ltr'/);
  assert.match(read('public/manifest.webmanifest'), /"display"\s*:\s*"standalone"/);
});

test('service requests require explicit service selection or explicit Other service choice', () => {
  const app = read('public/app.js');
  const server = read('src/server.js');
  const html = read('public/index.html');
  assert.match(html, /id="serviceSelect" required/);
  assert.match(html, /خدمة أخرى غير موجودة بالقائمة/);
  assert.match(app, /if\(!choice\)/);
  assert.match(app, /custom_service:isOther/);
  assert.match(app, /اختر الخدمة من القائمة أولًا/);
  assert.match(server, /req\.body\.custom_service!==true/);
  assert.match(server, /service_name_ar/);
  assert.match(html, /id="serviceMatch"/);
});


test('role dashboards have dedicated paths and the workshop hero is a custom illustration', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const server = read('src/server.js');
  assert.match(html, /hero-garage\.svg/);
  assert.match(app, /routeMode=\['\/admin','\/provider','\/customer'\]/);
  assert.match(app, /loadAdminOffers/);
  assert.match(server, /app\.get\('\/api\/admin\/offers'/);
  assert.match(html, /id="adminOffers"/);
});

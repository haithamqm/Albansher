import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TestApp, Api, ApiResponse } from './helpers.js';
import { startApp, registerUser, loginAdmin, uniquePhone } from './helpers.js';
import { signJwt } from '../src/core/security.js';

let t: TestApp, api: Api;
before(async () => { t = await startApp(); api = t.api; });
after(async () => { await t.close(); });

describe('Registration', () => {
  test('عميل جديد: 201 + توكن + لا يظهر password_hash', async () => {
    const r = await registerUser(api);
    assert.equal(r.status, 201);
    assert.ok(r.body.accessToken);
    assert.equal(r.body.user.role, 'CUSTOMER');
    assert.ok(!r.text.includes('password'), 'يجب ألا تحتوي الاستجابة على أي حقل password');
    assert.match(r.cookie, /^khadamat_rt=/);
  });
  test('كلمة المرور مخزنة مجزأة (scrypt) وليست نصًا صريحًا', async () => {
    const r = await registerUser(api, { password: 'MySecret999' });
    const row = t.app.db.one('SELECT password_hash FROM users WHERE id = ?', r.body.user.id);
    assert.ok(row.password_hash.startsWith('scrypt$'));
    assert.ok(!row.password_hash.includes('MySecret999'));
  });
  test('الكوكي HttpOnly + SameSite=Strict', async () => {
    const res = await fetch(t.base + '/api/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'كوكي', phone: uniquePhone(), password: 'Passw0rd123', role: 'CUSTOMER' }) });
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  });
  test('هاتف مكرر → 409', async () => {
    const a = await registerUser(api);
    const b = await registerUser(api, { phone: a.creds.phone });
    assert.equal(b.status, 409); assert.equal(b.body.error.code, 'PHONE_TAKEN');
  });
  test('تطبيع الأرقام العربية في الهاتف (تكرار مكتشف)', async () => {
    const a = await registerUser(api, { phone: '+967771234567' });
    assert.equal(a.status, 201);
    const b = await registerUser(api, { phone: '+٩٦٧٧٧١٢٣٤٥٦٧' });
    assert.equal(b.status, 409);
  });
  test('كلمة مرور أقصر من 8 أحرف → 422', async () => {
    assert.equal((await registerUser(api, { password: 'short1' })).status, 422);
    assert.equal((await registerUser(api, { password: 'abcdefgh' })).status, 201);
  });
  test('هاتف/بريد غير صالح → 422', async () => {
    assert.equal((await registerUser(api, { phone: 'abc' })).status, 422);
    assert.equal((await registerUser(api, { email: 'not-an-email' })).status, 422);
  });
  test('لا يمكن التسجيل كمدير (تصعيد صلاحيات) → 422', async () => {
    const r = await registerUser(api, { role: 'ADMIN' });
    assert.equal(r.status, 422);
  });
  test('حقل role غير معروف/حقول زائدة تُتجاهل: لا يمكن حقن adminLevel', async () => {
    const r = await registerUser(api, { adminLevel: 'SUPER_ADMIN', role_id: 3, status: 'ACTIVE' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'CUSTOMER');
    assert.equal(r.body.user.adminLevel, null);
  });
  test('مقدم خدمة: يتطلب بيانات provider وينشأ بحالة PENDING', async () => {
    const bad = await registerUser(api, { role: 'PROVIDER' });
    assert.equal(bad.status, 422);
    const ok = await registerUser(api, { role: 'PROVIDER', provider: { providerType: 'TECHNICIAN', displayName: 'فني كهرباء' } });
    assert.equal(ok.status, 201);
    const me = await api('GET', '/api/v1/auth/me', { token: ok.body.accessToken });
    assert.equal(me.body.provider.verificationStatus, 'PENDING');
    assert.equal(me.body.provider.verified, false);
  });
  test('شركة باسم النشاط/الاسم الظاهر من الواجهة → تُقبل ويُحفظ اسم الشركة', async () => {
  const r = await registerUser(api, { role: 'PROVIDER', provider: { providerType: 'COMPANY', displayName: 'غسيل سيارات متنقل' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'PROVIDER');
  const row = t.app.db.one<any>('SELECT company_name, display_name FROM service_providers WHERE user_id = ?', r.body.user.id);
  assert.equal(row.company_name, 'غسيل سيارات متنقل');
  assert.equal(row.display_name, 'غسيل سيارات متنقل');
});

test('شركة بدون اسم شركة → 422', async () => {
    const r = await registerUser(api, { role: 'PROVIDER', provider: { providerType: 'COMPANY' } });
    assert.equal(r.status, 422);
  });
});

describe('Login', () => {
  test('دخول بالهاتف وبالبريد', async () => {
    const u = await registerUser(api, { email: 'login1@test.local' });
    const byPhone = await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } });
    const byEmail = await api('POST', '/api/v1/auth/login', { body: { identifier: 'LOGIN1@test.local', password: u.creds.password } });
    assert.equal(byPhone.status, 200); assert.equal(byEmail.status, 200);
  });
  test('كلمة مرور خاطئة ومستخدم غير موجود → نفس الرسالة (لا تعداد حسابات)', async () => {
    const u = await registerUser(api);
    const a = await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: 'Wrong12345' } });
    const b = await api('POST', '/api/v1/auth/login', { body: { identifier: '+19999999999', password: 'Wrong12345' } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.deepEqual([a.body.error.code, a.body.error.message], [b.body.error.code, b.body.error.message]);
  });
  test('اختيار نوع حساب خاطئ عند الدخول مرفوض ولا يغيّر الدور', async () => {
    const customer = await registerUser(api);
    const wrong = await api('POST', '/api/v1/auth/login', { body: { identifier: customer.creds.phone, password: customer.creds.password, role: 'PROVIDER' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'ROLE_MISMATCH');
    const ok = await api('POST', '/api/v1/auth/login', { body: { identifier: customer.creds.phone, password: customer.creds.password, role: 'CUSTOMER' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'CUSTOMER');
  });
  test('حساب معلّق لا يستطيع الدخول', async () => {
    const u = await registerUser(api);
    t.app.db.run(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, u.body.user.id);
    const r = await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } });
    assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ACCOUNT_INACTIVE');
  });
  test('حقن SQL في identifier لا يكسر شيئًا', async () => {
    const r = await api('POST', '/api/v1/auth/login', { body: { identifier: "' OR 1=1 --", password: 'x' } });
    assert.equal(r.status, 401);
  });
});

describe('Tokens & Sessions', () => {
  test('/auth/me بدون توكن → 401، بتوكن صحيح → 200', async () => {
    const u = await registerUser(api);
    assert.equal((await api('GET', '/api/v1/auth/me')).status, 401);
    assert.equal((await api('GET', '/api/v1/auth/me', { token: u.body.accessToken })).status, 200);
  });
  test('توكن معبوث به (signature) مرفوض', async () => {
    const u = await registerUser(api);
    const parts = u.body.accessToken.split('.');
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: u.body.user.id, role: 'ADMIN', tv: 0, iss: 'khadamat', exp: 9999999999 })).toString('base64url')}.${parts[2]}`;
    assert.equal((await api('GET', '/api/v1/auth/me', { token: tampered })).status, 401);
  });
  test('توكن alg=none مرفوض', async () => {
    const u = await registerUser(api);
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: u.body.user.id, role: 'CUSTOMER', tv: 0, iss: 'khadamat', exp: 9999999999 })).toString('base64url');
    assert.equal((await api('GET', '/api/v1/auth/me', { token: `${h}.${p}.` })).status, 401);
  });
  test('توكن موقّع بمفتاح آخر مرفوض', async () => {
    const u = await registerUser(api);
    const forged = signJwt({ sub: u.body.user.id, role: 'CUSTOMER', tv: 0 }, 'another-secret-another-secret-123456', 900);
    assert.equal((await api('GET', '/api/v1/auth/me', { token: forged })).status, 401);
  });
  test('انتهاء صلاحية Access Token', async () => {
    const u = await registerUser(api);
    const real = t.app.clock.now;
    t.app.clock.now = () => Date.now() + 16 * 60 * 1000;
    const r = await api('GET', '/api/v1/auth/me', { token: u.body.accessToken });
    t.app.clock.now = real;
    assert.equal(r.status, 401);
  });
  test('Refresh: تدوير التوكن + رفض إعادة الاستخدام + إبطال العائلة', async () => {
    const u = await registerUser(api);
    const h = { 'X-Requested-With': 'khadamat' };
    const r1 = await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie, headers: h });
    assert.equal(r1.status, 200); assert.ok(r1.body.accessToken); assert.notEqual(r1.cookie, u.cookie);
    const reuse = await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie, headers: h }); // توكن قديم
    assert.equal(reuse.status, 401); assert.equal(reuse.body.error.code, 'SESSION_REUSED');
    const afterReuse = await api('POST', '/api/v1/auth/refresh', { cookie: r1.cookie, headers: h }); // العائلة كلها أُبطلت
    assert.equal(afterReuse.status, 401);
  });
  test('Refresh بدون ترويسة X-Requested-With → 403 (CSRF)', async () => {
    const u = await registerUser(api);
    assert.equal((await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie })).status, 403);
  });
  test('Refresh منتهي الصلاحية → 401', async () => {
    const u = await registerUser(api);
    const real = t.app.clock.now;
    t.app.clock.now = () => Date.now() + 31 * 86400_000;
    const r = await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie, headers: { 'X-Requested-With': 'khadamat' } });
    t.app.clock.now = real;
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'SESSION_EXPIRED');
  });
  test('Logout يبطل الـRefresh', async () => {
    const u = await registerUser(api);
    const out = await api('POST', '/api/v1/auth/logout', { cookie: u.cookie });
    assert.equal(out.status, 200);
    assert.equal((await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie, headers: { 'X-Requested-With': 'khadamat' } })).status, 401);
  });
  test('تغيير البريد الإلكتروني: يتحقق من كلمة المرور ويصدر جلسة جديدة ويمنع التكرار', async () => {
    const u = await registerUser(api, { email: 'change-email@test.local', password: 'OldPass123' });
    const changed = await api('POST', '/api/v1/auth/change-email', { token: u.body.accessToken, body: { currentPassword: 'OldPass123', newEmail: 'changed-email@test.local' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.email, 'changed-email@test.local');
    assert.ok(changed.body.accessToken);
    const oldLogin = await api('POST', '/api/v1/auth/login', { body: { identifier: 'change-email@test.local', password: 'OldPass123' } });
    const newLogin = await api('POST', '/api/v1/auth/login', { body: { identifier: 'changed-email@test.local', password: 'OldPass123' } });
    assert.equal(oldLogin.status, 401); assert.equal(newLogin.status, 200);
    const duplicate = await api('POST', '/api/v1/auth/change-email', { token: changed.body.accessToken, body: { currentPassword: 'OldPass123', newEmail: 'changed-email@test.local' } });
    assert.equal(duplicate.status, 409);
  });

  test('تغيير كلمة المرور: يبطل التوكنات القديمة وكلمة المرور القديمة', async () => {
    const u = await registerUser(api);
    const bad = await api('POST', '/api/v1/auth/change-password', { token: u.body.accessToken, body: { currentPassword: 'Wrong12345', newPassword: 'NewPassw0rd1' } });
    assert.equal(bad.status, 401);
    const ok = await api('POST', '/api/v1/auth/change-password', { token: u.body.accessToken, body: { currentPassword: u.creds.password, newPassword: 'NewPassw0rd1' } });
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', '/api/v1/auth/me', { token: u.body.accessToken })).status, 401, 'التوكن القديم يجب أن يُبطل');
    assert.equal((await api('POST', '/api/v1/auth/refresh', { cookie: u.cookie, headers: { 'X-Requested-With': 'khadamat' } })).status, 401);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } })).status, 401);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: 'NewPassw0rd1' } })).status, 200);
    assert.ok(t.app.db.get(`SELECT 1 FROM audit_logs WHERE action = 'auth.change_password' AND entity_id = ?`, u.body.user.id));
  });
});

describe('Roles & Permissions', () => {
  test('عميل/مزود لا يصلان لمسارات الإدارة → 403، وبدون توكن → 401', async () => {
    const c = await registerUser(api);
    const p = await registerUser(api, { role: 'PROVIDER', provider: { providerType: 'DRIVER' } });
    assert.equal((await api('GET', '/api/v1/admin/users')).status, 401);
    assert.equal((await api('GET', '/api/v1/admin/users', { token: c.body.accessToken })).status, 403);
    assert.equal((await api('GET', '/api/v1/admin/users', { token: p.body.accessToken })).status, 403);
  });
  test('عميل لا يصل لمسارات المزود والعكس', async () => {
    const c = await registerUser(api);
    const p = await registerUser(api, { role: 'PROVIDER', provider: { providerType: 'DRIVER' } });
    assert.equal((await api('GET', '/api/v1/provider/profile', { token: c.body.accessToken })).status, 403);
    assert.equal((await api('GET', '/api/v1/me/addresses', { token: p.body.accessToken })).status, 403);
  });
  test('المدير يصل لقائمة المستخدمين ولا تحتوي hash', async () => {
    const admin = await loginAdmin(api);
    const r = await api('GET', '/api/v1/admin/users?limit=5', { token: admin });
    assert.equal(r.status, 200); assert.ok(r.body.users.length > 0);
    assert.ok(!r.text.includes('scrypt$'));
  });
  test('مستويات الإدارة: SUPER_ADMIN ينشئ ADMIN/SUPPORT، وSUPPORT لا يستطيع', async () => {
    const admin = await loginAdmin(api);
    const create = await api('POST', '/api/v1/admin/admins', { token: admin, body: { fullName: 'دعم فني', phone: uniquePhone(), email: 'support1@test.local', password: 'SupportPass1', adminLevel: 'SUPPORT' } });
    assert.equal(create.status, 201);
    const sup = await api('POST', '/api/v1/auth/login', { body: { identifier: 'support1@test.local', password: 'SupportPass1' } });
    const tok = sup.body.accessToken;
    assert.equal((await api('GET', '/api/v1/admin/users', { token: tok })).status, 200, 'SUPPORT يقرأ');
    assert.equal((await api('POST', '/api/v1/admin/admins', { token: tok, body: { fullName: 'x y', phone: uniquePhone(), email: 'x1@test.local', password: 'SupportPass1', adminLevel: 'ADMIN' } })).status, 403);
    assert.equal((await api('GET', '/api/v1/admin/audit-logs', { token: tok })).status, 403, 'SUPPORT لا يقرأ سجل التدقيق');
    const victim = await registerUser(api);
    assert.equal((await api('PATCH', `/api/v1/admin/users/${victim.body.user.id}/status`, { token: tok, body: { status: 'SUSPENDED' } })).status, 403);
  });
  test('تعليق مستخدم: يبطل توكنه فورًا + Audit Log + يمنع الدخول، وإعادة التفعيل', async () => {
    const admin = await loginAdmin(api);
    const u = await registerUser(api);
    const s = await api('PATCH', `/api/v1/admin/users/${u.body.user.id}/status`, { token: admin, body: { status: 'SUSPENDED', reason: 'اختبار' } });
    assert.equal(s.status, 200);
    const me = await api('GET', '/api/v1/auth/me', { token: u.body.accessToken });
    assert.equal(me.status, 401);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } })).status, 403);
    const logs = await api('GET', `/api/v1/admin/audit-logs?entityType=user&entityId=${u.body.user.id}`, { token: admin });
    assert.equal(logs.body.logs[0].action, 'user.suspend');
    assert.equal(logs.body.logs[0].actorRole, 'ADMIN');
    assert.equal((await api('PATCH', `/api/v1/admin/users/${u.body.user.id}/status`, { token: admin, body: { status: 'ACTIVE' } })).status, 200);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } })).status, 200);
  });
  test('المدير لا يعلّق نفسه', async () => {
    const admin = await loginAdmin(api);
    const me = await api('GET', '/api/v1/auth/me', { token: admin });
    assert.equal((await api('PATCH', `/api/v1/admin/users/${me.body.user.id}/status`, { token: admin, body: { status: 'SUSPENDED' } })).status, 422);
  });
});

describe('Rate limiting', () => {
  test('تسجيل الدخول: بعد 8 محاولات فاشلة لنفس الحساب → 429', async () => {
    const t2 = await startApp({ DISABLE_RATE_LIMIT: 'false' });
    try {
      const u = await registerUser(t2.api);
      let last!: ApiResponse;
      for (let i = 0; i < 9; i++) last = await t2.api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: 'Wrong12345' } });
      assert.equal(last.status, 429);
      assert.ok(last.headers.get('retry-after'));
      // حتى كلمة المرور الصحيحة محجوبة أثناء القفل
      assert.equal((await t2.api('POST', '/api/v1/auth/login', { body: { identifier: u.creds.phone, password: u.creds.password } })).status, 429);
    } finally { await t2.close(); }
  });
});

describe('إدارة فريق الإدارة وحساب المدير', () => {
  test('SUPER_ADMIN يقرأ ويضيف ويعدل ويوقف حساب مشرف مستقل', async () => {
    const admin = await loginAdmin(api);
    const listed = await api('GET', '/api/v1/admin/admins', { token: admin });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.admins.some((x: any) => x.adminLevel === 'SUPER_ADMIN'));
    const email = `mod${Date.now()}@test.local`;
    const phone = uniquePhone();
    const created = await api('POST', '/api/v1/admin/admins', { token: admin, body: { fullName: 'مشرف مستقل', phone, email, password: 'ModPass1234', adminLevel: 'SUPPORT' } });
    assert.equal(created.status, 201);
    const createdId = created.body.user.id;
    const edited = await api('PATCH', `/api/v1/admin/admins/${createdId}`, { token: admin, body: { fullName: 'مشرف محدث', email: `mod2${Date.now()}@test.local`, password: 'ModPass5678', adminLevel: 'ADMIN' } });
    assert.equal(edited.status, 200);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: email, password: 'ModPass1234' } })).status, 401);
    const newEmail = edited.body.user.email;
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: newEmail, password: 'ModPass5678' } })).status, 200);
    assert.equal((await api('PATCH', `/api/v1/admin/admins/${createdId}`, { token: admin, body: { status: 'SUSPENDED' } })).status, 200);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: newEmail, password: 'ModPass5678' } })).status, 403);
  });

  test('SUPPORT لا يستطيع إدارة المديرين', async () => {
    const admin = await loginAdmin(api);
    const email = `sup${Date.now()}@test.local`;
    await api('POST', '/api/v1/admin/admins', { token: admin, body: { fullName: 'مشرف صلاحيات', phone: uniquePhone(), email, password: 'SupportPass123', adminLevel: 'SUPPORT' } });
    const sup = await api('POST', '/api/v1/auth/login', { body: { identifier: email, password: 'SupportPass123' } });
    assert.equal((await api('GET', '/api/v1/admin/admins', { token: sup.body.accessToken })).status, 403);
  });

  test('تعديل حساب المدير الحالي يتحقق من كلمة المرور ويصدر جلسة جديدة', async () => {
    const admin = await loginAdmin(api);
    const bad = await api('PATCH', '/api/v1/admin/account', { token: admin, body: { newPassword: 'ChangedPass123' } });
    assert.equal(bad.status, 422);
    const ok = await api('PATCH', '/api/v1/admin/account', { token: admin, body: { currentPassword: 'AdminPass123', newPassword: 'ChangedPass123' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.accessToken);
    assert.equal((await api('GET', '/api/v1/auth/me', { token: admin })).status, 401);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: 'admin@test.local', password: 'AdminPass123' } })).status, 401);
    assert.equal((await api('POST', '/api/v1/auth/login', { body: { identifier: 'admin@test.local', password: 'ChangedPass123' } })).status, 200);
  });
});

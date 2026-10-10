import { s, parse, normalizePhone, PHONE_RE } from '../core/validate.js';
import { E } from '../core/errors.js';
import { hashPassword, verifyPassword, uuid } from '../core/security.js';
import { iso, pageParams, cursorSql, finishPage, parseJson } from '../core/util.js';
import { auth, adminLevel } from './auth.middleware.js';
import { serializeUser } from './auth.js';
/** إدارة المستخدمين والمديرين وسجل التدقيق (الأساس الذي تبنى عليه لوحة الإدارة). */
export function registerAdminCoreRoutes(app, r) {
    const { db } = app;
    r.patch('/admin/account', auth, adminLevel('SUPPORT'), async (ctx) => {
        const b = parse(s.obj({
            fullName: s.str({ min: 2, max: 80, optional: true }),
            email: s.str({ max: 160, lower: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'بريد إلكتروني غير صالح', optional: true }),
            currentPassword: s.str({ min: 1, max: 128, trim: false, optional: true }),
            newPassword: s.str({ min: 10, max: 128, trim: false, pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, patternMessage: 'يجب أن تحتوي كلمة المرور على حرف ورقم', optional: true }),
        }), ctx.body);
        const current = app.authService.loadUser('u.id = ?', ctx.user.id);
        if (b.email === undefined && b.newPassword === undefined && b.fullName === undefined)
            throw E.unprocessable('لا توجد تغييرات للحفظ', 'NO_CHANGES');
        if ((b.email !== undefined || b.newPassword !== undefined) && !b.currentPassword)
            throw E.unprocessable('أدخل كلمة المرور الحالية لتغيير البريد أو كلمة المرور', 'CURRENT_PASSWORD_REQUIRED');
        if (b.currentPassword && !(await verifyPassword(b.currentPassword, current.password_hash)))
            throw E.unauthorized('كلمة المرور الحالية غير صحيحة', 'INVALID_CURRENT_PASSWORD');
        if (b.email !== undefined && db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', b.email, current.id))
            throw E.conflict('البريد الإلكتروني مستخدم من حساب آخر', 'EMAIL_TAKEN');
        const newHash = b.newPassword !== undefined ? await hashPassword(b.newPassword) : null;
        const now = iso(app.clock.now());
        db.tx(() => {
            db.run('UPDATE users SET full_name=COALESCE(?,full_name), email=COALESCE(?,email), password_hash=COALESCE(?,password_hash), token_version=token_version+1, updated_at=? WHERE id=?', b.fullName ?? null, b.email ?? null, newHash, now, current.id);
            db.run('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?', now, current.id);
            app.audit.log({ ctx, action: 'admin.account_update', entityType: 'user', entityId: current.id, before: { email: current.email }, after: { email: b.email ?? current.email, passwordChanged: !!newHash, fullNameChanged: b.fullName !== undefined } });
        });
        const updated = app.authService.loadUser('u.id = ?', current.id);
        return { user: serializeUser(updated), ...app.authService.issueSession(ctx, updated) };
    });
    r.get('/admin/admins', auth, adminLevel('SUPER_ADMIN'), () => {
        const rows = db.all(`SELECT u.id,u.full_name,u.phone,u.email,u.status,u.created_at,u.last_login_at,au.admin_level
      FROM users u JOIN roles r ON r.id=u.role_id JOIN admin_users au ON au.user_id=u.id
      WHERE r.code='ADMIN' ORDER BY CASE au.admin_level WHEN 'SUPER_ADMIN' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, u.created_at DESC`);
        return { admins: rows.map((x) => ({ id: x.id, fullName: x.full_name, phone: x.phone, email: x.email, status: x.status, adminLevel: x.admin_level, createdAt: x.created_at, lastLoginAt: x.last_login_at })) };
    });
    r.patch('/admin/admins/:id', auth, adminLevel('SUPER_ADMIN'), async (ctx) => {
        const b = parse(s.obj({
            fullName: s.str({ min: 2, max: 80, optional: true }), phone: s.str({ min: 8, max: 24, optional: true }),
            email: s.str({ max: 160, lower: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'بريد إلكتروني غير صالح', optional: true }),
            password: s.str({ min: 10, max: 128, trim: false, pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, patternMessage: 'يجب أن تحتوي كلمة المرور على حرف ورقم', optional: true }),
            adminLevel: s.oneOf(['ADMIN', 'SUPPORT'], { optional: true }), status: s.oneOf(['ACTIVE', 'SUSPENDED'], { optional: true })
        }), ctx.body);
        const target = app.authService.loadUser('u.id = ?', ctx.params['id']);
        if (!target || target.role !== 'ADMIN')
            throw E.notFound('حساب الإدارة غير موجود');
        if (target.id === ctx.user.id)
            throw E.unprocessable('استخدم إعدادات حسابي لتعديل حسابك', 'SELF_ADMIN_EDIT');
        if (target.admin_level === 'SUPER_ADMIN')
            throw E.forbidden('لا يمكن تعديل مدير النظام الأعلى من حساب آخر', 'PROTECTED_SUPER_ADMIN');
        const phone = b.phone !== undefined ? normalizePhone(b.phone) : undefined;
        if (phone !== undefined && !PHONE_RE.test(phone))
            throw E.unprocessable('رقم هاتف غير صالح', 'VALIDATION_ERROR');
        if (b.email !== undefined && db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', b.email, target.id))
            throw E.conflict('البريد الإلكتروني مستخدم مسبقًا', 'EMAIL_TAKEN');
        if (phone !== undefined && db.get('SELECT 1 FROM users WHERE phone = ? AND id != ?', phone, target.id))
            throw E.conflict('رقم الهاتف مستخدم مسبقًا', 'PHONE_TAKEN');
        const hash = b.password !== undefined ? await hashPassword(b.password) : null;
        const now = iso(app.clock.now());
        db.tx(() => {
            db.run('UPDATE users SET full_name=COALESCE(?,full_name), phone=COALESCE(?,phone), email=COALESCE(?,email), password_hash=COALESCE(?,password_hash), status=COALESCE(?,status), token_version=token_version+1, updated_at=? WHERE id=?', b.fullName ?? null, phone ?? null, b.email ?? null, hash, b.status ?? null, now, target.id);
            if (b.adminLevel)
                db.run('UPDATE admin_users SET admin_level=? WHERE user_id=?', b.adminLevel, target.id);
            db.run('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?', now, target.id);
            app.audit.log({ ctx, action: 'admin.update', entityType: 'user', entityId: target.id, before: { email: target.email, adminLevel: target.admin_level, status: target.status }, after: { email: b.email ?? target.email, adminLevel: b.adminLevel ?? target.admin_level, status: b.status ?? target.status, passwordChanged: !!hash } });
        });
        app.sse.send(target.id, 'sync', { scope: 'users' });
        return { user: serializeUser(app.authService.loadUser('u.id = ?', target.id)) };
    });
    r.get('/admin/intent-audit', auth, adminLevel('SUPPORT'), (ctx) => {
        const limit = Math.min(200, Math.max(1, Number(ctx.query['limit'] || 50)));
        const rows = db.all(`SELECT ia.*,u.full_name customer_name,ps.name_i18n predicted_name_i18n,ss.name_i18n selected_name_i18n,sp.display_name provider_name FROM intent_audit ia JOIN users u ON u.id=ia.customer_id LEFT JOIN services ps ON ps.id=ia.predicted_service_id LEFT JOIN services ss ON ss.id=ia.selected_service_id LEFT JOIN service_providers sp ON sp.id=ia.selected_provider_id ORDER BY ia.created_at DESC LIMIT ?`, limit);
        return { items: rows.map((x) => ({ id: x.id, originalText: x.original_text, customerName: x.customer_name, assistantSessionId: x.assistant_session_id, orderId: x.order_id, predictedServiceId: x.predicted_service_id, predictedConfidence: x.predicted_confidence, parserSource: x.parser_source, selectedServiceId: x.selected_service_id, selectedProviderId: x.selected_provider_id, providerName: x.provider_name, assignmentResult: x.assignment_result, outcome: x.outcome, correctionServiceId: x.correction_service_id, correctionNote: x.correction_note, analysis: x.analysis_json ? parseJson(x.analysis_json) : null, createdAt: x.created_at, updatedAt: x.updated_at })) };
    });
    r.patch('/admin/intent-audit/:id/correction', auth, adminLevel('ADMIN'), (ctx) => {
        const b = parse(s.obj({ serviceId: s.str({ max: 64, optional: true }), note: s.str({ max: 500, optional: true }) }), ctx.body);
        const row = db.get('SELECT id FROM intent_audit WHERE id=?', ctx.params['id']);
        if (!row)
            throw E.notFound('سجل المساعد غير موجود');
        if (b.serviceId && !db.get('SELECT id FROM services WHERE id=?', b.serviceId))
            throw E.notFound('الخدمة المصححة غير موجودة');
        const now = iso(app.clock.now());
        db.run('UPDATE intent_audit SET correction_service_id=?,correction_note=?,corrected_by=?,corrected_at=?,updated_at=? WHERE id=?', b.serviceId || null, b.note || null, ctx.user.id, now, now, row.id);
        app.audit.log({ ctx, action: 'intent.correction', entityType: 'intent_audit', entityId: row.id, after: { serviceId: b.serviceId || null, note: b.note || null } });
        return { ok: true };
    });
    r.get('/admin/dashboard', auth, adminLevel('SUPPORT'), () => {
        const count = (sql, ...params) => Number(db.get(sql, ...params)?.n || 0);
        return { stats: {
                users: count('SELECT COUNT(*) n FROM users'),
                providers: count('SELECT COUNT(*) n FROM service_providers'),
                pendingProviders: count("SELECT COUNT(*) n FROM service_providers WHERE verification_status='PENDING'"),
                orders: count('SELECT COUNT(*) n FROM orders'),
                activeOrders: count("SELECT COUNT(*) n FROM orders WHERE status IN ('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')"),
                completedOrders: count("SELECT COUNT(*) n FROM orders WHERE status='COMPLETED'"),
                cancelledOrders: count("SELECT COUNT(*) n FROM orders WHERE status='CANCELLED'"),
                complaints: count("SELECT COUNT(*) n FROM complaints WHERE status NOT IN ('RESOLVED','REJECTED','CLOSED')")
            } };
    });
    r.get('/admin/users', auth, adminLevel('SUPPORT'), (ctx) => {
        const { limit, cursor } = pageParams(ctx.query);
        const c = cursorSql('u', cursor);
        const where = [];
        const params = [];
        if (ctx.query['role']) {
            where.push('r.code = ?');
            params.push(String(ctx.query['role']));
        }
        if (ctx.query['status']) {
            where.push('u.status = ?');
            params.push(String(ctx.query['status']));
        }
        if (ctx.query['q']) {
            where.push('(u.full_name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)');
            const q = `%${String(ctx.query['q']).slice(0, 60)}%`;
            params.push(q, q, q);
        }
        const rows = db.all(`SELECT u.*, r.code AS role, au.admin_level FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN admin_users au ON au.user_id = u.id
                         WHERE 1=1 ${where.map((w) => 'AND ' + w).join(' ')}${c.sql} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`, ...params, ...c.params, limit + 1);
        const { items, nextCursor } = finishPage(rows, limit);
        return { users: items.map((u) => ({ ...serializeUser(u), createdAt: u.created_at, lastLoginAt: u.last_login_at })), nextCursor };
    });
    r.patch('/admin/users/:id/status', auth, adminLevel('ADMIN'), (ctx) => {
        const b = parse(s.obj({ status: s.oneOf(['ACTIVE', 'SUSPENDED']), reason: s.str({ max: 300, optional: true }) }), ctx.body);
        return db.tx(() => {
            const u = app.authService.loadUser('u.id = ?', ctx.params['id']);
            if (!u)
                throw E.notFound('المستخدم غير موجود');
            if (u.id === ctx.user.id)
                throw E.unprocessable('لا يمكنك تغيير حالة حسابك', 'SELF_ACTION');
            if (u.role === 'ADMIN' && ctx.user.adminLevel !== 'SUPER_ADMIN')
                throw E.forbidden('تعليق المديرين يتطلب مدير أعلى', 'INSUFFICIENT_ADMIN_LEVEL');
            db.run('UPDATE users SET status = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?', b.status, iso(app.clock.now()), u.id);
            if (b.status === 'SUSPENDED')
                db.run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', iso(app.clock.now()), u.id);
            app.audit.log({ ctx, action: b.status === 'SUSPENDED' ? 'user.suspend' : 'user.activate', entityType: 'user', entityId: u.id, before: { status: u.status }, after: { status: b.status, reason: b.reason || null } });
            app.sse.send(u.id, 'sync', { scope: 'users' });
            return { user: serializeUser({ ...u, status: b.status }) };
        });
    });
    r.post('/admin/admins', auth, adminLevel('SUPER_ADMIN'), async (ctx) => {
        const b = parse(s.obj({
            fullName: s.str({ min: 2, max: 80 }), phone: s.str({ min: 8, max: 24 }),
            email: s.str({ max: 160, lower: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'بريد إلكتروني غير صالح' }),
            password: s.str({ min: 10, max: 128, trim: false, pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, patternMessage: 'يجب أن تحتوي كلمة المرور على حرف ورقم' }),
            adminLevel: s.oneOf(['ADMIN', 'SUPPORT']),
        }), ctx.body);
        const phone = normalizePhone(b.phone);
        if (!PHONE_RE.test(phone))
            throw E.unprocessable('رقم هاتف غير صالح', 'VALIDATION_ERROR', [{ path: 'phone', message: 'رقم هاتف غير صالح' }]);
        const hash = await hashPassword(b.password);
        return db.tx(() => {
            if (db.get('SELECT 1 FROM users WHERE phone = ? OR email = ?', phone, b.email))
                throw E.conflict('الهاتف أو البريد مسجل مسبقًا', 'USER_EXISTS');
            const id = uuid(), now = iso(app.clock.now());
            db.run('INSERT INTO users(id,role_id,full_name,phone,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 3, b.fullName, phone, b.email, hash, now, now);
            db.run('INSERT INTO admin_users(user_id, admin_level, created_by) VALUES (?,?,?)', id, b.adminLevel, ctx.user.id);
            app.audit.log({ ctx, action: 'admin.create', entityType: 'user', entityId: id, after: { adminLevel: b.adminLevel, email: b.email } });
            ctx.status = 201;
            return { user: serializeUser(app.authService.loadUser('u.id = ?', id)) };
        });
    });
    r.get('/admin/audit-logs', auth, adminLevel('ADMIN'), (ctx) => {
        const limit = Math.min(Number.parseInt(ctx.query['limit'] ?? '', 10) || 50, 200);
        const where = [];
        const params = [];
        if (ctx.query['entityType']) {
            where.push('entity_type = ?');
            params.push(String(ctx.query['entityType']));
        }
        if (ctx.query['entityId']) {
            where.push('entity_id = ?');
            params.push(String(ctx.query['entityId']));
        }
        if (ctx.query['action']) {
            where.push('action = ?');
            params.push(String(ctx.query['action']));
        }
        if (ctx.query['before']) {
            where.push('id < ?');
            params.push(Number(ctx.query['before']) || 0);
        }
        const rows = db.all(`SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...params, limit);
        return { logs: rows.map((l) => ({ id: l.id, actorId: l.actor_id, actorRole: l.actor_role, action: l.action, entityType: l.entity_type, entityId: l.entity_id, before: parseJson(l.before), after: parseJson(l.after), ip: l.ip, createdAt: l.created_at })),
            nextBefore: rows.length === limit ? rows[rows.length - 1].id : null };
    });
}
//# sourceMappingURL=admin.core.js.map
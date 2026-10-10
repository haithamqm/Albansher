import { iso } from '../core/util.js';
export function createAudit(app) {
    return {
        /** سجل تدقيق للعمليات الحساسة. لا تمرر كلمات مرور أو رموزًا في before/after. */
        log({ ctx, actor, action, entityType, entityId, before, after }) {
            const a = actor || (ctx?.user ? { id: ctx.user.id, role: ctx.user.role } : { id: null, role: 'SYSTEM' });
            app.db.run(`INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, a.id || null, a.role || 'SYSTEM', action, entityType || null, entityId || null, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), ctx?.ip || null, ctx?.userAgent || null, iso(app.clock.now()));
        },
    };
}
//# sourceMappingURL=audit.js.map
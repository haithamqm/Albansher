import { iso } from '../core/util.js';
import type { App } from '../app.js';
import type { Ctx } from '../core/http.js';

export interface AuditActor { id: string | null; role: string }
export interface AuditEntry { ctx?: Ctx; actor?: AuditActor; action: string; entityType?: string; entityId?: string | null; before?: unknown; after?: unknown }
export interface AuditSvc { log(e: AuditEntry): void }

export function createAudit(app: App): AuditSvc {
  return {
    /** سجل تدقيق للعمليات الحساسة. لا تمرر كلمات مرور أو رموزًا في before/after. */
    log({ ctx, actor, action, entityType, entityId, before, after }: AuditEntry): void {
      const a: AuditActor = actor || (ctx?.user ? { id: ctx.user.id, role: ctx.user.role } : { id: null, role: 'SYSTEM' });
      app.db.run(
        `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        a.id || null, a.role || 'SYSTEM', action, entityType || null, entityId || null,
        before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
        ctx?.ip || null, ctx?.userAgent || null, iso(app.clock.now()));
    },
  };
}

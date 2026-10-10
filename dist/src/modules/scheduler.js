import { uuid as cryptoId } from '../core/security.js';
export function createScheduler(app) {
    let timer = null;
    const runOnce = () => {
        try {
            const r = app.assignment.tick();
            if (r.expired || r.waved || r.exhausted)
                app.log.debug('scheduler_tick', r);
        }
        catch (e) {
            app.log.error('scheduler_tick_failed', { err: String(e) });
        }
        try {
            const now = new Date(app.clock.now()).toISOString();
            app.db.run(`UPDATE quotes SET status='EXPIRED', updated_at=? WHERE status='SUBMITTED' AND valid_until IS NOT NULL AND valid_until <= ?`, now, now);
            const timeout = app.settings.get('presence.timeout_sec');
            const cutoff = new Date(app.clock.now() - timeout * 1000).toISOString();
            const stale = app.db.all(`SELECT id,user_id FROM service_providers WHERE is_online=1 AND (last_seen_at IS NULL OR last_seen_at < ?)`, cutoff);
            for (const p of stale) {
                app.db.run(`UPDATE service_providers SET is_online=0,updated_at=? WHERE id=?`, now, p.id);
                app.db.run(`UPDATE provider_presence_sessions SET ended_at=? WHERE provider_id=? AND ended_at IS NULL`, now, p.id);
                app.sse.send(p.user_id, 'sync', { scope: 'provider' });
            }
            // تعافٍ تلقائي: إذا انقطع مقدم الخدمة بعد القبول وقبل بدء التنفيذ، أعد الطلب للبحث.
            const stuck = app.db.all(`SELECT o.id,o.provider_id,o.code FROM orders o JOIN service_providers sp ON sp.id=o.provider_id WHERE o.status='ACCEPTED' AND sp.is_online=0 AND o.updated_at < ?`, new Date(app.clock.now() - Math.max(30, app.settings.get('assignment.offer_ttl_sec') || 120) * 1000).toISOString());
            for (const o of stuck) {
                const old = o.provider_id;
                const changed = app.db.run(`UPDATE orders SET provider_id=NULL,status='SEARCHING',updated_at=?,version=version+1 WHERE id=? AND status='ACCEPTED' AND provider_id=?`, now, o.id, old);
                if (changed.changes) {
                    app.db.run(`UPDATE order_assignments SET status='WITHDRAWN',responded_at=?,decision_reason='تعذر الوصول إلى مقدم الخدمة بعد القبول' WHERE order_id=? AND provider_id=? AND status='OFFERED'`, now, o.id, old);
                    app.db.run(`INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,reason,created_at) VALUES(?,?,?,?,?,?,?)`, o.id, 'ACCEPTED', 'SEARCHING', null, 'SYSTEM', 'تعافٍ تلقائي بعد انقطاع مقدم الخدمة', now);
                    app.db.run(`INSERT INTO provider_behavior_flags(id,provider_id,flag_type,severity,count_value,last_seen_at,details,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,flag_type,status) DO UPDATE SET count_value=count_value+1,last_seen_at=excluded.last_seen_at,details=excluded.details,updated_at=excluded.updated_at`, cryptoId(), old, 'ACCEPTED_THEN_OFFLINE', 'REVIEW', 1, now, 'مقدم الخدمة انقطع بعد قبول الطلب', 'OPEN', now, now);
                    const oldUser = app.db.get('SELECT user_id FROM service_providers WHERE id=?', old)?.user_id;
                    if (oldUser)
                        app.notifications.notify(oldUser, 'PROVIDER_REASSIGNED', { code: o.code }, { orderId: o.id });
                    app.assignment.assignWave(o.id);
                }
            }
        }
        catch (e) {
            app.log.error('scheduler_quote_expiry_failed', { err: String(e) });
        }
    };
    return {
        start() { if (!timer) {
            timer = setInterval(runOnce, app.config.assignmentTickMs);
            timer.unref?.();
        } },
        stop() { if (timer) {
            clearInterval(timer);
            timer = null;
        } },
        runOnce,
    };
}
//# sourceMappingURL=scheduler.js.map
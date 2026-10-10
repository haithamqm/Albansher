import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
export class CashPayment {
    method = 'CASH';
    app;
    constructor(app) { this.app = app; }
    onAccepted(order) {
        const now = iso(this.app.clock.now());
        this.app.db.run('INSERT INTO payments(id,order_id,method,status,amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uuid(), order.id, this.method, 'PENDING', order.agreed_price ?? 0, order.currency, now, now);
    }
    /** الدفع النقدي يُعدّ مستلمًا عند إكمال الخدمة (تُستبدل هذه القاعدة عند إضافة بوابات دفع حقيقية). */
    onCompleted(order) {
        this.app.db.run(`UPDATE payments SET status = 'PAID', provider_ref = 'cash', updated_at = ? WHERE order_id = ? AND status = 'PENDING'`, iso(this.app.clock.now()), order.id);
    }
    onCancelled(order) {
        this.app.db.run(`UPDATE payments SET status = 'FAILED', provider_ref = 'order_cancelled', updated_at = ? WHERE order_id = ? AND status = 'PENDING'`, iso(this.app.clock.now()), order.id);
    }
}
//# sourceMappingURL=payment.js.map
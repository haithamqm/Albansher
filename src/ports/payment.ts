import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import type { Db, Row } from '../db/database.js';
import type { Clock } from '../app.js';

/** أقل تبعية يحتاجها منفّذ الدفع من التطبيق — Port لا يعتمد على App الكامل. */
interface PaymentDeps { clock: Clock; db: Db }

/**
 * Port: PaymentProvider — طرق الدفع المستقبلية (محافظ، بطاقات، تحويل بنكي، رصيد) تُضاف كتنفيذات جديدة بنفس الواجهة
 * دون لمس منطق الطلبات. في MVP التنفيذ الوحيد: الدفع النقدي (CASH).
 */
export interface PaymentProvider {
  readonly method: string;
  onAccepted(order: Row): void;
  onCompleted(order: Row): void;
  onCancelled(order: Row): void;
}

export class CashPayment implements PaymentProvider {
  readonly method = 'CASH';
  app: PaymentDeps;
  constructor(app: PaymentDeps) { this.app = app; }
  onAccepted(order: Row): void {
    const now = iso(this.app.clock.now());
    this.app.db.run('INSERT INTO payments(id,order_id,method,status,amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      uuid(), order.id, this.method, 'PENDING', order.agreed_price ?? 0, order.currency, now, now);
  }
  /** الدفع النقدي يُعدّ مستلمًا عند إكمال الخدمة (تُستبدل هذه القاعدة عند إضافة بوابات دفع حقيقية). */
  onCompleted(order: Row): void {
    this.app.db.run(`UPDATE payments SET status = 'PAID', provider_ref = 'cash', updated_at = ? WHERE order_id = ? AND status = 'PENDING'`, iso(this.app.clock.now()), order.id);
  }
  onCancelled(order: Row): void {
    this.app.db.run(`UPDATE payments SET status = 'FAILED', provider_ref = 'order_cancelled', updated_at = ? WHERE order_id = ? AND status = 'PENDING'`, iso(this.app.clock.now()), order.id);
  }
}

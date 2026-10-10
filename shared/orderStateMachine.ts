import type { OrderStatus, ActorRole } from '../src/types/domain.js';

/**
 * آلة حالات الطلب — مصدر الحقيقة الوحيد.
 * تُستخدم في الخادم (للإنفاذ) وفي الواجهات (لإظهار الأزرار المسموحة فقط) — نفس الملف يُستورد من الطرفين.
 */
export const STATUSES: OrderStatus[] = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
export const ACTIVE_STATUSES: OrderStatus[] = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];
export const FINAL_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED'];
export const EXECUTION_STATUSES: OrderStatus[] = ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];
export const CANCELLABLE_ORDER: OrderStatus[] = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];

interface Transition { from: OrderStatus; to: OrderStatus; actors: ActorRole[] }
const A = (from: OrderStatus, to: OrderStatus, ...actors: ActorRole[]): Transition => ({ from, to, actors });

export const TRANSITIONS: Transition[] = [
  A('PENDING', 'SEARCHING', 'SYSTEM'),
  A('SEARCHING', 'ASSIGNED', 'SYSTEM'),
  A('ASSIGNED', 'SEARCHING', 'SYSTEM'),
  A('SEARCHING', 'ACCEPTED', 'PROVIDER', 'CUSTOMER', 'ADMIN'), // المزود يقبل العرض، أو العميل يقبل عرض سعر
  A('ASSIGNED', 'ACCEPTED', 'PROVIDER', 'ADMIN'),
  A('ACCEPTED', 'ON_THE_WAY', 'PROVIDER', 'ADMIN'),
  A('ON_THE_WAY', 'IN_PROGRESS', 'PROVIDER', 'ADMIN'),
  A('IN_PROGRESS', 'COMPLETED', 'PROVIDER', 'ADMIN'),
  ...CANCELLABLE_ORDER.map((f) => A(f, 'CANCELLED', 'CUSTOMER', 'PROVIDER', 'ADMIN', 'SYSTEM')),
  // DISPUTED متاحة من أي حالة تنفيذ نشطة أو مكتملة: شكوى NO_SHOW مثلًا تُفتح قبل بدء التنفيذ فعليًا (ACCEPTED/ON_THE_WAY)
  A('ACCEPTED', 'DISPUTED', 'CUSTOMER', 'ADMIN'),
  A('ON_THE_WAY', 'DISPUTED', 'CUSTOMER', 'ADMIN'),
  A('IN_PROGRESS', 'DISPUTED', 'CUSTOMER', 'ADMIN'),
  A('COMPLETED', 'DISPUTED', 'CUSTOMER', 'ADMIN'),
  A('DISPUTED', 'COMPLETED', 'ADMIN'),
  A('DISPUTED', 'CANCELLED', 'ADMIN'),
];

export const canTransition = (from: OrderStatus, to: OrderStatus, actor: ActorRole): boolean =>
  TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));

export const allowedNext = (status: OrderStatus, actor: ActorRole): OrderStatus[] =>
  TRANSITIONS.filter((t) => t.from === status && t.actors.includes(actor)).map((t) => t.to);

export const statusIndex = (s: OrderStatus): number => STATUSES.indexOf(s);

/** حالات التنفيذ التي يحدّثها المزود بزر واحد. */
export const PROVIDER_STEPS: Partial<Record<OrderStatus, OrderStatus>> = { ACCEPTED: 'ON_THE_WAY', ON_THE_WAY: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED' };

/**
 * آلة حالات الطلب — مصدر الحقيقة الوحيد.
 * تُستخدم في الخادم (للإنفاذ) وفي الواجهات (لإظهار الأزرار المسموحة فقط) — نفس الملف يُستورد من الطرفين.
 */
export const STATUSES = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
export const ACTIVE_STATUSES = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];
export const FINAL_STATUSES = ['COMPLETED', 'CANCELLED'];
export const EXECUTION_STATUSES = ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];
export const CANCELLABLE_ORDER = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'];
const A = (from, to, ...actors) => ({ from, to, actors });
export const TRANSITIONS = [
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
export const canTransition = (from, to, actor) => TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
export const allowedNext = (status, actor) => TRANSITIONS.filter((t) => t.from === status && t.actors.includes(actor)).map((t) => t.to);
export const statusIndex = (s) => STATUSES.indexOf(s);
/** حالات التنفيذ التي يحدّثها المزود بزر واحد. */
export const PROVIDER_STEPS = { ACCEPTED: 'ON_THE_WAY', ON_THE_WAY: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED' };
//# sourceMappingURL=orderStateMachine.js.map
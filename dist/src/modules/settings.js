import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { parseJson, iso } from '../core/util.js';
/** سجل الإعدادات: كل إعداد له قيمة افتراضية ومخطط تحقق. لا قيم أعمال مبرمجة داخل المنطق. */
export const SETTINGS = {
    'platform.country': { def: 'YE', schema: s.str({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ }), desc: 'الدولة المستهدفة (ISO 3166-1 alpha-2)' },
    'platform.currency': { def: 'YER', schema: s.str({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }), desc: 'رمز العملة (ISO 4217)' },
    'platform.timezone': { def: 'Asia/Aden', schema: s.str({ min: 1, max: 60 }), desc: 'المنطقة الزمنية (IANA) لحساب أوقات العمل' },
    'platform.default_locale': { def: 'ar', schema: s.oneOf(['ar', 'en']), desc: 'اللغة الافتراضية للواجهات' },
    'platform.commission_percent': { def: 10, schema: s.num({ min: 0, max: 100 }), desc: 'نسبة عمولة المنصة % (تقارير الأرباح)' },
    'assignment.offer_ttl_sec': { def: 180, schema: s.int({ min: 10, max: 86400 }), desc: 'مهلة قبول عرض الإسناد بالثواني' },
    'assignment.batch_size': { def: 5, schema: s.int({ min: 1, max: 50 }), desc: 'عدد المزودين في كل موجة (المطابقة الافتراضية: الأقرب أولًا)' },
    'assignment.max_waves': { def: 3, schema: s.int({ min: 1, max: 20 }), desc: 'أقصى عدد موجات إسناد' },
    'assignment.search_retry_minutes': { def: 10, schema: s.int({ min: 1, max: 1440 }), desc: 'دقائق إعادة البحث عن مقدم خدمة بعد استنفاد الموجات' },
    'assignment.auto_reassign_provider_cancel': { def: true, schema: s.bool(), desc: 'إعادة البحث تلقائيًا إذا ألغى مقدم الخدمة بعد القبول وقبل بدء التنفيذ' },
    'presence.timeout_sec': { def: 300, schema: s.int({ min: 30, max: 86400 }), desc: 'مهلة اعتبار مقدم الخدمة غير متصل عند غياب نبضة الحياة' },
    'operations.acceptance_sla_sec': { def: 180, schema: s.int({ min: 30, max: 86400 }), desc: 'مدة انتظار القبول قبل تنبيه الإدارة' },
    'operations.execution_sla_multiplier': { def: 2, schema: s.num({ min: 1, max: 20 }), desc: 'معامل تنبيه التأخر أثناء التنفيذ' },
    'assignment.max_distance_km': { def: 5000, schema: s.num({ min: 1, max: 5000 }), desc: 'إعداد قديم غير مستخدم في المطابقة؛ لا يقيّد المسافة' },
    'matching.weight_distance': { def: 0.6, schema: s.num({ min: 0, max: 1 }), desc: 'وزن المسافة في الترتيب' },
    'matching.weight_rating': { def: 0.4, schema: s.num({ min: 0, max: 1 }), desc: 'وزن التقييم في الترتيب' },
    'orders.max_active_per_customer': { def: 10, schema: s.int({ min: 1, max: 200 }), desc: 'أقصى عدد طلبات نشطة للعميل' },
    'quotes.default_valid_hours': { def: 48, schema: s.int({ min: 1, max: 720 }), desc: 'صلاحية عرض السعر بالساعات' },
    'trips.enabled': { def: true, schema: s.bool(), desc: 'تفعيل نظام المشاوير بالدباب' },
    'trips.base_fare': { def: 500, schema: s.num({ min: 0, max: 1000000 }), desc: 'أجرة بداية المشوار بالريال' },
    'trips.per_km_fare': { def: 300, schema: s.num({ min: 0, max: 1000000 }), desc: 'أجرة كل كيلومتر للمشوار بالريال' },
    'trips.minimum_fare': { def: 1000, schema: s.num({ min: 0, max: 1000000 }), desc: 'الحد الأدنى لأجرة المشوار بالريال' },
    'trips.waiting_per_minute_fare': { def: 50, schema: s.num({ min: 0, max: 1000000 }), desc: 'أجرة دقيقة الانتظار للمشاوير' },
    'push.vapid_public_key': { def: '', schema: s.str({ max: 200 }), desc: 'مفتاح VAPID العام لإشعارات الويب' },
    'push.vapid_private_key': { def: '', schema: s.str({ max: 4000 }), desc: 'مفتاح VAPID الخاص لإشعارات الويب' },
    'push.subject': { def: 'mailto:HaithamPro77@gmail.com', schema: s.str({ min: 5, max: 200 }), desc: 'هوية مرسل إشعارات الويب VAPID' },
};
export function createSettings(app) {
    const { db } = app;
    let cache = null;
    const load = () => {
        cache = {};
        for (const [k, v] of Object.entries(SETTINGS))
            cache[k] = v.def;
        for (const r of db.all('SELECT key, value FROM system_settings'))
            if (r.key in SETTINGS)
                cache[r.key] = parseJson(r.value);
    };
    return {
        get(key) { if (!cache)
            load(); if (!(key in SETTINGS))
            throw new Error(`unknown setting ${key}`); return cache[key]; },
        all() { if (!cache)
            load(); return Object.entries(SETTINGS).map(([key, m]) => ({ key, value: cache[key], default: m.def, description: m.desc })); },
        set(key, value, actorId) {
            const meta = SETTINGS[key];
            if (!meta)
                throw E.unprocessable('إعداد غير معروف', 'UNKNOWN_SETTING');
            const v = parse(meta.schema, value);
            db.run(`INSERT INTO system_settings(key,value,description,updated_by,updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, key, JSON.stringify(v), meta.desc, actorId || null, iso(app.clock.now()));
            cache = null;
            return v;
        },
        invalidate() { cache = null; },
    };
}
//# sourceMappingURL=settings.js.map
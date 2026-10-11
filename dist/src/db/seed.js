import { uuid, hashPassword, randomToken } from '../core/security.js';
import { iso } from '../core/util.js';
import { CATEGORIES, DEMO_AREAS } from './seed-data.js';
import { SETTINGS } from '../modules/settings.js';
const j = JSON.stringify;
/** Seed آمن لإعادة التشغيل (Idempotent): لا يكرر ولا يفرط في الكتابة فوق تعديلات المدير. */
export async function seedBase(db, config) {
    const now = iso();
    const out = { categories: 0, services: 0, adminCreated: false, adminPassword: null };
    db.tx(() => {
        db.run(`INSERT OR IGNORE INTO cancellation_policies(id,name,free_until_status,allowed_until_status,fee_percent) VALUES ('default','السياسة الافتراضية','ASSIGNED','ON_THE_WAY',0)`);
        // نطاق جغرافي عام لليمن كبيانات وصفية فقط. لا يستخدم لتحديد تغطية مقدم الخدمة؛
        // قبول الطلب يعتمد على GPS الفعلي، والمطابقة لاحقًا تعتمد على أقرب مقدم خدمة.
        db.run(`INSERT OR IGNORE INTO service_areas(id,parent_id,name_i18n,type,center_lat,center_lng,radius_km,created_at,updated_at)
            VALUES ('system-yemen',NULL,?,'COUNTRY',15.55,48.52,2000,?,?)`, j({ ar: 'اليمن', en: 'Yemen' }), now, now);
        // الإعدادات الافتراضية تُكتب في القاعدة لتظهر وتُعدَّل من اللوحة (لا تُستبدل إن كانت موجودة)
        for (const [key, m] of Object.entries(SETTINGS))
            db.run('INSERT OR IGNORE INTO system_settings(key,value,description,updated_at) VALUES (?,?,?,?)', key, j(m.def), m.desc, now);
        // البنشر الذكي لا يقدم مشاوير بالدباب؛ أوقف الإعداد القديم حتى في قواعد البيانات المرقّاة.
        db.run("INSERT INTO system_settings(key,value,description,updated_at) VALUES ('trips.enabled','false','ميزة قديمة غير مستخدمة في البنشر الذكي',?) ON CONFLICT(key) DO UPDATE SET value='false',description=excluded.description,updated_at=excluded.updated_at", now);
        CATEGORIES.forEach((c, ci) => {
            let cat = db.get('SELECT id FROM categories WHERE slug = ?', c.slug);
            if (!cat) {
                cat = { id: uuid() };
                db.run('INSERT INTO categories(id,slug,name_i18n,icon,keywords,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', cat.id, c.slug, j(c.name), c.icon, j(c.keywords), ci + 1, now, now);
                out.categories++;
            }
            if (c.slug === 'agriculture') {
                const parent = db.get('SELECT id FROM categories WHERE slug=?', 'on-demand-labor');
                if (parent)
                    db.run('UPDATE categories SET parent_id=? WHERE id=?', parent.id, cat.id);
            }
            c.services.forEach((sv, si) => {
                if (db.get('SELECT 1 FROM services WHERE slug = ?', sv.slug))
                    return;
                db.run(`INSERT INTO services(id,category_id,slug,name_i18n,icon,keywords,pricing_type,base_price,form_schema,cancellation_policy_id,requires_inspection,requires_vehicle,supports_waiting,seasonal_enabled,season_start_at,season_end_at,sort_order,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), cat.id, sv.slug, j(sv.name), sv.icon, j(sv.keywords), sv.pricing, sv.pricing === 'FIXED' ? sv.price : null, j(sv.form), 'default', sv.requiresInspection ? 1 : 0, sv.requiresVehicle ? 1 : 0, sv.supportsWaiting ? 1 : 0, sv.seasonal ? 1 : 0, null, null, si + 1, now, now);
                out.services++;
            });
        });
        // الزراعة عائلة مستقلة في تجربة العميل، لكنها تُحفظ كقسم فرعي لتوافق الكتالوج التاريخي.
        const agri = db.get('SELECT id FROM categories WHERE slug=?', 'agriculture');
        const labor = db.get('SELECT id FROM categories WHERE slug=?', 'on-demand-labor');
        if (agri && labor)
            db.run('UPDATE categories SET parent_id=? WHERE id=?', labor.id, agri.id);
        // إعدادات تشغيلية للخدمات التي تتطلب إثبات تسليم: تُطبق بعد إنشاء seed للخدمات لأن migrations تسبق seedBase.
        db.run("UPDATE services SET delivery_proof_type='PIN' WHERE slug IN ('parcel-delivery','shopping-delivery','shopping-for-me','document-delivery','motorcycle-trips','pharmacy-purchase','purchase-and-delivery')");
        // قاموس المرادفات اليمنية: بيانات قابلة للإدارة، ويستخدمها محرك المطابقة فعليًا.
        const aliasMap = {
            'motorcycle-trips': ['دباب', 'موتور', 'موتوسيكل', 'مشوار بالدباب', 'مشوار موتور'],
            'purchase-and-delivery': ['اشتر لي', 'اشتري لي', 'جيب لي', 'هات لي', 'دبر لي', 'شراء وإحضار', 'اشتره لي ووصلّه'],
            'shopping-for-me': ['مقاضي', 'مقاضي البيت', 'بقالة', 'بقاله', 'مواد البيت', 'احتياجات البيت', 'تسوق لي', 'تسوق عني'],
            'pharmacy-purchase': ['دواء ويوصله', 'جيب الدواء', 'هات الدواء', 'دواء للبيت', 'من الصيدلية للبيت'],
            'parcel-delivery': ['وصل لي الطرد', 'مندوب يجيب الطرد', 'جيب الطرد', 'أرسل لي الطرد'],
            'electricity': ['كهربائي', 'فني كهرباء', 'الكهرباء طافية', 'عطل كهرباء'],
            'plumbing': ['سباك', 'مشكلة ماء', 'تسريب ماء', 'مواسير'],
            'air-conditioning': ['مكيف', 'مكيف خربان', 'فريون', 'سبلت', 'سبليت'],
            'daily-worker': ['شغيل', 'عامل يومي', 'عامل باليوم', 'حمال'],
            'seasonal-plowing': ['حراث', 'حراثة', 'حرث الأرض', 'جهز الأرض'],
            'seasonal-harvest': ['حصيدة', 'حصد المحصول', 'وقت الحصاد', 'عمال حصاد'],
            'seasonal-crop-transport': ['نقل المحصول', 'نقل الحصيدة', 'من المزرعة للسوق', 'شاحنة للمحصول'],
            'farm-worker': ['عامل مزرعة', 'شغيل مزرعة', 'عامل زراعة'],
            'water-tank-delivery': ['ماء', 'مياه', 'وايت', 'صهريج', 'تعبئة خزان', 'توصيل ماء'],
            'solar-maintenance': ['طاقة شمسية', 'لوح شمسي', 'ألواح', 'بطارية شمسية', 'انفرتر', 'صيانة الطاقة'],
            'internet-router-support': ['نت', 'انترنت', 'إنترنت', 'راوتر', 'واي فاي', 'شبكة', 'ضعف النت'],
            'tailoring-alterations': ['خياط', 'خياطة', 'تفصيل', 'تعديل ملابس', 'تضييق', 'توسيع'],
            'home-cooking-catering': ['طبخ منزلي', 'طبخ', 'طباخ', 'تجهيز مناسبة', 'وليمة', 'عزومة'],
            'laundry-ironing': ['غسيل ملابس', 'غسيل', 'كي الملابس', 'كي'],
            'water-pump-maintenance': ['مضخة ماء', 'مضخة مياه', 'موتور ماء', 'طرمبة ماء', 'موتور الماء'],
        };
        for (const [slug, phrases] of Object.entries(aliasMap)) {
            const svc = db.get('SELECT id FROM services WHERE slug=?', slug);
            if (!svc)
                continue;
            for (const phrase of phrases) {
                const normalized = phrase.toLowerCase().trim().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '').replace(/\s+/g, ' ');
                db.run('INSERT OR IGNORE INTO service_aliases(id,service_id,phrase,normalized_phrase,source,created_at) VALUES(?,?,?,?,?,?)', uuid(), svc.id, phrase, normalized, 'SEED', now);
            }
        }
        // ترحيل آمن للاستحقاقات المالية للطلبات المكتملة القديمة بعد إضافة دفتر التسويات.
        const commissionRate = Number(SETTINGS['platform.commission_percent']?.def || 10);
        const completed = db.all(`SELECT id,provider_id,currency,COALESCE(agreed_price,price_snapshot,0) gross,completed_at FROM orders WHERE status='COMPLETED' AND provider_id IS NOT NULL`);
        for (const o of completed) {
            if (db.get('SELECT 1 FROM provider_settlements WHERE order_id=?', o.id))
                continue;
            const gross = Number(o.gross || 0);
            const commission = Math.round(gross * commissionRate) / 100;
            const payout = Math.max(0, gross - commission);
            const status = commission > 0 ? 'DUE' : 'WAIVED';
            db.run(`UPDATE orders SET commission_rate_snapshot=COALESCE(commission_rate_snapshot,?),commission_amount=COALESCE(commission_amount,?),provider_payout_amount=COALESCE(provider_payout_amount,?),settlement_status=CASE WHEN settlement_status='NOT_APPLICABLE' THEN ? ELSE settlement_status END WHERE id=?`, commissionRate, commission, payout, status, o.id);
            if (commission > 0)
                db.run(`INSERT OR IGNORE INTO provider_settlements(id,order_id,provider_id,gross_amount,commission_rate,commission_amount,payout_amount,currency,status,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), o.id, o.provider_id, gross, commissionRate, commission, payout, o.currency, 'DUE', o.completed_at || now, o.completed_at || now, now);
        }
        // انقل/حدّث أي خدمة تحمل أحد معرفات كتالوج المركبات إلى القسم الحالي، حتى عند ترقية قاعدة بيانات قديمة.
        const vehicleCategoryForUpdate = db.get('SELECT id FROM categories WHERE slug=?', 'vehicle-services');
        if (vehicleCategoryForUpdate) {
            const vehicleCategoryDef = CATEGORIES.find(c => c.slug === 'vehicle-services');
            for (const [index, sv] of (vehicleCategoryDef?.services || []).entries()) {
                const existing = db.get('SELECT id,category_id FROM services WHERE slug=?', sv.slug);
                if (!existing || existing.category_id === vehicleCategoryForUpdate.id)
                    continue;
                db.run(`UPDATE services SET category_id=?,name_i18n=?,icon=?,keywords=?,pricing_type=?,base_price=?,form_schema=?,requires_inspection=?,requires_vehicle=?,sort_order=?,is_active=1,updated_at=? WHERE id=?`, vehicleCategoryForUpdate.id, j(sv.name), sv.icon, j(sv.keywords), sv.pricing, sv.pricing === 'FIXED' ? sv.price : null, j(sv.form), sv.requiresInspection ? 1 : 0, sv.requiresVehicle ? 1 : 0, index + 1, now, existing.id);
            }
        }
        // خدمة المركبات المخصصة تُنشأ/تُنقل إلى القسم الوحيد الخاص بالبنشـر والصيانة.
        const vehicleCategory = db.get('SELECT id FROM categories WHERE slug=?', 'vehicle-services');
        if (vehicleCategory) {
            const custom = db.get('SELECT id,category_id FROM services WHERE slug=?', 'custom-request');
            if (!custom)
                db.run(`INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,cancellation_policy_id,default_priority,sort_order,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), vehicleCategory.id, 'custom-request', j({ ar: 'خدمة أخرى للمركبات', en: 'Other vehicle service' }), j({ ar: 'اطلب خدمة بنشر أو صيانة مركبة غير موجودة في القائمة مع وصف واضح', en: 'Request another tire or vehicle service with a clear description' }), '🧰', j(['خدمة أخرى', 'طلب خاص', 'خدمة غير موجودة', 'صيانة أخرى']), 'QUOTE', null, j([{ key: 'issue_description', type: 'textarea', label: { ar: 'ما الخدمة التي تحتاجها؟', en: 'Describe the required service' }, required: true }]), 'default', 'NORMAL', 999, 1, now, now);
            else if (custom.category_id !== vehicleCategory.id)
                db.run(`UPDATE services SET category_id=?,is_active=1,updated_at=? WHERE id=?`, vehicleCategory.id, now, custom.id);
            // عند استخدام قاعدة بيانات قديمة، أخفِ كتالوج الخدمات العامة من واجهة التشغيل دون حذف سجلات الطلبات التاريخية.
            db.run(`UPDATE categories SET is_active=CASE WHEN slug='vehicle-services' THEN 1 ELSE 0 END, updated_at=?`, now);
            db.run(`UPDATE services SET is_active=0, updated_at=? WHERE category_id<>?`, now, vehicleCategory.id);
            // عطّل خدمة المشاوير القديمة صراحةً حتى لو كانت محفوظة داخل قسم المركبات في قاعدة قديمة.
            db.run("UPDATE services SET is_active=0,updated_at=? WHERE slug='motorcycle-trips'", now);
        }
    });
    // مدير النظام الأول
    const a = config.admin;
    if (!db.get('SELECT 1 FROM admin_users WHERE admin_level = ?', 'SUPER_ADMIN')) {
        const password = a.password || (config.isProd ? randomToken(12) + 'a1' : 'Admin12345');
        const hash = await hashPassword(password);
        const id = uuid();
        db.tx(() => {
            db.run('INSERT INTO users(id,role_id,full_name,phone,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 3, a.name, a.phone, a.email.toLowerCase(), hash, now, now);
            db.run(`INSERT INTO admin_users(user_id, admin_level) VALUES (?, 'SUPER_ADMIN')`, id);
        });
        out.adminCreated = true;
        out.adminPassword = a.password ? '(من ADMIN_PASSWORD)' : password;
    }
    return out;
}
/** بيانات تجريبية للتطوير فقط — ترفض العمل في الإنتاج. */
export async function seedDemo(db, config) {
    if (config.isProd)
        throw new Error('seed:demo is not allowed in production');
    const now = iso();
    const ids = {};
    db.tx(() => {
        for (const a of DEMO_AREAS) {
            const ex = db.get(`SELECT id FROM service_areas WHERE json_extract(name_i18n,'$.en') = ?`, a.name.en);
            ids[a.key] = ex?.id || uuid();
            if (!ex)
                db.run('INSERT INTO service_areas(id,parent_id,name_i18n,type,center_lat,center_lng,radius_km,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', ids[a.key], a.parent ? ids[a.parent] : null, j(a.name), a.type, a.lat, a.lng, a.radius, now, now);
        }
    });
    const users = [
        ['demo-customer', 'عميل تجريبي', '+967770000001', 'customer@demo.local', 1],
        ['demo-provider', 'فني تجريبي', '+967770000002', 'provider@demo.local', 2],
    ];
    const password = 'Demo12345';
    const hash = await hashPassword(password);
    for (const [, name, phone, email, role] of users) {
        if (db.get('SELECT 1 FROM users WHERE phone = ?', phone))
            continue;
        const id = uuid();
        db.tx(() => {
            db.run('INSERT INTO users(id,role_id,full_name,phone,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, role, name, phone, email, hash, now, now);
            if (role === 2)
                db.run(`INSERT INTO service_providers(id,user_id,provider_type,display_name,verification_status,verified_at,base_lat,base_lng,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, uuid(), id, 'TECHNICIAN', name, 'VERIFIED', now, 12.79, 45.02, now, now);
        });
    }
    return { password, accounts: users.map((u) => u[3]) };
}
//# sourceMappingURL=seed.js.map
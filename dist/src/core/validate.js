import { AppError } from './errors.js';
/**
 * مُحقِّق مدخلات خفيف وبدون اعتماديات. يُستخدم على الخادم دائمًا (لا نثق بالواجهة).
 * الحقول غير المعرّفة في obj تُحذف تلقائيًا.
 */
export const s = {
    str: (o = {}) => ({ t: 'str', ...o }),
    num: (o = {}) => ({ t: 'num', ...o }),
    int: (o = {}) => ({ t: 'int', ...o }),
    bool: (o = {}) => ({ t: 'bool', ...o }),
    oneOf: (values, o = {}) => ({ t: 'enum', values, ...o }),
    arr: (item, o = {}) => ({ t: 'arr', item, ...o }),
    obj: (shape, o = {}) => ({ t: 'obj', shape, ...o }),
    date: (o = {}) => ({ t: 'date', ...o }),
    any: (o = {}) => ({ t: 'any', ...o }),
};
const arabicDigits = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
export const normalizeDigits = (str) => String(str).replace(/[٠-٩]/g, (d) => arabicDigits[d] ?? d);
export const normalizePhone = (p) => normalizeDigits(p).replace(/[\s\-().]/g, '');
export const PHONE_RE = /^\+?[0-9]{8,15}$/;
function run(sc, val, path, errs) {
    if (val === undefined || val === null || val === '') {
        if (sc.optional)
            return sc.default;
        errs.push({ path, message: 'هذا الحقل مطلوب' });
        return undefined;
    }
    const bad = (message) => { errs.push({ path, message }); return undefined; };
    switch (sc.t) {
        case 'str': {
            if (typeof val !== 'string')
                return bad('يجب أن يكون نصًا');
            let x = sc.trim === false ? val : val.trim();
            if (sc.lower)
                x = x.toLowerCase();
            if (typeof sc.min === 'number' && x.length < sc.min)
                return bad(`الحد الأدنى ${sc.min} أحرف`);
            if (typeof sc.max === 'number' && x.length > sc.max)
                return bad(`الحد الأقصى ${sc.max} حرفًا`);
            if (sc.pattern && !sc.pattern.test(x))
                return bad(sc.patternMessage || 'صيغة غير صحيحة');
            return x;
        }
        case 'num':
        case 'int': {
            const x = sc.coerce && typeof val === 'string' ? Number(val) : val;
            if (typeof x !== 'number' || !Number.isFinite(x))
                return bad('يجب أن يكون رقمًا');
            if (sc.t === 'int' && !Number.isInteger(x))
                return bad('يجب أن يكون عددًا صحيحًا');
            if (typeof sc.min === 'number' && x < sc.min)
                return bad(`القيمة الدنيا ${sc.min}`);
            if (typeof sc.max === 'number' && x > sc.max)
                return bad(`القيمة القصوى ${sc.max}`);
            return x;
        }
        case 'bool': {
            if (typeof val === 'boolean')
                return val;
            if (sc.coerce && (val === 'true' || val === 'false'))
                return val === 'true';
            return bad('يجب أن تكون قيمة منطقية');
        }
        case 'enum':
            return sc.values.includes(val) ? val : bad('قيمة غير مسموحة');
        case 'date': {
            const d = new Date(val);
            if (typeof val !== 'string' || Number.isNaN(d.getTime()))
                return bad('تاريخ غير صالح');
            return d.toISOString();
        }
        case 'arr': {
            if (!Array.isArray(val))
                return bad('يجب أن تكون قائمة');
            if (typeof sc.min === 'number' && val.length < sc.min)
                return bad(`الحد الأدنى ${sc.min} عناصر`);
            if (typeof sc.max === 'number' && val.length > sc.max)
                return bad(`الحد الأقصى ${sc.max} عناصر`);
            return val.map((v, i) => run(sc.item, v, `${path}[${i}]`, errs));
        }
        case 'obj': {
            if (typeof val !== 'object' || Array.isArray(val))
                return bad('يجب أن يكون كائنًا');
            const out = {};
            for (const [k, sub] of Object.entries(sc.shape)) {
                const r = run(sub, val[k], path ? `${path}.${k}` : k, errs);
                if (r !== undefined)
                    out[k] = r;
            }
            return out;
        }
        case 'any':
            return val;
        default:
            throw new Error(`unknown schema type ${sc.t}`);
    }
}
export function parse(schema, data) {
    const errs = [];
    const value = run(schema, data ?? (schema.t === 'obj' ? {} : data), '', errs);
    if (errs.length)
        throw new AppError(422, 'VALIDATION_ERROR', 'بيانات غير صالحة', errs);
    return value;
}
//# sourceMappingURL=validate.js.map
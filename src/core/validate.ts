import { AppError } from './errors.js';

export type FieldType = 'str' | 'num' | 'int' | 'bool' | 'enum' | 'arr' | 'obj' | 'date' | 'any';

export interface BaseOpts { optional?: boolean; default?: unknown }
export interface StrOpts extends BaseOpts { min?: number; max?: number; trim?: boolean; lower?: boolean; pattern?: RegExp; patternMessage?: string }
export interface NumOpts extends BaseOpts { min?: number; max?: number; coerce?: boolean }
export interface BoolOpts extends BaseOpts { coerce?: boolean }
export interface ArrOpts extends BaseOpts { min?: number; max?: number }

export interface Schema { t: FieldType; optional?: boolean; default?: unknown; [k: string]: unknown }

/**
 * مُحقِّق مدخلات خفيف وبدون اعتماديات. يُستخدم على الخادم دائمًا (لا نثق بالواجهة).
 * الحقول غير المعرّفة في obj تُحذف تلقائيًا.
 */
export const s = {
  str: (o: StrOpts = {}): Schema => ({ t: 'str', ...o }),
  num: (o: NumOpts = {}): Schema => ({ t: 'num', ...o }),
  int: (o: NumOpts = {}): Schema => ({ t: 'int', ...o }),
  bool: (o: BoolOpts = {}): Schema => ({ t: 'bool', ...o }),
  oneOf: (values: readonly string[], o: BaseOpts = {}): Schema => ({ t: 'enum', values, ...o }),
  arr: (item: Schema, o: ArrOpts = {}): Schema => ({ t: 'arr', item, ...o }),
  obj: (shape: Record<string, Schema>, o: BaseOpts = {}): Schema => ({ t: 'obj', shape, ...o }),
  date: (o: BaseOpts = {}): Schema => ({ t: 'date', ...o }),
  any: (o: BaseOpts = {}): Schema => ({ t: 'any', ...o }),
};

const arabicDigits: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
export const normalizeDigits = (str: unknown): string => String(str).replace(/[٠-٩]/g, (d) => arabicDigits[d] ?? d);
export const normalizePhone = (p: unknown): string => normalizeDigits(p).replace(/[\s\-().]/g, '');
export const PHONE_RE = /^\+?[0-9]{8,15}$/;

function run(sc: Schema, val: unknown, path: string, errs: { path: string; message: string }[]): any {
  if (val === undefined || val === null || val === '') {
    if (sc.optional) return sc.default;
    errs.push({ path, message: 'هذا الحقل مطلوب' });
    return undefined;
  }
  const bad = (message: string) => { errs.push({ path, message }); return undefined; };
  switch (sc.t) {
    case 'str': {
      if (typeof val !== 'string') return bad('يجب أن يكون نصًا');
      let x = sc.trim === false ? val : val.trim();
      if (sc.lower) x = x.toLowerCase();
      if (typeof sc.min === 'number' && x.length < sc.min) return bad(`الحد الأدنى ${sc.min} أحرف`);
      if (typeof sc.max === 'number' && x.length > sc.max) return bad(`الحد الأقصى ${sc.max} حرفًا`);
      if (sc.pattern && !(sc.pattern as RegExp).test(x)) return bad((sc.patternMessage as string) || 'صيغة غير صحيحة');
      return x;
    }
    case 'num':
    case 'int': {
      const x = sc.coerce && typeof val === 'string' ? Number(val) : val;
      if (typeof x !== 'number' || !Number.isFinite(x)) return bad('يجب أن يكون رقمًا');
      if (sc.t === 'int' && !Number.isInteger(x)) return bad('يجب أن يكون عددًا صحيحًا');
      if (typeof sc.min === 'number' && x < sc.min) return bad(`القيمة الدنيا ${sc.min}`);
      if (typeof sc.max === 'number' && x > sc.max) return bad(`القيمة القصوى ${sc.max}`);
      return x;
    }
    case 'bool': {
      if (typeof val === 'boolean') return val;
      if (sc.coerce && (val === 'true' || val === 'false')) return val === 'true';
      return bad('يجب أن تكون قيمة منطقية');
    }
    case 'enum':
      return (sc.values as string[]).includes(val as string) ? val : bad('قيمة غير مسموحة');
    case 'date': {
      const d = new Date(val as string);
      if (typeof val !== 'string' || Number.isNaN(d.getTime())) return bad('تاريخ غير صالح');
      return d.toISOString();
    }
    case 'arr': {
      if (!Array.isArray(val)) return bad('يجب أن تكون قائمة');
      if (typeof sc.min === 'number' && val.length < sc.min) return bad(`الحد الأدنى ${sc.min} عناصر`);
      if (typeof sc.max === 'number' && val.length > sc.max) return bad(`الحد الأقصى ${sc.max} عناصر`);
      return val.map((v, i) => run(sc.item as Schema, v, `${path}[${i}]`, errs));
    }
    case 'obj': {
      if (typeof val !== 'object' || Array.isArray(val)) return bad('يجب أن يكون كائنًا');
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(sc.shape as Record<string, Schema>)) {
        const r = run(sub, (val as Record<string, unknown>)[k], path ? `${path}.${k}` : k, errs);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    case 'any':
      return val;
    default:
      throw new Error(`unknown schema type ${sc.t}`);
  }
}

export function parse<T = any>(schema: Schema, data: unknown): T {
  const errs: { path: string; message: string }[] = [];
  const value = run(schema, data ?? (schema.t === 'obj' ? {} : data), '', errs);
  if (errs.length) throw new AppError(422, 'VALIDATION_ERROR', 'بيانات غير صالحة', errs);
  return value as T;
}

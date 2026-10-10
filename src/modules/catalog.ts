import { s, parse, type Schema } from '../core/validate.js';
import { E } from '../core/errors.js';
import { parseJson, tr, haversineKm, iso } from '../core/util.js';
import type { App } from '../app.js';
import type { Ctx } from '../core/http.js';
import { auth, adminLevel } from './auth.middleware.js';
import { uuid } from '../core/security.js';
import type { CategoryRow, ServiceRow, ServiceAreaRow, Locale, I18nText, PricingType, Priority } from '../types/domain.js';

const I18N = s.obj({ ar: s.str({ min: 1, max: 200 }), en: s.str({ max: 200, optional: true }) });

export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'boolean', 'date'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export interface FormFieldOption { value: string; label: I18nText }
export interface FormField { key: string; type: FieldType; label: I18nText; required?: boolean; placeholder?: string; min?: number; max?: number; maxLength?: number; options?: FormFieldOption[] }

/** مخطط حقول النموذج الديناميكي لكل خدمة (يحرره المدير من اللوحة). */
export const formFieldSchema: Schema = s.obj({
  key: s.str({ min: 1, max: 40, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/, patternMessage: 'مفتاح إنجليزي (أحرف/أرقام/_) يبدأ بحرف' }),
  type: s.oneOf(FIELD_TYPES),
  label: I18N,
  required: s.bool({ optional: true, default: false }),
  placeholder: s.str({ max: 120, optional: true }),
  min: s.num({ optional: true }), max: s.num({ optional: true }),
  maxLength: s.int({ min: 1, max: 2000, optional: true }),
  options: s.arr(s.obj({ value: s.str({ min: 1, max: 60 }), label: I18N }), { max: 50, optional: true }),
});
export const formSchemaSchema: Schema = s.arr(formFieldSchema, { max: 30 });

/** يبني مُحقِّقًا من مخطط النموذج ويتحقق من form_data القادمة من العميل (على الخادم دائمًا). */
export function validateFormData(fields: FormField[], data: unknown): Record<string, unknown> {
  const shape: Record<string, Schema> = {};
  const known = new Set<string>();
  for (const f of fields) {
    known.add(f.key);
    const opt = { optional: !f.required };
    if (f.type === 'text' || f.type === 'textarea') shape[f.key] = s.str({ ...opt, max: f.maxLength || (f.type === 'textarea' ? 1000 : 200) });
    else if (f.type === 'number') shape[f.key] = s.num({ ...opt, ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) });
    else if (f.type === 'boolean') shape[f.key] = s.bool({ optional: true });
    else if (f.type === 'date') shape[f.key] = s.date(opt);
    else if (f.type === 'select') shape[f.key] = s.oneOf((f.options || []).map((o) => o.value), opt);
  }
  const clean = data && typeof data === 'object' ? Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => known.has(k))) : {};
  return parse(s.obj(shape), clean);
}

export interface CatalogSnapshot { categories: CategoryRow[]; services: ServiceRow[]; areas: ServiceAreaRow[]; byService: Map<string, ServiceRow>; byCategory: Map<string, CategoryRow> }
export interface ServiceOut { id: string; slug: string; categoryId: string; categorySlug: string | undefined; name: string; description: string; icon: string | null; pricingType: PricingType; basePrice: number | null; currency: string; defaultPriority: Priority; formSchema?: unknown; requiresInspection?: boolean; requiresVehicle?: boolean; supportsWaiting?: boolean; deliveryProofType?: string; seasonalEnabled?: boolean; seasonStartAt?: string | null; seasonEndAt?: string | null; isActive?: boolean; nameI18n?: unknown; descriptionI18n?: unknown }
export interface CategoryOut { id: string; slug: string; parentId: string | null; name: string; description: string; icon: string | null; moduleType: string; sortOrder: number; services?: ServiceOut[]; isActive?: boolean; nameI18n?: unknown; descriptionI18n?: unknown; keywords?: unknown; children?: CategoryOut[] }
export interface AreaOut { id: string; parentId: string | null; name: string; type: string; localityType: string; centerLat: number; centerLng: number; radiusKm: number; isActive?: boolean; nameI18n?: unknown }

export interface Catalog {
  invalidate(): void;
  all(): CatalogSnapshot;
  serializeService(x: ServiceRow, locale: Locale, opts?: { full?: boolean }): ServiceOut;
  serializeCategory(c: CategoryRow, locale: Locale, opts?: { withServices?: boolean; admin?: boolean }): CategoryOut;
  tree(locale: Locale): CategoryOut[];
  getActiveService(id: string): ServiceRow | null;
  serializeArea(a: ServiceAreaRow, locale: Locale, admin?: boolean): AreaOut;
  resolveArea(lat: number, lng: number): ServiceAreaRow | null;
  areaChain(areaId: string): string[];
  aliasesForService(serviceId: string): string[];
}

export function createCatalog(app: App): Catalog {
  const { db } = app;
  let cache: CatalogSnapshot | null = null, cachedAt = 0;
  const TTL = 30_000;

  function isSeasonActive(x: ServiceRow): boolean {
    if (!x.seasonal_enabled) return true;
    if (!x.season_start_at || !x.season_end_at) return false;
    const now = app.clock.now();
    const start = Date.parse(x.season_start_at);
    const end = Date.parse(x.season_end_at);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end;
  }

  function load(): CatalogSnapshot {
    if (cache && app.clock.now() - cachedAt < TTL) return cache;
    const categories = db.all<CategoryRow>('SELECT * FROM categories ORDER BY sort_order, created_at');
    const services = db.all<ServiceRow>('SELECT * FROM services ORDER BY sort_order, created_at');
    const areas = db.all<ServiceAreaRow>('SELECT * FROM service_areas ORDER BY locality_type, type, created_at');
    cache = { categories, services, areas, byService: new Map(services.map((x) => [x.id, x])), byCategory: new Map(categories.map((c) => [c.id, c])) };
    cachedAt = app.clock.now();
    return cache;
  }

  const svc: Catalog = {
    invalidate() { cache = null; },
    all: load,
    serializeService(x, locale, { full = false } = {}) {
      const c = load().byCategory.get(x.category_id);
      const out: ServiceOut = { id: x.id, slug: x.slug, categoryId: x.category_id, categorySlug: c?.slug, name: tr(x.name_i18n, locale), description: tr(x.description_i18n, locale), icon: x.icon,
        pricingType: x.pricing_type, basePrice: x.base_price, currency: app.settings.get<string>('platform.currency'), defaultPriority: x.default_priority, deliveryProofType: x.delivery_proof_type, requiresInspection: !!x.requires_inspection, requiresVehicle: !!x.requires_vehicle, supportsWaiting: !!x.supports_waiting, seasonalEnabled: !!x.seasonal_enabled, seasonStartAt: x.season_start_at, seasonEndAt: x.season_end_at, isActive: !!x.is_active };
      if (full) {
        const fields = parseJson<FormField[]>(x.form_schema, []) ?? [];
        out.formSchema = fields.map((f) => ({ ...f, labelText: tr(f.label, locale), options: f.options?.map((o) => ({ value: o.value, label: tr(o.label, locale) })) }));
        out.nameI18n = parseJson(x.name_i18n, {}); out.descriptionI18n = parseJson(x.description_i18n, {});
      }
      return out;
    },
    serializeCategory(c, locale, { withServices = true, admin = false } = {}) {
      const data = load();
      const out: CategoryOut = { id: c.id, slug: c.slug, parentId: c.parent_id, name: tr(c.name_i18n, locale), description: tr(c.description_i18n, locale), icon: c.icon, moduleType: c.module_type, sortOrder: c.sort_order };
      if (admin) { out.isActive = !!c.is_active; out.nameI18n = parseJson(c.name_i18n, {}); out.descriptionI18n = parseJson(c.description_i18n, {}); out.keywords = parseJson(c.keywords, []); }
      if (withServices) out.services = data.services.filter((x) => x.category_id === c.id && (admin || (x.is_active && isSeasonActive(x)))).map((x) => svc.serializeService(x, locale, { full: admin }));
      return out;
    },
    tree(locale) {
      const data = load();
      const cats = data.categories.filter((c) => c.is_active);
      const build = (parent: string | null): CategoryOut[] => cats.filter((c) => (c.parent_id || null) === parent).map((c) => ({ ...svc.serializeCategory(c, locale), children: build(c.id) }));
      return build(null);
    },
    getActiveService(id) {
      const x = load().byService.get(id);
      if (!x || !x.is_active || !isSeasonActive(x)) return null;
      const c = load().byCategory.get(x.category_id);
      return c?.is_active ? x : null;
    },
    serializeArea(a, locale, admin = false) {
      const out: AreaOut = { id: a.id, parentId: a.parent_id, name: tr(a.name_i18n, locale), type: a.type, localityType: a.locality_type || a.type, centerLat: a.center_lat, centerLng: a.center_lng, radiusKm: a.radius_km };
      if (admin) { out.isActive = !!a.is_active; out.nameI18n = parseJson(a.name_i18n, {}); }
      return out;
    },
    /** المنطقة الأدق التي يقع فيها الموقع (الأصغر نصف قطر ضمن المدى) */
    resolveArea(lat, lng) {
      let best: { a: ServiceAreaRow; d: number } | null = null;
      for (const a of load().areas) {
        if (!a.is_active) continue;
        const d = haversineKm(lat, lng, a.center_lat, a.center_lng);
        if (d <= a.radius_km && (!best || a.radius_km < best.a.radius_km || (a.radius_km === best.a.radius_km && d < best.d))) best = { a, d };
      }
      // إذا لم نجد مدينة/حيًا محددًا، نستخدم نطاق الدولة كمنطقة تغطية عامة.
      // هذا يمنع رفض طلب صحيح داخل اليمن فقط لأن نقطة GPS خارج دائرة مركز مدينة صغيرة.
      if (best?.a) return best.a;
      const country = load().areas.find((a) => a.is_active && a.type === 'COUNTRY');
      return country && haversineKm(lat, lng, country.center_lat, country.center_lng) <= country.radius_km ? country : null;
    },
    /** المنطقة + أسلافها (مزود يغطي مدينة يخدم أحياءها) */
    aliasesForService(serviceId) {
      return db.all<{phrase:string}>('SELECT phrase FROM service_aliases WHERE service_id=? AND is_active=1 ORDER BY phrase', serviceId).map(x=>x.phrase);
    },
    areaChain(areaId) {
      const by = new Map(load().areas.map((a) => [a.id, a]));
      const out: string[] = []; let cur = by.get(areaId);
      while (cur && out.length < 6) { out.push(cur.id); cur = cur.parent_id ? by.get(cur.parent_id) : undefined; }
      return out;
    },
  };
  return svc;
}

export function registerCatalogAdminRoutes(app: App, r: App['router']): void {
  const { db, catalog } = app;
  const I18N_ADMIN: Schema = s.obj({ ar: s.str({ min: 1, max: 200 }), en: s.str({ max: 200, optional: true }) });
  const keywords = s.arr(s.str({ min: 1, max: 60 }), { max: 100, optional: true, default: [] });
  const categoryInput: Schema = s.obj({
    slug: s.str({ min: 2, max: 80, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }), name: I18N_ADMIN,
    description: s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }),
    icon: s.str({ max: 20, optional: true }), parentId: s.str({ max: 64, optional: true }), keywords,
    moduleType: s.str({ min: 1, max: 40, optional: true, default: 'STANDARD' }), sortOrder: s.int({ min: -100000, max: 100000, optional: true, default: 0 }),
  });
  const serviceInput: Schema = s.obj({
    categoryId: s.str({ min: 1, max: 64 }), slug: s.str({ min: 2, max: 100, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }), name: I18N_ADMIN,
    description: s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }), icon: s.str({ max: 20, optional: true }), keywords, pricingType: s.oneOf(['FIXED','QUOTE']),
    basePrice: s.num({ min: 0, optional: true }), defaultPriority: s.oneOf(['LOW','NORMAL','URGENT'], { optional: true, default: 'NORMAL' }),
    sortOrder: s.int({ min: -100000, max: 100000, optional: true, default: 0 }), formSchema: formSchemaSchema,
    requiresInspection: s.bool({ optional: true, default: false }), requiresVehicle: s.bool({ optional: true, default: false }), supportsWaiting: s.bool({ optional: true, default: false }), seasonalEnabled: s.bool({ optional: true, default: false }), seasonStartAt: s.date({ optional: true }), seasonEndAt: s.date({ optional: true }), deliveryProofType: s.oneOf(['NONE','PIN','RECIPIENT_CONFIRMATION','PHOTO'], { optional: true, default: 'NONE' }),
  });
  const adminCatalog = (locale: Ctx['locale']) => {
    const data = catalog.all();
    return { categories: data.categories.map(c => ({ ...catalog.serializeCategory(c, locale, { withServices: false, admin: true }), services: data.services.filter(x => x.category_id === c.id).map(x => catalog.serializeService(x, locale, { full: true })) })) };
  };
  r.get('/admin/catalog', auth, adminLevel('SUPPORT'), (ctx: Ctx) => adminCatalog(ctx.locale));
  r.post('/admin/categories', auth, adminLevel('ADMIN'), (ctx: Ctx) => {
    const b = parse<any>(categoryInput, ctx.body);
    if (db.get('SELECT 1 FROM categories WHERE slug = ?', b.slug)) throw E.conflict('معرّف القسم مستخدم بالفعل', 'DUPLICATE_SLUG');
    if (b.parentId && !db.get('SELECT 1 FROM categories WHERE id = ?', b.parentId)) throw E.unprocessable('القسم الأب غير موجود', 'INVALID_PARENT');
    const id=uuid(), now=iso(app.clock.now());
    db.run('INSERT INTO categories(id,parent_id,slug,name_i18n,description_i18n,icon,keywords,module_type,sort_order,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id,b.parentId||null,b.slug,JSON.stringify(b.name),b.description?JSON.stringify(b.description):null,b.icon||null,JSON.stringify(b.keywords||[]),b.moduleType||'STANDARD',b.sortOrder||0,1,now,now);
    catalog.invalidate(); app.audit.log({ctx,action:'category.create',entityType:'category',entityId:id,after:b}); ctx.status=201; app.sse.broadcast('sync', { scope: 'catalog' }); return { category: catalog.serializeCategory(db.get<any>('SELECT * FROM categories WHERE id=?',id)!,ctx.locale,{withServices:true,admin:true}) };
  });
  r.patch('/admin/categories/:id', auth, adminLevel('ADMIN'), (ctx: Ctx) => {
    const old=db.get<CategoryRow>('SELECT * FROM categories WHERE id=?',ctx.params['id']); if(!old) throw E.notFound('القسم غير موجود');
    const b=parse<any>(s.obj({name:s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }),description:s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }),icon:s.str({max:20,optional:true}),parentId:s.str({max:64,optional:true}),keywords,sortOrder:s.int({min:-100000,max:100000,optional:true}),isActive:s.bool({optional:true})}),ctx.body);
    if(b.parentId===old.id) throw E.unprocessable('لا يمكن أن يكون القسم أبًا لنفسه','INVALID_PARENT');
    if(b.parentId && !db.get('SELECT 1 FROM categories WHERE id=?',b.parentId)) throw E.unprocessable('القسم الأب غير موجود','INVALID_PARENT');
    db.run(`UPDATE categories SET name_i18n=COALESCE(?,name_i18n),description_i18n=COALESCE(?,description_i18n),icon=COALESCE(?,icon),parent_id=COALESCE(?,parent_id),keywords=COALESCE(?,keywords),sort_order=COALESCE(?,sort_order),is_active=COALESCE(?,is_active),updated_at=? WHERE id=?`,b.name?JSON.stringify(b.name):null,b.description?JSON.stringify(b.description):null,b.icon??null,b.parentId??null,b.keywords?JSON.stringify(b.keywords):null,b.sortOrder??null,b.isActive===undefined?null:(b.isActive?1:0),iso(app.clock.now()),old.id);
    catalog.invalidate(); app.sse.broadcast('sync', { scope: 'catalog' }); app.audit.log({ctx,action:'category.update',entityType:'category',entityId:old.id,before:{isActive:!!old.is_active},after:b}); return {category:catalog.serializeCategory(db.get<any>('SELECT * FROM categories WHERE id=?',old.id)!,ctx.locale,{withServices:true,admin:true})};
  });
  r.post('/admin/services', auth, adminLevel('ADMIN'), (ctx: Ctx) => {
    const b=parse<any>(serviceInput,ctx.body); if(b.seasonalEnabled && (!b.seasonStartAt || !b.seasonEndAt)) throw E.unprocessable('حدد بداية ونهاية الموسم عند تفعيل الخدمة الموسمية','SEASON_DATES_REQUIRED'); if(b.seasonalEnabled && b.seasonStartAt && b.seasonEndAt && Date.parse(b.seasonStartAt)>=Date.parse(b.seasonEndAt)) throw E.unprocessable('نهاية الموسم يجب أن تكون بعد بدايته','INVALID_SEASON'); const cat=db.get<CategoryRow>('SELECT * FROM categories WHERE id=?',b.categoryId); if(!cat) throw E.unprocessable('القسم غير موجود','INVALID_CATEGORY');
    if(db.get('SELECT 1 FROM services WHERE slug=?',b.slug)) throw E.conflict('معرّف الخدمة مستخدم بالفعل','DUPLICATE_SLUG');
    if(b.pricingType==='FIXED' && b.basePrice===undefined) throw E.unprocessable('السعر الأساسي مطلوب للخدمة ذات السعر الثابت','BASE_PRICE_REQUIRED');
    const id=uuid(),now=iso(app.clock.now()); db.run('INSERT INTO services(id,category_id,slug,name_i18n,description_i18n,icon,keywords,pricing_type,base_price,form_schema,default_priority,sort_order,is_active,created_at,updated_at,requires_inspection,requires_vehicle,supports_waiting,delivery_proof_type,seasonal_enabled,season_start_at,season_end_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,b.categoryId,b.slug,JSON.stringify(b.name),b.description?JSON.stringify(b.description):null,b.icon||null,JSON.stringify(b.keywords||[]),b.pricingType,b.pricingType==='QUOTE'?null:b.basePrice,JSON.stringify(b.formSchema||[]),b.defaultPriority||'NORMAL',b.sortOrder||0,1,now,now,b.requiresInspection?1:0,b.requiresVehicle?1:0,b.supportsWaiting?1:0,b.deliveryProofType||'NONE',b.seasonalEnabled?1:0,b.seasonStartAt||null,b.seasonEndAt||null); catalog.invalidate(); app.audit.log({ctx,action:'service.create',entityType:'service',entityId:id,after:b}); ctx.status=201; app.sse.broadcast('sync', { scope: 'catalog' }); return {service:catalog.serializeService(db.get<any>('SELECT * FROM services WHERE id=?',id)!,ctx.locale,{full:true})};
  });

  r.get('/admin/services/:id/areas', auth, adminLevel('SUPPORT'), (ctx: Ctx) => {
    if (!db.get('SELECT 1 FROM services WHERE id=?', ctx.params.id!)) throw E.notFound('الخدمة غير موجودة');
    return { areas: db.all<any>(`SELECT a.id,a.name_i18n nameI18n,a.type FROM service_area_rules r JOIN service_areas a ON a.id=r.area_id WHERE r.service_id=? ORDER BY a.type,a.created_at`, ctx.params.id!).map((a:any)=>({id:a.id,name:tr(a.nameI18n,ctx.locale),type:a.type})) };
  });
  r.put('/admin/services/:id/areas', auth, adminLevel('ADMIN'), (ctx: Ctx) => {
    if (!db.get('SELECT 1 FROM services WHERE id=?', ctx.params.id!)) throw E.notFound('الخدمة غير موجودة');
    const b=parse<any>(s.obj({areaIds:s.arr(s.str({max:64}),{max:100})}),ctx.body);
    const valid=new Set(catalog.all().areas.filter(a=>a.is_active).map(a=>a.id));
    for(const id of b.areaIds) if(!valid.has(id)) throw E.unprocessable('منطقة غير صالحة','INVALID_AREA');
    return db.tx(()=>{db.run('DELETE FROM service_area_rules WHERE service_id=?',ctx.params.id!);for(const id of new Set(b.areaIds))db.run('INSERT INTO service_area_rules(service_id,area_id,created_at) VALUES(?,?,?)',ctx.params.id!,id,iso(app.clock.now()));app.audit.log({ctx,action:'service.areas.update',entityType:'service',entityId:ctx.params.id!,after:{areaIds:b.areaIds}});return {ok:true};});
  });
  r.patch('/admin/services/:id', auth, adminLevel('ADMIN'), (ctx: Ctx) => {
    const old=db.get<ServiceRow>('SELECT * FROM services WHERE id=?',ctx.params['id']); if(!old) throw E.notFound('الخدمة غير موجودة'); const b=parse<any>(s.obj({categoryId:s.str({max:64,optional:true}),name:s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }),description:s.obj({ ar: s.str({ min: 1, max: 200, optional: true }), en: s.str({ max: 200, optional: true }) }, { optional: true }),icon:s.str({max:20,optional:true}),keywords,pricingType:s.oneOf(['FIXED','QUOTE'],{optional:true}),basePrice:s.num({min:0,optional:true}),defaultPriority:s.oneOf(['LOW','NORMAL','URGENT'],{optional:true}),sortOrder:s.int({min:-100000,max:100000,optional:true}),formSchema:s.arr(formFieldSchema,{max:30,optional:true}),requiresInspection:s.bool({optional:true}),requiresVehicle:s.bool({optional:true}),supportsWaiting:s.bool({optional:true}),seasonalEnabled:s.bool({optional:true}),seasonStartAt:s.date({optional:true}),seasonEndAt:s.date({optional:true}),deliveryProofType:s.oneOf(['NONE','PIN','RECIPIENT_CONFIRMATION','PHOTO'],{optional:true}),isActive:s.bool({optional:true})}),ctx.body);
    if(b.seasonalEnabled && (!b.seasonStartAt || !b.seasonEndAt)) throw E.unprocessable('حدد بداية ونهاية الموسم عند تفعيل الخدمة الموسمية','SEASON_DATES_REQUIRED'); if(b.seasonalEnabled && b.seasonStartAt && b.seasonEndAt && Date.parse(b.seasonStartAt)>=Date.parse(b.seasonEndAt)) throw E.unprocessable('نهاية الموسم يجب أن تكون بعد بدايته','INVALID_SEASON'); const pricing=b.pricingType||old.pricing_type; const price=pricing==='QUOTE'?null:(b.basePrice!==undefined?b.basePrice:old.base_price); if(pricing==='FIXED'&&price===null) throw E.unprocessable('السعر الأساسي مطلوب للخدمة ذات السعر الثابت','BASE_PRICE_REQUIRED'); if(b.categoryId&&!db.get('SELECT 1 FROM categories WHERE id=?',b.categoryId)) throw E.unprocessable('القسم غير موجود','INVALID_CATEGORY');
    db.run(`UPDATE services SET category_id=COALESCE(?,category_id),name_i18n=COALESCE(?,name_i18n),description_i18n=COALESCE(?,description_i18n),icon=COALESCE(?,icon),keywords=COALESCE(?,keywords),pricing_type=?,base_price=?,form_schema=COALESCE(?,form_schema),default_priority=COALESCE(?,default_priority),sort_order=COALESCE(?,sort_order),is_active=COALESCE(?,is_active),requires_inspection=COALESCE(?,requires_inspection),requires_vehicle=COALESCE(?,requires_vehicle),supports_waiting=COALESCE(?,supports_waiting),delivery_proof_type=COALESCE(?,delivery_proof_type),seasonal_enabled=COALESCE(?,seasonal_enabled),season_start_at=COALESCE(?,season_start_at),season_end_at=COALESCE(?,season_end_at),updated_at=? WHERE id=?`,b.categoryId??null,b.name?JSON.stringify(b.name):null,b.description?JSON.stringify(b.description):null,b.icon??null,b.keywords?JSON.stringify(b.keywords):null,pricing,price,b.formSchema?JSON.stringify(b.formSchema):null,b.defaultPriority??null,b.sortOrder??null,b.isActive===undefined?null:(b.isActive?1:0),b.requiresInspection===undefined?null:(b.requiresInspection?1:0),b.requiresVehicle===undefined?null:(b.requiresVehicle?1:0),b.supportsWaiting===undefined?null:(b.supportsWaiting?1:0),b.deliveryProofType??null,b.seasonalEnabled===undefined?null:(b.seasonalEnabled?1:0),b.seasonStartAt??null,b.seasonEndAt??null,iso(app.clock.now()),old.id); catalog.invalidate(); app.sse.broadcast('sync', { scope: 'catalog' }); app.audit.log({ctx,action:'service.update',entityType:'service',entityId:old.id,before:{isActive:!!old.is_active,pricingType:old.pricing_type,basePrice:old.base_price},after:b}); return {service:catalog.serializeService(db.get<any>('SELECT * FROM services WHERE id=?',old.id)!,ctx.locale,{full:true})};
  });
}

export function registerCatalogRoutes(app: App, r: App['router']): void {
  const { catalog } = app;
  r.get('/categories', (ctx: Ctx) => ({ categories: catalog.tree(ctx.query['lang'] === 'en' ? 'en' : ctx.locale) }));
  r.get('/catalog/bootstrap', (ctx: Ctx) => {
    const locale = ctx.query['lang'] === 'en' ? 'en' : ctx.locale; const data = catalog.all();
    const now = iso(app.clock.now());
    const temporaryServices = app.db.all<any>(`SELECT * FROM temporary_services WHERE is_active=1 AND start_at<=? AND end_at>? ORDER BY priority DESC, sort_order ASC, start_at ASC`, now, now).map((x:any) => ({
      id:x.id, linkedServiceId:x.linked_service_id, name:tr(parseJson(x.name_i18n),locale), title:tr(parseJson(x.title_i18n),locale), description:tr(parseJson(x.description_i18n||'{}'),locale), icon:x.icon, categoryId:x.category_id, startAt:x.start_at,endAt:x.end_at,sortOrder:x.sort_order,priority:Number(x.priority||0),requestFlow:x.request_flow||'SERVICE',actionValue:x.action_value||x.linked_service_id,actionLabel:tr(parseJson(x.action_label_i18n||'{}'),locale),areaIds:parseJson(x.area_ids_json||'[]'),maxOrders:x.max_orders,pricing:parseJson(x.pricing_json||'{}'),targetCapabilities:parseJson(x.target_capabilities_json||'[]')||[]
    }));
    const campaigns = app.db.all<any>(`SELECT * FROM admin_campaigns WHERE is_active=1 AND start_at<=? AND end_at>? ORDER BY priority DESC, sort_order ASC, start_at ASC`,now,now).map((x:any)=>({id:x.id,title:tr(parseJson(x.title_i18n),locale),description:tr(parseJson(x.description_i18n||'{}'),locale),buttonLabel:tr(parseJson(x.button_label_i18n||'{}'),locale),actionType:x.action_type,actionValue:x.action_value,startAt:x.start_at,endAt:x.end_at,priority:Number(x.priority||0),sortOrder:x.sort_order,areaIds:parseJson(x.area_ids_json||'[]')}));
    const popularRows=app.db.all<any>(`SELECT service_id serviceId, COUNT(*) count FROM orders WHERE created_at>=? GROUP BY service_id ORDER BY count DESC LIMIT 30`, new Date(app.clock.now()-30*86400000).toISOString()); const popularity=popularRows.map(x=>({serviceId:x.serviceId,count:Number(x.count||0)})); return { categories: catalog.tree(locale), services: data.services.filter(x=>!!catalog.getActiveService(x.id)).map(x=>catalog.serializeService(x, locale)), temporaryServices, campaigns, popularity };
  });
  r.get('/categories/:slug/services', (ctx: Ctx) => {
    const data = catalog.all();
    const c = data.categories.find((x) => x.slug === ctx.params['slug'] && x.is_active);
    if (!c) throw E.notFound('القسم غير موجود');
    const extraCategoryIds = c.slug==='maintenance' ? data.categories.filter(x=>x.slug==='car-services' && x.is_active).map(x=>x.id) : []; const allowed=new Set([c.id,...extraCategoryIds]); return { category: catalog.serializeCategory(c, ctx.locale, { withServices: false }),
      services: data.services.filter((x) => allowed.has(x.category_id) && x.is_active).map((x) => catalog.serializeService(x, ctx.locale)) };
  });
  r.get('/services/:id', (ctx: Ctx) => {
    const idOrSlug = ctx.params['id']!;
    let x = catalog.getActiveService(idOrSlug);
    if (!x) { const y = catalog.all().services.find((z) => z.slug === idOrSlug); x = y ? catalog.getActiveService(y.id) : null; }
    if (!x) throw E.notFound('الخدمة غير موجودة');
    return { service: catalog.serializeService(x, ctx.locale, { full: true }) };
  });
  r.get('/areas', (ctx: Ctx) => ({ areas: catalog.all().areas.filter((a) => a.is_active).map((a) => catalog.serializeArea(a, ctx.locale)) }));
}

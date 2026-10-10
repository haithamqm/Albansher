import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, tr } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import { serializeTrip } from './trips.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';

const serializeBeneficiary=(app:App,b:any,locale:'ar'|'en')=>({id:b.id,label:b.label,fullName:b.full_name,phone:b.phone,location:b.location_id?app.locations.serialize(app.db.get<any>('SELECT * FROM locations WHERE id=?',b.location_id)!,locale):null});

const beneficiarySchema = s.obj({
  label: s.str({ min: 1, max: 40 }), fullName: s.str({ min: 2, max: 80 }), phone: s.str({ min: 8, max: 24 }),
  location: s.obj({ lat:s.num({min:-90,max:90}), lng:s.num({min:-180,max:180}), accuracy:s.num({min:0,max:100000,optional:true}), addressText:s.str({max:300,optional:true}), landmarkText:s.str({max:200,optional:true}), localityText:s.str({max:200,optional:true}), accessNotes:s.str({max:500,optional:true}), source:s.oneOf(['gps','map','manual'],{optional:true,default:'manual'}) }, { optional:true })
});

export function registerCustomerExperienceRoutes(app: App, r: Router): void {
  const { db } = app;
  r.get('/me/favorites/providers', auth, roles('CUSTOMER'), (ctx: Ctx) => ({ providers: db.all<any>(`SELECT sp.id,sp.display_name displayName,sp.rating_avg rating,sp.verification_status verificationStatus FROM favorite_providers f JOIN service_providers sp ON sp.id=f.provider_id WHERE f.customer_id=? ORDER BY f.created_at DESC`, ctx.user!.id) }));
  r.post('/me/favorites/providers/:providerId', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const p = db.get('SELECT id FROM service_providers WHERE id=?', ctx.params.providerId); if (!p) throw E.notFound('مقدم الخدمة غير موجود');
    db.run('INSERT OR IGNORE INTO favorite_providers(customer_id,provider_id,created_at) VALUES(?,?,?)',ctx.user!.id,ctx.params.providerId,iso(app.clock.now()));
    return { ok:true };
  });
  r.delete('/me/favorites/providers/:providerId', auth, roles('CUSTOMER'), (ctx: Ctx) => { db.run('DELETE FROM favorite_providers WHERE customer_id=? AND provider_id=?',ctx.user!.id,ctx.params.providerId); return {ok:true}; });

  r.get('/me/beneficiaries', auth, roles('CUSTOMER'), (ctx: Ctx) => ({ beneficiaries: db.all<any>('SELECT * FROM customer_beneficiaries WHERE customer_id=? ORDER BY updated_at DESC',ctx.user!.id).map(b=>serializeBeneficiary(app,b,ctx.locale)) }));
  r.post('/me/beneficiaries', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const b=parse<any>(beneficiarySchema,ctx.body); const idem=String(ctx.req.headers['idempotency-key']||'').trim().slice(0,128);
    if(idem){const old=db.get<any>('SELECT * FROM customer_beneficiaries WHERE customer_id=? AND idempotency_key=?',ctx.user!.id,idem);if(old){ctx.status=200;return {beneficiary:serializeBeneficiary(app,old,ctx.locale),idempotent:true};}}
    const id=uuid(),now=iso(app.clock.now()); let locId=null;
    if(b.location) locId=app.locations.create(b.location).id;
    try { db.run('INSERT INTO customer_beneficiaries(id,customer_id,label,full_name,phone,location_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',id,ctx.user!.id,b.label,b.fullName,b.phone,locId,idem||null,now,now); }
    catch(e){ if(idem){const old=db.get<any>('SELECT * FROM customer_beneficiaries WHERE customer_id=? AND idempotency_key=?',ctx.user!.id,idem);if(old){ctx.status=200;return {beneficiary:serializeBeneficiary(app,old,ctx.locale),idempotent:true};}} throw e; }
    ctx.status=201; return {beneficiary:serializeBeneficiary(app,db.get<any>('SELECT * FROM customer_beneficiaries WHERE id=?',id)!,ctx.locale)};
  });
  r.patch('/me/beneficiaries/:id', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const old=db.get<any>('SELECT * FROM customer_beneficiaries WHERE id=? AND customer_id=?',ctx.params.id!,ctx.user!.id); if(!old)throw E.notFound('المستفيد غير موجود');
    const b=parse<any>(s.obj({label:s.str({min:1,max:40,optional:true}),fullName:s.str({min:2,max:80,optional:true}),phone:s.str({min:8,max:24,optional:true}),location:s.obj({lat:s.num({min:-90,max:90}),lng:s.num({min:-180,max:180}),accuracy:s.num({min:0,max:100000,optional:true}),addressText:s.str({max:300,optional:true}),landmarkText:s.str({max:200,optional:true}),localityText:s.str({max:200,optional:true}),accessNotes:s.str({max:500,optional:true}),source:s.oneOf(['gps','map','manual'],{optional:true,default:'manual'})},{optional:true})}),ctx.body);
    const loc=b.location?app.locations.create(b.location).id:old.location_id; const now=iso(app.clock.now());
    db.run('UPDATE customer_beneficiaries SET label=COALESCE(?,label),full_name=COALESCE(?,full_name),phone=COALESCE(?,phone),location_id=?,updated_at=? WHERE id=?',b.label??null,b.fullName??null,b.phone??null,loc,now,old.id); return {ok:true};
  });
  r.delete('/me/beneficiaries/:id',auth,roles('CUSTOMER'),(ctx:Ctx)=>{const x=db.run('DELETE FROM customer_beneficiaries WHERE id=? AND customer_id=?',ctx.params.id!,ctx.user!.id);if(!x.changes)throw E.notFound('المستفيد غير موجود');return {ok:true};});


  r.get('/me/recommendations', auth, roles('CUSTOMER'), (ctx: Ctx) => {
    const rows = db.all<any>(`SELECT o.service_id serviceId, COUNT(*) uses, MAX(o.created_at) lastUsed
      FROM orders o WHERE o.customer_id=? AND o.status <> 'CANCELLED' GROUP BY o.service_id ORDER BY uses DESC, lastUsed DESC LIMIT 8`, ctx.user!.id);
    const searched = db.all<any>(`SELECT service_id serviceId, COUNT(*) uses, MAX(created_at) lastUsed
      FROM customer_searches WHERE customer_id=? AND service_id IS NOT NULL GROUP BY service_id ORDER BY uses DESC, lastUsed DESC LIMIT 8`, ctx.user!.id);
    const ids=[...new Set([...rows,...searched].map((x:any)=>x.serviceId).filter(Boolean))];
    const usage=new Map<string,any>(); for(const x of [...rows,...searched]) { const prev=usage.get(x.serviceId)||{uses:0,lastUsed:x.lastUsed}; prev.uses+=Number(x.uses||0); if(String(x.lastUsed)>String(prev.lastUsed)) prev.lastUsed=x.lastUsed; usage.set(x.serviceId,prev); }
    const out=ids.map(id=>{const svc=app.catalog.all().byService.get(id);if(!svc||!svc.is_active)return null;const u=usage.get(id);return {...app.catalog.serializeService(svc,ctx.locale),personalUses:u.uses,lastUsed:u.lastUsed};}).filter(Boolean).sort((a:any,b:any)=>b.personalUses-a.personalUses || String(b.lastUsed).localeCompare(String(a.lastUsed))).slice(0,8);
    return { recommendations: out, source:'customer-only' };
  });

  r.get('/me/searches/recent',auth,roles('CUSTOMER'),(ctx:Ctx)=>({searches:db.all<any>('SELECT query,service_id serviceId,created_at createdAt FROM customer_searches WHERE customer_id=? ORDER BY id DESC LIMIT 10',ctx.user!.id)}));

  // لا توجد نقاط نهاية للمساعد أو تحليل الصور/النوايا في نسخة البنشر الذكي.

  r.get('/orders/:id/purchase-change',auth,(ctx:Ctx)=>{
    const o=db.get<any>('SELECT * FROM orders WHERE id=?',ctx.params.id!);if(!o)throw E.notFound('الطلب غير موجود');
    if(ctx.user!.role==='CUSTOMER'&&o.customer_id!==ctx.user!.id)throw E.forbidden(); if(ctx.user!.role==='PROVIDER'&&o.provider_id!==ctx.user!.providerId)throw E.forbidden();
    return {changes:db.all<any>('SELECT id,requested_price requestedPrice,requested_product requestedProduct,reason,status,created_at createdAt,responded_at respondedAt FROM purchase_change_requests WHERE order_id=? ORDER BY created_at DESC',o.id)};
  });
  r.post('/provider/orders/:id/purchase-change',auth,roles('PROVIDER'),(ctx:Ctx)=>{
    const b=parse<any>(s.obj({requestedPrice:s.num({min:0,max:100000000}),requestedProduct:s.str({max:300,optional:true}),reason:s.str({max:500,optional:true})}),ctx.body);
    const o=db.get<any>(`SELECT o.*, s.slug service_slug FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=? AND o.provider_id=?`,ctx.params.id!,ctx.user!.providerId);if(!o)throw E.notFound('الطلب غير موجود');
    const trip=db.get<any>('SELECT purpose FROM trip_orders WHERE order_id=?',o.id);
    const purchaseSlugs=new Set(['purchase-and-delivery','pharmacy-purchase']);
    const isPurchase=purchaseSlugs.has(String(o.service_slug)) || ['ITEM_PURCHASE','MEDICINE','STORE_SHOPPING'].includes(String(trip?.purpose||''));
    if(!isPurchase)throw E.unprocessable('هذا الطلب ليس طلب شراء بالنيابة','PURCHASE_NOT_APPLICABLE');
    if(!['ACCEPTED','ON_THE_WAY','IN_PROGRESS'].includes(o.status))throw E.unprocessable('يمكن تعديل الشراء بعد قبول الطلب وأثناء تنفيذه','PURCHASE_CHANGE_STATE');
    if(db.get("SELECT 1 FROM purchase_change_requests WHERE order_id=? AND status='PENDING'",o.id))throw E.conflict('يوجد طلب تعديل شراء بانتظار رد العميل','PURCHASE_CHANGE_PENDING');
    const id=uuid(),now=iso(app.clock.now());db.run('INSERT INTO purchase_change_requests(id,order_id,provider_id,requested_price,requested_product,reason,created_at) VALUES(?,?,?,?,?,?,?)',id,o.id,ctx.user!.providerId,b.requestedPrice,b.requestedProduct||null,b.reason||null,now);app.notifications.notify(o.customer_id,'PURCHASE_CHANGE_REQUEST',{code:o.code,amount:b.requestedPrice},{orderId:o.id});return {change:db.get<any>('SELECT id,requested_price requestedPrice,requested_product requestedProduct,reason,status,created_at createdAt FROM purchase_change_requests WHERE id=?',id)};
  });
  r.post('/orders/:id/purchase-change/:changeId/respond',auth,roles('CUSTOMER'),(ctx:Ctx)=>{
    const b=parse<any>(s.obj({decision:s.oneOf(['APPROVE','REJECT'])}),ctx.body);const o=db.get<any>('SELECT * FROM orders WHERE id=? AND customer_id=?',ctx.params.id!,ctx.user!.id);if(!o)throw E.notFound('الطلب غير موجود');const c=db.get<any>('SELECT * FROM purchase_change_requests WHERE id=? AND order_id=? AND status=\'PENDING\'',ctx.params.changeId!,o.id);if(!c)throw E.notFound('طلب تغيير الشراء غير موجود');const now=iso(app.clock.now());db.run('UPDATE purchase_change_requests SET status=?,responded_at=? WHERE id=?','APPROVE'===b.decision?'APPROVED':'REJECTED',now,c.id);if(b.decision==='APPROVE')db.run('UPDATE orders SET agreed_price=?,updated_at=?,version=version+1 WHERE id=?',c.requested_price,now,o.id);if(o.provider_id){const pu=db.get<{user_id:string}>('SELECT user_id FROM service_providers WHERE id=?',o.provider_id);if(pu)app.notifications.notify(pu.user_id,'PURCHASE_CHANGE_RESPONDED',{code:o.code,approved:b.decision==='APPROVE'?'وافق':'رفض'},{orderId:o.id})}return {ok:true,status:b.decision==='APPROVE'?'APPROVED':'REJECTED'};
  });

  r.post('/orders/:id/reorder',auth,roles('CUSTOMER'),(ctx:Ctx)=>{
    const o=db.get<any>('SELECT * FROM orders WHERE id=? AND customer_id=?',ctx.params.id!,ctx.user!.id);if(!o)throw E.notFound('الطلب غير موجود');
    const loc=db.get<any>('SELECT lat,lng,accuracy_m accuracy,address_text addressText,source,area_id areaId FROM locations WHERE id=?',o.location_id); if(!loc)throw E.unprocessable('موقع الطلب السابق غير متاح','LOCATION_UNAVAILABLE');
    return {draft:{serviceId:o.service_id,description:o.description,formData:JSON.parse(o.form_data||'{}'),notes:o.customer_notes||'',contactPhone:o.contact_phone,priority:o.priority,location:loc,sourceOrderId:o.id}};
  });

}

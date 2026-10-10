import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { auth, adminLevel, roles } from './auth.middleware.js';
import { uuid } from '../core/security.js';
import { iso, parseJson, tr } from '../core/util.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';

const activeOrderStatuses = "('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')";

function normalizePhrase(v:string):string {
  return String(v||'').toLowerCase().trim()
    .replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
    .replace(/[ًٌٍَُِّْـ]/g,'').replace(/[.,!?،؛:()[\]{}"']/g,' ')
    .replace(/\s+/g,' ');
}

export function registerProductRoutes(app:App,r:Router):void {
  const {db,catalog}=app;

  r.get('/orders/:id/contact',auth,roles('CUSTOMER','PROVIDER','ADMIN'),(_ctx:Ctx)=>{
    throw E.forbidden('أرقام العملاء ومقدمي الخدمة خاصة. التواصل يتم داخل محادثة الطلب في خدمات.', 'CONTACT_PHONE_PRIVATE');
  });

  r.get('/provider/dashboard',auth,roles('PROVIDER'),(ctx:Ctx)=>{
    const pid=ctx.user!.providerId!;
    const count=(sql:string,...p:any[])=>Number(db.get<any>(sql,...p)?.n||0);
    const current=db.all<any>(`SELECT id,code,status,created_at createdAt,updated_at updatedAt FROM orders WHERE provider_id=? AND status IN ${activeOrderStatuses} ORDER BY updated_at DESC LIMIT 10`,pid);
    const pending=count(`SELECT COUNT(*) n FROM order_assignments WHERE provider_id=? AND status='OFFERED'`,pid);
    const unread=count(`SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL`,ctx.user!.id);
    const completed=count(`SELECT COUNT(*) n FROM orders WHERE provider_id=? AND status='COMPLETED'`,pid);
    const gross=Number(db.get<any>(`SELECT COALESCE(SUM(COALESCE(agreed_price,price_snapshot)),0) v FROM orders WHERE provider_id=? AND status='COMPLETED'`,pid)?.v||0);
    const due=Number(db.get<any>(`SELECT COALESCE(SUM(commission_amount),0) v FROM provider_settlements WHERE provider_id=? AND status='DUE'`,pid)?.v||0);
    return {current,pendingOffers:pending,unreadNotifications:unread,completedOrders:completed,gross,commissionDue:due,currency:app.settings.get<string>('platform.currency')};
  });

  r.get('/admin/business-kpis',auth,adminLevel('SUPPORT'),(ctx:Ctx)=>{
    const count=(sql:string,...p:any[])=>Number(db.get<any>(sql,...p)?.n||0);
    const active=count(`SELECT COUNT(*) n FROM orders WHERE status IN ${activeOrderStatuses}`);
    const created=count(`SELECT COUNT(*) n FROM orders WHERE date(created_at)=date(?)`,iso(app.clock.now()));
    const completed=count(`SELECT COUNT(*) n FROM orders WHERE status='COMPLETED' AND date(completed_at)=date(?)`,iso(app.clock.now()));
    const cancelled=count(`SELECT COUNT(*) n FROM orders WHERE status='CANCELLED' AND date(cancelled_at)=date(?)`,iso(app.clock.now()));
    const noProvider=count(`SELECT COUNT(*) n FROM orders WHERE status='SEARCHING' AND provider_id IS NULL AND search_exhausted_at IS NOT NULL`);
    const verifiedOnline=count(`SELECT COUNT(*) n FROM service_providers WHERE verification_status='VERIFIED' AND is_online=1 AND accepting_orders=1`);
    const due=Number(db.get<any>(`SELECT COALESCE(SUM(commission_amount),0) v FROM provider_settlements WHERE status='DUE'`)?.v||0);
    const paid=Number(db.get<any>(`SELECT COALESCE(SUM(commission_amount),0) v FROM provider_settlements WHERE status='PAID'`)?.v||0);
    const avgResponse=Number(db.get<any>(`SELECT COALESCE(AVG((julianday(a.responded_at)-julianday(a.offered_at))*86400),0) v FROM order_assignments a WHERE a.status='ACCEPTED' AND a.responded_at IS NOT NULL`)?.v||0);
    return {today:{created,completed,cancelled},activeOrders:active,ordersWithoutProvider:noProvider,availableProviders:verifiedOnline,commissionDue:due,commissionPaid:paid,avgProviderResponseSec:Math.round(avgResponse),currency:app.settings.get<string>('platform.currency')};
  });

  r.get('/admin/settlements',auth,adminLevel('SUPPORT'),(ctx:Ctx)=>({settlements:db.all<any>(`SELECT ps.*,o.code,sp.display_name providerName FROM provider_settlements ps JOIN orders o ON o.id=ps.order_id JOIN service_providers sp ON sp.id=ps.provider_id ORDER BY ps.created_at DESC LIMIT 300`).map(x=>({...x,grossAmount:Number(x.gross_amount),commissionRate:Number(x.commission_rate),commissionAmount:Number(x.commission_amount),payoutAmount:Number(x.payout_amount),currency:x.currency,dueAt:x.due_at,paidAt:x.paid_at}))}));

  r.post('/admin/settlements/:id/pay',auth,adminLevel('ADMIN'),(ctx:Ctx)=>{
    const b=parse<any>(s.obj({note:s.str({max:500,optional:true})}),ctx.body);
    const row=db.get<any>('SELECT * FROM provider_settlements WHERE id=?',ctx.params.id!);
    if(!row) throw E.notFound('التسوية غير موجودة');
    if(row.status!=='DUE') throw E.conflict('هذه التسوية ليست مستحقة للدفع','SETTLEMENT_NOT_DUE');
    const now=iso(app.clock.now());
    db.run('UPDATE provider_settlements SET status=\'PAID\',paid_at=?,paid_by=?,note=COALESCE(?,note),updated_at=? WHERE id=?',now,ctx.user!.id,b.note||null,now,row.id);
    db.run('UPDATE orders SET settlement_status=\'PAID\',updated_at=?,version=version+1 WHERE id=?',now,row.order_id);
    app.audit.log({ctx,action:'settlement.pay',entityType:'provider_settlement',entityId:row.id,before:{status:'DUE'},after:{status:'PAID',note:b.note||null}});
    return {ok:true};
  });

  r.get('/admin/service-aliases',auth,adminLevel('SUPPORT'),()=>({aliases:db.all<any>(`SELECT sa.id,sa.service_id serviceId,sa.phrase,sa.normalized_phrase normalizedPhrase,sa.source,sa.is_active isActive,s.slug serviceSlug, json_extract(s.name_i18n,'$.ar') serviceName FROM service_aliases sa JOIN services s ON s.id=sa.service_id ORDER BY s.sort_order,sa.phrase`)}));
  r.post('/admin/service-aliases',auth,adminLevel('ADMIN'),(ctx:Ctx)=>{
    const b=parse<any>(s.obj({serviceId:s.str({min:1,max:64}),phrase:s.str({min:2,max:120})}),ctx.body);
    const svc=catalog.all().services.find(x=>x.id===b.serviceId); if(!svc) throw E.notFound('الخدمة غير موجودة');
    const normalized=normalizePhrase(b.phrase); if(!normalized) throw E.unprocessable('العبارة غير صالحة','INVALID_ALIAS');
    if(db.get('SELECT 1 FROM service_aliases WHERE service_id=? AND normalized_phrase=?',svc.id,normalized)) throw E.conflict('هذه العبارة موجودة بالفعل','DUPLICATE_ALIAS');
    const id=uuid(),now=iso(app.clock.now());db.run('INSERT INTO service_aliases(id,service_id,phrase,normalized_phrase,source,created_at) VALUES(?,?,?,?,?,?)',id,svc.id,b.phrase,normalized,'ADMIN',now);
    app.audit.log({ctx,action:'service_alias.create',entityType:'service_alias',entityId:id,after:{serviceId:svc.id,phrase:b.phrase}});
    return {alias:{id,serviceId:svc.id,phrase:b.phrase,normalizedPhrase:normalized}};
  });
  r.patch('/admin/service-aliases/:id',auth,adminLevel('ADMIN'),(ctx:Ctx)=>{
    const b=parse<any>(s.obj({phrase:s.str({min:2,max:120}),isActive:s.bool({optional:true})}),ctx.body); const row=db.get<any>('SELECT * FROM service_aliases WHERE id=?',ctx.params.id!); if(!row)throw E.notFound('العبارة غير موجودة'); const normalized=normalizePhrase(b.phrase); if(db.get('SELECT 1 FROM service_aliases WHERE service_id=? AND normalized_phrase=? AND id<>?',row.service_id,normalized,row.id))throw E.conflict('هذه العبارة موجودة بالفعل','DUPLICATE_ALIAS'); db.run('UPDATE service_aliases SET phrase=?,normalized_phrase=?,is_active=COALESCE(?,is_active) WHERE id=?',b.phrase,normalized,b.isActive===undefined?null:(b.isActive?1:0),row.id); return {ok:true};
  });
  r.delete('/admin/service-aliases/:id',auth,adminLevel('ADMIN'),(ctx:Ctx)=>{const row=db.get<any>('SELECT id FROM service_aliases WHERE id=?',ctx.params.id!);if(!row)throw E.notFound('العبارة غير موجودة');db.run('DELETE FROM service_aliases WHERE id=?',row.id);return {ok:true};});

}

export { normalizePhrase };

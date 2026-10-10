import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso, parseJson } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';

const taskSchema=s.obj({title:s.str({min:2,max:200}),taskType:s.str({min:2,max:50,optional:true}),details:s.str({max:1000,optional:true})});

export function executionEvent(app:App, orderId:string, eventType:string, title:string, detail:string|undefined, actorRole:'CUSTOMER'|'PROVIDER'|'ADMIN'|'SYSTEM', actorId?:string, metadata:Record<string,unknown>={}) {
  const now=iso(app.clock.now());
  app.db.run('INSERT INTO order_execution_events(order_id,event_type,title,detail,actor_role,actor_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)',orderId,eventType,title,detail||null,actorRole,actorId||null,JSON.stringify(metadata),now);
  try { for(const a of app.db.all<{id:string}>("SELECT u.id FROM users u JOIN admin_users au ON au.user_id=u.id WHERE u.status='ACTIVE'")) app.sse.send(a.id,'sync',{scope:'admin',orderId,eventType}); } catch { /* realtime admin notification must never break order state */ }
}

export function registerExecutionRoutes(app:App,r:Router):void {
  const {db}=app;
  const owned=(id:string,ctx:Ctx)=>{
    const o=db.get<any>('SELECT * FROM orders WHERE id=?',id); if(!o)throw E.notFound('الطلب غير موجود');
    if(ctx.user!.role==='CUSTOMER'&&o.customer_id!==ctx.user!.id)throw E.forbidden();
    if(ctx.user!.role==='PROVIDER'&&o.provider_id!==ctx.user!.providerId && !db.get('SELECT 1 FROM order_assignments WHERE order_id=? AND provider_id=?',id,ctx.user!.providerId))throw E.forbidden();
    if(ctx.user!.role!=='ADMIN'&&ctx.user!.role!=='CUSTOMER'&&ctx.user!.role!=='PROVIDER')throw E.forbidden();
    return o;
  };

  r.get('/orders/:id/tasks',auth,(ctx:Ctx)=>{const o=owned(ctx.params.id!,ctx);return {tasks:db.all<any>('SELECT id,sequence_no sequenceNo,title,task_type taskType,status,details,created_at createdAt,updated_at updatedAt FROM order_tasks WHERE order_id=? ORDER BY sequence_no',o.id)};});
  r.post('/orders/:id/tasks',auth,roles('CUSTOMER'),(ctx:Ctx)=>{const o=owned(ctx.params.id!,ctx);if(['COMPLETED','CANCELLED'].includes(o.status))throw E.unprocessable('لا يمكن إضافة مهمة لطلب منتهٍ','ORDER_CLOSED');const b=parse<any>(s.obj({tasks:s.arr(taskSchema,{min:1,max:20})}),ctx.body);const start=Number(db.get<any>('SELECT COALESCE(MAX(sequence_no),0) n FROM order_tasks WHERE order_id=?',o.id)?.n||0);const now=iso(app.clock.now());return db.tx(()=>{for(let i=0;i<b.tasks.length;i++)db.run('INSERT INTO order_tasks(id,order_id,sequence_no,title,task_type,status,details,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',uuid(),o.id,start+i+1,b.tasks[i].title,b.tasks[i].taskType||'GENERAL','PENDING',b.tasks[i].details||null,now,now);executionEvent(app,o.id,'COMPOUND_TASKS_ADDED','إضافة مهام مركبة',`تمت إضافة ${b.tasks.length} مهام`, 'CUSTOMER',ctx.user!.id,{count:b.tasks.length});return {tasks:db.all<any>('SELECT id,sequence_no sequenceNo,title,task_type taskType,status,details,created_at createdAt,updated_at updatedAt FROM order_tasks WHERE order_id=? ORDER BY sequence_no',o.id)};});});
  r.patch('/orders/:id/tasks/:taskId',auth,(ctx:Ctx)=>{const o=owned(ctx.params.id!,ctx);const b=parse<any>(s.obj({status:s.oneOf(['PENDING','IN_PROGRESS','COMPLETED','CANCELLED']),details:s.str({max:1000,optional:true})}),ctx.body);const t=db.get<any>('SELECT * FROM order_tasks WHERE id=? AND order_id=?',ctx.params.taskId!,o.id);if(!t)throw E.notFound('المهمة غير موجودة');const now=iso(app.clock.now());db.run('UPDATE order_tasks SET status=?,details=COALESCE(?,details),updated_at=? WHERE id=?',b.status,b.details||null,now,t.id);executionEvent(app,o.id,'TASK_STATUS',`تحديث المهمة: ${t.title}`,`الحالة: ${b.status}`,ctx.user!.role as any,ctx.user!.id,{taskId:t.id,status:b.status});return {ok:true};});

  r.get('/orders/:id/timeline',auth,(ctx:Ctx)=>{const o=owned(ctx.params.id!,ctx);const history=db.all<any>('SELECT h.created_at at,h.actor_role actorRole,h.reason detail,h.to_status toStatus FROM order_status_history h WHERE h.order_id=? ORDER BY h.id',o.id).map(x=>({type:'STATUS',at:x.at,title:`حالة الطلب: ${x.toStatus}`,detail:x.detail,actorRole:x.actorRole}));const events=db.all<any>('SELECT created_at at,event_type type,title,detail,actor_role actorRole,metadata FROM order_execution_events WHERE order_id=? ORDER BY id',o.id).map(x=>({...x,metadata:parseJson(x.metadata,{})}));const assigns=db.all<any>('SELECT a.offered_at at,a.status,a.decision_reason detail,sp.display_name providerName FROM order_assignments a JOIN service_providers sp ON sp.id=a.provider_id WHERE a.order_id=? ORDER BY a.offered_at',o.id).map(x=>({type:'ASSIGNMENT',at:x.at,title:`إسناد إلى ${x.providerName}`,detail:x.detail||x.status,actorRole:'SYSTEM'}));const changes=db.all<any>('SELECT created_at at,status,requested_price requestedPrice,requested_product requestedProduct FROM purchase_change_requests WHERE order_id=? ORDER BY created_at',o.id).map(x=>({type:'PRICE_CHANGE',at:x.at,title:'تغيير مقترح في السعر',detail:`${x.requestedPrice} ${x.requestedProduct||''} · ${x.status}`,actorRole:'SYSTEM'}));const notes=db.all<any>(`SELECT created_at at,type,params FROM notifications WHERE json_extract(data,'$.orderId')=? ORDER BY created_at`,o.id).map(x=>({type:'NOTIFICATION',at:x.at,title:'تم إنشاء إشعار',detail:String(x.type),actorRole:'SYSTEM'}));return {timeline:[...history,...events,...assigns,...changes,...notes].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))};});

  r.get('/admin/execution/behavior-flags',auth,roles('ADMIN'),()=>({flags:db.all<any>('SELECT * FROM provider_behavior_flags ORDER BY last_seen_at DESC LIMIT 500')}));
}

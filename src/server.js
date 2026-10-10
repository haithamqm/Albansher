import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { hashPassword, verifyPassword, createToken, requireAuth, requireRole, audit } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const defaultPrivateDocsDir = fs.existsSync('/data') ? '/data/provider-documents' : './data/provider-documents';
const privateDocsDir = path.resolve(process.env.PROVIDER_DOCUMENTS_PATH || defaultPrivateDocsDir);
fs.mkdirSync(privateDocsDir, { recursive: true });
const upload = multer({storage:multer.diskStorage({destination:(_req,_file,cb)=>cb(null,privateDocsDir),filename:(_req,file,cb)=>cb(null,`${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)}),limits:{fileSize:8*1024*1024,files:2},fileFilter:(_req,file,cb)=>{const ok=['application/pdf','image/jpeg','image/png'].includes(file.mimetype);cb(ok?null:new Error('يسمح بملفات PDF أو JPG أو PNG فقط'),ok)}});
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
 defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
 fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'https:', 'data:'],
 connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: []
} } }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/', rateLimit({ windowMs: 15*60_000, limit: 25, standardHeaders: true, legacyHeaders: false }));

function cleanText(v, max=1000) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }
function numberOrNull(v) { if (v === '' || v === null || v === undefined) return null; const n=Number(v); return Number.isFinite(n) ? n : null; }
function publicUser(u) { const {password_hash, ...safe}=u; return safe; }
function activeOffers() { return db.prepare("SELECT o.*,p.name_ar AS product_name_ar,p.name_en AS product_name_en FROM offers o LEFT JOIN products p ON p.id=o.product_id WHERE o.active=1 AND (o.starts_at IS NULL OR datetime(o.starts_at)<=datetime('now')) AND (o.ends_at IS NULL OR datetime(o.ends_at)>=datetime('now')) ORDER BY o.created_at DESC").all(); }
function getOrder(id) { return db.prepare(`SELECT o.*, c.name customer_name, p.name provider_name, s.name_ar service_name_ar, s.name_en service_name_en, pr.name_ar product_name_ar, pr.name_en product_name_en FROM orders o JOIN users c ON c.id=o.customer_id LEFT JOIN users p ON p.id=o.provider_id LEFT JOIN services s ON s.id=o.service_id LEFT JOIN products pr ON pr.id=o.product_id WHERE o.id=?`).get(id); }

function normalizeServiceText(value='') {
 return String(value).toLowerCase().normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[ًٌٍَُِّْـ]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function inferServiceId(description) {
 const text=normalizeServiceText(description);
 if(!text) return null;
 const rules=[
  {id:1,terms:['بنشر','بنشر متنقل','كفر مثقوب','اطار مثقوب','بنشره','تنسيم الكفر','تصليح الكفر','تصليح الاطار','puncture','flat tire','tire repair']},
  {id:2,terms:['تغيير اطار','تغيير الاطارات','تبديل اطار','تبديل الاطارات','كفر جديد','كفرات جديده','شراء كفر','شراء اطار','تركيب كفر','تركيب اطار','tire replacement','replace tires','new tire']},
  {id:3,terms:['تغيير زيت','زيت المكينة','زيت المحرك','تبديل الزيت','زيوت','oil change','engine oil']},
  {id:4,terms:['بطاريه','البطاريه','البطاريه انتهت','اشتراك بطاريه','تغيير البطاريه','تبديل البطاريه','بطاريه جديده','battery','jump start']},
  {id:5,terms:['السياره تعطلت','السياره لا تعمل','مساعده على الطريق','مساعده طريق','اشتراك سياره','عطلان','تعطل المركبه','roadside assistance','car wont start']},
  {id:6,terms:['سطحه','سطحه نقل','نقل السياره','سحب السياره','نقل المركبه','ونش','towing','tow truck']},
 ];
 for(const rule of rules) if(rule.terms.some(term=>text.includes(normalizeServiceText(term)))) { const row=db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(rule.id); if(row)return row.id; }
 const active=db.prepare('SELECT id,name_ar,name_en FROM services WHERE active=1').all();
 const exact=active.find(x=>{const ar=normalizeServiceText(x.name_ar),en=normalizeServiceText(x.name_en);return (ar&&text.includes(ar))||(en&&text.includes(en));});
 return exact?.id ?? null;
}
function canSeeOrder(user, order) { return user.role==='admin' || order.customer_id===user.id || order.provider_id===user.id; }
function notify(userId, type, title, body='', entityType='', entityId='') {
 if (!userId) return;
 db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id) VALUES (?,?,?,?,?,?)')
  .run(userId, type, title, body, entityType, String(entityId || ''));
}
function transitionOrder(order, status, actor, note='') {
 const allowed = {new:['accepted','cancelled'], accepted:['on_the_way','cancelled'], on_the_way:['arrived','cancelled'], arrived:['in_progress','cancelled'], in_progress:['completed'], completed:[], cancelled:[]};
 if (!allowed[order.status]?.includes(status)) return {error:`لا يمكن تغيير الحالة من ${order.status} إلى ${status}`};
 if (status==='in_progress' && order.quote_status==='pending') return {error:'ينتظر عرض السعر موافقة العميل قبل بدء العمل'};
 if (status==='in_progress' && order.quote_status==='rejected') return {error:'رفض العميل عرض السعر؛ أرسل عرضًا جديدًا قبل بدء العمل'};
 if (actor.role==='customer' && status!=='cancelled') return {error:'العميل لا يملك صلاحية هذه المرحلة'};
 if (actor.role==='customer' && !['new','accepted','on_the_way'].includes(order.status)) return {error:'لا يمكن إلغاء الطلب في هذه المرحلة'};
 if (actor.role==='provider' && (order.provider_id!==actor.id || !['accepted','on_the_way','arrived','in_progress'].includes(order.status))) return {error:'لا تملك صلاحية تحديث هذا الطلب'};
 if (actor.role==='admin' && status!=='cancelled' && status!=='completed') return {error:'التغيير الإداري لهذه الحالة غير مسموح'};
 const run = db.transaction(()=>{
  db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,order.id);
  if (status==='cancelled' && order.kind==='product' && order.stock_reserved===1) { db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(order.quantity,order.product_id); db.prepare('UPDATE orders SET stock_reserved=0 WHERE id=?').run(order.id); }
  db.prepare('INSERT INTO order_events(order_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?)').run(order.id,actor.id,order.status,status,note);
  audit(actor.id,'order.status_changed','order',order.id,`${order.status} -> ${status}`);
  notify(order.customer_id,'order_status','تحديث حالة الطلب',`تم تحديث الطلب ${order.order_code} إلى ${status}`,'order',order.id);
 }); run(); return {order:getOrder(order.id)};
}

// First-start bootstrap: create one administrator without requiring Railway variables.
// A cryptographically random password is printed only to deployment logs on first creation.
function bootstrapAdmin() {
 if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) return;
 const name = process.env.ADMIN_NAME || 'مدير البنشر الذكي';
 const email = (process.env.ADMIN_EMAIL || 'admin@albanshar.app').trim().toLowerCase();
 const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
 if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
  throw new Error('تعذر إنشاء حساب الإدارة الأول: تحقق من بيانات الإدارة المخصصة إن كانت مضبوطة.');
 }
 db.prepare("INSERT INTO users(name,email,password_hash,role,status,must_change_password) VALUES (?,?,?,'admin','active',1)").run(name, email, hashPassword(password));
 console.log('='.repeat(68));
 console.log('البنشر الذكي | بيانات دخول المدير الأول — احتفظ بها بسرية');
 console.log(`البريد الإلكتروني: ${email}`);
 console.log(`كلمة المرور المؤقتة: ${password}`);
 console.log('سجّل الدخول عبر /admin ثم غيّر كلمة المرور فورًا من لوحة الإدارة.');
 console.log('لن تُعرض كلمة المرور مرة أخرى تلقائيًا، ولن يُنشأ مدير آخر عند إعادة التشغيل.');
 console.log('='.repeat(68));
}
bootstrapAdmin();

app.get('/api/health', (_req,res)=>res.json({ok:true,service:'البنشر الذكي',time:new Date().toISOString()}));
app.get('/api/public/config', (_req,res)=>res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value]))));
app.get('/api/services', (_req,res)=>res.json(db.prepare('SELECT * FROM services WHERE active=1 ORDER BY id').all()));
app.get('/api/products', (req,res)=>{
 const q=cleanText(req.query.q,80), category=cleanText(req.query.category,60);
 res.json(db.prepare(`SELECT * FROM products WHERE active=1 AND stock>=0 AND (?='' OR name_ar LIKE ? OR name_en LIKE ? OR brand LIKE ?) AND (?='' OR category=?) ORDER BY created_at DESC`).all(q,`%${q}%`,`%${q}%`,`%${q}%`,category,category));
});
app.get('/api/products/:id',(req,res)=>{const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(req.params.id)); if(!p)return res.status(404).json({error:'المنتج غير موجود'});res.json(p);});
app.get('/api/offers',(_req,res)=>res.json(activeOffers()));
app.get('/api/vehicle-types',(_req,res)=>res.json(db.prepare('SELECT id,name_ar,name_en FROM vehicle_types WHERE active=1 ORDER BY id').all()));
app.get('/api/branches',(_req,res)=>res.json(db.prepare('SELECT id,name_ar,name_en,address,latitude,longitude,hours_json FROM branches WHERE active=1 ORDER BY id').all()));

app.post('/api/auth/register', (req,res)=>{
 const name=cleanText(req.body.name,100), phone=cleanText(req.body.phone,30), email=cleanText(req.body.email,254).toLowerCase(), password=req.body.password, role=req.body.role;
 if (!name || !phone || typeof password!=='string' || password.length<10 || !['customer','provider'].includes(role)) return res.status(400).json({error:'أدخل الاسم والهاتف وكلمة مرور من 10 أحرف على الأقل، وحدد نوع الحساب.'});
 if (role==='provider' && (!email || !/^\S+@\S+\.\S+$/.test(email))) return res.status(400).json({error:'البريد الإلكتروني مطلوب لحساب مقدم الخدمة.'});
 if (['customer','provider'].includes(req.body.portal) && role!==req.body.portal) return res.status(403).json({error:'هذا الرابط مخصص لتسجيل نوع حساب مختلف.'});
 try {
  const result=db.transaction(()=>{
   const info=db.prepare('INSERT INTO users(name,phone,email,password_hash,role,status) VALUES (?,?,?,?,?,?)').run(name,phone,email||null,hashPassword(password),role,role==='provider'?'pending':'active');
   if(role==='provider') db.prepare('INSERT INTO provider_profiles(user_id) VALUES (?)').run(info.lastInsertRowid);
   audit(info.lastInsertRowid,'user.registered','user',info.lastInsertRowid,role);
   return db.prepare('SELECT id,name,phone,email,role,status FROM users WHERE id=?').get(info.lastInsertRowid);
  })();
  res.status(201).json({user:result, message:role==='provider'?'تم التسجيل، وحسابك بانتظار مراجعة الإدارة.':'تم إنشاء الحساب. تحقق من رقم الهاتف مطلوب قبل استخدامه في الإنتاج.'});
 } catch(e) { if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'رقم الهاتف أو البريد الإلكتروني مستخدم بالفعل'}); throw e; }
});
app.post('/api/auth/login',(req,res)=>{
 const identifier=cleanText(req.body.identifier,254), password=req.body.password, portal=cleanText(req.body.portal,20);
 if ((portal==='admin' || portal==='provider') && !/^\S+@\S+\.\S+$/.test(identifier)) return res.status(400).json({error:portal==='admin'?'أدخل البريد الإلكتروني الإداري.':'أدخل البريد الإلكتروني لمقدم الخدمة.'});
 const user=portal==='admin'
  ? db.prepare('SELECT * FROM users WHERE email=? AND role=\'admin\'').get(identifier.toLowerCase())
  : portal==='provider'
   ? db.prepare('SELECT * FROM users WHERE email=? AND role=\'provider\'').get(identifier.toLowerCase())
   : db.prepare('SELECT * FROM users WHERE phone=? OR email=?').get(identifier,identifier.toLowerCase());
 if(!user || !verifyPassword(String(password||''),user.password_hash)) return res.status(401).json({error:'بيانات الدخول غير صحيحة'});
 if(user.status!=='active' && !(user.role==='provider'&&user.status==='pending')) return res.status(403).json({error:'الحساب غير نشط أو موقوف'});
 const token=createToken(user); audit(user.id,'user.login','user',user.id,'');
 res.json({token,user:{...publicUser(user),must_change_password:Boolean(user.must_change_password)}});
});
app.get('/api/me',requireAuth,(req,res)=>{
 const profile=req.user.role==='provider'?db.prepare('SELECT * FROM provider_profiles WHERE user_id=?').get(req.user.id):null;
 res.json({user:req.user,profile:profile?{...profile,services:JSON.parse(profile.services_json)}:null});
});

app.post('/api/orders',requireAuth,requireRole('customer'),(req,res)=>{
 const kind=req.body.kind==='product'?'product':'service', description=cleanText(req.body.description,1500);
 let serviceId=numberOrNull(req.body.service_id); const productId=numberOrNull(req.body.product_id), quantity=Math.max(1,Math.min(100,Math.floor(Number(req.body.quantity)||1)));
 if(kind==='service' && serviceId===null && req.body.custom_service!==true) return res.status(400).json({error:'اختر خدمة من القائمة، أو اختر «خدمة أخرى» صراحةً إذا لم تجد الخدمة المطلوبة'});
 const lat=numberOrNull(req.body.latitude), lng=numberOrNull(req.body.longitude), location=cleanText(req.body.location_text,500);
 const requestKey=cleanText(req.get('Idempotency-Key') || req.body.request_key,120);
 if(!description) return res.status(400).json({error:'اكتب وصف الطلب أولًا'});
 if((lat===null)!==(lng===null) || (lat!==null&&(lat < -90||lat>90||lng < -180||lng>180))) return res.status(400).json({error:'إحداثيات الموقع غير صحيحة'});
 if(lat===null&&!location) return res.status(400).json({error:'حدد موقعك أو اكتب وصفًا يساعد على الوصول إليك'});
 if(kind==='service'&&serviceId&&!db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(serviceId)) return res.status(400).json({error:'الخدمة المحددة غير متاحة'});
 if(kind==='product'&&(!productId)) return res.status(400).json({error:'حدد المنتج المطلوب'});
 try {
  const result=db.transaction(()=>{
   if (requestKey) { const previous=db.prepare('SELECT o.* FROM idempotency_keys k JOIN orders o ON o.id=k.order_id WHERE k.user_id=? AND k.request_key=?').get(req.user.id,requestKey); if(previous) return getOrder(previous.id); }
   let initialPrice=null, stockReserved=0;
   if(kind==='product') {const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId); if(!p||p.stock<quantity) throw new Error('المنتج غير متوفر بالكمية المطلوبة'); const reserved=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?').run(quantity,productId,quantity); if(!reserved.changes) throw new Error('نفدت الكمية المتاحة للتو؛ حدّث الصفحة وحاول مجددًا'); initialPrice=p.price*quantity; stockReserved=1;}
   const code='BS-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
   const info=db.prepare(`INSERT INTO orders(order_code,customer_id,kind,service_id,product_id,quantity,description,latitude,longitude,location_text,price_quote,stock_reserved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(code,req.user.id,kind,serviceId,productId,quantity,description,lat,lng,location,initialPrice,stockReserved);
   db.prepare('INSERT INTO order_events(order_id,actor_id,to_status,note) VALUES (?,?,?,?)').run(info.lastInsertRowid,req.user.id,'new','تم إنشاء الطلب');
   if (requestKey) db.prepare('INSERT INTO idempotency_keys(user_id,request_key,order_id) VALUES (?,?,?)').run(req.user.id,requestKey,info.lastInsertRowid);
   audit(req.user.id,'order.created','order',info.lastInsertRowid,kind);
   notify(req.user.id,'order_created','تم إنشاء الطلب',`رقم الطلب ${code}`,'order',info.lastInsertRowid);
   return getOrder(info.lastInsertRowid);
  })(); res.status(201).json(result);
 } catch(e) {res.status(400).json({error:e.message||'تعذر إنشاء الطلب'});}
});
app.get('/api/orders',requireAuth,(req,res)=>{
 let rows;
 if(req.user.role==='admin') rows=db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
 else if(req.user.role==='customer') rows=db.prepare('SELECT o.*, s.name_ar service_name_ar, s.name_en service_name_en, pr.name_ar product_name_ar, pr.name_en product_name_en FROM orders o LEFT JOIN services s ON s.id=o.service_id LEFT JOIN products pr ON pr.id=o.product_id WHERE o.customer_id=? ORDER BY o.created_at DESC').all(req.user.id);
 else {
  const profile=db.prepare('SELECT services_json,approved,availability FROM provider_profiles WHERE user_id=?').get(req.user.id);
  const ids=profile ? JSON.parse(profile.services_json || '[]').map(Number).filter(Number.isFinite) : [];
  const assigned=db.prepare("SELECT o.*, s.name_ar service_name_ar, s.name_en service_name_en, pr.name_ar product_name_ar, pr.name_en product_name_en FROM orders o LEFT JOIN services s ON s.id=o.service_id LEFT JOIN products pr ON pr.id=o.product_id WHERE o.provider_id=? ORDER BY o.created_at DESC").all(req.user.id);
  const available=(profile?.approved && profile.availability==='online' && ids.length)
   ? db.prepare(`SELECT o.*, s.name_ar service_name_ar, s.name_en service_name_en, pr.name_ar product_name_ar, pr.name_en product_name_en FROM orders o LEFT JOIN services s ON s.id=o.service_id LEFT JOIN products pr ON pr.id=o.product_id WHERE o.provider_id IS NULL AND o.status='new' AND o.kind='service' AND (o.service_id IS NULL OR o.service_id IN (${ids.map(()=>'?').join(',')})) ORDER BY o.created_at DESC`).all(...ids)
   : [];
  rows=[...assigned,...available];
 }
 res.json(rows);
});
app.get('/api/orders/:id',requireAuth,(req,res)=>{const o=getOrder(Number(req.params.id));if(!o||!canSeeOrder(req.user,o))return res.status(404).json({error:'الطلب غير موجود'});res.json(o);});
app.post('/api/orders/:id/accept',requireAuth,requireRole('provider'),(req,res)=>{
 const id=Number(req.params.id); const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
 const profile=db.prepare('SELECT * FROM provider_profiles WHERE user_id=?').get(req.user.id);
 if(!profile?.approved||profile.availability!=='online') return res.status(403).json({error:'يجب اعتماد حسابك وتفعيل حالة الاستعداد لاستقبال الطلبات'});
 if(order?.kind!=='service') return res.status(400).json({error:'طلبات المنتجات تُدار من لوحة الإدارة في هذه النسخة'});
 const offered=JSON.parse(profile.services_json||'[]').map(Number);
 if(order.service_id && !offered.includes(Number(order.service_id))) return res.status(403).json({error:'هذه الخدمة غير موجودة ضمن خدمات حسابك'});
 if(!order||order.status!=='new'||order.provider_id) return res.status(409).json({error:'تم إسناد الطلب أو لم يعد متاحًا'});
 const claim=db.prepare("UPDATE orders SET provider_id=?,status='accepted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='new' AND provider_id IS NULL").run(req.user.id,id);
 if(!claim.changes) return res.status(409).json({error:'قبِل مقدم خدمة آخر هذا الطلب قبل لحظات'});
 db.prepare('INSERT INTO order_events(order_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?)').run(id,req.user.id,'new','accepted','قبول مقدم الخدمة'); audit(req.user.id,'order.accepted','order',id,''); notify(order.customer_id,'order_accepted','تم قبول طلبك','قبل مقدم الخدمة الطلب وسيبدأ تحديث حالته.','order',id); res.json(getOrder(id));
});
app.patch('/api/orders/:id/status',requireAuth,(req,res)=>{const order=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));if(!order||!canSeeOrder(req.user,order))return res.status(404).json({error:'الطلب غير موجود'});const r=transitionOrder(order,cleanText(req.body.status,30),req.user,cleanText(req.body.note,500));if(r.error)return res.status(400).json({error:r.error});res.json(r.order);});
app.post('/api/orders/:id/quote',requireAuth,requireRole('provider'),(req,res)=>{
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id)); const price=numberOrNull(req.body.price);
 if(!order||order.provider_id!==req.user.id||!['accepted','on_the_way','arrived'].includes(order.status))return res.status(403).json({error:'لا يمكن تقديم عرض لهذا الطلب'});
 if(price===null||price<0)return res.status(400).json({error:'أدخل سعرًا صحيحًا'});
 db.prepare("UPDATE orders SET price_quote=?,quote_status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price,order.id);audit(req.user.id,'quote.sent','order',order.id,String(price));notify(order.customer_id,'quote','عرض سعر جديد',`السعر المقترح: ${price}`,'order',order.id);res.json(getOrder(order.id));
});
app.post('/api/orders/:id/quote-decision',requireAuth,requireRole('customer'),(req,res)=>{
 const order=db.prepare('SELECT * FROM orders WHERE id=? AND customer_id=?').get(Number(req.params.id),req.user.id);if(!order||order.quote_status!=='pending')return res.status(400).json({error:'لا يوجد عرض سعر بانتظار قرارك'});
 const decision=req.body.decision;if(!['accepted','rejected'].includes(decision))return res.status(400).json({error:'القرار غير صحيح'});
 db.prepare('UPDATE orders SET quote_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(decision,order.id);audit(req.user.id,'quote.decision','order',order.id,decision);notify(order.provider_id,'quote_decision','قرار العميل بشأن السعر',decision==='accepted'?'وافق العميل على عرض السعر':'رفض العميل عرض السعر','order',order.id);res.json(getOrder(order.id));
});
app.get('/api/orders/:id/messages',requireAuth,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));if(!o||!canSeeOrder(req.user,o))return res.status(404).json({error:'الطلب غير موجود'});res.json(db.prepare('SELECT m.id,m.order_id,m.sender_id,u.name sender_name,m.body,m.created_at FROM messages m JOIN users u ON u.id=m.sender_id WHERE order_id=? ORDER BY m.id').all(o.id));});
app.post('/api/orders/:id/messages',requireAuth,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));const body=cleanText(req.body.body,2000);if(!o||!canSeeOrder(req.user,o))return res.status(404).json({error:'الطلب غير موجود'});if(!body)return res.status(400).json({error:'اكتب الرسالة'});const info=db.prepare('INSERT INTO messages(order_id,sender_id,body) VALUES (?,?,?)').run(o.id,req.user.id,body);const recipient=req.user.id===o.customer_id?o.provider_id:o.customer_id;notify(recipient,'message','رسالة جديدة',body.slice(0,160),'order',o.id);res.status(201).json(db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid));});
app.post('/api/orders/:id/reviews',requireAuth,requireRole('customer'),(req,res)=>{const o=db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=? AND status='completed'").get(Number(req.params.id),req.user.id);const rating=Number(req.body.rating);if(!o)return res.status(400).json({error:'يمكن تقييم الطلب المكتمل فقط'});if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'التقييم من 1 إلى 5'});try{db.prepare('INSERT INTO reviews(order_id,customer_id,provider_id,rating,comment) VALUES (?,?,?,?,?)').run(o.id,req.user.id,o.provider_id,rating,cleanText(req.body.comment,1000));res.status(201).json({ok:true});}catch{return res.status(409).json({error:'تم تقييم هذا الطلب مسبقًا'});}});
app.post('/api/complaints',requireAuth,requireRole('customer'),(req,res)=>{const subject=cleanText(req.body.subject,150),details=cleanText(req.body.details,2000),orderId=numberOrNull(req.body.order_id);if(!subject||!details)return res.status(400).json({error:'اكتب عنوان الشكوى وتفاصيلها'});if(orderId&&!db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(orderId,req.user.id))return res.status(400).json({error:'الطلب غير صالح'});const r=db.prepare('INSERT INTO complaints(order_id,customer_id,subject,details) VALUES (?,?,?,?)').run(orderId,req.user.id,subject,details);res.status(201).json({id:r.lastInsertRowid,status:'open'});});

app.get('/api/notifications',requireAuth,(req,res)=>res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id)));
app.patch('/api/notifications/:id/read',requireAuth,(req,res)=>{const r=db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(Number(req.params.id),req.user.id);if(!r.changes)return res.status(404).json({error:'الإشعار غير موجود'});res.json({ok:true});});

// Provider settings and account review
app.patch('/api/provider/availability',requireAuth,requireRole('provider'),(req,res)=>{const v=req.body.availability;if(!['online','offline','busy'].includes(v))return res.status(400).json({error:'الحالة غير صحيحة'});const p=db.prepare('SELECT approved FROM provider_profiles WHERE user_id=?').get(req.user.id);if(v==='online'&&!p?.approved)return res.status(403).json({error:'حسابك لم يعتمد بعد'});db.prepare('UPDATE provider_profiles SET availability=? WHERE user_id=?').run(v,req.user.id);res.json({availability:v});});
app.patch('/api/provider/profile',requireAuth,requireRole('provider'),(req,res)=>{const region=cleanText(req.body.region,120),bio=cleanText(req.body.bio,1000),services=Array.isArray(req.body.services)?req.body.services.map(Number).filter(n=>db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(n)).slice(0,30):[];db.prepare('UPDATE provider_profiles SET region=?,bio=?,services_json=? WHERE user_id=?').run(region,bio,JSON.stringify(services),req.user.id);res.json({ok:true});});

// Private provider verification documents: never served from the public static directory.
app.post('/api/provider/documents',requireAuth,requireRole('provider'),(req,res,next)=>upload.fields([{name:'identity_document',maxCount:1},{name:'license_document',maxCount:1}])(req,res,err=>{if(err)return res.status(400).json({error:err.message||'تعذر رفع الملفات'});next();}),(req,res)=>{
 const files=req.files||{}, identity=files.identity_document?.[0], license=files.license_document?.[0];
 if(!identity||!license){for(const f of [...(files.identity_document||[]),...(files.license_document||[])])try{fs.unlinkSync(f.path)}catch{};return res.status(400).json({error:'ارفع صورة الهوية والترخيص أو الوثيقة المهنية معًا'});}
 const save=db.prepare(`INSERT INTO provider_documents(provider_id,doc_type,original_name,stored_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?) ON CONFLICT(provider_id,doc_type) DO UPDATE SET original_name=excluded.original_name,stored_name=excluded.stored_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,created_at=CURRENT_TIMESTAMP`);
 for(const [type,file] of [['identity',identity],['license',license]]){const old=db.prepare('SELECT stored_name FROM provider_documents WHERE provider_id=? AND doc_type=?').get(req.user.id,type);save.run(req.user.id,type,cleanText(file.originalname,240),path.basename(file.filename),file.mimetype,file.size);if(old&&old.stored_name!==file.filename)try{fs.unlinkSync(path.join(privateDocsDir,old.stored_name))}catch{}}
 audit(req.user.id,'provider.documents_uploaded','provider',req.user.id,'identity,license');res.status(201).json({ok:true,message:'تم استلام الوثائق وهي بانتظار مراجعة الإدارة.'});
});
app.get('/api/provider/documents',requireAuth,requireRole('provider'),(req,res)=>res.json(db.prepare('SELECT id,doc_type,original_name,mime_type,size_bytes,created_at FROM provider_documents WHERE provider_id=? ORDER BY id').all(req.user.id)));
app.get('/api/admin/providers/:id/documents',requireAuth,requireRole('admin'),(req,res)=>res.json(db.prepare('SELECT id,doc_type,original_name,mime_type,size_bytes,created_at FROM provider_documents WHERE provider_id=? ORDER BY id').all(Number(req.params.id))));
app.get('/api/admin/provider-documents/:id/download',requireAuth,requireRole('admin'),(req,res)=>{const doc=db.prepare('SELECT * FROM provider_documents WHERE id=?').get(Number(req.params.id));if(!doc)return res.status(404).json({error:'الوثيقة غير موجودة'});const file=path.join(privateDocsDir,path.basename(doc.stored_name));if(!fs.existsSync(file))return res.status(404).json({error:'ملف الوثيقة غير موجود على التخزين'});res.setHeader('Content-Type',doc.mime_type);res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(doc.original_name)}"`);res.sendFile(file);});

// Admin-only data and controls
app.get('/api/admin/admins',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare("SELECT id,name,email,status,created_at FROM users WHERE role='admin' ORDER BY id").all()));
app.post('/api/admin/admins',requireAuth,requireRole('admin'),(req,res)=>{const name=cleanText(req.body.name,100),email=cleanText(req.body.email,254).toLowerCase(),password=String(req.body.password||'');if(!name||!/^\S+@\S+\.\S+$/.test(email)||password.length<12)return res.status(400).json({error:'أدخل الاسم والبريد وكلمة مرور من 12 حرفًا على الأقل'});try{const r=db.prepare("INSERT INTO users(name,email,password_hash,role,status) VALUES (?,?,?,'admin','active')").run(name,email,hashPassword(password));audit(req.user.id,'admin.created','user',r.lastInsertRowid,email);res.status(201).json({id:r.lastInsertRowid,name,email,role:'admin'});}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'البريد الإلكتروني مستخدم بالفعل'});throw e;}});
app.patch('/api/admin/account',requireAuth,requireRole('admin'),(req,res)=>{const current=String(req.body.current_password||''),next=String(req.body.new_password||''),email=req.body.email===undefined?'':cleanText(req.body.email,254).toLowerCase();const row=db.prepare('SELECT password_hash,must_change_password FROM users WHERE id=?').get(req.user.id);if(!verifyPassword(current,row.password_hash))return res.status(400).json({error:'كلمة المرور الحالية غير صحيحة'});if(email&&!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'صيغة البريد الإلكتروني غير صحيحة'});if((next||row.must_change_password)&&next.length<12)return res.status(400).json({error:'غيّر كلمة المرور المؤقتة إلى كلمة مرور جديدة من 12 حرفًا على الأقل'});if(row.must_change_password&&!next)return res.status(400).json({error:'يجب تغيير كلمة المرور المؤقتة قبل استخدام لوحة الإدارة'});try{if(email)db.prepare('UPDATE users SET email=? WHERE id=?').run(email,req.user.id);if(next)db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hashPassword(next),req.user.id);audit(req.user.id,'admin.account_updated','user',req.user.id,email?'email changed':'password changed');const user=db.prepare('SELECT id,name,phone,email,role,status,must_change_password FROM users WHERE id=?').get(req.user.id);res.json({ok:true,user:{...user,must_change_password:Boolean(user.must_change_password)}});}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'البريد الإلكتروني مستخدم بالفعل'});throw e;}});
app.get('/api/admin/summary',requireAuth,requireRole('admin'),(_req,res)=>{
 const count=(sql)=>db.prepare(sql).get().n;
 res.json({customers:count("SELECT COUNT(*) n FROM users WHERE role='customer'"),providers:count("SELECT COUNT(*) n FROM users WHERE role='provider'"),pendingProviders:count("SELECT COUNT(*) n FROM users WHERE role='provider' AND status='pending'"),newOrders:count("SELECT COUNT(*) n FROM orders WHERE status='new'"),activeOrders:count("SELECT COUNT(*) n FROM orders WHERE status IN ('accepted','on_the_way','arrived','in_progress')"),completedOrders:count("SELECT COUNT(*) n FROM orders WHERE status='completed'"),cancelledOrders:count("SELECT COUNT(*) n FROM orders WHERE status='cancelled'"),openComplaints:count("SELECT COUNT(*) n FROM complaints WHERE status='open'")});
});
app.get('/api/admin/users',requireAuth,requireRole('admin'),(req,res)=>{const role=['customer','provider','admin'].includes(req.query.role)?req.query.role:'';res.json(db.prepare("SELECT id,name,phone,email,role,status,created_at FROM users WHERE (?='' OR role=?) ORDER BY created_at DESC LIMIT 500").all(role,role));});
app.patch('/api/admin/users/:id/status',requireAuth,requireRole('admin'),(req,res)=>{const status=req.body.status;if(!['active','suspended','pending'].includes(status))return res.status(400).json({error:'الحالة غير صحيحة'});const user=db.prepare('SELECT id,role FROM users WHERE id=?').get(Number(req.params.id));if(!user)return res.status(404).json({error:'المستخدم غير موجود'});if(user.role==='admin'&&status!=='active')return res.status(400).json({error:'لا يمكن إيقاف حساب مدير من هذه الواجهة'});db.prepare('UPDATE users SET status=? WHERE id=?').run(status,user.id);if(user.role==='provider')db.prepare('UPDATE provider_profiles SET approved=? WHERE user_id=?').run(status==='active'?1:0,user.id);audit(req.user.id,'user.status_changed','user',user.id,status);res.json({ok:true});});
app.get('/api/admin/providers',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare(`SELECT u.id,u.name,u.phone,u.email,u.status,p.region,p.services_json,p.availability,p.approved,p.bio,(SELECT COUNT(*) FROM provider_documents d WHERE d.provider_id=u.id) document_count FROM users u JOIN provider_profiles p ON p.user_id=u.id ORDER BY u.created_at DESC`).all().map(p=>({...p,services:JSON.parse(p.services_json)}))));
app.patch('/api/admin/providers/:id/approval',requireAuth,requireRole('admin'),(req,res)=>{const approved=req.body.approved===true?1:0;const id=Number(req.params.id);const p=db.prepare('SELECT user_id FROM provider_profiles WHERE user_id=?').get(id);if(!p)return res.status(404).json({error:'مقدم الخدمة غير موجود'});if(approved){const docs=db.prepare('SELECT COUNT(*) n FROM provider_documents WHERE provider_id=?').get(id).n;if(docs<2)return res.status(400).json({error:'لا يمكن اعتماد مقدم الخدمة قبل رفع الهوية والترخيص/الوثيقة المهنية ومراجعتهما'});}db.prepare('UPDATE provider_profiles SET approved=?,availability=? WHERE user_id=?').run(approved,'offline',id);db.prepare('UPDATE users SET status=? WHERE id=?').run(approved?'active':'suspended',id);audit(req.user.id,approved?'provider.approved':'provider.rejected','user',id,'');res.json({ok:true});});
app.get('/api/admin/services',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare('SELECT * FROM services ORDER BY id DESC').all()));
app.post('/api/admin/services',requireAuth,requireRole('admin'),(req,res)=>{const a=req.body;if(!cleanText(a.name_ar,120)||!cleanText(a.name_en,120))return res.status(400).json({error:'اسم الخدمة بالعربية والإنجليزية مطلوب'});const price=numberOrNull(a.price);if(price!==null&&price<0)return res.status(400).json({error:'السعر لا يمكن أن يكون سالبًا'});const r=db.prepare('INSERT INTO services(name_ar,name_en,description_ar,description_en,category,pricing_type,price,active) VALUES (?,?,?,?,?,?,?,?)').run(cleanText(a.name_ar,120),cleanText(a.name_en,120),cleanText(a.description_ar,500),cleanText(a.description_en,500),cleanText(a.category,80)||'general',['fixed','quote','estimate'].includes(a.pricing_type)?a.pricing_type:'quote',price,a.active===false?0:1);audit(req.user.id,'service.created','service',r.lastInsertRowid,'');res.status(201).json(db.prepare('SELECT * FROM services WHERE id=?').get(r.lastInsertRowid));});
app.patch('/api/admin/services/:id',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),a=req.body;if(!db.prepare('SELECT id FROM services WHERE id=?').get(id))return res.status(404).json({error:'الخدمة غير موجودة'});db.prepare('UPDATE services SET name_ar=COALESCE(?,name_ar),name_en=COALESCE(?,name_en),description_ar=COALESCE(?,description_ar),description_en=COALESCE(?,description_en),active=COALESCE(?,active),price=COALESCE(?,price) WHERE id=?').run(a.name_ar?cleanText(a.name_ar,120):null,a.name_en?cleanText(a.name_en,120):null,a.description_ar?cleanText(a.description_ar,500):null,a.description_en?cleanText(a.description_en,500):null,typeof a.active==='boolean'?(a.active?1:0):null,numberOrNull(a.price),id);audit(req.user.id,'service.updated','service',id,'');res.json(db.prepare('SELECT * FROM services WHERE id=?').get(id));});
app.post('/api/admin/products',requireAuth,requireRole('admin'),(req,res)=>{const a=req.body;const ar=cleanText(a.name_ar,160),en=cleanText(a.name_en,160),price=numberOrNull(a.price),stock=Number(a.stock);if(!ar||!en||price===null||price<0||!Number.isInteger(stock)||stock<0)return res.status(400).json({error:'تحقق من الاسم والسعر والكمية'});const r=db.prepare('INSERT INTO products(name_ar,name_en,description_ar,description_en,category,brand,specs,price,old_price,stock,image_url,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(ar,en,cleanText(a.description_ar,1000),cleanText(a.description_en,1000),cleanText(a.category,80)||'other',cleanText(a.brand,100),cleanText(a.specs,300),price,numberOrNull(a.old_price),stock,cleanText(a.image_url,1000),a.active===false?0:1);audit(req.user.id,'product.created','product',r.lastInsertRowid,'');res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid));});
app.patch('/api/admin/products/:id',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),a=req.body;const p=db.prepare('SELECT id FROM products WHERE id=?').get(id);if(!p)return res.status(404).json({error:'المنتج غير موجود'});const allowed=['name_ar','name_en','description_ar','description_en','category','brand','specs','image_url'];for(const k of allowed)if(a[k]!==undefined) a[k]=cleanText(a[k],1000);if(a.price!==undefined&&(!Number.isFinite(Number(a.price))||Number(a.price)<0))return res.status(400).json({error:'السعر غير صحيح'});if(a.stock!==undefined&&(!Number.isInteger(Number(a.stock))||Number(a.stock)<0))return res.status(400).json({error:'المخزون غير صحيح'});const fields=[...allowed,'price','old_price','stock','active'].filter(k=>a[k]!==undefined);if(fields.length){const sql=fields.map(k=>`${k}=?`).join(',');db.prepare(`UPDATE products SET ${sql} WHERE id=?`).run(...fields.map(k=>k==='active'?(a[k]?1:0):a[k]),id);}audit(req.user.id,'product.updated','product',id,'');res.json(db.prepare('SELECT * FROM products WHERE id=?').get(id));});
app.get('/api/admin/offers',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare('SELECT * FROM offers ORDER BY created_at DESC').all()));
app.post('/api/admin/offers',requireAuth,requireRole('admin'),(req,res)=>{const a=req.body,ar=cleanText(a.title_ar,160),en=cleanText(a.title_en,160);if(!ar||!en)return res.status(400).json({error:'عنوان العرض بالعربية والإنجليزية مطلوب'});if(a.starts_at&&a.ends_at&&new Date(a.ends_at)<=new Date(a.starts_at))return res.status(400).json({error:'وقت نهاية العرض يجب أن يأتي بعد بدايته'});const price=numberOrNull(a.price);if(price!==null&&price<0)return res.status(400).json({error:'سعر العرض غير صحيح'});const productId=numberOrNull(a.product_id);if(productId!==null&&!db.prepare('SELECT id FROM products WHERE id=?').get(productId))return res.status(400).json({error:'المنتج المرتبط غير موجود'});const r=db.prepare('INSERT INTO offers(title_ar,title_en,description_ar,description_en,image_url,product_id,price,starts_at,ends_at,active) VALUES (?,?,?,?,?,?,?,?,?,?)').run(ar,en,cleanText(a.description_ar,1000),cleanText(a.description_en,1000),cleanText(a.image_url,1000),productId,price,a.starts_at||null,a.ends_at||null,a.active===false?0:1);audit(req.user.id,'offer.created','offer',r.lastInsertRowid,'');res.status(201).json(db.prepare('SELECT * FROM offers WHERE id=?').get(r.lastInsertRowid));});
app.patch('/api/admin/offers/:id',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),active=req.body.active;if(!db.prepare('SELECT id FROM offers WHERE id=?').get(id))return res.status(404).json({error:'العرض غير موجود'});if(typeof active==='boolean')db.prepare('UPDATE offers SET active=? WHERE id=?').run(active?1:0,id);audit(req.user.id,'offer.updated','offer',id,typeof active==='boolean'?String(active):'');res.json({ok:true});});
app.get('/api/admin/complaints',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare('SELECT c.*,u.name customer_name FROM complaints c JOIN users u ON u.id=c.customer_id ORDER BY c.created_at DESC').all()));
app.patch('/api/admin/complaints/:id',requireAuth,requireRole('admin'),(req,res)=>{const status=['open','in_review','resolved','rejected'].includes(req.body.status)?req.body.status:'open';db.prepare('UPDATE complaints SET status=?,admin_reply=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,cleanText(req.body.admin_reply,1500),Number(req.params.id));audit(req.user.id,'complaint.updated','complaint',req.params.id,status);res.json({ok:true});});
app.get('/api/admin/audit',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare('SELECT a.*,u.name actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300').all()));
app.get('/api/admin/orders',requireAuth,requireRole('admin'),(req,res)=>{const status=cleanText(req.query.status,30);const rows=db.prepare("SELECT o.*,c.name customer_name,c.phone customer_phone,p.name provider_name FROM orders o JOIN users c ON c.id=o.customer_id LEFT JOIN users p ON p.id=o.provider_id WHERE (?='' OR o.status=?) ORDER BY o.created_at DESC LIMIT 500").all(status,status);res.json(rows);});
app.patch('/api/admin/orders/:id/status',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),next=cleanText(req.body.status,30);const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!order)return res.status(404).json({error:'الطلب غير موجود'});if(order.kind==='product'){const allowed={new:['accepted','cancelled'],accepted:['completed','cancelled'],completed:[],cancelled:[]};if(!allowed[order.status]?.includes(next))return res.status(400).json({error:'انتقال حالة طلب المنتج غير مسموح'});const run=db.transaction(()=>{db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next,id);if(next==='cancelled'&&order.stock_reserved===1){db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(order.quantity,order.product_id);db.prepare('UPDATE orders SET stock_reserved=0 WHERE id=?').run(id);}db.prepare('INSERT INTO order_events(order_id,actor_id,from_status,to_status,note) VALUES (?,?,?,?,?)').run(id,req.user.id,order.status,next,cleanText(req.body.note,500));audit(req.user.id,'product_order.status_changed','order',id,next);notify(order.customer_id,'order_status','تحديث طلب المنتج',`تم تحديث طلب المنتج ${order.order_code} إلى ${next}`,'order',id);});run();return res.json(getOrder(id));}const result=transitionOrder(order,next,req.user,cleanText(req.body.note,500));if(result.error)return res.status(400).json({error:result.error});res.json(result.order);});
app.patch('/api/admin/orders/:id/payment',requireAuth,requireRole('admin'),(req,res)=>{const status=req.body.payment_status;if(!['unpaid','paid','refunded'].includes(status))return res.status(400).json({error:'حالة الدفع غير صحيحة'});const id=Number(req.params.id);const order=db.prepare('SELECT id FROM orders WHERE id=?').get(id);if(!order)return res.status(404).json({error:'الطلب غير موجود'});db.prepare('UPDATE orders SET payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,id);audit(req.user.id,'order.payment_status_changed','order',id,status);res.json({ok:true});});
app.get('/api/admin/reports/summary',requireAuth,requireRole('admin'),(_req,res)=>{const rows=db.prepare('SELECT kind,status,payment_status,COUNT(*) count,COALESCE(SUM(price_quote),0) total FROM orders GROUP BY kind,status,payment_status ORDER BY kind,status,payment_status').all();const reviews=db.prepare('SELECT COUNT(*) count,ROUND(AVG(rating),2) average_rating FROM reviews').get();res.json({orders:rows,reviews});});
app.post('/api/admin/vehicle-types',requireAuth,requireRole('admin'),(req,res)=>{const ar=cleanText(req.body.name_ar,100),en=cleanText(req.body.name_en,100);if(!ar||!en)return res.status(400).json({error:'اسم النوع بالعربية والإنجليزية مطلوب'});try{const r=db.prepare('INSERT INTO vehicle_types(name_ar,name_en) VALUES (?,?)').run(ar,en);audit(req.user.id,'vehicle_type.created','vehicle_type',r.lastInsertRowid,'');res.status(201).json({id:r.lastInsertRowid,name_ar:ar,name_en:en});}catch{return res.status(409).json({error:'نوع المركبة موجود مسبقًا'});}});
app.patch('/api/admin/vehicle-types/:id',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),ar=cleanText(req.body.name_ar,100),en=cleanText(req.body.name_en,100),active=req.body.active;if(!db.prepare('SELECT id FROM vehicle_types WHERE id=?').get(id))return res.status(404).json({error:'نوع المركبة غير موجود'});if(ar)db.prepare('UPDATE vehicle_types SET name_ar=? WHERE id=?').run(ar,id);if(en)db.prepare('UPDATE vehicle_types SET name_en=? WHERE id=?').run(en,id);if(typeof active==='boolean')db.prepare('UPDATE vehicle_types SET active=? WHERE id=?').run(active?1:0,id);audit(req.user.id,'vehicle_type.updated','vehicle_type',id,'');res.json(db.prepare('SELECT * FROM vehicle_types WHERE id=?').get(id));});
app.get('/api/admin/branches',requireAuth,requireRole('admin'),(_req,res)=>res.json(db.prepare('SELECT * FROM branches ORDER BY id DESC').all()));
app.post('/api/admin/branches',requireAuth,requireRole('admin'),(req,res)=>{const ar=cleanText(req.body.name_ar,120),en=cleanText(req.body.name_en,120);if(!ar||!en)return res.status(400).json({error:'اسم الفرع بالعربية والإنجليزية مطلوب'});const lat=numberOrNull(req.body.latitude),lng=numberOrNull(req.body.longitude);if((lat===null)!==(lng===null)||(lat!==null&&(lat < -90||lat>90||lng < -180||lng>180)))return res.status(400).json({error:'إحداثيات الفرع غير صحيحة'});const r=db.prepare('INSERT INTO branches(name_ar,name_en,address,latitude,longitude,hours_json,active) VALUES (?,?,?,?,?,?,?)').run(ar,en,cleanText(req.body.address,500),lat,lng,JSON.stringify(req.body.hours||{}),req.body.active===false?0:1);audit(req.user.id,'branch.created','branch',r.lastInsertRowid,'');res.status(201).json(db.prepare('SELECT * FROM branches WHERE id=?').get(r.lastInsertRowid));});
app.patch('/api/admin/branches/:id',requireAuth,requireRole('admin'),(req,res)=>{const id=Number(req.params.id),b=req.body;if(!db.prepare('SELECT id FROM branches WHERE id=?').get(id))return res.status(404).json({error:'الفرع غير موجود'});const fields=['name_ar','name_en','address','hours_json','active'];const values=[];const updates=[];for(const k of fields)if(b[k]!==undefined){updates.push(`${k}=?`);values.push(k==='hours_json'?JSON.stringify(b[k]):k==='active'?(b[k]?1:0):cleanText(b[k],500));}for(const k of ['latitude','longitude'])if(b[k]!==undefined){updates.push(`${k}=?`);values.push(numberOrNull(b[k]));}if(updates.length)db.prepare(`UPDATE branches SET ${updates.join(',')} WHERE id=?`).run(...values,id);audit(req.user.id,'branch.updated','branch',id,'');res.json(db.prepare('SELECT * FROM branches WHERE id=?').get(id));});
app.patch('/api/admin/settings',requireAuth,requireRole('admin'),(req,res)=>{const allowed=['app_name','tagline','currency','support_whatsapp','support_email','theme'];const put=db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');for(const k of allowed)if(typeof req.body[k]==='string')put.run(k,cleanText(req.body[k],250));audit(req.user.id,'settings.updated','settings','global',Object.keys(req.body).filter(k=>allowed.includes(k)).join(','));res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value])));});
app.post('/api/auth/change-password',requireAuth,(req,res)=>{const old=String(req.body.current_password||''),next=String(req.body.new_password||'');const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);if(!verifyPassword(old,row.password_hash))return res.status(400).json({error:'كلمة المرور الحالية غير صحيحة'});if(next.length<12)return res.status(400).json({error:'كلمة المرور الجديدة يجب أن تكون 12 حرفًا على الأقل'});db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next),req.user.id);audit(req.user.id,'password.changed','user',req.user.id,'');res.json({ok:true,message:'تم تغيير كلمة المرور'});});

app.use(express.static(path.join(__dirname,'../public'), { maxAge: process.env.NODE_ENV==='production'?'1h':0 }));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'حدث خطأ داخلي. راجع سجل الخادم للحصول على التفاصيل.'});});
app.listen(port,'0.0.0.0',()=>console.log(`البنشر الذكي running on port ${port}`));

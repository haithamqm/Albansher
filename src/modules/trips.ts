import { s, parse, type Schema } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { haversineKm, iso } from '../core/util.js';
import { auth, roles } from './auth.middleware.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';
import type { LocationRow, OrderRow } from '../types/domain.js';

const tripLocation: Schema = s.obj({
  lat: s.num({ min: -90, max: 90 }),
  lng: s.num({ min: -180, max: 180 }),
  accuracy: s.num({ min: 0, max: 100000, optional: true }),
  addressText: s.str({ max: 300, optional: true }),
  source: s.oneOf(['gps', 'map', 'manual'], { optional: true, default: 'map' }),
});
const purposeSchema = s.oneOf(['PASSENGER','ITEM_PURCHASE','MEDICINE','PARCEL','RESTAURANT_PICKUP','DOCUMENT_DELIVERY','TECHNICIAN_PICKUP','STORE_SHOPPING','SMALL_CARGO','HOME_PICKUP','OTHER']);
const tripInputSchema: Schema = s.obj({
  origin: tripLocation,
  destination: { ...tripLocation, optional: true } as Schema,
  originAddressId: s.str({ max: 64, optional: true }),
  destinationAddressId: s.str({ max: 64, optional: true }),
  purpose: purposeSchema,
  purposeNote: s.str({ max: 500, optional: true }),
  description: s.str({ min: 5, max: 1000 }),
  contactPhone: s.str({ min: 8, max: 24 }),
  notes: s.str({ max: 500, optional: true }),
  stops: s.arr(tripLocation, { max: 5, optional: true, default: [] }),
  waitingPerMinute: s.num({ min: 0, max: 100000, optional: true }),
  purchaseMaxPrice: s.num({ min: 0, max: 100000000, optional: true }),
  purchaseQuantity: s.int({ min: 1, max: 10000, optional: true }),
  purchaseAlternatives: s.str({ max: 500, optional: true }),
  purchaseRequiresApproval: s.bool({ optional: true, default: false }),
});

type Purpose = 'PASSENGER'|'ITEM_PURCHASE'|'MEDICINE'|'PARCEL'|'RESTAURANT_PICKUP'|'DOCUMENT_DELIVERY'|'TECHNICIAN_PICKUP'|'STORE_SHOPPING'|'SMALL_CARGO'|'HOME_PICKUP'|'OTHER';


interface RouteDistance {
  distanceKm: number;
  durationMin: number | null;
  method: 'ROAD_ROUTING' | 'STRAIGHT_LINE_TEST';
}

async function drivingDistance(app: App, origin: { lat: number; lng: number }, destination: { lat: number; lng: number }): Promise<RouteDistance> {
  const baseUrl = app.config.routingUrl.replace(/\/$/, '');
  if (baseUrl === 'mock://straight-line') {
    return { distanceKm: Math.round(haversineKm(origin.lat, origin.lng, destination.lat, destination.lng) * 10) / 10, durationMin: null, method: 'STRAIGHT_LINE_TEST' };
  }
  const timer = setTimeout(() => {}, app.config.routingTimeoutMs);
  try {
    const url = `${baseUrl}/route/v1/driving/${encodeURIComponent(origin.lng)},${encodeURIComponent(origin.lat)};${encodeURIComponent(destination.lng)},${encodeURIComponent(destination.lat)}?overview=false&steps=false`;
    const response = await Promise.race([
      fetch(url, { headers: { accept: 'application/json' } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ROUTING_TIMEOUT')), app.config.routingTimeoutMs)),
    ]);
    if (!response.ok) throw E.serviceUnavailable('تعذر الوصول إلى خدمة حساب مسافة القيادة حاليًا', 'ROUTING_UNAVAILABLE');
    const data = await response.json() as any;
    const route = data?.routes?.[0];
    if (data?.code !== 'Ok' || !route || !Number.isFinite(route.distance) || route.distance <= 0) {
      throw E.unprocessable('تعذر العثور على طريق قيادة بين الموقعين', 'ROUTE_NOT_FOUND');
    }
    const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
    const durationMin = Number.isFinite(route.duration) ? Math.round((route.duration / 60) * 10) / 10 : null;
    return { distanceKm, durationMin, method: 'ROAD_ROUTING' };
  } catch (err) {
    if ((err as any)?.code) throw err;
    if ((err as any)?.message === 'ROUTING_TIMEOUT') throw E.serviceUnavailable('انتهت مهلة حساب مسافة القيادة، حاول مرة أخرى', 'ROUTING_TIMEOUT');
    throw E.serviceUnavailable('تعذر حساب مسافة القيادة حاليًا، حاول مرة أخرى', 'ROUTING_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}


async function drivingRoute(app: App, points: Array<{lat:number;lng:number}>): Promise<RouteDistance> {
  if (points.length < 2) throw E.unprocessable('حدد نقطتين على الأقل للمسار', 'ROUTE_POINTS_REQUIRED');
  const baseUrl = app.config.routingUrl.replace(/\/$/, '');
  if (baseUrl === 'mock://straight-line') {
    let km=0; for(let i=1;i<points.length;i++) km += haversineKm(points[i-1].lat,points[i-1].lng,points[i].lat,points[i].lng);
    return {distanceKm:Math.round(km*10)/10,durationMin:null,method:'STRAIGHT_LINE_TEST'};
  }
  try {
    const coords=points.map(p=>`${encodeURIComponent(p.lng)},${encodeURIComponent(p.lat)}`).join(';');
    const response=await Promise.race([fetch(`${baseUrl}/route/v1/driving/${coords}?overview=false&steps=false`,{headers:{accept:'application/json'}}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('ROUTING_TIMEOUT')),app.config.routingTimeoutMs))]);
    if(!response.ok) throw E.serviceUnavailable('تعذر الوصول إلى خدمة حساب مسافة القيادة حاليًا','ROUTING_UNAVAILABLE');
    const data=await response.json() as any; const route=data?.routes?.[0];
    if(data?.code!=='Ok'||!route||!Number.isFinite(route.distance)||route.distance<=0) throw E.unprocessable('تعذر العثور على طريق قيادة بين النقاط','ROUTE_NOT_FOUND');
    return {distanceKm:Math.round(route.distance/100)/10,durationMin:Number.isFinite(route.duration)?Math.round(route.duration/6)/10:null,method:'ROAD_ROUTING'};
  } catch(err){
    // لا نمنع إنشاء المشوار بسبب تعطل خدمة التوجيه الخارجية. نستخدم مسافة جغرافية احتياطية،
    // مع إبقاء مسار القيادة الحقيقي هو الأولوية عندما يكون متاحًا.
    if ((err as any)?.code !== 'ROUTE_POINTS_REQUIRED') {
      let km=0; for(let i=1;i<points.length;i++) km += haversineKm(points[i-1].lat,points[i-1].lng,points[i].lat,points[i].lng);
      km=Math.round(km*10)/10;
      if(km<=0) throw E.unprocessable('حدد وجهة مختلفة عن موقع الانطلاق','SAME_LOCATION');
      return {distanceKm:km,durationMin:null,method:'STRAIGHT_LINE_TEST'};
    }
    if((err as any)?.code) throw err;
    throw E.serviceUnavailable('تعذر حساب مسافة القيادة حاليًا، حاول مرة أخرى','ROUTING_UNAVAILABLE');
  }
}

function price(app: App, distanceKm: number) {
  const base = app.settings.get<number>('trips.base_fare');
  const perKm = app.settings.get<number>('trips.per_km_fare');
  const minimum = app.settings.get<number>('trips.minimum_fare');
  const fare = Math.max(minimum, base + distanceKm * perKm);
  return { baseFare: base, perKmFare: perKm, minimumFare: minimum, fare: Math.round(fare / 50) * 50, currency: app.settings.get<string>('platform.currency') };
}

function resolveSaved(db: App['db'], userId: string, id?: string): LocationRow | null {
  if (!id) return null;
  const a = db.get<{ location_id: string }>('SELECT location_id FROM addresses WHERE id=? AND user_id=?', id, userId);
  if (!a) throw E.unprocessable('العنوان المحفوظ غير موجود', 'INVALID_ADDRESS');
  return db.get<LocationRow>('SELECT * FROM locations WHERE id=?', a.location_id) || null;
}

function makeLocation(app: App, userId: string, input: any, addressId?: string): LocationRow {
  const saved = resolveSaved(app.db, userId, addressId);
  return saved || app.locations.create(input, { requireArea: false });
}

export function registerTripRoutes(app: App, r: Router): void {
  r.post('/trips/estimate', auth, roles('CUSTOMER'), async (ctx: Ctx) => {
    if (!app.settings.get<boolean>('trips.enabled')) throw E.unprocessable('نظام المشاوير غير متاح حاليًا', 'TRIPS_DISABLED');
    const b = parse<any>(s.obj({ origin: tripLocation, destination: tripLocation, stops: s.arr(tripLocation,{max:5,optional:true,default:[]}) }), ctx.body);
    const route = await drivingRoute(app, [b.origin, ...(b.stops||[]), b.destination]);
    return { distanceKm: route.distanceKm, durationMin: route.durationMin, ...price(app, route.distanceKm), method: route.method, note: 'المسافة محسوبة حسب مسار القيادة على الطرق، وليست خطًا مستقيمًا بين النقطتين.' };
  });

  r.post('/trips', auth, roles('CUSTOMER'), async (ctx: Ctx) => {
    if (!app.settings.get<boolean>('trips.enabled')) throw E.unprocessable('نظام المشاوير غير متاح حاليًا', 'TRIPS_DISABLED');
    const tripService = app.catalog.all().services.find(x => x.slug === 'motorcycle-trips');
    if (!tripService || !tripService.is_active) throw E.notFound('خدمة المشاوير غير متاحة', 'SERVICE_NOT_FOUND');
    const b = parse<any>(tripInputSchema, ctx.body);
    const origin = makeLocation(app, ctx.user!.id, b.origin, b.originAddressId);
    const destination = b.destination ? makeLocation(app, ctx.user!.id, b.destination, b.destinationAddressId) : origin;
    const stops: LocationRow[] = []; for (const stop of (b.stops||[])) stops.push(app.locations.create(stop, { requireArea:false }));
    const points=[origin,...stops,...(b.destination?[destination]:[])];
    const destinationPending=!b.destination;
    if (!destinationPending && points.every((p:any)=>p.lat===origin.lat && p.lng===origin.lng)) throw E.unprocessable('حدد وجهة مختلفة عن موقع الانطلاق','SAME_LOCATION');
    const route = destinationPending ? {distanceKm:0,durationMin:null,method:'STRAIGHT_LINE_TEST' as const} : await drivingRoute(app, points);
    const distanceKm = route.distanceKm;
    const pricing = price(app, distanceKm);
    const now = iso(app.clock.now());
    return app.db.tx(() => {
      const activeCount = app.db.get<{c:number}>(`SELECT COUNT(*) c FROM orders WHERE customer_id=? AND status IN ('PENDING','SEARCHING','ASSIGNED','ACCEPTED','ON_THE_WAY','IN_PROGRESS')`, ctx.user!.id)!.c;
      if (activeCount >= app.settings.get<number>('orders.max_active_per_customer')) throw E.unprocessable('لديك عدد كبير من الطلبات النشطة حاليًا', 'TOO_MANY_ACTIVE_ORDERS');
      const id = uuid();
      const code = (() => { const year = new Date(app.clock.now()).getUTCFullYear(); const key=`order_seq_${year}`; app.db.run('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1',key); const n=app.db.get<{value:number}>('SELECT value FROM counters WHERE name=?',key)!.value; return `KH-${year}-${String(n).padStart(6,'0')}`; })();
      app.db.run(`INSERT INTO orders(id,code,customer_id,service_id,status,priority,description,form_data,location_id,area_id,contact_phone,scheduled_at,pricing_type,price_snapshot,agreed_price,currency,customer_notes,attachments,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, code, ctx.user!.id, tripService.id, 'PENDING', 'NORMAL', b.description,
        JSON.stringify({ purpose:b.purpose, purposeNote:b.purposeNote || null, originAddressText:b.origin.addressText || null, destinationAddressText:b.destination?.addressText || null, destinationPending, stops: points.slice(1,-1).map((p:any)=>({lat:p.lat,lng:p.lng,addressText:p.address_text||p.addressText||null})) }), origin.id, origin.area_id,
        b.contactPhone, null, 'FIXED', pricing.fare, null, pricing.currency, b.notes || null, '[]', now, now);
      app.db.run(`INSERT INTO trip_orders(order_id,destination_location_id,destination_pending,purpose,purpose_note,distance_km,base_fare,per_km_fare,minimum_fare,fare,currency,waiting_per_minute_fare,waiting_total_minutes,purchase_max_price,purchase_quantity,purchase_alternatives,purchase_requires_approval,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, destination.id, destinationPending?1:0, b.purpose as Purpose, b.purposeNote || null, distanceKm, pricing.baseFare, pricing.perKmFare, pricing.minimumFare, pricing.fare, pricing.currency, Number(b.waitingPerMinute ?? app.settings.get<number>('trips.waiting_per_minute_fare')), 0, b.purchaseMaxPrice ?? null, b.purchaseQuantity ?? null, b.purchaseAlternatives ?? null, b.purchaseRequiresApproval?1:0, now, now);
      stops.forEach((p:any,i:number)=>app.db.run('INSERT INTO trip_stops(id,order_id,sequence_no,location_id,note) VALUES(?,?,?,?,?)',uuid(),id,i+1,p.id,null));
      app.db.run('INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,actor_role,created_at) VALUES (?,?,?,?,?,?)', id, null, 'PENDING', ctx.user!.id, 'CUSTOMER', now);
      let o = app.db.get<OrderRow>('SELECT * FROM orders WHERE id=?', id)!;
      o = app.orders.applyTransition(o, 'SEARCHING', 'SYSTEM', ctx, { reason:'trip-auto' });
      app.notifications.notify(ctx.user!.id, 'ORDER_RECEIVED', { code:o.code });
      app.assignment.assignWave(o.id);
      o = app.db.get<OrderRow>('SELECT * FROM orders WHERE id=?', id)!;
      ctx.status=201;
      return { order: app.orders.serialize(o, ctx), trip: serializeTrip(app, o.id, ctx.locale) };
    });
  });

  r.post('/trips/:id/destination', auth, roles('CUSTOMER','PROVIDER'), async (ctx: Ctx) => {
    const b=parse<any>(s.obj({destination:tripLocation}),ctx.body);
    const o=app.db.get<OrderRow>('SELECT * FROM orders WHERE id=?',ctx.params.id!);
    if(!o) throw E.notFound('المشوار غير موجود');
    if(ctx.user!.role==='CUSTOMER' && o.customer_id!==ctx.user!.id) throw E.forbidden();
    if(ctx.user!.role==='PROVIDER' && o.provider_id!==ctx.user!.providerId) throw E.forbidden();
    if(['COMPLETED','CANCELLED'].includes(o.status)) throw E.unprocessable('لا يمكن تغيير وجهة مشوار منتهٍ','TRIP_CLOSED');
    const t=app.db.get<any>('SELECT * FROM trip_orders WHERE order_id=?',o.id); if(!t) throw E.notFound('بيانات المشوار غير موجودة');
    const d=makeLocation(app,ctx.user!.id,b.destination);
    const origin=app.db.get<any>('SELECT * FROM locations WHERE id=?',o.location_id)!;
    const route=await drivingRoute(app,[origin,{lat:d.lat,lng:d.lng}]); const pricing=price(app,route.distanceKm); const now=iso(app.clock.now());
    app.db.run('UPDATE trip_orders SET destination_location_id=?,destination_pending=0,distance_km=?,fare=?,updated_at=? WHERE order_id=?',d.id,route.distanceKm,pricing.fare,now,o.id);
    app.db.run('UPDATE orders SET price_snapshot=?,updated_at=?,version=version+1 WHERE id=?',pricing.fare,now,o.id);
    app.sse.send(o.customer_id,'sync',{scope:'orders',orderId:o.id});
    return {ok:true,distanceKm:route.distanceKm,fare:pricing.fare,currency:pricing.currency,trip:serializeTrip(app,o.id,ctx.locale)};
  });

  r.post('/trips/:id/wait', auth, roles('PROVIDER'), (ctx: Ctx) => {
    const b=parse<any>(s.obj({action:s.oneOf(['START','STOP'])}),ctx.body); const o=app.db.get<any>('SELECT id,status FROM orders WHERE id=? AND provider_id=?',ctx.params.id!,ctx.user!.providerId); if(!o)throw E.notFound('المشوار غير موجود');
    if(o.status!=='IN_PROGRESS')throw E.unprocessable('يمكن احتساب الانتظار أثناء تنفيذ المشوار فقط','INVALID_TRIP_STATE');
    const active=app.db.get<any>('SELECT * FROM trip_wait_sessions WHERE order_id=? AND provider_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',o.id,ctx.user!.providerId); const now=iso(app.clock.now());
    if(b.action==='START'){if(active)throw E.conflict('يوجد وقت انتظار قيد التسجيل','WAIT_ALREADY_STARTED'); const id=uuid();app.db.run('INSERT INTO trip_wait_sessions(id,order_id,provider_id,started_at,created_at) VALUES(?,?,?,?,?)',id,o.id,ctx.user!.providerId,now,now);return {ok:true,startedAt:now};}
    if(!active)throw E.unprocessable('لا يوجد وقت انتظار قيد التسجيل','WAIT_NOT_STARTED');
    const minutes=Math.max(0,(Date.parse(now)-Date.parse(active.started_at))/60000); const rounded=Math.round(minutes*10)/10; const t=app.db.get<any>('SELECT * FROM trip_orders WHERE order_id=?',o.id)!; const total=Math.round((Number(t.waiting_total_minutes)+rounded)*10)/10; const extra=Math.round(total*Number(t.waiting_per_minute_fare||0)); const baseFare=Math.max(Number(t.minimum_fare),Number(t.base_fare)+Number(t.distance_km)*Number(t.per_km_fare)); const fare=Math.round((baseFare+extra)/50)*50; app.db.run('UPDATE trip_wait_sessions SET ended_at=?,minutes=? WHERE id=?',now,rounded,active.id); app.db.run('UPDATE trip_orders SET waiting_total_minutes=?,fare=?,updated_at=? WHERE order_id=?',total,fare,now,o.id); return {ok:true,minutes:rounded,totalMinutes:total,fare};
  });
}

export function serializeTrip(app: App, orderId: string, locale: 'ar'|'en' = 'ar') {
  const t = app.db.get<any>('SELECT * FROM trip_orders WHERE order_id=?', orderId);
  if (!t) return null;
  const d = t.destination_pending ? null : app.db.get<LocationRow>('SELECT * FROM locations WHERE id=?', t.destination_location_id);
  const labels: Record<string,string> = { PASSENGER:'نقل شخص', ITEM_PURCHASE:'شراء وإحضار غرض', MEDICINE:'شراء دواء من صيدلية', PARCEL:'توصيل طلب أو غرض', RESTAURANT_PICKUP:'استلام طلب من مطعم', DOCUMENT_DELIVERY:'استلام وتسليم مستندات', TECHNICIAN_PICKUP:'إحضار فني أو عامل', STORE_SHOPPING:'شراء أغراض من متجر', SMALL_CARGO:'نقل أغراض صغيرة', HOME_PICKUP:'استلام أو توصيل شيء من/إلى المنزل', OTHER:'أخرى' };
  return { purpose:t.purpose, purposeName: labels[t.purpose] || t.purpose, purposeNote:t.purpose_note, distanceKm:t.distance_km, fare:t.fare, currency:t.currency, pricing:{baseFare:t.base_fare,perKmFare:t.per_km_fare,minimumFare:t.minimum_fare,waitingPerMinuteFare:t.waiting_per_minute_fare}, waitingTotalMinutes:t.waiting_total_minutes, purchase:{maxPrice:t.purchase_max_price,quantity:t.purchase_quantity,alternatives:t.purchase_alternatives,requiresApproval:!!t.purchase_requires_approval}, stops:app.db.all<any>('SELECT ts.sequence_no sequenceNo,l.lat,l.lng,l.address_text addressText FROM trip_stops ts JOIN locations l ON l.id=ts.location_id WHERE ts.order_id=? ORDER BY ts.sequence_no',orderId), destination:d ? app.locations.serialize(d, locale) : null, destinationPending:!!t.destination_pending };
}

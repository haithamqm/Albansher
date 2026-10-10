import { haversineKm, round } from '../core/util.js';
import type { Db } from '../db/database.js';
import type { App } from '../app.js';
import type { OrderRow } from '../types/domain.js';

/**
 * المطابقة تعتمد على الخدمة والحالة والتوفر ثم المسافة الجغرافية الفعلية.
 * المنطقة الإدارية ليست شرطًا للمطابقة؛ GPS هو المرجع الأساسي.
 */
export interface Candidate { providerId: string; score: number; distanceKm: number | null }
export interface Matcher { findCandidates(order: OrderRow, opts: { excludeProviderIds: string[]; limit: number }): Candidate[] }

function localParts(ms: number, tz: string): { weekday: number; hhmm: string } {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)); }
  catch { parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Aden', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)); }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday: wd, hhmm: `${get('hour').padStart(2, '0')}:${get('minute')}` };
}

export function isProviderAvailable(db: Db, providerId: string, ms: number, tz: string): boolean {
  const rows = db.all<{ weekday: number; start_time: string; end_time: string }>('SELECT weekday, start_time, end_time FROM provider_availability WHERE provider_id = ? AND is_available = 1', providerId);
  if (!rows.length) return true;
  const { weekday, hhmm } = localParts(ms, tz);
  return rows.some((r) => r.weekday === weekday && r.start_time <= hhmm && hhmm < r.end_time);
}

export class NearestRatedMatcher implements Matcher {
  constructor(private app: App) {}

  findCandidates(order: OrderRow, { excludeProviderIds = [], limit }: { excludeProviderIds: string[]; limit: number }): Candidate[] {
    const { db, settings } = this.app;
    const loc = order.location_provided === 0 ? null : db.get<{ lat: number; lng: number }>('SELECT lat, lng FROM locations WHERE id = ?', order.location_id);
    if (order.location_provided !== 0 && !loc) return [];
    const when = order.scheduled_at ? Date.parse(order.scheduled_at) : this.app.clock.now();
    const tz = settings.get<string>('platform.timezone');
    const excluded = new Set(excludeProviderIds);
    const serviceAreas = new Set(db.all<{area_id:string}>('SELECT area_id FROM service_area_rules WHERE service_id=?', order.service_id).map(x=>x.area_id));
    const chain = order.area_id ? new Set(this.app.catalog.areaChain(String(order.area_id))) : new Set<string>();
    const serviceSlug = String(db.get<{slug:string}>('SELECT slug FROM services WHERE id=?', order.service_id)?.slug || '');
    let requiredCapability: string | null = null;
    const form=(()=>{ try{return JSON.parse(order.form_data||'{}')}catch{return {}} })() as any;
    if (serviceSlug === 'motorcycle-trips') { const purpose=String(form.purpose||''); requiredCapability = purpose==='PASSENGER'?'trip:passenger': purpose==='MEDICINE'?'trip:medicine': purpose==='ITEM_PURCHASE'?'trip:purchase': purpose==='PARCEL'||purpose==='HOME_PICKUP'?'trip:delivery': purpose==='RESTAURANT_PICKUP'?'trip:restaurant': purpose==='DOCUMENT_DELIVERY'?'trip:documents':purpose==='TECHNICIAN_PICKUP'?'trip:worker':purpose==='STORE_SHOPPING'?'trip:shopping':purpose==='SMALL_CARGO'?'trip:cargo':null; }
    else if (serviceSlug === 'passenger-transport') requiredCapability='trip:passenger';
    else if (serviceSlug === 'pharmacy-purchase') requiredCapability='purchase:pharmacy';
    else if (['purchase-and-delivery','shopping-delivery','shopping-for-me'].includes(serviceSlug)) requiredCapability='purchase:store';
    else if (serviceSlug === 'document-delivery') requiredCapability='delivery:item';
    else if (serviceSlug === 'seasonal-plowing') requiredCapability='agri:plowing';
    else if (serviceSlug === 'seasonal-harvest') requiredCapability='agri:harvest';
    else if (serviceSlug === 'seasonal-crop-transport') requiredCapability='agri:crop-transport';
    const rows = db.all<any>(`SELECT sp.id,sp.base_lat,sp.base_lng,sp.rating_avg,sp.completed_orders_count,
        GROUP_CONCAT(DISTINCT psa.area_id) provider_area_ids,
        GROUP_CONCAT(DISTINCT pc.capability_key) capability_keys,
        ll.lat live_lat,ll.lng live_lng,ll.updated_at live_updated_at,
        CASE WHEN f.provider_id IS NULL THEN 0 ELSE 1 END favorite,
        (SELECT COUNT(*) FROM orders ao WHERE ao.provider_id=sp.id AND ao.status IN ('ACCEPTED','ON_THE_WAY','IN_PROGRESS')) active_order_count
      FROM service_providers sp
      JOIN users u ON u.id=sp.user_id AND u.status='ACTIVE'
      JOIN provider_services ps ON ps.provider_id=sp.id AND ps.service_id=? AND ps.is_active=1
      LEFT JOIN provider_service_areas psa ON psa.provider_id=sp.id
      LEFT JOIN provider_capabilities pc ON pc.provider_id=sp.id AND pc.is_active=1
      LEFT JOIN provider_live_locations ll ON ll.provider_id=sp.id AND ll.updated_at >= ?
      LEFT JOIN favorite_providers f ON f.customer_id=? AND f.provider_id=sp.id
      WHERE sp.verification_status='VERIFIED' AND sp.is_online=1 AND sp.accepting_orders=1
      GROUP BY sp.id`, order.service_id, new Date(this.app.clock.now()-5*60_000).toISOString(), order.customer_id);

    const scored: Candidate[] = [];
    for (const p of rows) {
      if (excluded.has(p.id)) continue;
      if (!isProviderAvailable(db, p.id, when, tz)) continue;
      if (requiredCapability) { const caps=String(p.capability_keys||'').split(',').filter(Boolean); if(caps.length && !caps.includes(requiredCapability)) continue; }
      if (serviceAreas.size && order.area_id) {
        const areas = String(p.provider_area_ids||'').split(',').filter(Boolean);
        if (areas.length && !areas.some((id:string)=>chain.has(id))) continue;
      }
      const candidatePoint = p.live_lat != null ? {lat:Number(p.live_lat),lng:Number(p.live_lng)} : (p.base_lat != null && p.base_lng != null ? {lat:Number(p.base_lat),lng:Number(p.base_lng)} : null);
      if (loc && !candidatePoint) continue;
      const dist = loc && candidatePoint ? haversineKm(loc.lat, loc.lng, candidatePoint.lat, candidatePoint.lng) : null;
      const rating = Math.max(0,Math.min(5,Number(p.rating_avg||0)));
      const completed = Math.max(0,Number(p.completed_orders_count||0));
      const favorite = Number(p.favorite||0);
      const distanceComponent = dist === null ? 0 : Math.max(0, 1 - Math.min(dist, 50)/50);
      const qualityComponent = rating/5;
      const experienceComponent = Math.min(1, completed/50);
      const activeOrders = Math.max(0, Number(p.active_order_count || 0));
      // مقدم الخدمة الذي لديه طلبات حالية لكنه اختار استقبال طلبات إضافية يبقى مرشحًا؛
      // الحمل الحالي عامل ترتيب/ازدحام وليس شرط منع.
      const workloadComponent = Math.max(0, 1 - Math.min(activeOrders, 3) / 3);
      // Distance-first: quality can break close ties but cannot normally outrank a materially closer capable provider.
      const urgencyBoost = order.priority === 'URGENT' ? (dist === null ? 0.08 : Math.max(0,1-Math.min(dist,10)/10)*0.12) : 0;
      const composite = dist === null ? qualityComponent*0.48 + favorite*0.18 + experienceComponent*0.10 + workloadComponent*0.16 + urgencyBoost : distanceComponent*0.68 + qualityComponent*0.11 + favorite*0.05 + experienceComponent*0.03 + workloadComponent*0.13 + urgencyBoost;
      scored.push({ providerId:p.id, distanceKm:dist===null?null:round(dist,2), score:round(composite,6) });
    }
    scored.sort((a,b)=>{
      if (a.distanceKm !== null && b.distanceKm !== null) {
        const delta=a.distanceKm-b.distanceKm;
        if (Math.abs(delta) >= 1) return delta;
      }
      return (b.score-a.score) || ((a.distanceKm??Number.POSITIVE_INFINITY)-(b.distanceKm??Number.POSITIVE_INFINITY)) || a.providerId.localeCompare(b.providerId);
    });
    return scored.slice(0,limit);
  }
}

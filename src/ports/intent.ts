import { normalizeAr, tr, parseJson } from '../core/util.js';
import type { Locale, ServiceRow, CategoryRow } from '../types/domain.js';
import type { Catalog } from '../modules/catalog.js';

export interface IntentMatch { serviceId: string; serviceSlug: string; serviceName: string; categoryId: string; categorySlug: string; categoryName: string; score: number; confidence: number; icon: string | null }
export interface IntentStep { serviceId: string; serviceSlug: string; serviceName: string; reason: string; confidence: number }
export interface StructuredIntent {
  taskType: 'PASSENGER'|'DELIVERY'|'PURCHASE_AND_DELIVERY'|'PURCHASE_PHARMACY'|'PICKUP_AND_DELIVERY'|'AGRICULTURE_PLOWING'|'AGRICULTURE_HARVEST'|'AGRICULTURE_CROP_TRANSPORT'|'SHOPPING'|'CUSTOM'|'UNKNOWN';
  item: string | null;
  quantity: number | null;
  pickupText: string | null;
  deliveryText: string | null;
  requiredCapabilities: string[];
  sourceSignals: string[];
}
export interface IntentResult {
  matches: IntentMatch[];
  priority: 'LOW' | 'NORMAL' | 'URGENT';
  extracted: { urgent: boolean; when: 'today' | 'now' | null; destinationHint: 'CITY_TO_VILLAGE' | 'VILLAGE_TO_CITY' | null; purchaseIntent: boolean; compound: boolean; structured: StructuredIntent };
  steps: IntentStep[];
  clarification: { question: string; options: Array<{ label: string; serviceId: string }> } | null;
  source: 'RULES';
}
export interface IntentParser { parse(text: string, ctx: { catalog: Catalog; locale?: Locale; image?: { mime: string; dataBase64: string } }): Promise<IntentResult> }

const URGENT = ['اليوم','الان','حالا','فورا','بسرعه','مستعجل','عاجل','ضروري','طارئ','سريع','urgent','asap','now','today'].map(normalizeAr);
const VILLAGE = ['قرية','ريف','مزرعة','عزلة','منطقة','القرية','المزرعة','الريف','قرية صغيرة','مكان غير مسمى'].map(normalizeAr);
const CITY = ['مدينة','المدينة','المدينه','السوق','المركز','إب','صنعاء','تعز','عدن'].map(normalizeAr);
const PURCHASE_WORDS = ['اشتر','اشتري','اشترِ','يشتري','شراء','تسوق','تسوق لي','تسوق عني','بدلي','بالنيابة','جيب لي','هات لي','جيب','هات','وفر لي','وفرلي','اشتريلي','اشترلي','دبر لي','دبرلي','دواء','صيدلية'].map(normalizeAr);
const PASSENGER_WORDS = ['يوصلني','يوصلنى','يأخذني','ياخذني','ياخذنى','يجيبني','يجيبنى','ينقلني','ينقلنى','توصيلة','مشوار شخصي','مشوار لي','اركب','يركبني','نقل شخص','نقلني'].map(normalizeAr);
const DELIVERY_WORDS = ['يوصله','يوصلها','يوصلهم','توصيل','يوصل','يوصله','يجيبه','يجيبها','يجيبه لي','احضره','احضرها','استلام','يستلمه','يأخذ الغرض','ياخذ الغرض','يوصل للبيت','يوصله للبيت'].map(normalizeAr);
const PICKUP_WORDS = ['يأخذ من','ياخذ من','استلام من','يستلم من','من بيت اخوي','من بيت اخي','من عند اخوي','من عند اخي','من بيت اخوه','من بيت أخوي'].map(normalizeAr);
const PHARMACY_WORDS = ['صيدلية','دواء','دوا','ادوية','علاج','روشتة','وصفة طبية'].map(normalizeAr);
const SHOPPING_WORDS = ['مقاضي','مقاضي البيت','بقالة','بقاله','مواد غذائية','مواد غذائيه','اغراض البيت','أغراض البيت','مستلزمات البيت','مشتريات البيت','مشتريات','سوبرماركت','ماركت','من السوق','حاجات البيت','احتياجات البيت','مقاضي المنزل'].map(normalizeAr);
const AGRI_PLOW = ['يحرث','احرث','حرث','حراثة','تجهيز الأرض','تجهيز الارض','يجهز الأرض','يجهز الارض'].map(normalizeAr);
const AGRI_HARVEST = ['يحصد','احصد','حصاد','حصد','محصول يحصد','حصيدة'].map(normalizeAr);
const AGRI_CROP = ['نقل المحصول','انقل المحصول','ينقل المحصول','نقل محاصيل','محاصيل من المزرعة','محصول إلى السوق'].map(normalizeAr);
const stripPrefix = (w: string): string => w.replace(/^(وال|بال|كال|فال|لل|ال)/, '').replace(/^و(?=.{4,})/, '');
const tokenize = (norm:string) => norm.split(/\s+/).filter(Boolean).flatMap(w => [w, stripPrefix(w)]).filter(w=>w.length>=2);
const hasAny=(norm:string,words:string[])=>words.some(w=>norm.includes(w));
const extractItem=(norm:string):string|null=>{
  const patterns=[/يشتري?\s+لي\s+(.+?)(?:\s+و(?:يوصله|يجيبه|يوصلها)|$)/, /اشتر(?:ي|ِ)?\s+لي\s+(.+?)(?:\s+و(?:يوصله|يجيبه|يوصلها)|$)/, /تسوق(?:\s+لي|\s+عني)?\s+(.+)/, /شراء\s+(.+?)(?:\s+وتوصيل|\s+ويوصل|$)/];
  for(const re of patterns){const m=norm.match(re);if(m?.[1]){const x=m[1].trim().replace(/^(هذا|هذه)\s+/,'');if(x.length>=2)return x.slice(0,180);}}
  return null;
};
const extractQuantity=(norm:string):number|null=>{const m=norm.match(/(?:عدد|كمية|كم)\s*(\d{1,4})|(?:\b|^)(\d{1,4})\s+(?:حبة|حبات|قطعة|قطع|متر|كيلو|كيلوجرام)/);const n=Number(m?.[1]||m?.[2]);return Number.isFinite(n)&&n>0?n:null;};
const chooseService=(data:any[],slug:string)=>data.find((x:any)=>x.slug===slug&&x.is_active&&x.active!==false&&x.isSeasonActive!==false);

function deterministic(text: string, { catalog, locale='ar' }: { catalog: Catalog; locale?: Locale }): IntentResult {
  const norm = normalizeAr(text); const tokens=tokenize(norm); const tokenSet=new Set(tokens); const data=catalog.all();
  const activeCats=new Map(data.categories.filter(c=>c.is_active).map(c=>[c.id,c]));
  const matches:Array<{svc:ServiceRow;cat:CategoryRow;score:number}> = [];
  const passenger=hasAny(norm,PASSENGER_WORDS); const pharmacy=hasAny(norm,PHARMACY_WORDS); const purchase=hasAny(norm,PURCHASE_WORDS); const delivery=hasAny(norm,DELIVERY_WORDS)||/يوصل|توصيل|يجيب/.test(norm); const pickupDelivery=hasAny(norm,PICKUP_WORDS)&&delivery; const shopping=hasAny(norm,[...SHOPPING_WORDS,'تسوق لي','تسوق عني','تسوق','اشتر لي','اشترِ لي','شراء بالنيابة'].map(normalizeAr));
  const plow=hasAny(norm,AGRI_PLOW), harvest=hasAny(norm,AGRI_HARVEST), crop=hasAny(norm,AGRI_CROP);
  let forcedSlug:string|null=null;
  if(plow) forcedSlug='seasonal-plowing'; else if(harvest) forcedSlug='seasonal-harvest'; else if(crop) forcedSlug='seasonal-crop-transport';
  else if(passenger) forcedSlug=norm.includes('دباب')||norm.includes('موتوسيكل')?'motorcycle-trips':'passenger-transport';
  else if(pharmacy && (purchase||delivery)) forcedSlug='pharmacy-purchase';
  else if(purchase && delivery) forcedSlug='purchase-and-delivery';
  else if(shopping && delivery) forcedSlug='shopping-delivery';
  else if(shopping || purchase) forcedSlug='shopping-for-me';
  else if(delivery) forcedSlug='parcel-delivery';

  for(const svc of data.services){
    const cat=activeCats.get(svc.category_id); if(!svc.is_active||!cat||!catalog.getActiveService(svc.id)) continue;
    const terms=new Set<string>(); for(const k of parseJson<string[]>(svc.keywords,[])||[])terms.add(normalizeAr(k)); for(const lang of ['ar','en'] as const)terms.add(normalizeAr(tr(svc.name_i18n,lang))); for(const alias of catalog.aliasesForService(svc.id)) terms.add(normalizeAr(alias));
    let score=0; if(forcedSlug===svc.slug) score+=12;
    for(const term of terms){if(!term)continue;if(term.includes(' ')){if(norm.includes(term))score+=4+term.split(' ').length;continue;}if(tokenSet.has(term))score+=3;else if(term.length>=3&&tokens.some(t=>t.length>=3&&(t.startsWith(term)||term.startsWith(t))))score+=1.5;}
    for(const k of parseJson<string[]>(cat.keywords,[])||[]){const kk=normalizeAr(k);if(kk&&(tokenSet.has(kk)||norm.includes(kk)))score+=.75;}
    if(passenger&&['car-with-driver','passenger-transport','motorcycle-trips'].includes(svc.slug))score+=4;
    if(purchase&&delivery&&['purchase-and-delivery','shopping-for-me','pharmacy-purchase','shopping-delivery','motorcycle-trips'].includes(svc.slug))score+=4;
    if(plow&&svc.slug==='seasonal-plowing')score+=5;if(harvest&&svc.slug==='seasonal-harvest')score+=5;if(crop&&svc.slug==='seasonal-crop-transport')score+=5;
    if(score>0)matches.push({svc,cat,score});
  }
  matches.sort((a,b)=>b.score-a.score);
  const top:IntentMatch[]=matches.slice(0,6).map(({svc,cat,score})=>({serviceId:svc.id,serviceSlug:svc.slug,serviceName:tr(svc.name_i18n,locale),categoryId:cat.id,categorySlug:cat.slug,categoryName:tr(cat.name_i18n,locale),score,confidence:Math.min(1,Math.round((score/6)*100)/100),icon:svc.icon}));
  const urgent=URGENT.some(u=>norm.includes(u)||tokenSet.has(u)); const hasVillage=VILLAGE.some(u=>norm.includes(u)); const hasCity=CITY.some(u=>norm.includes(u));
  const cityPos=Math.min(...CITY.map(x=>norm.indexOf(x)).filter(x=>x>=0)); const villagePos=Math.min(...VILLAGE.map(x=>norm.indexOf(x)).filter(x=>x>=0)); const hasDirection=/\b(?:من|في|الى|إلى|ل)\b/.test(norm)||norm.includes('من')||norm.includes('الى')||norm.includes('إلى');
  const cityToVillage=hasCity&&hasVillage&&hasDirection&&cityPos>=0&&villagePos>=0&&cityPos<villagePos;
  const villageToCity=hasCity&&hasVillage&&hasDirection&&cityPos>=0&&villagePos>=0&&villagePos<cityPos;
  const destinationHint=cityToVillage?'CITY_TO_VILLAGE':villageToCity?'VILLAGE_TO_CITY':null;
  const compound=(purchase&&delivery)||(/\sو\s/.test(norm)&&purchase&&!pharmacy);
  const item=extractItem(norm); const quantity=extractQuantity(norm);
  const taskType:StructuredIntent['taskType']=plow?'AGRICULTURE_PLOWING':harvest?'AGRICULTURE_HARVEST':crop?'AGRICULTURE_CROP_TRANSPORT':passenger?'PASSENGER':pharmacy&&(purchase||delivery)?'PURCHASE_PHARMACY':purchase&&delivery?'PURCHASE_AND_DELIVERY':pickupDelivery?'PICKUP_AND_DELIVERY':shopping?'SHOPPING':delivery?'DELIVERY':(item||norm.length>=6)?'CUSTOM':'UNKNOWN';
  const requiredCapabilities = taskType==='PASSENGER'?['trip:passenger']:taskType==='PURCHASE_PHARMACY'?['purchase:pharmacy','delivery:item']:taskType==='PURCHASE_AND_DELIVERY'||taskType==='SHOPPING'?['purchase:store','delivery:item']:taskType==='PICKUP_AND_DELIVERY'?['pickup:item','delivery:item']:taskType==='DELIVERY'?['delivery:item']:taskType==='AGRICULTURE_PLOWING'?['agri:plowing']:taskType==='AGRICULTURE_HARVEST'?['agri:harvest']:taskType==='AGRICULTURE_CROP_TRANSPORT'?['agri:crop-transport']:[];
  const structured:StructuredIntent={taskType,item,quantity,pickupText:pharmacy?'الصيدلية':null,deliveryText:/للبيت|الى البيت|إلى البيت|للمنزل|الى المنزل|إلى المنزل/.test(norm)?'منزل العميل':null,requiredCapabilities,sourceSignals:[forcedSlug?'forced-intent': '',passenger?'passenger-synonym':'',purchase?'purchase-synonym':'',delivery?'delivery-synonym':'',pharmacy?'pharmacy-signal':'',item?'item-extracted':''].filter(Boolean)};
  const steps=top.slice(0,3).map(m=>({serviceId:m.serviceId,serviceSlug:m.serviceSlug,serviceName:m.serviceName,reason:forcedSlug===m.serviceSlug?'فهم مباشر للنية من صياغة الطلب':requiredCapabilities.length?'يتوافق مع القدرات المطلوبة للمهمة':'يتوافق مع كلمات الطلب',confidence:m.confidence}));
  let clarification:IntentResult['clarification']=null;
  if(!top.length){const custom=data.services.find(x=>x.slug==='custom-request');if(custom)clarification={question:'ما الخدمة التي تحتاجها؟ يمكنك وصفها بكلماتك أو إرسال صورة.',options:[{label:tr(custom.name_i18n,locale),serviceId:custom.id}]};}
  else if((taskType==='DELIVERY' || taskType==='PICKUP_AND_DELIVERY' || taskType==='PURCHASE_AND_DELIVERY') && !item){
    clarification={question:'ما الطلب الذي تريد توصيله؟ اكتب اسم الغرض أو صفه بكلماتك.',options:[]};
  }
  else if(top[0].confidence<.35){clarification={question:'ما الذي تريد تنفيذه تحديدًا؟',options:top.slice(0,3).map(x=>({label:x.serviceName,serviceId:x.serviceId}))};}
  const best=data.byService.get(top[0]?.serviceId||'');
  return {matches:top,priority:urgent?'URGENT':(best?.default_priority||'NORMAL'),extracted:{urgent,when:/اليوم|today/.test(norm)?'today':/الان|حالا|فورا|now/.test(norm)?'now':null,destinationHint,purchaseIntent:purchase,compound,structured},steps,clarification,source:'RULES'};
}

/** مطابقة محلية تقليدية بالكلمات المفتاحية فقط؛ لا تتصل بخدمات ذكاء اصطناعي أو واجهات خارجية. */
export class RuleIntentParser implements IntentParser {
  async parse(text: string, ctx: { catalog: Catalog; locale?: Locale; image?: { mime: string; dataBase64: string } }): Promise<IntentResult> {
    return deterministic(text, { catalog: ctx.catalog, locale: ctx.locale });
  }
}

export { deterministic as keywordIntentParse };

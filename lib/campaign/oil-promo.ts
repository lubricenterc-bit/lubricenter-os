export const CAMPAIGN_END = '2026-10-10';
export type Customer = {id:string; name:string; phone:string|null};
export type Vehicle = {id:string; customer_id:string|null; make:string|null; model:string|null; year:number|null; plate:string|null};
export type Service = {vehicle_id:string|null; performed_at:string; service_type:string; description:string|null; service_notes:string|null; oil_brand:string|null; oil_viscosity:string|null; next_service_date:string|null};
export type Visit = {vehicle_id:string|null; business_at:string|null; closed_at:string|null; opened_at:string};
export type Contact = {customerId:string; vehicleId:string; name:string; phone:string; vehicle:string; plate:string|null; lastOil:string; due:string|null; idleDays:number; kind:'reenganche'|'mantenimiento'; reason:string; first:boolean; message:string; url:string};

export function normalizePhone(phone:string|null) {
  let digits=(phone||'').replace(/\D/g,'');
  if(/^0\d{10}$/.test(digits)) digits='58'+digits.slice(1);
  if(/^4\d{9}$/.test(digits)) digits='58'+digits;
  return /^584\d{9}$/.test(digits)?digits:null;
}
const compact=/\b(?:aveo|corsa|optra|spark|fiesta|ka|festiva|focus|corolla|araya|yaris|sentra|lancer|signo|accent|elantra|getz|rio|matiz|arauca|orinoco|qq|palio|siena|uno|neon|brisa|forza|clio|logan|megane|megan|twingo|323|626|swift|fit|206|bora|fox|crossfox|centauro|turpial|indigo|a60|alsvin)\b/i;
const dateText=(date:string)=>date.slice(0,10).split('-').reverse().join('/');
const oilService=(s:Service)=>!!s.oil_brand||!!s.oil_viscosity||/oil|aceite/i.test(s.service_type)||/cambio.*aceite/i.test(s.description||'');
const clean=(s:string)=>s.replace(/[*_~`\r\n]/g,' ').replace(/\s+/g,' ').trim();

export function campaignMessage(contact:Pick<Contact,'name'|'vehicle'|'kind'>) {
  const name=clean(contact.name), vehicle=clean(contact.vehicle);
  return `¡Hola, ${name}! 👋😊\n\nEsta semana tenemos un beneficio especial para tu *${vehicle}* en *Lubricenter Cabudare* 🚗✨\n\nHaciendo con nosotros el *cambio de aceite* y colocando también el *filtro*, te incluimos la *limpieza de inyectores GRATIS* 🔧🎁\n\n🗓️ *Solo por pocos días*. Aplican condiciones según el vehículo.\n\nSi quieres aprovecharla, respóndeme por aquí y te digo si aplica para tu carro y coordinamos tu visita 🙌\n\n— *Lubricenter Cabudare*`;
}

export function selectContacts(customers:Customer[],vehicles:Vehicle[],services:Service[],visits:Visit[],asOf:string):Contact[] {
  const cutoff=Date.parse(asOf+'T23:59:59-04:00');
  const days=(at:string)=>Math.floor((cutoff-Date.parse(at))/86400000);
  const byCustomer=new Map(customers.map(c=>[c.id,c]));
  const byVehicle=new Map<string,Service[]>();
  for(const s of services) if(s.vehicle_id && Number.isFinite(Date.parse(s.performed_at)) && Date.parse(s.performed_at)<=cutoff) {
    const list=byVehicle.get(s.vehicle_id)||[];list.push(s);byVehicle.set(s.vehicle_id,list);
  }
  const visitDates=new Map<string,string>();
  for(const v of visits) {
    const at=v.business_at||v.closed_at||v.opened_at;
    if(v.vehicle_id && Date.parse(at)<=cutoff && (!visitDates.has(v.vehicle_id)||Date.parse(at)>Date.parse(visitDates.get(v.vehicle_id)!))) visitDates.set(v.vehicle_id,at);
  }
  const candidates:Array<Contact&{score:number}>=[];
  for(const v of vehicles) {
    const c=byCustomer.get(v.customer_id||'');if(!c||/desconocido/i.test(c.name))continue;
    const phone=normalizePhone(c.phone);if(!phone)continue;
    const history=(byVehicle.get(v.id)||[]).sort((a,b)=>Date.parse(b.performed_at)-Date.parse(a.performed_at));
    const oils=history.filter(oilService),oil=oils[0];if(!oil)continue;
    const injector=history.find(s=>/inyector|injector/i.test((s.description||'')+' '+(s.service_notes||'')));
    if(days(oil.performed_at)<60||(injector&&days(injector.performed_at)<60))continue;
    const last=[history[0]?.performed_at,visitDates.get(v.id)].filter((x):x is string=>!!x).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
    const idleDays=days(last),due=!!oil.next_service_date&&oil.next_service_date<=asOf;
    if(!due&&idleDays<180)continue;
    const vehicle=[v.make,v.model,v.year].filter(Boolean).join(' ')||'vehículo';
    const kind=idleDays>=180?'reenganche':'mantenimiento';
    const reason=[due?`Revisión programada vencida (${dateText(oil.next_service_date!)})`:null,idleDays>=180?`${idleDays} días sin visita registrada de este vehículo`:null].filter(Boolean).join('; ');
    const score=(due?100:0)+(idleDays>=180?40:0)+(compact.test(vehicle)?20:0)+Math.min(20,oils.length*3)+Math.min(30,idleDays/20);
    const message=campaignMessage({name:c.name,vehicle,kind});
    candidates.push({customerId:c.id,vehicleId:v.id,name:c.name,phone,vehicle,plate:v.plate,lastOil:oil.performed_at,due:oil.next_service_date,idleDays,kind,reason,score,first:false,message,url:`https://wa.me/${phone}?text=${encodeURIComponent(message)}`});
  }
  candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'es')||a.vehicleId.localeCompare(b.vehicleId));
  const phones=new Set<string>(),clients=new Set<string>(),out:Contact[]=[];
  for(const c of candidates) {
    if(phones.has(c.phone)||clients.has(c.customerId))continue;
    phones.add(c.phone);clients.add(c.customerId);
    const {score:_,...contact}=c;out.push({...contact,first:out.length<50});
  }
  return out;
}
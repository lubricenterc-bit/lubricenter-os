import { canMentionUsageForecast, confidenceForForecast, type VehicleOilForecast } from "./oil-forecast";

export type CrmStage = "NOT_READY" | "PREVENTIVE" | "DUE" | "LATE" | "RECOVERY" | "WINBACK";
export type CrmEventType = "SENT" | "REPLIED" | "BOOKED" | "DECLINED" | "CLOSED_NO_REPLY" | "REACTIVATED";
export type CrmPermission = "UNKNOWN" | "OPT_IN" | "OPT_OUT";
export type CrmJourneyStatus = "READY" | "NOT_READY" | "NEEDS_CONSENT" | "OPTED_OUT" |
  "ARCHIVED" | "NO_PHONE" | "SNOOZED" | "WAITING" | "CONTACTED" | "REPLIED" |
  "BOOKED" | "DECLINED" | "CLOSED_NO_REPLY" | "COMPLETED";
export type CrmMaintenanceEvent = {
  id:string; service_record_id:string; vehicle_id:string; customer_id:string;
  event_type:CrmEventType; stage:CrmStage|null;
  message_text:string|null; notes:string|null; recorded_at:string;
};
export type CrmContactPermission = {
  customer_id:string; status:"OPT_IN"|"OPT_OUT"; evidence:string; updated_at:string;
};
export type CrmVehicleReminder = VehicleOilForecast & {
  service_record_id:string; vehicle_id:string; customer_id:string|null;
  customer_name:string|null; customer_phone:string|null; plate:string|null;
  make:string|null; model:string|null; year:number|null;
  current_odometer:number|null; service_odometer:number|null; performed_at:string;
  next_service_odometer:number|null; next_service_date:string|null;
  reminder_status:"PENDING"|"SENT"|"SNOOZED"; snoozed_until:string|null;
  sent_at:string|null; urgency:string;
};
export type CrmJourney = {
  stage:CrmStage; daysFromDue:number; status:CrmJourneyStatus;
  contactCount:number; lastSentAt:string|null; nextAllowedAt:string|null;
  confirmedSent:boolean; priority:number;
};
export function caracasDay(now=new Date()) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/Caracas",day:"2-digit",month:"2-digit",year:"numeric"
  }).formatToParts(now);
  const get=(key:string)=>parts.find(p=>p.type===key)?.value||"01";
  return [get("year"),get("month"),get("day")].join("-");
}
export function calendarDayDelta(date:string,fromDay:string) {
  const a=Date.parse(date.slice(0,10)+"T12:00:00Z");
  const b=Date.parse(fromDay.slice(0,10)+"T12:00:00Z");
  return Number.isFinite(a)&&Number.isFinite(b)?Math.round((b-a)/86_400_000):NaN;
}
export function crmStage(days:number):CrmStage {
  if(!Number.isFinite(days)||days< -14)return "NOT_READY";
  if(days< -4)return "PREVENTIVE";
  if(days<=7)return "DUE";
  if(days<=30)return "LATE";
  if(days<=90)return "RECOVERY";
  return "WINBACK";
}
export const CRM_STAGE_LABEL:Record<CrmStage,string>={
  NOT_READY:"Próximo ciclo",PREVENTIVE:"Prevención",DUE:"Fecha de cambio",
  LATE:"Seguimiento cercano",RECOVERY:"Recuperación",WINBACK:"Reconexión"
};
export const CRM_STATUS_LABEL:Record<CrmJourneyStatus,string>={
  READY:"Listo para contactar",NOT_READY:"Todavía no corresponde",
  NEEDS_CONSENT:"Falta autorización",OPTED_OUT:"No contactar",
  ARCHIVED:"Histórico por revisar",NO_PHONE:"Falta WhatsApp",
  SNOOZED:"Contacto pospuesto",WAITING:"Esperar intervalo",
  CONTACTED:"Ya contactado en esta etapa",REPLIED:"Cliente respondió",
  BOOKED:"Visita acordada",DECLINED:"No desea agendar",
  CLOSED_NO_REPLY:"Sin respuesta · cerrado",
  COMPLETED:"Máximo de contactos alcanzado"
};
const PRIORITY:Record<CrmStage,number>={NOT_READY:0,PREVENTIVE:30,DUE:70,LATE:85,RECOVERY:100,WINBACK:60};
export function cleanCrmWhatsapp(value:string|null) {
  const digits=(value??"").replace(/\D/g,"");
  if(/^584\d{9}$/.test(digits))return digits;
  if(/^04\d{9}$/.test(digits))return "58"+digits.slice(1);
  if(/^4\d{9}$/.test(digits))return "58"+digits;
  return "";
}
function afterDays(iso:string,days:number){
  const n=Date.parse(iso);
  return Number.isFinite(n)?new Date(n+days*86_400_000).toISOString():null;
}
export function buildCrmJourney(
  row:CrmVehicleReminder, events:CrmMaintenanceEvent[],
  consent:CrmPermission, customerEvents:CrmMaintenanceEvent[],now=new Date()
):CrmJourney {
  const today=caracasDay(now),days=calendarDayDelta(row.next_service_date||"",today),stage=crmStage(days);
  const sent=events.filter(x=>x.event_type==="SENT").sort((a,b)=>b.recorded_at.localeCompare(a.recorded_at));
  const closedTypes:CrmEventType[]=["BOOKED","REPLIED","DECLINED","CLOSED_NO_REPLY"];
  const final=events.filter(e=>closedTypes.includes(e.event_type)).sort((a,b)=>b.recorded_at.localeCompare(a.recorded_at))[0];
  const customerSent=customerEvents.filter(e=>e.event_type==="SENT").sort((a,b)=>b.recorded_at.localeCompare(a.recorded_at))[0];
  let status:CrmJourneyStatus="READY",nextAllowedAt:string|null=null;
  if(consent==="OPT_OUT")status="OPTED_OUT";
  else if(final)status=final.event_type as CrmJourneyStatus;
  else if(sent.length>=3)status="COMPLETED";
  else if(row.reminder_status==="SENT"&&events.length===0)status="ARCHIVED";
  else if(consent!=="OPT_IN")status="NEEDS_CONSENT";
  else if(!cleanCrmWhatsapp(row.customer_phone))status="NO_PHONE";
  else if(row.reminder_status==="SNOOZED"&&row.snoozed_until&&row.snoozed_until>today){
    status="SNOOZED";nextAllowedAt=row.snoozed_until+"T12:00:00Z";
  } else if(stage==="NOT_READY")status="NOT_READY";
  else if(sent.some(e=>e.stage===stage))status="CONTACTED";
  else {
    const deadlines=[sent[0]?.recorded_at?afterDays(sent[0].recorded_at,10):null,
      customerSent?.recorded_at?afterDays(customerSent.recorded_at,14):null]
      .filter((x):x is string=>!!x).sort();
    const until=deadlines.at(-1)??null;
    if(until&&Date.parse(until)>now.getTime()){status="WAITING";nextAllowedAt=until;}
  }
  return {stage,daysFromDue:days,status,contactCount:sent.length,
    lastSentAt:sent[0]?.recorded_at??null,nextAllowedAt,confirmedSent:sent.length>0,
    priority:PRIORITY[stage]+Math.min(12,Math.max(0,days)/8)};
}
function firstName(name:string|null){
  const raw=(name??"").trim().split(/\s+/)[0].replace(/[^\p{L}\p{M}'-]/gu,"");
  return raw||"amigo";
}
function vehicleName(row:CrmVehicleReminder){
  return [row.make,row.model].filter(Boolean).join(" ").trim()||"vehículo";
}
function forecastContext(row:CrmVehicleReminder){
  if(canMentionUsageForecast(row)&&row.due_reason==="KM_USAGE"){
    if(["HIGH","MEDIUM"].includes(confidenceForForecast(row)))
      return "Por los cambios anteriores de este mismo carro, calculamos que podría acercarse al próximo mantenimiento.";
    return "Por su historial, tenemos una estimación inicial de cuándo podría acercarse al próximo mantenimiento.";
  }
  if(row.due_reason==="VISIT_PATTERN")
    return "Por las fechas de sus visitas anteriores, podría estar acercándose el momento del próximo cambio.";
  return "Por la fecha de su último servicio, es buen momento para revisar cuándo le corresponde el próximo cambio.";
}
export function makeCrmMessage(row:CrmVehicleReminder,journey:CrmJourney):string {
  const greeting="¡Hola, "+firstName(row.customer_name)+"! 👋 Soy del equipo de *Lubricenter Cabudare*.";
  const car="Te escribo por tu *"+vehicleName(row)+"*"+(row.plate?" (placa "+row.plate+")":"")+".";
  let content="",question="";
  if(journey.contactCount>=2) {
    content="Solo quería cerrar el seguimiento que dejamos pendiente sobre tu cambio de aceite. No queremos llenarte de mensajes. Si necesitas ayuda para organizarlo, aquí seguimos a la orden.";
    question="¿Prefieres que dejemos este seguimiento aquí por ahora?";
  } else if(journey.contactCount===1){
    content="Te escribimos hace unos días por el mantenimiento del carro. No sé si pudiste revisar el kilometraje. Si ya lo hiciste en otro lugar, ¡perfecto!";
    question="¿Quieres que te ayudemos con una cotización o prefieres retomarlo más adelante?";
  } else if(journey.stage==="PREVENTIVE"){
    content="Queríamos adelantarnos para que puedas organizar tu próximo cambio de aceite sin carreras. "+forecastContext(row);
  } else if(journey.stage==="DUE"){
    content="Estamos pendientes de tu próximo cambio de aceite. "+forecastContext(row);
  } else if(journey.stage==="LATE"){
    content="Hace un tiempo que teníamos previsto revisar el cambio de aceite de tu carro. No sabemos su kilometraje actual y preferimos confirmarlo contigo antes de recomendarte una fecha.";
  } else if(journey.stage==="RECOVERY"){
    content="Hace un buen tiempo que no te vemos por el taller y quería saber cómo te ha ido con el carro. ¿Sigues usando el mismo aceite o has cambiado tu rutina de manejo?";
  } else if(journey.stage==="WINBACK"){
    content="Hace tiempo que no nos visitas, y queríamos saber cómo te ha ido con el carro. ¿Todavía lo tienes contigo? Si te provoca retomar el mantenimiento con nosotros, con gusto te ayudamos.";
  } else {
    content="Queríamos ayudarte a tener presente su próximo mantenimiento.";
  }
  if(!question)question=journey.stage==="RECOVERY"||journey.stage==="WINBACK"
    ?"Si aún lo tienes, ¿qué kilometraje lleva? Con eso te orientamos sin compromiso."
    :"¿Me confirmas cuánto marca hoy el kilometraje? Así vemos si ya conviene hacerle el cambio o si todavía puede esperar.";
  return [
    greeting,"",car,"",content,"",question,"",
    "Si prefieres que no te enviemos estos recordatorios, solo dínoslo y lo dejamos registrado. 🧡"
  ].join("\n");
}
export function crmJourneySort(a:{journey:CrmJourney},b:{journey:CrmJourney}) {
  if(a.journey.status==="READY"&&b.journey.status!=="READY")return -1;
  if(b.journey.status==="READY"&&a.journey.status!=="READY")return 1;
  return b.journey.priority-a.journey.priority;
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { OsIcon } from "@/components/os-icon";
import { VehicleOilForecastCard } from "@/components/vehicle-oil-forecast-card";
import { supabase } from "@/lib/supabase";
import {
  CRM_STAGE_LABEL, CRM_STATUS_LABEL, buildCrmJourney, caracasDay,
  cleanCrmWhatsapp, crmJourneySort, makeCrmMessage,
  type CrmMaintenanceEvent, type CrmContactPermission,
  type CrmEventType, type CrmJourney, type CrmVehicleReminder
} from "@/lib/crm-retention";

type JourneyView="ACTION"|"RECOVERY"|"FOLLOWUP"|"CONSENT"|"ARCHIVED"|"ALL";
type WithJourney={reminder:CrmVehicleReminder;journey:CrmJourney;permission:string;events:CrmMaintenanceEvent[]};

function humanDate(iso:string|null) {
  if(!iso)return "Sin fecha";
  const n=new Date(iso.length<=10?iso+"T12:00:00":iso);
  return n.toLocaleDateString("es-VE",{day:"2-digit",month:"short",year:"numeric",timeZone:"America/Caracas"});
}
function serviceDescription(row:CrmVehicleReminder){
  return [row.make,row.model,row.year].filter(Boolean).join(" ")||"Vehículo";
}

export function MaintenanceJourneyScreen({
  reminders, onRefresh
}:{
  reminders:CrmVehicleReminder[];
  onRefresh:()=>void;
}){
  const [events,setEvents]=useState<CrmMaintenanceEvent[]>([]);
  const [permissions,setPermissions]=useState<Record<string,CrmContactPermission>>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [view,setView]=useState<JourneyView>("ACTION");
  const [query,setQuery]=useState("");
  const [displayCount,setDisplayCount]=useState(18);
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [opened,setOpened]=useState<Record<string,boolean>>({});
  const [editingPermission,setEditingPermission]=useState<string|null>(null);
  const [evidence,setEvidence]=useState("");
  const [busy,setBusy]=useState<string|null>(null);

  async function loadAudit(){
    setLoading(true);
    setError("");
    const [e,p]=await Promise.all([
      supabase.from("crm_maintenance_events")
        .select("id,service_record_id,vehicle_id,customer_id,event_type,stage,message_text,notes,recorded_at")
        .order("recorded_at",{ascending:false}).limit(3000),
      supabase.from("crm_contact_permissions")
        .select("customer_id,status,evidence,updated_at").limit(1500)
    ]);
    setLoading(false);
    if(e.error||p.error){
      setError((e.error||p.error)?.message||"No pudimos cargar la bitácora de CRM. No se permiten contactos sin verificar el historial.");
      return;
    }
    setEvents((e.data||[]) as CrmMaintenanceEvent[]);
    setPermissions(Object.fromEntries(((p.data||[]) as CrmContactPermission[]).map(x=>[x.customer_id,x])));
  }
  useEffect(()=>{void loadAudit();},[]);

  const rows=useMemo(()=>{
    const byService=new Map<string,CrmMaintenanceEvent[]>();
    const byCustomer=new Map<string,CrmMaintenanceEvent[]>();
    for(const item of events){
      byService.set(item.service_record_id,[...(byService.get(item.service_record_id)||[]),item]);
      byCustomer.set(item.customer_id,[...(byCustomer.get(item.customer_id)||[]),item]);
    }
    const now=new Date();
    return reminders.map(reminder=>{
      const cid=reminder.customer_id||"";
      const own=byService.get(reminder.service_record_id)||[];
      const permission=permissions[cid]?.status||"UNKNOWN";
      const journey=buildCrmJourney(reminder,own,permission,byCustomer.get(cid)||[],now);
      return {reminder,journey,permission,events:own} as WithJourney;
    }).sort(crmJourneySort);
  },[events,permissions,reminders]);

  const counts=useMemo(()=>({
    action:rows.filter(x=>x.journey.status==="READY").length,
    recovery:rows.filter(x=>["LATE","RECOVERY","WINBACK"].includes(x.journey.stage)&&
      !["BOOKED","OPTED_OUT","DECLINED","CLOSED_NO_REPLY","COMPLETED"].includes(x.journey.status)).length,
    following:rows.filter(x=>["CONTACTED","WAITING","REPLIED","BOOKED","SNOOZED"].includes(x.journey.status)).length,
    consent:rows.filter(x=>["NEEDS_CONSENT","NO_PHONE"].includes(x.journey.status)).length,
    archived:rows.filter(x=>x.journey.status==="ARCHIVED").length,
    responses:new Set(events.filter(x=>x.event_type==="REPLIED").map(x=>x.service_record_id)).size,
    booked:new Set(events.filter(x=>x.event_type==="BOOKED").map(x=>x.service_record_id)).size,
    actualSent:events.filter(x=>x.event_type==="SENT").length
  }),[rows,events]);

  const visible=useMemo(()=>{
    const q=query.trim().toLocaleLowerCase("es-VE");
    return rows.filter(({reminder:r,journey:j})=>{
      if(view==="ACTION"&&j.status!=="READY")return false;
      if(view==="RECOVERY"&&(!["LATE","RECOVERY","WINBACK"].includes(j.stage)||
        ["BOOKED","OPTED_OUT","DECLINED","CLOSED_NO_REPLY","COMPLETED"].includes(j.status)))return false;
      if(view==="FOLLOWUP"&&!["CONTACTED","WAITING","REPLIED","BOOKED","SNOOZED"].includes(j.status))return false;
      if(view==="CONSENT"&&!["NEEDS_CONSENT","NO_PHONE"].includes(j.status))return false;
      if(view==="ARCHIVED"&&j.status!=="ARCHIVED")return false;
      return !q||[r.customer_name,r.plate,r.customer_phone,r.make,r.model].filter(Boolean)
        .join(" ").toLocaleLowerCase("es-VE").includes(q);
    });
  },[rows,view,query]);

  async function changePermission(customerId:string,consent:"OPT_IN"|"OPT_OUT"){
    if(consent==="OPT_IN"&&evidence.trim().length<8){
      setError("Escribe cómo y cuándo el cliente autorizó recibir recordatorios (mínimo 8 caracteres).");
      return;
    }
    if(consent==="OPT_OUT"&&!window.confirm("¿Confirmas que este cliente no desea recibir recordatorios por WhatsApp? Se bloquearán todos sus vehículos."))return;
    setBusy(customerId);setError("");setNotice("");
    const {error:err}=await supabase.rpc("set_crm_contact_permission",{
      p_customer_id:customerId,p_status:consent,p_evidence:consent==="OPT_IN"?evidence.trim():"El cliente pidió no recibir mensajes"
    });
    setBusy(null);
    if(err){setError(err.message);return;}
    setEditingPermission(null);setEvidence("");
    setNotice(consent==="OPT_IN"?"Autorización registrada con su origen. Ahora puedes revisar los mensajes de este cliente.":
      "Cliente excluido de recordatorios. Se aplica a todos sus carros.");
    await loadAudit();
  }

  async function logActivity(row:WithJourney,eventType:CrmEventType){
    const {reminder:r,journey:j}=row;
    const message=drafts[r.service_record_id]??makeCrmMessage(r,j);
    if(eventType==="SENT"){
      if(!opened[r.service_record_id]){
        setError("Primero abre WhatsApp, envía el mensaje realmente y después confírmalo aquí.");
        return;
      }
      if(!window.confirm("¿Confirmas que ENVIASTE este WhatsApp al cliente? Abrir la conversación no significa enviarlo."))return;
    }
    if(eventType==="REACTIVATED" && !window.confirm(
      "Este registro figura como enviado por el sistema antiguo. ¿Verificaste el historial y la autorización del cliente para reactivar su seguimiento individual?"
    ))return;
    const key=r.service_record_id;
    setBusy(key);setError("");setNotice("");
    const {error:err}=await supabase.rpc("record_crm_maintenance_activity",{
      p_service_record_id:key,p_event_type:eventType,
      p_stage:eventType==="SENT"?j.stage:null,
      p_message_text:eventType==="SENT"?message:null,
      p_notes:null
    });
    setBusy(null);
    if(err){setError(err.message);return;}
    setOpened(prev=>({...prev,[key]:false}));
    const labels:Record<CrmEventType,string>={
      SENT:"Envío confirmado en la bitácora. El próximo contacto respetará el período de espera.",
      REPLIED:"Respuesta registrada. El caso sale de la secuencia automática de recordatorios.",
      BOOKED:"Visita acordada y registrada en CRM. Recuerda crear la orden cuando el vehículo llegue.",
      DECLINED:"Cliente marcado como no interesado en este ciclo.",
      CLOSED_NO_REPLY:"Secuencia cerrada sin respuesta. No insistiremos durante este ciclo.",
      REACTIVATED:"Registro histórico revisado y reactivado para atención manual."
    };
    setNotice(labels[eventType]);
    await loadAudit();onRefresh();
  }

  function openWhatsapp(row:WithJourney){
    const {reminder:r,journey:j}=row;
    if(j.status!=="READY" || row.permission!=="OPT_IN"){
      setError("Solo se puede abrir la secuencia cuando el cliente autorizó contacto y corresponde un mensaje.");
      return;
    }
    const phone=cleanCrmWhatsapp(r.customer_phone);
    if(!phone){setError("Este número no corresponde a un WhatsApp venezolano válido.");return;}
    const msg=drafts[r.service_record_id]??makeCrmMessage(r,j);
    const popup=window.open("https://wa.me/"+phone+"?text="+encodeURIComponent(msg),"_blank");
    if(popup)popup.opener=null;
    if(!popup){setError("El navegador bloqueó WhatsApp. Habilita la ventana emergente e inténtalo de nuevo.");return;}
    setOpened(prev=>({...prev,[r.service_record_id]:true}));
  }

  const tabs:{id:JourneyView,label:string,count:number}[]=[
    {id:"ACTION",label:"Contactar hoy",count:counts.action},
    {id:"RECOVERY",label:"Recuperar clientes",count:counts.recovery},
    {id:"FOLLOWUP",label:"En seguimiento",count:counts.following},
    {id:"CONSENT",label:"Verificar permiso",count:counts.consent},
    {id:"ARCHIVED",label:"Archivo anterior",count:counts.archived},
    {id:"ALL",label:"Todos",count:rows.length}
  ];

  return <section className="crmj">
    <header className="crmj-intro">
      <div><span className="crmj-eyebrow"><OsIcon name="clock" size={17}/> PLAN DE FIDELIZACIÓN · POR VEHÍCULO</span>
        <h2>Que vuelvan porque los cuidamos.</h2>
        <p>Una conversación útil, en el momento correcto. Cada carro tiene su calendario; cada cliente, un solo historial de contacto y la opción de no recibir mensajes.</p>
      </div>
      <button className="btn btn-ghost" onClick={()=>{void loadAudit();onRefresh()}}>Actualizar seguimiento</button>
    </header>

    <div className="crmj-metrics">
      <div><span>Para contactar</span><strong>{counts.action}</strong><small>Listos y autorizados</small></div>
      <div><span>Por recuperar</span><strong>{counts.recovery}</strong><small>Necesitan revisión comercial</small></div>
      <div><span>WhatsApp confirmados</span><strong>{counts.actualSent}</strong><small>Solo envíos registrados aquí</small></div>
      <div><span>Clientes que respondieron</span><strong>{counts.responses}</strong><small>Por ciclo de mantenimiento</small></div>
      <div><span>Visitas acordadas</span><strong>{counts.booked}</strong><small>Registradas por el equipo</small></div>
    </div>

    <div className="crmj-policy">
      <OsIcon name="shield" size={19}/>
      <div><strong>Contacto responsable y manual.</strong>
        <span>Exigimos autorización comprobada, máximo 3 mensajes por cambio, un solo mensaje por etapa y al menos 10 días entre contactos de un carro y 14 días entre mensajes a la misma persona. Abrir WhatsApp nunca registra el envío.</span></div>
    </div>
    {error&&<div className="error" role="alert">{error}</div>}
    {notice&&<div className="success" role="status">{notice}</div>}

    <div className="crmj-toolbar">
      <div className="crmj-tabs">{tabs.map(t=><button key={t.id} type="button"
        className={"crmj-tab"+(view===t.id?" is-active":"")} onClick={()=>{
          setView(t.id);setDisplayCount(18);
        }}>{t.label} <span>{t.count}</span></button>)}</div>
      <label className="crmj-search"><OsIcon name="search" size={17}/>
        <input type="search" value={query} onChange={e=>{setQuery(e.target.value);setDisplayCount(18);}}
          placeholder="Buscar cliente, placa, modelo o teléfono" aria-label="Buscar seguimiento"/></label>
    </div>

    {loading?<div className="card muted">Verificando permisos e historial de contacto…</div>:
      <div className="crmj-list">
        {visible.slice(0,displayCount).map(row=>{
          const r=row.reminder,j=row.journey,permission=row.permission,own=row.events;
          const draft=drafts[r.service_record_id]??makeCrmMessage(r,j);
          const latest=own.find(x=>x.event_type==="SENT");
          const canAct=j.status==="READY";
          const permissionOpen=editingPermission===r.customer_id;
          const isBusy=busy===r.service_record_id||busy===r.customer_id;
          return <article className="crmj-item" key={r.service_record_id}>
            <div className="crmj-item-top">
              <div className="crmj-client">
                <strong>{r.customer_name||"Cliente sin nombre"}</strong>
                <span>{serviceDescription(r)} · {r.plate||"Sin placa"} · {r.customer_phone||"Sin teléfono"}</span>
              </div>
              <div className="crmj-flags">
                <span className={"crmj-stage is-"+j.stage.toLowerCase()}>{CRM_STAGE_LABEL[j.stage]}</span>
                <span className={"crmj-status"+(canAct?" is-ready":"")}>{CRM_STATUS_LABEL[j.status]}</span>
              </div>
            </div>
            <div className="crmj-detail-strip">
              <span><small>Último cambio</small><strong>{humanDate(r.performed_at)}</strong></span>
              <span><small>Fecha recomendada</small><strong>{humanDate(r.next_service_date)}</strong></span>
              <span><small>Contactos confirmados</small><strong>{j.contactCount} de 3</strong></span>
              <span><small>Estado del cliente</small><strong>{permission==="OPT_IN"?"Autorizó recordatorios":permission==="OPT_OUT"?"No desea contacto":"Permiso no registrado"}</strong></span>
            </div>

            {j.status==="ARCHIVED"&&<div className="crmj-archive-warning">
              <OsIcon name="shield" size={17}/> Este servicio aparece como enviado en el sistema antiguo, pero no tenemos constancia del mensaje. No se recontacta automáticamente.
            </div>}

            {permission!=="OPT_IN"&&<div className="crmj-consent">
              <p>{permission==="OPT_OUT"?
                "Este cliente pidió no recibir mensajes. El bloqueo se aplica a todos sus vehículos.":
                "Para escribirle de forma proactiva, primero comprueba que aceptó recibir recordatorios de Lubricenter. Tener su teléfono guardado no demuestra autorización."}</p>
              {permissionOpen?
                <div className="crmj-consent-form">
                  <label>¿Cómo confirmó la autorización?
                    <input value={evidence} maxLength={400} onChange={e=>setEvidence(e.target.value)}
                      placeholder="Ej. Autorizó recordatorios en mostrador, 9/10/2026"/></label>
                  <button className="btn btn-primary" disabled={isBusy||evidence.trim().length<8||!r.customer_id}
                    onClick={()=>r.customer_id&&void changePermission(r.customer_id,"OPT_IN")}>Guardar autorización</button>
                  <button className="btn btn-ghost" onClick={()=>setEditingPermission(null)}>Cancelar</button>
                </div>
                :<button className="btn btn-ghost" onClick={()=>{setEditingPermission(r.customer_id);setEvidence("");}}>
                  {permission==="OPT_OUT"?"Registrar nueva autorización comprobada":"Registrar autorización"}
                </button>}
            </div>}

            {j.status==="ARCHIVED"&&permission==="OPT_IN"&&
              <button className="btn btn-ghost" disabled={isBusy}
                onClick={()=>void logActivity(row,"REACTIVATED")}>Revisé el histórico · activar recuperación manual</button>}

            {j.nextAllowedAt&&<p className="crmj-next">Próxima oportunidad de contacto: {humanDate(j.nextAllowedAt)}. No es necesario insistir antes.</p>}

            {canAct&&<div className="crmj-compose">
              <div className="crmj-compose-label">
                <strong>Mensaje personalizado para esta etapa</strong>
                <span>{j.contactCount===0?"Primer contacto":j.contactCount===1?"Segundo contacto":"Último contacto"} · Revisa y ajusta antes de enviarlo</span>
              </div>
              <textarea value={draft} rows={7} maxLength={1800}
                onChange={e=>setDrafts(d=>({...d,[r.service_record_id]:e.target.value}))}
                aria-label={"Mensaje WhatsApp de "+(r.customer_name||"cliente")}/>
              <div className="crmj-action-row">
                <button className="btn btn-primary" disabled={isBusy}
                  onClick={()=>openWhatsapp(row)}><OsIcon name="arrow" size={16}/> Abrir WhatsApp</button>
                <button className="btn" disabled={!opened[r.service_record_id]||isBusy}
                  onClick={()=>void logActivity(row,"SENT")}>Confirmar que lo envié</button>
                <span>Abrir el chat no marca el mensaje como enviado.</span>
              </div>
            </div>}

            {own.some(e=>e.event_type==="SENT")&&!own.some(e=>["BOOKED","DECLINED","CLOSED_NO_REPLY"].includes(e.event_type))&&
              <div className="crmj-outcomes">
                <strong>¿Qué ocurrió después del contacto?</strong>
                <div>
                  {!own.some(e=>e.event_type==="REPLIED")&&<button className="btn btn-ghost" disabled={isBusy}
                    onClick={()=>void logActivity(row,"REPLIED")}>Respondió</button>}
                  {!own.some(e=>e.event_type==="BOOKED")&&<button className="btn btn-ghost" disabled={isBusy}
                    onClick={()=>void logActivity(row,"BOOKED")}>Agendó visita</button>}
                  <button className="btn btn-ghost" disabled={isBusy}
                    onClick={()=>void logActivity(row,"DECLINED")}>No desea agendar</button>
                  {j.lastSentAt&&Date.now()-Date.parse(j.lastSentAt)>=14*86_400_000&&
                    <button className="btn btn-ghost" disabled={isBusy}
                      onClick={()=>void logActivity(row,"CLOSED_NO_REPLY")}>Cerrar sin respuesta</button>}
                </div>
              </div>}

            <div className="crmj-item-bottom">
              <details><summary>Ver cálculo por este vehículo</summary>
                <VehicleOilForecastCard compact forecast={{...r,recommended_due_date:r.next_service_date}}/>
              </details>
              <div className="crmj-links">
                <Link href={"/vehicles/"+r.vehicle_id}>Ver carro <OsIcon name="right" size={15}/></Link>
                {r.customer_id&&<Link href={"/customers/"+r.customer_id}>Ficha cliente <OsIcon name="right" size={15}/></Link>}
              </div>
              {permission==="OPT_IN"&&r.customer_id&&
                <button className="crmj-optout" disabled={isBusy}
                  onClick={()=>void changePermission(r.customer_id!,"OPT_OUT")}>No contactar a este cliente</button>}
            </div>
            {latest&&<small className="crmj-last-message">Último WhatsApp confirmado: {humanDate(latest.recorded_at)} · {CRM_STAGE_LABEL[latest.stage||"DUE"]}</small>}
          </article>;
        })}
        {!visible.length&&<div className="card muted">
          {view==="ACTION"?"No hay mensajes habilitados para enviar ahora. Revisa los permisos o la sección de recuperación.":
            "No hay clientes en esta vista. Puedes revisar otra etapa del seguimiento."}
        </div>}
        {visible.length>displayCount&&<button className="btn btn-ghost" onClick={()=>setDisplayCount(v=>v+18)}>
          Ver más clientes ({visible.length-displayCount} pendientes)
        </button>}
      </div>}
    <p className="crmj-footnote">
      Los contactos antiguos marcados por el corte de migración no se cuentan como WhatsApp reales.
      Las cifras de respuestas y citas muestran únicamente los eventos que el equipo registra a partir de este seguimiento.
      Nunca se envían mensajes automáticamente.
    </p>
  </section>;
}

'use client';

import {useEffect,useMemo,useState} from 'react';
import {supabase} from '@/lib/supabase';
import {CAMPAIGN_END} from '@/lib/campaign/oil-promo';

type CampaignStatus='PENDING'|'SENT'|'RESPONDED'|'SCHEDULED'|'VISITED'|'CONVERTED'|'NOT_INTERESTED';
type Contact={
  id:string;customerId:string;vehicleId:string|null;name:string;phone:string;vehicle:string;plate:string|null;
  kind:string;first:boolean;reason:string;message:string;url:string;status:CampaignStatus;
  sentAt:string|null;respondedAt:string|null;scheduledFor:string|null;visitedAt:string|null;convertedAt:string|null;
  convertedOrderId:string|null;note:string|null;
};
const labels:Record<CampaignStatus,string>={
  PENDING:'Pendiente',SENT:'Enviado',RESPONDED:'Respondió',SCHEDULED:'Agendó',VISITED:'Visitó',CONVERTED:'Compró',NOT_INTERESTED:'No interesado'
};
function RichMessage({text}:{text:string}) {
  return <div className="campaign-message">{text.split(/(\*[^*\n]+\*)/g).map((part,i)=>part.startsWith('*')&&part.endsWith('*')?<strong key={i}>{part.slice(1,-1)}</strong>:part)}</div>;
}
export function OilCampaign(){
  const [contacts,setContacts]=useState<Contact[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[group,setGroup]=useState('first'),[pending,setPending]=useState(false);
  const [asOf,setAsOf]=useState(''),[retry,setRetry]=useState(0),[notice,setNotice]=useState(''),[busyId,setBusyId]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let mounted=true;
    setLoading(true);setError('');setContacts([]);
    const subscription=supabase.auth.onAuthStateChange((_event,session)=>{if(!session&&mounted){controller.abort();setContacts([]);setError('Inicia sesión nuevamente.');}});
    async function load(){
      try{
        const session=await supabase.auth.getSession();
        if(!session.data.session)throw new Error('Inicia sesión para ver la lista.');
        const response=await fetch('/api/campaigns/oil-promo',{headers:{Authorization:`Bearer ${session.data.session.access_token}`},cache:'no-store',signal:controller.signal});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'No se pudo cargar la lista.');
        if(!mounted)return;
        setAsOf(data.asOf);setContacts(data.contacts);
      }catch(e){if(mounted&&!controller.signal.aborted)setError(e instanceof Error?e.message:'No se pudo cargar la lista.');}
      finally{if(mounted)setLoading(false);}
    }
    void load();
    return()=>{mounted=false;controller.abort();subscription.data.subscription.unsubscribe();};
  },[retry]);
  const expired=!!asOf&&asOf>CAMPAIGN_END;
  const visible=useMemo(()=>contacts.filter(c=>(group==='all'||group==='first'&&c.first||group===c.kind)&&(!pending||c.status==='PENDING')&&`${c.name} ${c.phone} ${c.vehicle} ${c.plate||''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())),[contacts,group,pending,search]);
  async function setStatus(contact:Contact,status:CampaignStatus){
    if(busyId)return;
    const previous=contact.status;
    setBusyId(contact.id);setError('');setNotice('');
    try{
      const session=await supabase.auth.getSession();
      if(!session.data.session)throw new Error('Tu sesión venció. Inicia sesión nuevamente.');
      const response=await fetch('/api/campaigns/oil-promo',{
        method:'PATCH',
        headers:{Authorization:`Bearer ${session.data.session.access_token}`,'Content-Type':'application/json'},
        body:JSON.stringify({contactId:contact.id,status}),
        cache:'no-store'
      });
      const text=await response.text();
      let data:any={};
      if(text){
        try{data=JSON.parse(text);}catch{throw new Error('Lubricenter OS recibió una respuesta inválida. El estado no se cambió.');}
      }
      if(!response.ok||!data?.ok||!data?.contact)throw new Error(data?.error||'No se pudo confirmar el cambio. El estado anterior se mantiene.');
      const saved=data.contact;
      setContacts(rows=>rows.map(x=>x.id===contact.id?{
        ...x,
        status:saved.status as CampaignStatus,
        sentAt:saved.sent_at??x.sentAt,
        respondedAt:saved.responded_at??x.respondedAt,
        scheduledFor:saved.scheduled_for??x.scheduledFor,
        visitedAt:saved.visited_at??x.visitedAt,
        convertedAt:saved.converted_at??x.convertedAt,
        convertedOrderId:saved.converted_order_id??x.convertedOrderId,
        note:saved.outcome_note??x.note
      }:x));
      setNotice(`${contact.name}: ${labels[saved.status as CampaignStatus]} guardado en la nube.`);
    }catch(e){
      setContacts(rows=>rows.map(x=>x.id===contact.id?{...x,status:previous}:x));
      setError(e instanceof Error?e.message:'No se pudo guardar el estado. La pantalla sigue disponible; intenta nuevamente.');
    }finally{
      setBusyId('');
    }
  }
  const sentCount=contacts.filter(c=>c.status!=='PENDING').length;
  const convertedCount=contacts.filter(c=>c.status==='CONVERTED').length;
  return <main className="container campaign">
    <header className="campaign-card">
      <p className="campaign-eyebrow">CRM · CAMPAÑA ACTIVA</p>
      <h1>Aceite + filtro + limpieza de inyectores gratis</h1>
      <p><strong>Piloto Cabudare · vigente hasta este sábado 10 de octubre de 2026.</strong></p>
      <p>Abre el mensaje de cada cliente y envíalo manualmente por WhatsApp. Después registra el resultado para que quede sincronizado entre teléfono y computadora.</p><p className="muted"><strong>Regla comercial:</strong> debe comprar aceite + filtro con nosotros. Internamente se cobran $5 por el servicio de cambio. No aplica Cashea. Lubricenter cubre los insumos normales; fallas o repuestos de inyectores van por cuenta del cliente. Vehículos complicados se cotizan aparte y mantienen la regla especial del 70% de descuento.</p>
      <p className="muted">Aplican condiciones según el vehículo. El envío sigue siendo manual; Lubricenter OS solo prepara el mensaje y registra el seguimiento.</p>
      {asOf&&<p className="muted">Consulta actualizada: {asOf.split('-').reverse().join('/')} · {contacts.length} contactos · {sentCount} gestionados · {convertedCount} compras registradas</p>}
      {expired&&<p className="error" role="alert">La promoción terminó. Los enlaces están desactivados para no enviar una fecha vencida.</p>}
    </header>
    {loading?<div className="campaign-card" role="status">Revisando clientes e historial…</div>:error?<div className="campaign-card"><p className="error" role="alert">{error}</p><button className="btn" onClick={()=>setRetry(x=>x+1)}>Intentar nuevamente</button></div>:<>
      <section className="campaign-controls" aria-label="Filtrar contactos">
        <label><span>Buscar cliente</span><input className="input" type="search" placeholder="Nombre, vehículo, placa o teléfono" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <label><span>Mostrar</span><select className="input" value={group} onChange={e=>setGroup(e.target.value)}><option value="first">Primera tanda</option><option value="all">Todos los candidatos</option><option value="reenganche">Reenganche</option><option value="mantenimiento">Mantenimiento</option></select></label>
        <label className="campaign-check"><input type="checkbox" checked={pending} onChange={e=>setPending(e.target.checked)}/> Solo pendientes</label>
        <p aria-live="polite">{visible.length} contactos visibles</p>
      </section>
      {notice&&<p className="success" role="status">{notice}</p>}
      {visible.length===0&&<div className="campaign-card">No hay contactos para este filtro.</div>}
      {visible.map(c=><article key={c.id} className={`campaign-card ${c.status!=='PENDING'?'campaign-done':''}`}>
        <div className="campaign-top"><div><p className="campaign-eyebrow">{c.first?'PRIMERA TANDA · ':''}{c.kind==='reenganche'?'REENGANCHE':'MANTENIMIENTO'}</p><h2>{c.name}</h2><p>{c.vehicle} · {c.plate||'Sin placa registrada'}<br/>+{c.phone}</p><span className={`pill ${c.status==='CONVERTED'?'ok':c.status==='PENDING'?'warn':''}`}>{labels[c.status]}</span></div>
          {!expired&&<a className="campaign-send" href={c.url} target="_blank" rel="noopener noreferrer">Abrir mensaje en WhatsApp ↗</a>}
        </div>
        <p className="muted">{c.reason}</p>
        <details><summary>Ver mensaje personalizado</summary><RichMessage text={c.message}/></details>
        <label><span className="label">Resultado del contacto</span><select className="input" value={c.status} disabled={busyId===c.id} onChange={e=>setStatus(c,e.target.value as CampaignStatus)}>
          <option value="PENDING">Pendiente</option><option value="SENT">Enviado</option><option value="RESPONDED">Respondió</option><option value="SCHEDULED">Agendó</option><option value="VISITED">Visitó</option><option value="CONVERTED">Compró</option><option value="NOT_INTERESTED">No interesado</option>
        </select></label>
        {busyId===c.id&&<p className="muted small">Guardando en la nube…</p>}
      </article>)}
      <p className="muted">Los estados se guardan ahora en Lubricenter OS y se sincronizan entre dispositivos. “Sin visita registrada” no confirma que el cliente no haya realizado mantenimiento en otro lugar.</p>
    </>}
  </main>;
}
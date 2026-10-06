'use client';

import {useEffect,useMemo,useState} from 'react';
import {supabase} from '@/lib/supabase';
import {CAMPAIGN_END,type Contact} from '@/lib/campaign/oil-promo';

function RichMessage({text}:{text:string}) {
  return <div className="campaign-message">{text.split(/(\*[^*\n]+\*)/g).map((part,i)=>part.startsWith('*')&&part.endsWith('*')?<strong key={i}>{part.slice(1,-1)}</strong>:part)}</div>;
}
export function OilCampaign(){
  const [contacts,setContacts]=useState<Contact[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[group,setGroup]=useState('first'),[pending,setPending]=useState(false);
  const [sent,setSent]=useState<Record<string,boolean>>({}),[storageKey,setStorageKey]=useState(''),[asOf,setAsOf]=useState('');
  const [retry,setRetry]=useState(0),[notice,setNotice]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let mounted=true;
    setLoading(true);setError('');setContacts([]);setSent({});setStorageKey('');
    const subscription=supabase.auth.onAuthStateChange((_event,session)=>{if(!session&&mounted){controller.abort();setContacts([]);setError('Inicia sesión nuevamente.');}});
    async function load(){
      try{
        const session=await supabase.auth.getSession();
        if(!session.data.session)throw new Error('Inicia sesión para ver la lista.');
        const response=await fetch('/api/campaigns/oil-promo',{headers:{Authorization:`Bearer ${session.data.session.access_token}`},cache:'no-store',signal:controller.signal});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'No se pudo cargar la lista.');
        if(!mounted)return;
        const key=`lubricenter-promo-inyectores-20261006-${data.userId}`;
        let saved:Record<string,boolean>={};
        try{const value=JSON.parse(localStorage.getItem(key)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))saved=value;}catch{}
        setStorageKey(key);setSent(saved);setAsOf(data.asOf);setContacts(data.contacts);
      }catch(e){if(mounted&&!controller.signal.aborted)setError(e instanceof Error?e.message:'No se pudo cargar la lista.');}
      finally{if(mounted)setLoading(false);}
    }
    void load();
    return()=>{mounted=false;controller.abort();subscription.data.subscription.unsubscribe();};
  },[retry]);
  const expired=!!asOf&&asOf>CAMPAIGN_END;
  const visible=useMemo(()=>contacts.filter(c=>(group==='all'||group==='first'&&c.first||group===c.kind)&&(!pending||!sent[c.customerId])&&`${c.name} ${c.phone} ${c.vehicle} ${c.plate||''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())),[contacts,group,pending,search,sent]);
  function mark(c:Contact,checked:boolean){
    const next={...sent,[c.customerId]:checked};setSent(next);
    try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{setNotice('La marca dura esta sesión; el navegador no permitió guardarla.');}
  }
  return <main className="container campaign">
    <header className="campaign-card">
      <p className="campaign-eyebrow">CAMPAÑA PRIVADA · MENSAJES MANUALES</p>
      <h1>Cambio de aceite + limpieza de inyectores</h1>
      <p><strong>Solo hasta este sábado 10 de octubre de 2026.</strong></p>
      <p>Abre el mensaje de cada cliente y pulsa <strong>Enviar</strong> en WhatsApp. Las negritas y emojis ya están preparados.</p>
      <p className="muted">Aplican condiciones según el vehículo. Esta lista no modifica el CRM ni envía mensajes automáticamente.</p>
      {asOf&&<p className="muted">Consulta actualizada: {asOf.split('-').reverse().join('/')} · {contacts.length} contactos distintos · {contacts.filter(c=>c.first).length} prioritarios</p>}
      {expired&&<p className="error" role="alert">La promoción terminó. Los enlaces están desactivados para no enviar una fecha vencida.</p>}
    </header>
    {loading?<div className="campaign-card" role="status">Revisando clientes e historial…</div>:error?<div className="campaign-card"><p className="error" role="alert">{error}</p><button className="btn" onClick={()=>setRetry(x=>x+1)}>Intentar nuevamente</button></div>:<>
      <section className="campaign-controls" aria-label="Filtrar contactos">
        <label><span>Buscar cliente</span><input className="input" type="search" placeholder="Nombre, vehículo, placa o teléfono" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <label><span>Mostrar</span><select className="input" value={group} onChange={e=>setGroup(e.target.value)}><option value="first">Primera tanda</option><option value="all">Todos los candidatos</option><option value="reenganche">Reenganche</option><option value="mantenimiento">Mantenimiento</option></select></label>
        <label className="campaign-check"><input type="checkbox" checked={pending} onChange={e=>setPending(e.target.checked)}/> Solo sin marcar como enviados</label>
        <p aria-live="polite">{visible.length} contactos visibles</p>
      </section>
      {notice&&<p role="status">{notice}</p>}
      {visible.length===0&&<div className="campaign-card">No hay contactos para este filtro.</div>}
      {visible.map(c=><article key={c.customerId} className={`campaign-card ${sent[c.customerId]?'campaign-done':''}`}>
        <div className="campaign-top"><div><p className="campaign-eyebrow">{c.first?'PRIMERA TANDA · ':''}{c.kind==='reenganche'?'REENGANCHE':'MANTENIMIENTO'}</p><h2>{c.name}</h2><p>{c.vehicle} · {c.plate||'Sin placa registrada'}<br/>+{c.phone}</p></div>
          {!expired&&<a className="campaign-send" href={c.url} target="_blank" rel="noopener noreferrer">Abrir mensaje en WhatsApp ↗</a>}
        </div>
        <p className="muted">{c.reason}</p>
        <details><summary>Ver mensaje personalizado</summary><RichMessage text={c.message}/></details>
        <label className="campaign-check"><input type="checkbox" checked={!!sent[c.customerId]} onChange={e=>mark(c,e.target.checked)}/> Ya lo envié (marcar manualmente)</label>
      </article>)}
      <p className="muted">Las marcas de envío se guardan solo en este navegador y cuenta; no se sincronizan entre teléfono y computadora. “Sin visita registrada” no confirma que el cliente no haya realizado mantenimiento en otro lugar.</p>
    </>}
  </main>;
}

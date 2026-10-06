'use client';

import Link from 'next/link';
import {useEffect,useMemo,useState} from 'react';
import {supabase} from '@/lib/supabase';

type CampaignStatus='PENDING'|'SENT'|'RESPONDED'|'SCHEDULED'|'VISITED'|'CONVERTED'|'NOT_INTERESTED';
type Campaign={name:string;slug:string;status:string;starts_on:string;ends_on:string|null;objective:string;description:string|null};
type Contact={status:CampaignStatus};

export default function CampaignsPage(){
  const [campaign,setCampaign]=useState<Campaign|null>(null);
  const [contacts,setContacts]=useState<Contact[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    let mounted=true;
    async function load(){
      try{
        const session=await supabase.auth.getSession();
        if(!session.data.session)throw new Error('Inicia sesión para ver campañas.');
        const response=await fetch('/api/campaigns/oil-promo',{headers:{Authorization:`Bearer ${session.data.session.access_token}`},cache:'no-store'});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'No se pudo cargar campañas.');
        if(mounted){setCampaign(data.campaign);setContacts(data.contacts);}
      }catch(e){if(mounted)setError(e instanceof Error?e.message:'No se pudo cargar campañas.');}
      finally{if(mounted)setLoading(false);}
    }
    void load();return()=>{mounted=false;};
  },[]);
  const stats=useMemo(()=>({
    total:contacts.length,
    pending:contacts.filter(c=>c.status==='PENDING').length,
    sent:contacts.filter(c=>c.status!=='PENDING').length,
    responded:contacts.filter(c=>['RESPONDED','SCHEDULED','VISITED','CONVERTED'].includes(c.status)).length,
    scheduled:contacts.filter(c=>c.status==='SCHEDULED').length,
    converted:contacts.filter(c=>c.status==='CONVERTED').length,
  }),[contacts]);
  return <main className="container stack">
    <section className="brand-hero">
      <div>
        <div className="eyebrow">CRM · CAMPAÑAS</div>
        <h1>Campañas</h1>
        <p>Contacta segmentos concretos, registra el resultado y mide qué promociones terminan generando visitas y ventas.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter"/>
    </section>
    {loading&&<div className="card">Cargando campañas…</div>}
    {error&&<div className="error">{error}</div>}
    {campaign&&<>
      <section className="grid grid-3">
        <div className="card"><div className="muted small">CANDIDATOS</div><div className="kpi">{stats.total}</div><div className="muted">{stats.pending} pendientes</div></div>
        <div className="card"><div className="muted small">GESTIONADOS</div><div className="kpi">{stats.sent}</div><div className="muted">{stats.responded} con respuesta o avance</div></div>
        <div className="card"><div className="muted small">COMPRAS REGISTRADAS</div><div className="kpi">{stats.converted}</div><div className="muted">{stats.scheduled} agendados ahora</div></div>
      </section>
      <article className="card stack">
        <div className="row-between">
          <div>
            <div className="row"><strong>{campaign.name}</strong><span className="pill ok">{campaign.status}</span></div>
            <div className="muted small">{campaign.starts_on} → {campaign.ends_on||'Sin fecha de cierre'} · objetivo {campaign.objective}</div>
          </div>
          <Link href="/promociones/aceite" className="btn btn-primary">Abrir campaña</Link>
        </div>
        {campaign.description&&<p>{campaign.description}</p>}
        <div className="muted small">Esta primera versión conserva el envío manual por WhatsApp. Los estados ya se guardan en Supabase y se ven desde cualquier dispositivo.</div>
      </article>
      <Link href="/reminders" className="btn btn-ghost">← Volver a Seguimiento</Link>
    </>}
  </main>;
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { parseBdv, type Preview } from '@/lib/finance/importers';
import { natures, type Nature } from '@/lib/finance/money';

type WeekAccount = {
  account_id: string; code: string; name: string; currency: 'USD'|'VES'; type: string;
  opening: number|string; closing: number|string|null; net: number|string; expected_closing: number|string;
  difference: number|string|null; source_id: string|null; source_name: string|null; imported: boolean;
  pending: number; conflicts: number; cash_days_due: number;
};
type WeekStatus = {
  id?: string; status: 'NEEDS_OPENING'|'OPEN'|'CLOSED'|'CLOSED_WITH_EXCEPTION';
  start: string; end: string; ready: boolean; accounts: WeekAccount[]; blockers: string[];
  cashea?: { imported: boolean; pending: number }; close_reason?: string|null; closed_at?: string|null;
};
type PendingRow = {
  id: string; account_id: string; account_name: string; occurred_at: string; reference: string;
  description: string; direction: 'IN'|'OUT'; currency: 'USD'|'VES'; amount: number|string; remaining: number|string;
  nature: Nature; category: string|null; category_id: string|null;
};
type Category = { id: string; name: string; nature: Nature };
type AccountRef = { id: string; code: string; name: string; currency: 'USD'|'VES' };
type PendingData = { total: number; rows: PendingRow[]; categories: Category[]; accounts: AccountRef[] };

const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
function monday(value = localDate()) {
  const d = new Date(`${value}T12:00:00-04:00`);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(d);
}
function money(value: number|string|null|undefined, currency: string) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  return currency === 'USD' ? `$${n.toFixed(2)}` : `Bs ${n.toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}
const outNatures: Nature[] = ['EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE'];
const inNatures: Nature[] = ['OWNER_CONTRIBUTION','OTHER_INCOME','INTERNAL_TRANSFER','REFUND'];

export default function WeeklyReconciliationPage() {
  const [week, setWeek] = useState(monday());
  const [status, setStatus] = useState<WeekStatus|null>(null);
  const [pending, setPending] = useState<PendingData>({ total:0, rows:[], categories:[], accounts:[] });
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [openings,setOpenings] = useState<Record<string,string>>({BDV:'',BNC:'',CASH_USD:'',CASH_VES:''});
  const [closings,setClosings] = useState<Record<string,string>>({});
  const [bdvText,setBdvText] = useState(''), [bdvPreview,setBdvPreview] = useState<Preview|null>(null);
  const today = localDate();

  async function load() {
    setError('');
    const reconcile = await supabase.rpc('finance_reconcile');
    if (reconcile.error && !String(reconcile.error.message).includes('administrador')) throw reconcile.error;
    const s = await supabase.rpc('finance_week_status',{p_start:week});
    if (s.error) throw s.error;
    const next = s.data as WeekStatus;
    setStatus(next);
    if (next.status !== 'NEEDS_OPENING') {
      const p = await supabase.rpc('finance_week_pending',{p_start:week,p_offset:0});
      if (p.error) throw p.error;
      setPending(p.data as PendingData);
      setClosings(Object.fromEntries(next.accounts.map(a=>[a.account_id,a.closing === null ? '' : String(a.closing)])));
    } else {
      setPending({total:0,rows:[],categories:[],accounts:[]});
    }
  }
  useEffect(()=>{load().catch(e=>setError(e.message));},[week]);

  async function run(fn:()=>Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await load(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function openWeek() {
    const values = Object.fromEntries(Object.entries(openings).map(([k,v])=>[k,Number(v)]));
    if (Object.values(openings).some(v=>v.trim()==='' || !Number.isFinite(Number(v)) || Number(v)<0)) throw new Error('Escribe los cuatro saldos iniciales.');
    const r=await supabase.rpc('finance_week_open',{p_start:week,p_openings:values});
    if(r.error) throw r.error;
    setNotice('Semana financiera abierta. Desde aquí cada diferencia debe quedar explicada.');
  }

  async function saveClosings() {
    if(!status) return;
    for(const a of status.accounts) {
      const raw=closings[a.account_id];
      if(raw===undefined || raw.trim()==='' || !Number.isFinite(Number(raw)) || Number(raw)<0) throw new Error(`Falta saldo final de ${a.name}`);
      const r=await supabase.rpc('finance_week_set_closing',{p_start:week,p_account_id:a.account_id,p_closing:Number(raw)});
      if(r.error) throw r.error;
    }
    setNotice('Saldos finales guardados.');
  }

  async function importBdv() {
    if(!status) return;
    const account=status.accounts.find(a=>a.code==='BDV');
    if(!account?.source_id) throw new Error('La fuente BDV no está configurada.');
    const preview=bdvPreview ?? parseBdv(bdvText);
    if(preview.errors.length) throw new Error(preview.errors.slice(0,3).map(x=>`fila ${x.row}: ${x.message}`).join(' · '));
    const r=await supabase.rpc('finance_import',{
      p_source_id:account.source_id,p_name:`BDV ${status.start} a ${status.end}`,
      p_from:status.start,p_to:status.end,p_preview:preview
    });
    if(r.error) throw r.error;
    const rr=await supabase.rpc('finance_reconcile'); if(rr.error) throw rr.error;
    setBdvText(''); setBdvPreview(null); setNotice('BDV importado y conciliado automáticamente.');
  }

  const finished = !!status && today > status.end;
  const first = pending.rows[0];

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">CUADRE OBLIGATORIO</div><h1>Conciliación semanal</h1><p>Lunes a domingo. Explica lo que el sistema no pueda resolver y no repitas el gasto en otro módulo.</p></div>
      <Link className="btn" href="/finance/inbox">Herramientas avanzadas</Link>
    </section>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}

    <section className="card row-between">
      <div><strong>Semana</strong><div className="muted small">{status ? `${status.start} → ${status.end}` : week}</div></div>
      <input className="input" type="date" value={week} onChange={e=>setWeek(monday(e.target.value))} />
    </section>

    {status?.status==='NEEDS_OPENING' && <OpenWeek openings={openings} setOpenings={setOpenings} busy={busy} onOpen={()=>run(openWeek)} week={week} today={today} />}

    {status && status.status!=='NEEDS_OPENING' && <>
      <section className="card stack">
        <div className="row-between"><div><h2 className="section-title">Estado del cuadre</h2><p className="muted small">Una semana solo queda cerrada cuando bancos, Cashea y efectivo tienen explicación.</p></div>
          <span className={status.status==='OPEN' ? (status.ready?'pill ok':'pill') : 'pill ok'}>{status.status==='OPEN' ? (status.ready?'LISTA PARA CERRAR':'POR CUADRAR') : status.status}</span>
        </div>
        <div className="grid grid-2">{status.accounts.map(a=><div className="finance-account" key={a.account_id}><div className="row-between"><strong>{a.name}</strong><span className="pill">{a.currency}</span></div><div className="muted small">Inicial {money(a.opening,a.currency)} · Movimiento {money(a.net,a.currency)}</div><div>Esperado: <strong>{money(a.expected_closing,a.currency)}</strong></div><div>Real: <strong>{money(a.closing,a.currency)}</strong></div>{a.difference!==null && <div className="muted small">Diferencia {money(a.difference,a.currency)}</div>}<div className="muted small">{a.type==='BANK' ? (a.imported?'Reporte semanal importado':'Falta reporte semanal') : (a.cash_days_due?`${a.cash_days_due} día(s) de caja pendientes`:'Caja al día')}</div></div>)}</div>
        {!!status.blockers.length && <div className="finance-warning card"><strong>Antes de cerrar:</strong>{status.blockers.map((b,i)=><div key={i}>• {b}</div>)}</div>}
      </section>

      {status.status==='OPEN' && finished && <section className="card stack">
        <h2 className="section-title">1 · Traer BDV</h2>
        <p>Copia la tabla completa de “Movimientos en línea”. El parser valida fecha, referencia, tipo, monto y cadena de saldos antes de importar.</p>
        <textarea className="textarea" rows={8} value={bdvText} onChange={e=>{setBdvText(e.target.value);setBdvPreview(null);}} placeholder="Fecha · Referencia · Descripción · Débito / Crédito · Monto · Saldo" />
        <div className="row">
          <button className="btn" disabled={busy||!bdvText.trim()} onClick={()=>{try{setBdvPreview(parseBdv(bdvText));}catch(e){setError((e as Error).message)}}}>Validar</button>
          {bdvPreview && <span className={bdvPreview.errors.length?'pill':'pill ok'}>{bdvPreview.rows.length} movimientos · {bdvPreview.errors.length} errores · {bdvPreview.duplicates} duplicados omitidos</span>}
        </div>
        {bdvPreview && !!bdvPreview.errors.length && <div className="error">{bdvPreview.errors.slice(0,5).map(e=>`fila ${e.row}: ${e.message}`).join(' · ')}</div>}
        <button className="btn btn-primary" disabled={busy||!bdvPreview||!!bdvPreview.errors.length} onClick={()=>run(importBdv)}>Importar y conciliar BDV</button>
        <div className="muted small">BNC y Cashea se mantienen en Herramientas avanzadas mientras terminamos su adaptador semanal.</div>
      </section>}

      {status.status==='OPEN' && first && <Classifier key={first.id} row={first} data={pending} busy={busy} run={run} />}
      {status.status==='OPEN' && !first && <section className="card"><strong>✓ No quedan movimientos bancarios importados por explicar en esta semana.</strong></section>}

      {status.status==='OPEN' && finished && <section className="card stack">
        <h2 className="section-title">3 · Saldos finales</h2>
        <p>Escribe el saldo real actual de las cuatro cuentas. Si falta una operación importada, el saldo esperado no va a cuadrar.</p>
        <div className="grid grid-2">{status.accounts.map(a=><label key={a.account_id}>{a.name} · {a.currency}<input className="input" inputMode="decimal" value={closings[a.account_id]??''} onChange={e=>setClosings(v=>({...v,[a.account_id]:e.target.value}))} /></label>)}</div>
        <button className="btn" disabled={busy} onClick={()=>run(saveClosings)}>Guardar saldos finales</button>
        <div className="row">
          <button className="btn btn-primary" disabled={busy||!status.ready} onClick={()=>run(async()=>{const r=await supabase.rpc('finance_week_close',{p_start:week,p_force:false,p_reason:null});if(r.error)throw r.error;setNotice('Semana cerrada y cuadrada.');})}>Cerrar semana cuadrada</button>
          <Link className="btn" href="/cash-close">Revisar caja diaria</Link>
        </div>
        {!status.ready && <ForceClose week={week} busy={busy} run={run} />}
      </section>}
    </>}
  </main>;
}

function OpenWeek({openings,setOpenings,busy,onOpen,week,today}:{openings:Record<string,string>;setOpenings:React.Dispatch<React.SetStateAction<Record<string,string>>>;busy:boolean;onOpen:()=>void;week:string;today:string}) {
  const labels:Record<string,string>={BDV:'BDV central · Bs',BNC:'BNC Cashea · Bs',CASH_USD:'Caja USD · $',CASH_VES:'Caja Bs'};
  return <section className="card stack"><h2>Primera apertura</h2><p>Este es el punto cero. Después de la primera semana, el cierre anterior alimenta automáticamente la siguiente apertura.</p><div className="grid grid-2">{Object.entries(labels).map(([code,label])=><label key={code}>{label}<input className="input" inputMode="decimal" value={openings[code]??''} onChange={e=>setOpenings(v=>({...v,[code]:e.target.value}))} /></label>)}</div><button className="btn btn-primary" disabled={busy||week>today} onClick={onOpen}>{week>today?'Disponible el lunes':'Abrir semana financiera'}</button></section>;
}

function Classifier({row,data,busy,run}:{row:PendingRow;data:PendingData;busy:boolean;run:(f:()=>Promise<void>)=>void}) {
  const choices=row.direction==='OUT'?outNatures:inNatures;
  const [nature,setNature]=useState<Nature>(choices[0]);
  const [category,setCategory]=useState('');
  const [newCategory,setNewCategory]=useState('');
  const [target,setTarget]=useState('');
  const [saveRule,setSaveRule]=useState(false);
  const [note,setNote]=useState('');
  const categories=useMemo(()=>data.categories.filter(c=>c.nature===nature),[data.categories,nature]);
  useEffect(()=>{setCategory(categories[0]?.id??'');setTarget('');setSaveRule(false);},[nature,row.id]);

  async function createCategory() {
    if(!newCategory.trim()) throw new Error('Escribe el nombre de la categoría.');
    const r=await supabase.rpc('finance_category_upsert',{p_name:newCategory.trim(),p_nature:nature});
    if(r.error) throw r.error;
    setNewCategory('');
  }
  async function classify() {
    if(!['INTERNAL_TRANSFER','REFUND'].includes(nature) && !category) throw new Error('Selecciona o crea una categoría.');
    if(nature==='INTERNAL_TRANSFER' && !target) throw new Error('Selecciona la otra cuenta.');
    const r=await supabase.rpc('finance_classify_external',{p_id:row.id,p_data:{
      nature,category_id:category||null,target_account_id:target||null,save_rule:saveRule,note:note||null
    }});
    if(r.error) throw r.error;
  }

  return <section className="card stack">
    <div className="row-between"><div><div className="eyebrow">2 · POR CUADRAR · {data.total} PENDIENTE(S)</div><h2>{row.direction==='OUT'?'Salida':'Entrada'} · {money(row.amount,row.currency)}</h2></div><span className="pill">{row.account_name}</span></div>
    <div><strong>{row.description}</strong><div className="muted small">{new Date(row.occurred_at).toLocaleString('es-VE')} · Ref. {row.reference}</div></div>
    <label>¿Qué fue?<select className="select" value={nature} onChange={e=>setNature(e.target.value as Nature)}>{choices.map(n=><option key={n} value={n}>{natures[n]}</option>)}</select></label>
    {!['INTERNAL_TRANSFER','REFUND'].includes(nature) && <>
      <label>Categoría<select className="select" value={category} onChange={e=>setCategory(e.target.value)}><option value="">Selecciona…</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <div className="row"><input className="input" value={newCategory} onChange={e=>setNewCategory(e.target.value)} placeholder="Nueva categoría: Papá, Casa, Internet…" /><button className="btn" disabled={busy||!newCategory.trim()} onClick={()=>run(createCategory)}>+ Crear</button></div>
    </>}
    {nature==='INTERNAL_TRANSFER' && <label>Otra cuenta<select className="select" value={target} onChange={e=>setTarget(e.target.value)}><option value="">Selecciona…</option>{data.accounts.filter(a=>a.id!==row.account_id&&a.currency===row.currency).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    <label>Nota opcional<input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Solo si hace falta explicar algo" /></label>
    {row.direction==='OUT' && ['EXPENSE','BANK_FEE'].includes(nature) && <label className="row"><input type="checkbox" checked={saveRule} onChange={e=>setSaveRule(e.target.checked)} />Recordar esta descripción para próximas semanas</label>}
    <button className="btn btn-primary" disabled={busy} onClick={()=>run(classify)}>Guardar y siguiente</button>
    <p className="muted small">Esta acción registra o enlaza el movimiento interno y lo concilia. No debes volver a cargar el gasto.</p>
  </section>;
}

function ForceClose({week,busy,run}:{week:string;busy:boolean;run:(f:()=>Promise<void>)=>void}) {
  const [reason,setReason]=useState('');
  return <details><summary>Cierre excepcional del dueño</summary><div className="stack"><p>Solo úsalo si conscientemente aceptas una diferencia. El motivo queda auditado.</p><textarea className="textarea" value={reason} onChange={e=>setReason(e.target.value)} /><button className="btn" disabled={busy||reason.trim().length<10} onClick={()=>run(async()=>{const r=await supabase.rpc('finance_week_close',{p_start:week,p_force:true,p_reason:reason});if(r.error)throw r.error;})}>Cerrar con excepción</button></div></details>;
}

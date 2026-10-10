'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { parseBdv, type Preview } from '@/lib/finance/importers';
import { natures, type Nature } from '@/lib/finance/money';

type OutflowNature = Extract<Nature,
 'EXPENSE'|'INVENTORY_PURCHASE'|'ASSET_PURCHASE'|'SUPPLIER_PAYMENT'|'OWNER_DRAW'|'PAYROLL'|'INTERNAL_TRANSFER'|'REFUND'|'TAX'|'BANK_FEE'>;
type Outflow = {
 id:string; occurred_at:string; reference:string; description:string; amount:string; currency:string;
 nature:string; category:string|null; category_id:string|null; ownership_status:string; classification_reason:string|null;
 allocated:boolean;
};
type Category = { id:string; name:string; nature:string };
type Account = { id:string; name:string; code:string; currency:string };
type Source = { id:string; name:string };
type Queue = {total:number;pending:number;rows:Outflow[];categories:Category[];accounts:Account[];sources:Source[]};
const types:OutflowNature[] = [
 'EXPENSE','INVENTORY_PURCHASE','SUPPLIER_PAYMENT','PAYROLL','BANK_FEE',
 'INTERNAL_TRANSFER','OWNER_DRAW','ASSET_PURCHASE','TAX','REFUND'
];
function localToday():string {
 return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function monday(date:string):string {
 const d=new Date(date+'T12:00:00-04:00'); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
 return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function ves(value:string|number):string { return Number(value).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function dateCaracas(value:string):string {
 return new Date(value).toLocaleString('es-VE',{timeZone:'America/Caracas',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
}

export default function BankOutflowsPage() {
 const today=localToday();
 const [from,setFrom]=useState(monday(today)),[to,setTo]=useState(today);
 const [offset,setOffset]=useState(0),[queue,setQueue]=useState<Queue|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [bankText,setBankText]=useState(''),[preview,setPreview]=useState<Preview|null>(null);
 const [acknowledged,setAcknowledged]=useState(false),[filter,setFilter]=useState<'pending'|'all'|'classified'>('pending');
 const [selected,setSelected]=useState<string|null>(null),[nature,setNature]=useState<OutflowNature|''>('');
 const [categoryId,setCategoryId]=useState(''),[newCategory,setNewCategory]=useState('');
 const [target,setTarget]=useState(''),[note,setNote]=useState(''),[saveRule,setSaveRule]=useState(false);
 const current=useMemo(()=>queue?.rows.find(x=>x.id===selected)||null,[queue,selected]);
 const categories=useMemo(()=>queue?.categories.filter(x=>x.nature===nature)??[],[queue,nature]);

 const load=useCallback(async()=>{
  if(from>to) throw Error('El período no puede terminar antes de empezar.');
  const r=await supabase.rpc('finance_bank_outflows_review',{p_from:from,p_to:to,p_offset:offset});
  if(r.error)throw r.error;
  setQueue(r.data as Queue);
 },[from,to,offset]);
 useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
 async function run(action:()=>Promise<void>) {
  if(busy)return;setBusy(true);setError('');setNotice('');
  try{await action();await load();}catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 function select(x:Outflow){
  setSelected(x.id);
  setNature(types.includes(x.nature as OutflowNature)?x.nature as OutflowNature:'');
  setCategoryId(x.category_id||'');setNote('');setTarget('');setNewCategory('');setSaveRule(false);
 }
 async function importMovements() {
  if(!queue?.sources?.[0])throw Error('La fuente BDV no está configurada en Finance Core.');
  const p=preview||parseBdv(bankText);
  if(p.errors.length)throw Error('Corrige los errores de lectura del reporte antes de importar.');
  if(!p.rows.length||!p.observed_from||!p.observed_to)throw Error('No hay movimientos para importar.');
  if(!p.balance_chain&&!acknowledged)throw Error('El extracto presenta saltos de saldo. Confirma primero que comprendes la cobertura.');
  const result=await supabase.rpc('finance_import',{
    p_source_id:queue.sources[0].id,p_name:'BDV · clasificación progresiva '+p.observed_from+' a '+p.observed_to,
    p_from:p.observed_from,p_to:p.observed_to,p_preview:p
  });
  if(result.error)throw result.error;
  const reconciled=await supabase.rpc('finance_reconcile');
  if(reconciled.error)throw reconciled.error;
  setFrom(p.observed_from);setTo(p.observed_to);setOffset(0);
  setBankText('');setPreview(null);setAcknowledged(false);
  setNotice('Extracto guardado: no se duplicaron movimientos existentes. Las salidas pueden categorizarse por separado.');
 }
 async function createCategory() {
  if(!nature||!newCategory.trim())throw Error('Selecciona la naturaleza y escribe un nombre de categoría.');
  const result=await supabase.rpc('finance_category_upsert',{p_name:newCategory.trim(),p_nature:nature});
  if(result.error)throw result.error;
  setNewCategory('');
  setNotice('Categoría disponible para los egresos de esta naturaleza.');
 }
 async function classify() {
  if(!current||!nature)throw Error('Selecciona un tipo de movimiento.');
  if(current.allocated)throw Error('Este movimiento ya está conciliado. Abre la revisión avanzada si necesita rectificación.');
  if(nature!=='INTERNAL_TRANSFER'&&nature!=='REFUND'&&!categoryId)throw Error('Selecciona una categoría.');
  if(nature==='INTERNAL_TRANSFER'&&!target)throw Error('Selecciona la cuenta de destino.');
  if(current.ownership_status!=='OWN')throw Error('Primero debes resolver la propiedad del movimiento.');
  if(nature==='INTERNAL_TRANSFER'&&/INTERV.*DOLAR|COMPRA.*DOLAR|INTERV.*CAMB/i.test(current.description)) {
    throw Error('Una compra de dólares es un cambio de moneda, no un traspaso Bs→Bs. Déjala en revisión hasta registrar la contrapartida USD.');
  }
  const result=await supabase.rpc('finance_classify_external',{p_id:current.id,p_data:{
    nature,category_id:categoryId||null,target_account_id:target||null,
    note:note.trim()||null,save_rule:saveRule
  }});
  if(result.error)throw result.error;
  setSelected(null);setNotice('Egreso clasificado y conciliado. La evidencia bancaria se conserva; no vuelvas a registrar el gasto.');
 }
 const rows=(queue?.rows||[]).filter(x=>filter==='all'||(filter==='pending'?x.nature==='UNCLASSIFIED':x.nature!=='UNCLASSIFIED'));
 const pageTotal=Math.ceil((queue?.total||0)/100);
 return <main className="container stack">
  <section className="brand-hero">
   <div><div className="eyebrow">FINANZAS · BANCO DE VENEZUELA</div><h1>Egresos bancarios</h1>
    <p>Importa el extracto una vez. Clasifica pagos, comisiones, compras y transferencias a tu ritmo; el progreso queda guardado, aunque todavía no abras el cierre semanal.</p></div>
   <Link className="btn" href="/finance">Volver a finanzas</Link>
  </section>
  {error&&<div role="alert" className="error">{error}</div>}
  {notice&&<div role="status" className="success">{notice}</div>}
  <section className="card stack">
   <h2 className="section-title">1 · Importar movimientos del BDV</h2>
   <p className="muted small">Pega la tabla de seis columnas del Banco de Venezuela: Fecha, Referencia, Descripción, Débito/Crédito, Monto y Saldo. Se guardan entradas y salidas, pero esta vista muestra los egresos. Los importes y saldos del banco nunca se alteran.</p>
   <textarea className="textarea" rows={7} value={bankText} onChange={e=>{setBankText(e.target.value);setPreview(null);setAcknowledged(false);}} placeholder={"Fecha\nReferencia\nDescripción\nDébito / Crédito\nMonto\nSaldo\n10-10-2026 - 08:36\n0027220815852\nCOMISION PAGOMOVILBDV\nDEBITO\n-14,00\n465.982,66"}/>
   <div className="row">
    <button className="btn" disabled={!bankText.trim()||busy} onClick={()=>{const p=parseBdv(bankText);setPreview(p);setError('');}}>Validar extracto</button>
    {preview&&<span className={preview.errors.length?'pill':'pill ok'}>{preview.rows.length} movimientos · {preview.rows.filter(x=>x.direction==='OUT').length} egresos · {preview.duplicates} repetidos omitidos</span>}
   </div>
   {preview&&<>
    <p className="small muted">Cobertura detectada: {preview.observed_from||'—'} → {preview.observed_to||'—'} · Cadena de saldos {preview.balance_chain?'correcta':'con saltos o errores'}.</p>
    {preview.errors.length>0&&<div className="error">{preview.errors.slice(0,5).map(x=><div key={x.row}>Fila {x.row}: {x.message}</div>)}</div>}
    {preview.warnings.length>0&&<div className="finance-warning"><strong>Revisa el extracto:</strong> {preview.warnings.length} advertencia(s). No afirmamos que esté completo solo porque cuadren los saldos.</div>}
    {!preview.balance_chain&&!preview.errors.length&&<label className="row"><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/>Entiendo que puede faltar una página o existir un corte parcial y lo completaré después.</label>}
    <button className="btn btn-primary" disabled={busy||!!preview.errors.length||(!preview.balance_chain&&!acknowledged)} onClick={()=>run(importMovements)}>{busy?'Importando…':'Importar sin duplicar'}</button>
   </>}
  </section>
  <section className="card stack">
   <div className="row-between"><div><h2 className="section-title">2 · Clasificar egresos</h2><p className="muted small">Puedes hacerlo durante varios días; no requiere registrar hoy el saldo inicial.</p></div><Link href="/finance/inbox" className="btn btn-ghost">Revisión avanzada</Link></div>
   <div className="grid grid-3">
    <div><div className="muted small">Egresos importados</div><div className="money-lg">{queue?.total??'—'}</div></div>
    <div><div className="muted small">Sin clasificar</div><div className="money-lg">{queue?.pending??'—'}</div></div>
    <div><div className="muted small">Con naturaleza definida</div><div className="money-lg">{queue?queue.total-queue.pending:'—'}</div></div>
   </div>
   <div className="grid grid-2">
    <label><span className="label">Desde</span><input className="input" type="date" value={from} onChange={e=>{setFrom(e.target.value);setOffset(0);setSelected(null);}}/></label>
    <label><span className="label">Hasta</span><input className="input" type="date" value={to} onChange={e=>{setTo(e.target.value);setOffset(0);setSelected(null);}}/></label>
   </div>
   <div className="row">
    <button className={`btn ${filter==='pending'?'btn-primary':''}`} onClick={()=>setFilter('pending')}>Pendientes</button>
    <button className={`btn ${filter==='all'?'btn-primary':''}`} onClick={()=>setFilter('all')}>Todos</button>
    <button className={`btn ${filter==='classified'?'btn-primary':''}`} onClick={()=>setFilter('classified')}>Clasificados</button>
   </div>
   {!queue&&<p className="muted">Consultando egresos…</p>}
   {queue&&rows.length===0&&<p className="muted">No hay egresos para este filtro en la página actual.</p>}
   {rows.map(x=><div className="order-item stack" key={x.id}>
    <div className="row-between"><div><strong>Bs. {ves(x.amount)}</strong><span className="muted small"> · {dateCaracas(x.occurred_at)}</span></div><span className={x.nature==='UNCLASSIFIED'?'pill':'pill ok'}>{x.nature==='UNCLASSIFIED'?'Sin clasificar':'Clasificado'}</span></div>
    <div>{x.description}</div>
    <div className="row-between"><span className="muted small">Ref. {x.reference} {x.category?'· '+x.category:''}</span><button className="btn" onClick={()=>select(x)}>{x.allocated?'Ver':'Categorizar'}</button></div>
   </div>)}
   {pageTotal>1&&<div className="row-between"><button className="btn" disabled={!offset} onClick={()=>{setOffset(v=>Math.max(0,v-100));setSelected(null);}}>Anterior</button><span className="muted small">Página {Math.floor(offset/100)+1} de {pageTotal}</span><button className="btn" disabled={offset+100>=(queue?.total??0)} onClick={()=>{setOffset(v=>v+100);setSelected(null);}}>Siguiente</button></div>}
  </section>
  {current&&<section className="card stack">
   <div className="row-between"><h2 className="section-title">3 · Revisar egreso · Bs. {ves(current.amount)}</h2><button className="btn" onClick={()=>setSelected(null)}>Cerrar</button></div>
   <p className="muted small">{dateCaracas(current.occurred_at)} · {current.description} · {current.reference}</p>
   {current.allocated?<p>Este egreso ya está conciliado. Si necesitas corregirlo, utiliza Revisión avanzada para conservar la historia del movimiento.</p>:<>
    {/\b(DOLAR|USD|INTERVENCION)\b/i.test(current.description)&&<div className="finance-warning">Posible compra de divisas: no la marques como gasto. Una conversión entre Bs y USD requiere registrar ambas partes de la operación.</div>}
    <label><span className="label">¿Qué tipo de salida fue?</span><select className="select" value={nature} onChange={e=>{setNature(e.target.value as OutflowNature);setCategoryId('');setTarget('');}}><option value="">Seleccionar naturaleza…</option>{types.map(x=><option key={x} value={x}>{natures[x]}</option>)}</select></label>
    {nature&&nature!=='INTERNAL_TRANSFER'&&nature!=='REFUND'&&<>
     <label><span className="label">Categoría</span><select className="select" value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="">Seleccionar categoría…</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
     <div className="row"><input className="input" value={newCategory} onChange={e=>setNewCategory(e.target.value)} placeholder="Nueva categoría (ej. Herramientas, Teléfono…)"/><button className="btn" disabled={busy||!newCategory.trim()} onClick={()=>run(createCategory)}>Crear</button></div>
    </>}
    {nature==='INTERNAL_TRANSFER'&&<label><span className="label">Cuenta destino (misma moneda)</span><select className="select" value={target} onChange={e=>setTarget(e.target.value)}><option value="">Seleccionar cuenta…</option>{queue?.accounts.filter(a=>a.code!=='BDV').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    <label><span className="label">Nota / justificación</span><input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Proveedor, finalidad o detalle de la operación"/></label>
    {(nature==='BANK_FEE'||nature==='EXPENSE')&&<label className="row"><input type="checkbox" checked={saveRule} onChange={e=>setSaveRule(e.target.checked)}/>Recordar automáticamente este concepto para próximas semanas (solo si es recurrente)</label>}
    <p className="muted small">Al clasificar, el sistema crea o vincula el movimiento contable UNA vez. No lo vuelvas a cargar manualmente como gasto.</p>
    <button className="btn btn-primary" disabled={busy||!nature} onClick={()=>run(classify)}>{busy?'Guardando…':'Guardar clasificación'}</button>
   </>}
  </section>}
 </main>;
}

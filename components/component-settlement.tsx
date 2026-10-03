"use client";

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { D } from '@/lib/finance/money';
import type { PriceBasis } from '@/lib/finance/settlement';

type Line = { id: string; item_id: string; quantity: string; description: string; basis: PriceBasis; ownership: string; principal: string; covered: string; financed: string };
type Summary = { revision: number; version: number; components: Line[]; payments: { id: string; currency: string; amount: string; method: string; paid_at: string; valuation_status: string }[] };
type Preview = { quote_id: string; applications: { component: string; native: string; covered: string; currency: string; bcv: string|null; benefit: string }[]; tenders: { received: string; applied: string; change: string; currency: string }[] };
type ChangePlan = { native_return?: string|null; change_usd: string; return_usd: string; return_currency: string; rate: string|null };
const methods = [['CASH_USD','Efectivo USD'],['CASH_VES','Efectivo Bs'],['TRANSFER_BDV','Pago móvil · Venezuela'],['TRANSFER_BNC','Pago móvil · BNC'],['ZELLE','Zelle USD'],['BINANCE','Binance USD']];
const remaining = (l: Line) => new D(l.principal).sub(l.covered).sub(l.financed);
const basisLabel = (l: Line) => l.basis === 'USD_FIXED' ? 'USD pactados' : l.basis === 'USD_REF_BCV' ? 'USD de referencia BCV' : 'Bs pactados';
const native = (value: string, currency: string) => `${currency==='VES'?'Bs':'$'} ${new D(value).toFixed(2)}`;

/** Visible only for explicitly activated v3 orders. Never activates or converts old orders. */
export function ComponentSettlement({ orderId, revision, locked, onCommitted }: { orderId: string; revision?: number; locked: boolean; onCommitted: () => Promise<void> }) {
  const [summary,setSummary]=useState<Summary|null>(null);
  const [error,setError]=useState('');
  const [show,setShow]=useState(false);
  const [method,setMethod]=useState('CASH_USD');
  const [reference,setReference]=useState('');
  const [received,setReceived]=useState('');
  const [amounts,setAmounts]=useState<Record<string,string>>({});
  const [selected,setSelected]=useState<Record<string,boolean>>({});
  const [acceptance,setAcceptance]=useState<Record<string,string>>({});
  const [changeRate,setChangeRate]=useState('');
  const [returnUsd,setReturnUsd]=useState('');
  const [returnCurrency,setReturnCurrency]=useState('USD');
  const [pendingChange,setPendingChange]=useState(false);
  const [customerLabel,setCustomerLabel]=useState('');
  const [changePlans,setChangePlans]=useState<ChangePlan[]>([]);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [busy,setBusy]=useState(false);
  const [attempted,setAttempted]=useState(false);
  const [bcv,setBcv]=useState('');
  const [notice,setNotice]=useState('');
  const [priceLine,setPriceLine]=useState<Line|null>(null);
  const [priceBasis,setPriceBasis]=useState<PriceBasis>('USD_REF_BCV');
  const [priceUnit,setPriceUnit]=useState('');
  const [priceReason,setPriceReason]=useState('Precio pactado con el cliente');
  const request=useRef<{ quote:string; tender:string; effective:string; commit:string }|null>(null);
  const sheet=useRef<HTMLDivElement>(null);
  const currency=['CASH_USD','ZELLE','BINANCE'].includes(method)?'USD':'VES';
  async function load() {
    const {data,error}=await supabase.rpc('get_order_financial_summary_v3',{p_order:orderId});
    if(error)throw error;
    if(data.version!==3)throw new Error('La orden conserva su cálculo anterior.');
    setSummary(data);
    return data as Summary;
  }
  useEffect(()=>{load().catch(e=>setError(e.message));},[orderId,revision]);
  useEffect(()=>{
    if(!show&&!priceLine)return;
    const previous=document.activeElement as HTMLElement|null;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    sheet.current?.querySelector<HTMLElement>('button,input,select')?.focus();
    function trap(e:KeyboardEvent){
      if(e.key!=='Tab')return;
      const nodes=Array.from(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')??[]).filter(n=>n.getClientRects().length);
      const first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }
    document.addEventListener('keydown',trap);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',trap);previous?.focus();};
  },[show,priceLine?.id]);
  function changed(){setPreview(null);setChangePlans([]);request.current=null;setError('');}
  function openPrice(l:Line){setPriceLine(l);setPriceBasis(l.basis);setPriceUnit(new D(l.principal).div(l.quantity).toString());setPriceReason('Precio pactado con el cliente');setError('');setShow(false);}
  async function savePrice(){
    if(!priceLine||!summary||busy)return;setBusy(true);setError('');
    try{
      const normalized=priceUnit.trim().replace(',','.');
      const principal=new D(normalized).mul(priceLine.quantity).toFixed(priceBasis==='USD_REF_BCV'?8:2);
      const {error}=await supabase.rpc('set_order_price_v3',{p_item:priceLine.item_id,p_revision:summary.revision,p_basis:priceBasis,p_principal:principal,p_ownership:priceLine.ownership,p_reason:priceReason});
      if(error)throw error;setPriceLine(null);setNotice('Precio acordado guardado con historial.');
      try{await load();await onCommitted();}catch(e:any){setError(`El precio quedó guardado. Recarga para actualizar la pantalla: ${e.message}`);}
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function open(){
    setError('');setNotice('');setBusy(true);
    try{
      const data=await load();
      const rates=await supabase.rpc('get_current_rates');if(rates.error)throw rates.error;
      const row=Array.isArray(rates.data)?rates.data[0]:rates.data;
      setBcv(row?.bcv_rate==null?'':String(row.bcv_rate));
      setSelected(Object.fromEntries(data.components.map(l=>[l.id,remaining(l).gt(0)])));
      setAmounts({});setAcceptance({});setReceived('');setReference('');setPreview(null);setAttempted(false);request.current=null;setShow(true);
      setChangeRate('');setReturnUsd('');setReturnCurrency('USD');setPendingChange(false);setCustomerLabel('');setChangePlans([]);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  function exactNative(l:Line){
    let factor=new D(1);
    if(currency==='VES'&&l.basis!=='VES_FIXED')factor=new D(1).div(bcv);
    else if(currency==='USD'&&l.basis==='VES_FIXED')factor=new D(bcv);
    if(currency==='USD'&&acceptance[l.id]&&l.basis!=='USD_FIXED')factor=l.basis==='VES_FIXED'?new D(acceptance[l.id]):new D(acceptance[l.id]).div(bcv);
    if(!factor.isFinite()||factor.lte(0))throw new Error('Falta BCV para estimar el pago.');
    return remaining(l).div(factor).toDecimalPlaces(2);
  }
  let suggestion='';
  try{suggestion=(summary?.components??[]).filter(l=>selected[l.id]).reduce((total,l)=>total.add(amounts[l.id]||exactNative(l)),new D(0)).toFixed(2);}catch{/* The server returns the actionable missing-rate error. */}
  async function prepare(){
    if(!summary||busy)return;setError('');setBusy(true);
    request.current??={quote:crypto.randomUUID(),tender:crypto.randomUUID(),effective:new Date().toISOString(),commit:crypto.randomUUID()};
    try{
      const targets=summary.components.filter(l=>selected[l.id]).map(l=>({component:l.id,amount:amounts[l.id]||'EXACT_DUE',...(currency==='USD'&&acceptance[l.id]?{exchange:{mode:'RATE',acceptance:acceptance[l.id]}}:{})}));
      const {data,error}=await supabase.rpc('prepare_collection_v3',{p_order:orderId,p_request:request.current.quote,p_revision:summary.revision,p_effective_at:request.current.effective,p_payload:{tenders:[{id:request.current.tender,method,received:received||suggestion,reference:reference.trim()||null,targets}]}});
      if(error)throw error;
      const calculated=data as Preview;
      if(calculated.tenders.some(t=>new D(t.change).gt(0))){
        const plans=calculated.tenders.filter(t=>new D(t.change).gt(0)).map(t=>{
          const rate=changeRate||calculated.applications[0]?.bcv||'';
          const total=t.currency==='USD'?new D(t.change):new D(t.change).div(rate).toDecimalPlaces(2);
          return {tender:request.current!.tender,rate:changeRate||null,return_usd:pendingChange?'0':returnUsd||total.toFixed(2),return_currency:returnCurrency,customer_label:customerLabel.trim()||null};
        });
        const result=await supabase.rpc('prepare_change_v3',{p_quote:calculated.quote_id,p_plans:plans});
        if(result.error)throw result.error;setChangePlans(result.data);
      }else setChangePlans([]);
      setPreview(calculated);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function confirm(){
    if(!preview||!request.current||busy)return;setBusy(true);setAttempted(true);setError('');
    try{
      const result=await supabase.rpc('commit_collection_v3',{p_quote:preview.quote_id,p_request:request.current.commit});if(result.error)throw result.error;
      setShow(false);setPreview(null);request.current=null;setNotice('Pago registrado por concepto.');
      try{await load();await onCommitted();}catch(e:any){setError(`El pago quedó registrado, pero no pudimos actualizar la pantalla: ${e.message}. Recarga; no lo registres otra vez.`);}
    }catch(e:any){
      if(e.code==='P0001'){
        setAttempted(false);setPreview(null);request.current=null;
        setError(`${e.message}. Revisa los datos antes de confirmar otra vez.`);
        try{await load();}catch{/* Retain the actionable collection error. */}
      }else setError(`${e.message}. Puedes reintentar la misma confirmación; no generaremos un segundo cobro.`);
    }finally{setBusy(false);}
  }
  const hasChange=preview?.tenders.some(t=>new D(t.change).gt(0));
  return <section className="card stack">
    <h2 className="section-title">Saldo por concepto</h2>
    {summary?.components.map(l=><div className="stack" key={l.id}><div className="row-between"><strong>{l.description}</strong>{!locked&&new D(l.covered).eq(0)&&new D(l.financed).eq(0)&&<button className="btn btn-ghost" disabled={busy} onClick={()=>openPrice(l)}>Editar precio</button>}</div><div className="muted small">{l.quantity} × {new D(l.principal).div(l.quantity).toFixed(2)} · total {new D(l.principal).toFixed(2)} {basisLabel(l)}</div><div className="row-between"><span>Cubierto {new D(l.covered).toFixed(2)} · financiado {new D(l.financed).toFixed(2)}</span><strong>Pendiente {remaining(l).toFixed(2)}</strong></div></div>)}
    <p className="muted small">Los saldos de referencia se pagan en Bs al BCV del día de cada abono. Los pagos anteriores conservan su tasa.</p>
    {summary?.payments.map(p=><div className="row-between" key={p.id}><span>{methods.find(([m])=>m===p.method)?.[1]??p.method}{p.valuation_status==='PENDING'&&<div className="muted small">Valoración en Bs pendiente</div>}</span><strong>{native(p.amount,p.currency)}</strong></div>)}
    {!locked&&<button className="btn btn-primary" disabled={busy||!summary?.components.some(l=>remaining(l).gt(0))} onClick={open}>Agregar pago por concepto</button>}
    {notice&&<div className="success" role="status">{notice}</div>}
    {error&&!show&&!priceLine&&<div className="error" role="alert">{error}</div>}
    {priceLine&&<div className="overlay"><div ref={sheet} className="sheet stack" role="dialog" aria-modal="true" aria-label="Precio acordado"><div className="row-between"><h2>Precio de {priceLine.description}</h2><button className="btn btn-ghost" disabled={busy} onClick={()=>setPriceLine(null)}>Cerrar</button></div><fieldset disabled={busy} className="stack" style={{border:0,padding:0}}><label>Base del precio<select className="select" value={priceBasis} onChange={e=>setPriceBasis(e.target.value as PriceBasis)}><option value="USD_REF_BCV">Referencia BCV · Bs al día de pago</option><option value="USD_FIXED">USD pactados · divisas</option><option value="VES_FIXED">Bs pactados</option></select></label><label>Precio unitario<input className="input" inputMode="decimal" value={priceUnit} onChange={e=>setPriceUnit(e.target.value)}/></label><p className="muted small">Cantidad: {priceLine.quantity}. El precio se multiplica por esta cantidad y conserva el acuerdo anterior en el historial.</p><label>Razón del acuerdo<input className="input" value={priceReason} onChange={e=>setPriceReason(e.target.value)}/></label></fieldset>{error&&<div className="error" role="alert">{error}</div>}<button className="btn btn-primary" disabled={busy||priceReason.trim().length<5||!priceUnit.trim()} onClick={savePrice}>{busy?'Guardando…':'Guardar precio acordado'}</button></div></div>}
    {show&&<div className="overlay"><div ref={sheet} className="sheet stack" role="dialog" aria-modal="true" aria-label="Pago por concepto">
      <div className="row-between"><h2>Registrar pago</h2><button className="btn btn-ghost" disabled={busy} onClick={()=>setShow(false)}>Cerrar</button></div>
      <fieldset disabled={busy||attempted} style={{border:0,padding:0}} className="stack">
        <label>Cómo recibes el dinero<select className="select" value={method} onChange={e=>{setMethod(e.target.value);setReceived('');setAmounts({});setAcceptance({});changed();}}>{methods.map(([m,l])=><option key={m} value={m}>{l}</option>)}</select></label>
        {!method.startsWith('CASH')&&<label>Referencia<input className="input" value={reference} onChange={e=>{setReference(e.target.value);changed();}} inputMode="numeric"/></label>}
        <p className="muted small">Elige qué estás cobrando. Para un abono, escribe el dinero que aplicas a cada concepto; vacío cobra su saldo completo.</p>
        {summary?.components.filter(l=>remaining(l).gt(0)).map(l=><div className="card stack" key={l.id}><label><input type="checkbox" checked={!!selected[l.id]} onChange={e=>{setSelected({...selected,[l.id]:e.target.checked});changed();}}/> {l.description} · {remaining(l).toFixed(2)} {basisLabel(l)}</label>{selected[l.id]&&<><label>Aplicar {currency==='USD'?'USD':'Bs'}<input className="input" inputMode="decimal" placeholder="Todo el saldo" value={amounts[l.id]??''} onChange={e=>{setAmounts({...amounts,[l.id]:e.target.value});changed();}}/></label>{currency==='USD'&&l.basis==='USD_REF_BCV'&&<details><summary>Negociar aceptación de divisas</summary><label>Tasa acordada en Bs por USD<input className="input" inputMode="decimal" placeholder="Sin preferencia: USD 1 cancela REF 1" value={acceptance[l.id]??''} onChange={e=>{setAcceptance({...acceptance,[l.id]:e.target.value});changed();}}/></label><p className="muted small">Solo cambia la deuda cancelada por este concepto; el dinero recibido conserva su monto.</p></details>}</>}</div>)}
        <label>Dinero recibido ({currency==='USD'?'USD':'Bs'})<input className="input" inputMode="decimal" value={received} placeholder={suggestion} onChange={e=>{setReceived(e.target.value);changed();}}/></label>
        {method.startsWith('CASH')&&<details><summary>Vuelto si entregan más dinero</summary><div className="stack"><label>Moneda que entregas<select className="select" value={returnCurrency} onChange={e=>{setReturnCurrency(e.target.value);changed();}}><option value="USD">USD</option><option value="VES">Bs</option></select></label><label>Tasa acordada para convertir el vuelto<input className="input" inputMode="decimal" value={changeRate} placeholder="Vacío usa BCV del pago" onChange={e=>{setChangeRate(e.target.value);changed();}}/></label><label><input type="checkbox" checked={pendingChange} onChange={e=>{setPendingChange(e.target.checked);changed();}}/> Dejar el vuelto pendiente de entregar</label>{!pendingChange&&<label>USD de vuelto que entregas<input className="input" inputMode="decimal" value={returnUsd} placeholder="Vacío devuelve todo el sobrante" onChange={e=>{setReturnUsd(e.target.value);changed();}}/></label>}<label>Nombre del cliente si queda vuelto pendiente<input className="input" value={customerLabel} onChange={e=>{setCustomerLabel(e.target.value);changed();}} placeholder="Si la orden ya tiene cliente, no es necesario"/></label></div></details>}
      </fieldset>
      {preview&&<div className="card stack"><strong>Revisa antes de confirmar</strong>{preview.tenders.map((t,i)=><div key={i}>Recibido {native(t.received,t.currency)} · aplicado {native(t.applied,t.currency)}{new D(t.change).gt(0)&&<> · sobrante {native(t.change,t.currency)}</>}</div>)}{preview.applications.map((a,i)=><div key={i}>{summary?.components.find(l=>l.id===a.component)?.description}: {native(a.native,a.currency)} cancela {new D(a.covered).toFixed(2)} {basisLabel(summary!.components.find(l=>l.id===a.component)!)}{a.bcv&&<div className="muted small">BCV del pago: {a.bcv}</div>}</div>)}{changePlans.map((p,i)=><div key={i}><strong>Vuelto: {native(p.change_usd,"USD")}</strong><div>Entregas {p.native_return?native(p.native_return,"VES"):p.return_currency==="USD"?native(p.return_usd,"USD"):native(new D(p.return_usd).mul(p.rate||0).toFixed(2),"VES")} · pendiente {native(new D(p.change_usd).sub(p.return_usd).toFixed(2),"USD")}</div>{p.rate&&<div className="muted small">Tasa acordada del vuelto: {p.rate} Bs/USD</div>}</div>)}</div>}
      {error&&<div className="error" role="alert">{error}</div>}
      {preview?<><button className="btn btn-primary" disabled={busy||(hasChange&&!changePlans.length)} onClick={confirm}>{busy?'Confirmando…':attempted?'Reintentar la misma confirmación':'Confirmar cobro'}</button>{!attempted&&<button className="btn" disabled={busy} onClick={changed}>Editar el cobro</button>}</>:<button className="btn btn-primary" disabled={busy||!Object.values(selected).some(Boolean)} onClick={prepare}>{busy?'Calculando…':'Revisar cobro'}</button>}
    </div></div>}
  </section>;
}

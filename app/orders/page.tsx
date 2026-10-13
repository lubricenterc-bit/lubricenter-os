"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes, fmtRate } from "@/lib/format";
type PaymentDetail = {method:string;currency:"VES"|"USD";amount_original:number;equivalent_bcv:number|null;reference_tail:string|null;paid_at:string|null};
type CasheaInfo = {initial_percent:number;initial_bcv_usd:number;initial_ves:number;financed_bcv_usd:number;total_bcv_usd:number;bcv_rate:number;reference:string|null;initial_method:string|null;ownership_status:string;status:string};
type Sale = {id:string;order_number:string;status:string;sale_at:string;customer_id:string|null;customer_name:string|null;plate:string|null;kind:string;services:string|null;total_ref:number;total_ves:number;payment_type:string;has_financed_sale:boolean;cancellation_reason:string|null;collected_ves:number;collected_usd:number;payment_details:PaymentDetail[];cashea:CasheaInfo|null};
type Summary = {orders:number;closed:number;cashea:number;sales_ref:number;collected_ves:number;collected_usd:number;cashea_initial_bcv:number;cashea_initial_ves:number;cashea_financed_bcv:number};
const BLANK:Summary={orders:0,closed:0,cashea:0,sales_ref:0,collected_ves:0,collected_usd:0,cashea_initial_bcv:0,cashea_initial_ves:0,cashea_financed_bcv:0};
type DatePreset = "TODAY"|"YESTERDAY"|"WEEK"|"MONTH"|"ALL"|"CUSTOM";
function caracasToday(){return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}
function shiftDate(day:string,offset:number){const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
function monday(day:string){const weekDay=new Date(day+"T12:00:00Z").getUTCDay();return shiftDate(day,-((weekDay+6)%7));}
function methodLabel(name:string){return ({TRANSFER_BDV:"Banco de Venezuela",TRANSFER_BNC:"BNC",MOBILE_PAYMENT:"Pago móvil",CASH_VES:"Efectivo Bs",CASH_USD:"Efectivo USD",BINANCE:"Binance USDT",ZELLE:"Zelle"} as Record<string,string>)[name]??name.replaceAll("_"," ");}
function whenVenezuela(value:string){return new Intl.DateTimeFormat("es-VE",{timeZone:"America/Caracas",dateStyle:"short",timeStyle:"short"}).format(new Date(value));}
function Explanation({title,children}:{title:string;children:React.ReactNode}){return <details style={{position:"relative"}}><summary title={title} aria-label={title} style={{cursor:"pointer",listStyle:"none",color:"var(--muted)",padding:"2px 5px"}}>ⓘ</summary><div className="card small" style={{position:"absolute",top:25,right:0,zIndex:5,width:"min(280px,74vw)",boxShadow:"0 12px 25px #0003"}}><strong>{title}</strong><p>{children}</p></div></details>;}
function Metric({label,value,ves,description}:{label:string;value:number;ves?:boolean;description:string}){return <div className="card"><div className="row-between" style={{gap:5}}><span className="small muted">{label}</span><Explanation title={label}>{description}</Explanation></div><div className="kpi" style={{wordBreak:"break-word"}}>{ves?fmtVes(value):fmtRef(value)}</div></div>;}
export default function OrdersPage() {
 const [rows,setRows]=useState<Sale[]>([]),[count,setCount]=useState(0),[page,setPage]=useState(0);
 const [summary,setSummary]=useState<Summary>(BLANK),[paymentFilter,setPaymentFilter]=useState("ALL"),[preset,setPreset]=useState<DatePreset>("TODAY");
 const [query,setQuery]=useState(""),[status,setStatus]=useState("CLOSED"),[from,setFrom]=useState(caracasToday()),[to,setTo]=useState(caracasToday());
 const [admin,setAdmin]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[revision,setRevision]=useState(0);
 const [cancel,setCancel]=useState<Sale|null>(null),[reason,setReason]=useState(""),[keepAsBalance,setKeepAsBalance]=useState(false);
 useEffect(()=>{supabase.rpc("can_administer_orders").then(({data})=>setAdmin(data===true));},[]);
 useEffect(()=>{let active=true;setLoading(true);const timer=setTimeout(async()=>{
  const r=await supabase.rpc("search_order_collection_v2",{p_query:query,p_status:status,p_from:from||null,p_to:to||null,p_page:page,p_payment_filter:paymentFilter});
  if(!active)return;setLoading(false);if(r.error){setRows([]);setSummary(BLANK);return setError(r.error.message);}setRows(r.data?.rows??[]);setSummary(r.data?.summary??BLANK);setCount(Number(r.data?.count??0));setError("");
 },250);return()=>{active=false;clearTimeout(timer);};},[query,status,from,to,page,revision,paymentFilter]);
 function selectPeriod(p:DatePreset){setPreset(p);setPage(0);const today=caracasToday();if(p==="TODAY"){setFrom(today);setTo(today);}if(p==="YESTERDAY"){const d=shiftDate(today,-1);setFrom(d);setTo(d);}if(p==="WEEK"){setFrom(monday(today));setTo(today);}if(p==="MONTH"){setFrom(today.slice(0,7)+"-01");setTo(today);}if(p==="ALL"){setFrom("");setTo("");}}
 async function annul(){if(!cancel||busy||reason.trim().length<5)return;setBusy(true);setError("");const r=await supabase.rpc(keepAsBalance?"cancel_order_to_customer_balance":"cancel_order",{p_order_id:cancel.id,p_reason:reason.trim()});setBusy(false);if(r.error)return setError(r.error.message);setCancel(null);setReason("");setKeepAsBalance(false);setRevision(x=>x+1);}
 return <main className="container stack">
  <div className="row-between"><div><div className="eyebrow">VENTAS · CONTROL DIARIO</div><h1>Órdenes y cobranza</h1><p className="muted">Lo que se hizo, cuánto se vendió, cómo se cobró y qué quedó financiado. Sin duplicar la inicial de Cashea.</p></div><div className="row" style={{flexWrap:"wrap"}}><Link className="btn" href="/service-history">Historial de mantenimiento</Link><Link className="btn" href="/quick-sale">Venta rápida</Link><Link className="btn btn-primary" href="/orders/new">+ Orden completa</Link></div></div>
  {error&&<div className="error" role="alert">{error}</div>}
  <section className="card stack">
    <div className="row-between" style={{flexWrap:"wrap",gap:10}}><strong>Consultar por día o período</strong><span className="muted small">Fechas del negocio: Venezuela (UTC−4)</span></div>
    <div className="row" style={{flexWrap:"wrap",gap:7}}>
      {([["TODAY","Hoy"],["YESTERDAY","Ayer"],["WEEK","Esta semana"],["MONTH","Este mes"],["ALL","Todo el historial"]] as [DatePreset,string][]).map(([key,label])=>
        <button key={key} className={"btn "+(preset===key?"btn-primary":"btn-ghost")} onClick={()=>selectPeriod(key)}>{label}</button>
      )}
    </div>
    <div className="grid grid-2">
      <label><span className="label">Desde</span><input className="input" type="date" value={from} onChange={e=>{setFrom(e.target.value);setPreset("CUSTOM");setPage(0);}}/></label>
      <label><span className="label">Hasta</span><input className="input" type="date" value={to} onChange={e=>{setTo(e.target.value);setPreset("CUSTOM");setPage(0);}}/></label>
    </div>
    <div className="grid grid-3">
      <label><span className="label">Buscar orden, cliente o placa</span><input className="input" placeholder="Número, nombre, teléfono o placa" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
      <label><span className="label">Forma de venta</span><select className="select" value={paymentFilter} onChange={e=>{setPaymentFilter(e.target.value);setPage(0);}}>
        <option value="ALL">Todas</option><option value="CASHEA">Solo Cashea</option><option value="CONTADO">Contado y mixto</option><option value="CREDIT">Crédito LC</option>
      </select></label>
      <label><span className="label">Estado</span><select className="select" value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}>
        <option value="CLOSED">Cerradas</option><option value="ALL">Todos los estados</option><option value="OPEN">Abiertas</option><option value="CANCELLED">Anuladas</option>
      </select></label>
    </div>
  </section>
  <section className="stack" aria-busy={loading}>
    <div className="row-between" style={{gap:10,flexWrap:"wrap"}}><h2 className="section-title" style={{margin:0}}>Resumen del período</h2><span className="muted small">{loading?"Consultando…":String(count)+" órdenes coincidentes · totales de todas las páginas"}</span></div>
    <div className="grid grid-3">
      <div className="card"><div className="muted small">ÓRDENES CERRADAS</div><div className="kpi">{summary.closed}</div><div className="muted small">{summary.cashea} con Cashea</div></div>
      <Metric label="Facturado (valor ref.)" value={summary.sales_ref} description="Suma del valor de referencia de órdenes cerradas. No representa caja ni dólares reales; no se suma otra vez a cobros."/>
      <Metric label="Cobros en Bs de estas órdenes" ves value={summary.collected_ves} description="Pagos registrados en bolívares contra las órdenes seleccionadas, aunque hayan llegado en otra fecha. Para ingresos del día consultar el banco."/>
      <Metric label="Cobros en divisas de estas órdenes" value={summary.collected_usd} description="Pagos en efectivo USD, Zelle y Binance USDT asociados a las órdenes seleccionadas. No se mezclan con Bs."/>
      <Metric label="Inicial Cashea · $ BCV" value={summary.cashea_initial_bcv} description="Valor contractual de la inicial de las ventas Cashea del período, expresado a tasa BCV de cada orden. No se suma nuevamente a pagos bancarios."/>
      <Metric label="Inicial Cashea · Bs" ves value={summary.cashea_initial_ves} description="Monto en bolívares pactado como inicial de Cashea a la tasa BCV de venta. Los pagos efectivamente registrados se muestran por método dentro de cada orden."/>
    </div>
    {summary.cashea>0&&<div className="card row-between" style={{gap:10,flexWrap:"wrap"}}><div><strong>Cashea financiado</strong><p className="muted small">Parte financiada de estas ventas, no efectivo recibido.</p></div><strong>{fmtRef(summary.cashea_financed_bcv)} <span className="muted small">$ BCV</span></strong></div>}
    <p className="muted small">Las ventas se filtran por la fecha de la orden. Los cobros incluyen los pagos vinculados que figuran en su historial, no necesariamente depositados ese mismo día.</p>
  </section>
  {cancel&&<section className="card stack" role="region" aria-label="Anular venta"><h2>Anular {cancel.order_number}</h2><p>El stock y las comisiones se revertirán. El original y el motivo seguirán visibles en el historial.</p>{cancel.status==='CLOSED'&&<div className="stack"><strong>¿Qué pasó con el dinero recibido?</strong><label className="row"><input type="radio" checked={!keepAsBalance} onChange={()=>setKeepAsBalance(false)}/><span>Se devolvió al cliente lo cobrado por la venta · registrar salida de caja</span></label>{cancel.customer_id&&!cancel.has_financed_sale?<label className="row"><input type="radio" checked={keepAsBalance} onChange={()=>setKeepAsBalance(true)}/><span>El cliente lo conserva como saldo a favor · no salió dinero de caja</span></label>:<div className="muted small">Para conservar el cobro como saldo, la venta debe tener cliente y no incluir Cashea ni Crédito LC.</div>}</div>}{keepAsBalance?<div className="card muted small">Los cobros en Bs se acreditarán con su BCV original; los cobros en USD quedarán en divisas. El saldo aparecerá en la ficha del cliente.</div>:<div className="muted small">Si un pago tuvo sobrante separado como saldo a favor, ese sobrante permanece. Devuélvelo aparte desde la ficha del cliente si también entregaste ese dinero.</div>}<label><span className="label">Motivo obligatorio</span><textarea className="input" autoFocus value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ej. el cliente no compró; se cerró al preparar el recibo"/></label><div className="row"><button className="btn" disabled={busy} onClick={()=>setCancel(null)}>Volver</button><button className="btn btn-primary" disabled={busy||reason.trim().length<5} onClick={annul}>{busy?"Anulando…":keepAsBalance?"Anular y acreditar saldo":"Confirmar anulación y reversión"}</button></div></section>}
  <section className="card" style={{overflowX:"auto"}} aria-busy={loading}><table className="table sales-table"><caption style={{textAlign:"left",paddingBottom:12}}>{loading?"Buscando…":`${count} ventas / órdenes`}</caption><thead><tr><th>Fecha / número</th><th>Cliente / vehículo</th><th>Tipo / cobro</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td data-label="Fecha / número"><Link href={`/orders/${r.id}`}><strong>{r.order_number}</strong></Link><div className="small muted">{fmtDate(r.sale_at)}</div></td><td data-label="Cliente / vehículo">{r.customer_name||"Mostrador"}<div className="small muted">{r.plate||"Sin vehículo"}</div></td><td data-label="Tipo / cobro">{r.kind}<div className="small muted">{r.payment_type}</div></td><td data-label="Total"><strong>{fmtRef(r.total_ref)}</strong><div className="small muted">{fmtVes(r.total_ves)}</div></td><td data-label="Estado"><span className={`pill ${r.status==='CLOSED'?'ok':r.status==='OPEN'?'warn':''}`}>{r.status==='CLOSED'?'Cerrada':r.status==='OPEN'?'Abierta':'Anulada'}</span>{r.cancellation_reason&&<div className="small muted">{r.cancellation_reason}</div>}</td><td data-label="Acciones"><div className="sales-actions"><Link className="btn btn-ghost" href={`/orders/${r.id}`}>Abrir</Link><Link className="btn btn-ghost" href={`/orders/${r.id}/receipt`}>Recibo 58 mm</Link><Link className="btn btn-ghost" href={`/orders/${r.id}/history`}>Historial</Link>{admin&&r.status==='CLOSED'&&<Link className="btn" href={`/orders/${r.id}/correct`}>Corregir</Link>}{admin&&r.status!=='CANCELLED'&&<button className="btn" onClick={()=>{setCancel(r);setReason("");setKeepAsBalance(false);}}>Anular</button>}</div></td></tr>)}</tbody></table>{!loading&&!rows.length&&<p className="muted">No hay ventas para estos filtros.</p>}</section>
  <div className="row-between"><button className="btn" disabled={page===0||loading} onClick={()=>setPage(x=>x-1)}>Anterior</button><span>Página {page+1} de {Math.max(1,Math.ceil(count/30))}</span><button className="btn" disabled={(page+1)*30>=count||loading} onClick={()=>setPage(x=>x+1)}>Siguiente</button></div>{!admin&&<p className="muted small">Las correcciones y anulaciones están disponibles en la cuenta propietaria.</p>}
 </main>;
}


"use client";

import Link from "next/link";
import Decimal from "decimal.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";

type Statement = { id:string; period_from:string; period_to:string; invoice_number:string; ownership_status:string; ownership_reason:string; sales_ref:string; commission_percent:string; service_ref:string; vat_ref:string; withholding_ref:string; total_deduct_ref:string; evidence:string; voided_at:string|null; void_reason:string|null; cashea_balance_events:{id:string;reversed_at:string|null}[] };
type BalanceEvent = { id:string; kind:string; occurred_on:string; amount_ref:string; reference:string; evidence:string; statement_id:string|null; bank_transaction_id:string|null; reversed_at:string|null; reversal_reason:string|null };
type BalanceSummary = { opening_on:string|null; recorded_net:string; events_total:number; statements_total:number; pending_bank_payouts:number; pending_deductions:number };
const labels:Record<string,string> = { COVERAGE_CREDIT:"Cuota asumida por Cashea", SERVICE_DEDUCTION:"Comisión descontada", PAYOUT:"Pago de Cashea al negocio", OPENING_CREDIT:"Apertura a favor", OPENING_DEBIT:"Apertura en contra", ADJUSTMENT_CREDIT:"Ajuste a favor", ADJUSTMENT_DEBIT:"Ajuste en contra" };
const debitKinds = new Set(["SERVICE_DEDUCTION","PAYOUT","OPENING_DEBIT","ADJUSTMENT_DEBIT"]);
function today() { return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
function previousMonth() { const [year,month] = today().split("-").map(Number); const date = new Date(Date.UTC(year,month-2,1)); const y = date.getUTCFullYear(); const m = String(date.getUTCMonth()+1).padStart(2,"0"); return {from:`${y}-${m}-01`,to:`${y}-${m}-${String(new Date(Date.UTC(y,date.getUTCMonth()+1,0)).getUTCDate()).padStart(2,"0")}`}; }
function rounded(value:string) { try { return new Decimal(value || "0").toDecimalPlaces(2,Decimal.ROUND_HALF_UP).toFixed(2); } catch { return "0.00"; } }
function decimalInput(value:string,scale=2):string|null { const normalized=value.trim().replace(',', '.');if(!/^\d+(?:\.\d+)?$/.test(normalized))return null;try{const n=new Decimal(normalized);return n.isFinite()&&n.decimalPlaces()<=scale?n.toString():null;}catch{return null;} }

export default function CasheaBalancePage() {
  const month = useMemo(previousMonth,[]);
  const [role,setRole] = useState("");
  const [statements,setStatements] = useState<Statement[]>([]);
  const [events,setEvents] = useState<BalanceEvent[]>([]);
  const [summary,setSummary] = useState<BalanceSummary|null>(null);
  const [statementPage,setStatementPage] = useState(0);
  const [eventPage,setEventPage] = useState(0);
  const statementRequest=useRef<string|null>(null);
  const eventRequest=useRef<string|null>(null);
  const [ownershipStatement,setOwnershipStatement]=useState<Statement|null>(null);
  const [ownership,setOwnership]=useState('UNRESOLVED');
  const [ownershipReason,setOwnershipReason]=useState('');
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [periodFrom,setPeriodFrom] = useState(month.from);
  const [periodTo,setPeriodTo] = useState(month.to);
  const [invoice,setInvoice] = useState("");
  const [sales,setSales] = useState("");
  const [percent,setPercent] = useState("4");
  const [service,setService] = useState("");
  const [vat,setVat] = useState("");
  const [withholding,setWithholding] = useState("0");
  const [invoiceEvidence,setInvoiceEvidence] = useState("");
  const [kind,setKind] = useState("COVERAGE_CREDIT");
  const [eventDate,setEventDate] = useState(today);
  const [amount,setAmount] = useState("");
  const [reference,setReference] = useState("");
  const [eventEvidence,setEventEvidence] = useState("");
  const [statementId,setStatementId] = useState("");

  async function load() {
    const r = await supabase.rpc("finance_role");
    if (r.error) { setError(r.error.message); return; }
    const currentRole = String(r.data ?? ""); setRole(currentRole);
    if (!['OWNER','ADMIN'].includes(currentRole)) return;
    const [s,e,totals] = await Promise.all([
      supabase.from("cashea_merchant_statements").select("id,period_from,period_to,invoice_number,ownership_status,ownership_reason,sales_ref,commission_percent,service_ref,vat_ref,withholding_ref,total_deduct_ref,evidence,voided_at,void_reason,cashea_balance_events(id,reversed_at)").order("period_to",{ascending:false}).order("id").range(statementPage*25,statementPage*25+24),
      supabase.from("cashea_balance_events").select("id,kind,occurred_on,amount_ref,reference,evidence,statement_id,bank_transaction_id,reversed_at,reversal_reason").order("occurred_on",{ascending:false}).order("id").range(eventPage*50,eventPage*50+49),
      supabase.rpc("finance_cashea_balance_summary"),
    ]);
    if (s.error || e.error || totals.error) setError((s.error || e.error || totals.error)!.message);
    else {
      setStatements((s.data ?? []).map(x=>({...x,sales_ref:String(x.sales_ref),commission_percent:String(x.commission_percent),service_ref:String(x.service_ref),vat_ref:String(x.vat_ref),withholding_ref:String(x.withholding_ref),total_deduct_ref:String(x.total_deduct_ref)})) as Statement[]);
      setEvents((e.data ?? []).map(x=>({...x,amount_ref:String(x.amount_ref)})) as BalanceEvent[]);
      setSummary(totals.data as BalanceSummary);
    }
  }
  useEffect(()=>{void load();},[statementPage,eventPage]);
  const linked = new Set(statements.filter(s=>s.cashea_balance_events.some(e=>!e.reversed_at)).map(s=>s.id));
  const suggestedService = useMemo(()=>rounded(new Decimal(decimalInput(sales)||0).mul(decimalInput(percent,4)||0).div(100).toString()),[sales,percent]);
  const suggestedVat = useMemo(()=>rounded(new Decimal(decimalInput(service)||0).mul("0.16").toString()),[service]);
  const selectedStatement = statements.find(s=>s.id===statementId);

  async function saveStatement() {
    if(busy)return;
    const values=[decimalInput(sales),decimalInput(percent,4),decimalInput(service),decimalInput(vat),decimalInput(withholding)];
    if(values.some(x=>x===null)){setError("Escribe importes válidos con hasta dos decimales; puedes usar coma o punto.");return;}
    setError(""); setBusy(true);
    statementRequest.current??=crypto.randomUUID();
    const r=await supabase.rpc("finance_cashea_statement",{p_request_id:statementRequest.current,p_from:periodFrom,p_to:periodTo,p_invoice:invoice.trim(),p_sales:values[0],p_percent:values[1],p_service:values[2],p_vat:values[3],p_withholding:values[4],p_evidence:invoiceEvidence.trim()});
    setBusy(false); if(r.error)return setError(r.error.message);
    statementRequest.current=null;
    setInvoice("");setSales("");setService("");setVat("");setInvoiceEvidence("");await load();
  }
  async function saveEvent() {
    if(busy)return;
    const value=decimalInput(amount);if(value===null||new Decimal(value).lte(0)){setError("Escribe un importe mayor que cero con hasta dos decimales.");return;}
    setError("");setBusy(true);
    eventRequest.current??=crypto.randomUUID();
    const r=await supabase.rpc("finance_cashea_balance_entry",{p_request_id:eventRequest.current,p_kind:kind,p_date:eventDate,p_amount:value,p_reference:reference.trim(),p_evidence:eventEvidence.trim(),p_statement_id:kind==="SERVICE_DEDUCTION"?statementId:null,p_bank_transaction_id:null});
    setBusy(false);if(r.error)return setError(r.error.message);
    eventRequest.current=null;
    setAmount("");setReference("");setEventEvidence("");setStatementId("");await load();
  }
  async function reverse(item:"EVENT"|"STATEMENT",id:string) {
    const reason=window.prompt("Motivo de la corrección (queda en el historial):");
    if (!reason) return;
    setError("");setBusy(true);
    const r=await supabase.rpc("finance_cashea_reverse",{p_kind:item,p_id:id,p_reason:reason.trim()});
    setBusy(false);if(r.error)return setError(r.error.message);
    await load();
  }
  async function saveOwnership() {
    if(!ownershipStatement||busy)return;
    setBusy(true);setError('');
    const r=await supabase.rpc('finance_cashea_ownership',{p_id:ownershipStatement.id,p_status:ownership,p_reason:ownershipReason.trim()});
    setBusy(false);if(r.error)return setError(r.error.message);
    setOwnershipStatement(null);await load();
  }
  function chooseKind(value:string) { setKind(value);setAmount("");setReference("");setStatementId(""); }
  function chooseStatement(id:string) { const s=statements.find(x=>x.id===id);setStatementId(id);setAmount(s?.total_deduct_ref??"");setReference(s?.invoice_number??""); }

  return <main className="container stack">
    <div className="row-between"><div><div className="eyebrow">FINANZAS · CASHEA</div><h1>Balance comercial</h1><p className="muted">Factura, compensación y pago son hechos distintos. Aquí se registran con su comprobante, sin crear otra venta ni otro cobro.</p></div><Link className="btn" href="/cashea">Volver a Cashea</Link></div>
    {error && <div className="error">{error}</div>}
    {role && !['OWNER','ADMIN'].includes(role) && <div className="card">Esta revisión corresponde al administrador o al dueño.</div>}
    {['OWNER','ADMIN'].includes(role) && <>
      <section className="grid grid-2"><div className="card stack"><div className="muted small">MOVIMIENTOS DEL BALANCE REGISTRADOS</div><div className="kpi">{summary?fmtRef(summary.recorded_net):"…"}</div><div className="muted small">{summary?.opening_on ? `Apertura al inicio del ${summary.opening_on}; requiere contrastar el balance completo de Cashea.` : "Parcial: falta saldo inicial comprobado. No representa dinero disponible."}</div>{summary&&<div className="muted small">{summary.pending_deductions} facturas sin descuento documentado · {summary.pending_bank_payouts} pagos pendientes de banco</div>}</div><div className="card stack"><h2 className="section-title">Cómo leerlo</h2><p className="muted">El 4 % es un costo del negocio. Los pagos de clientes entran completos al banco. Cashea factura la comisión y luego la descuenta de su balance; una transferencia de Cashea reduce ese balance y debe comprobarse en el banco.</p></div></section>
      <section className="card stack"><h2 className="section-title">Facturas de servicio</h2><p className="muted small">Guarda el total de ventas y los importes exactos de la factura. El sistema sugiere 4 % y 16 % de IVA, pero conserva lo que diga el documento.</p>
        <div className="grid grid-2"><label>Desde<input className="input" type="date" value={periodFrom} onChange={e=>setPeriodFrom(e.target.value)}/></label><label>Hasta<input className="input" type="date" value={periodTo} onChange={e=>setPeriodTo(e.target.value)}/></label><label>Número de factura<input className="input" value={invoice} onChange={e=>setInvoice(e.target.value)}/></label><label>Ventas Cashea del período (USD)<input className="input" inputMode="decimal" value={sales} onChange={e=>setSales(e.target.value)}/></label><label>Comisión (%)<input className="input" inputMode="decimal" value={percent} onChange={e=>setPercent(e.target.value)}/></label><label>Servicio sin IVA (USD) · sugerido {suggestedService}<input className="input" inputMode="decimal" value={service} onChange={e=>setService(e.target.value)}/></label><label>IVA (USD) · sugerido {suggestedVat}<input className="input" inputMode="decimal" value={vat} onChange={e=>setVat(e.target.value)}/></label><label>ISLR retenido (USD)<input className="input" inputMode="decimal" value={withholding} onChange={e=>setWithholding(e.target.value)}/></label></div>
        <button className="btn" disabled={busy||!decimalInput(sales)||!decimalInput(percent,4)} onClick={()=>{setService(suggestedService);setVat(rounded(new Decimal(suggestedService).mul('0.16').toString()));}}>Usar cálculo sugerido</button><label>Comprobante o nota<input className="input" value={invoiceEvidence} onChange={e=>setInvoiceEvidence(e.target.value)} placeholder="Factura PDF y detalle de servicio"/></label><button className="btn btn-primary" disabled={busy||!invoice||!sales||!service||!vat||invoiceEvidence.trim().length<5||!periodFrom||!periodTo} onClick={saveStatement}>Guardar factura</button>
        {statements.map(s=><div className="row-between order-item" key={s.id}><div><strong>{s.invoice_number}</strong><div className="muted small">{s.period_from} a {s.period_to} · Ventas {fmtRef(s.sales_ref)} · Servicio {fmtRef(s.service_ref)} + IVA {fmtRef(s.vat_ref)} · ISLR {fmtRef(s.withholding_ref)}</div><div className="muted small">{s.voided_at?`Anulada: ${s.void_reason}`:linked.has(s.id)?"Descuento documentado":"Descuento aún sin balance"} · {s.ownership_status==='OWN'?'Toda de Lubricenter':s.ownership_status==='SHARED'?'Cuenta compartida':'Propiedad pendiente'}</div><details><summary>Comprobante</summary><p>{s.evidence}</p><p>{s.ownership_reason}</p></details></div><div style={{textAlign:"right"}}><strong>{fmtRef(s.total_deduct_ref)}</strong>{!s.voided_at&&<div><button className="btn btn-ghost" disabled={busy} onClick={()=>{setOwnershipStatement(s);setOwnership(s.ownership_status);setOwnershipReason(s.ownership_reason);}}>Atribuir factura</button></div>}{role==='OWNER'&&!s.voided_at&&<div><button className="btn btn-ghost" disabled={busy} onClick={()=>reverse('STATEMENT',s.id)}>Anular registro</button></div>}</div></div>)}
        {summary&&<div className="row"><button className="btn" disabled={busy||statementPage===0} onClick={()=>setStatementPage(x=>x-1)}>Más recientes</button><span>{statementPage*25+statements.length} de {summary.statements_total} facturas</span><button className="btn" disabled={busy||(statementPage+1)*25>=summary.statements_total} onClick={()=>setStatementPage(x=>x+1)}>Más antiguas</button></div>}
      </section>
      <section className="card stack"><h2 className="section-title">Movimientos del balance Cashea</h2><p className="muted small">Registra solo lo que aparezca en el balance o comprobante de Cashea. Una comisión facturada no se marca descontada automáticamente.</p>
        <div className="grid grid-2"><label>Tipo<select className="select" value={kind} onChange={e=>chooseKind(e.target.value)}>{Object.entries(labels).filter(([k])=>role==='OWNER'||!k.startsWith('OPENING_')&&!k.startsWith('ADJUSTMENT_')).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label>Fecha<input className="input" type="date" max={today()} value={eventDate} onChange={e=>setEventDate(e.target.value)}/></label></div>
        {kind==="SERVICE_DEDUCTION" && <label>Factura<select className="select" value={statementId} onChange={e=>chooseStatement(e.target.value)}><option value="">Selecciona factura</option>{statements.filter(s=>!linked.has(s.id)&&!s.voided_at).map(s=><option value={s.id} key={s.id}>{s.invoice_number} · {fmtRef(s.total_deduct_ref)}</option>)}</select></label>}
        <div className="grid grid-2"><label>Importe USD<input className="input" inputMode="decimal" value={amount} readOnly={kind==="SERVICE_DEDUCTION"} onChange={e=>setAmount(e.target.value)}/></label><label>Referencia del comprobante<input className="input" value={reference} readOnly={kind==="SERVICE_DEDUCTION"} onChange={e=>setReference(e.target.value)}/></label></div>
        <label>Evidencia o explicación<input className="input" value={eventEvidence} onChange={e=>setEventEvidence(e.target.value)} placeholder="Indica en qué balance o comprobante aparece"/></label>
        {kind==="PAYOUT" && <div className="muted small">Este registro documenta el pago de Cashea. La entrada bancaria se comprueba aparte; aquí no se crea dinero en caja.</div>}
        <button className="btn btn-primary" disabled={busy||!amount||!reference||!eventEvidence||(kind==="SERVICE_DEDUCTION"&&!selectedStatement)} onClick={saveEvent}>Registrar movimiento comprobado</button>
        {events.map(e=><div className="row-between order-item" key={e.id}><div><strong>{labels[e.kind]}</strong><div className="muted small">{e.occurred_on} · Ref. {e.reference}{e.reversed_at?` · Revertido: ${e.reversal_reason}`:""}{e.kind==='PAYOUT'&&!e.bank_transaction_id&&!e.reversed_at?" · Falta enlace bancario":""}</div><details><summary>Comprobante</summary><p>{e.evidence}</p></details></div><div style={{textAlign:"right"}}><strong>{debitKinds.has(e.kind)?"−":"+"}{fmtRef(e.amount_ref)}</strong>{role==='OWNER'&&!e.reversed_at&&<div><button className="btn btn-ghost" disabled={busy} onClick={()=>reverse('EVENT',e.id)}>Anular registro</button></div>}</div></div>)}
        {summary&&<div className="row"><button className="btn" disabled={busy||eventPage===0} onClick={()=>setEventPage(x=>x-1)}>Más recientes</button><span>{eventPage*50+events.length} de {summary.events_total} movimientos</span><button className="btn" disabled={busy||(eventPage+1)*50>=summary.events_total} onClick={()=>setEventPage(x=>x+1)}>Más antiguos</button></div>}
        {!events.length && <p className="muted">Aún no hay movimientos del balance documentados.</p>}
      </section>
    </>}
    {ownershipStatement&&<div className="overlay"><div className="sheet stack"><h2>Atribuir factura {ownershipStatement.invoice_number}</h2><p className="muted">Una cuenta compartida puede incluir ventas de otro local. Esta decisión conserva su motivo y no cambia los importes.</p><label>Propiedad<select className="select" value={ownership} onChange={e=>setOwnership(e.target.value)}><option value="UNRESOLVED">Aún sin confirmar</option><option value="OWN">Toda corresponde a Lubricenter</option><option value="SHARED">Incluye otros locales</option></select></label><label>Evidencia<input className="input" value={ownershipReason} onChange={e=>setOwnershipReason(e.target.value)}/></label>{error&&<div className="error">{error}</div>}<div className="row"><button className="btn" disabled={busy} onClick={()=>setOwnershipStatement(null)}>Volver</button><button className="btn btn-primary" disabled={busy||ownershipReason.trim().length<5} onClick={saveOwnership}>Guardar decisión</button></div></div></div>}
  </main>;
}

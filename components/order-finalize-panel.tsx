"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type PaymentMethod = "MOBILE_PAYMENT" | "TRANSFER_BDV" | "TRANSFER_BNC" | "CASH_VES" | "CASH_USD";
type Mode = "DIRECT" | "CASHEA" | "CREDIT";
type CasheaSale = { id:string; status:string; initial_percent:number; gross_ref:number; initial_ref:number; financed_ref:number; commission_ref:number };
const METHODS: readonly [PaymentMethod,string][] = [["MOBILE_PAYMENT","Pago móvil"],["TRANSFER_BDV","Transferencia BDV"],["TRANSFER_BNC","Transferencia BNC"],["CASH_VES","Efectivo Bs"],["CASH_USD","Efectivo USD"]];

export function OrderFinalizePanel({ orderId }: { orderId:string }) {
  const router = useRouter();
  const [status,setStatus] = useState("OPEN");
  const [orderNumber,setOrderNumber] = useState("");
  const [customerId,setCustomerId] = useState<string|null>(null);
  const [totalVes,setTotalVes] = useState(0);
  const [totalRef,setTotalRef] = useState(0);
  const [paidVes,setPaidVes] = useState(0);
  const [paymentCount,setPaymentCount] = useState(0);
  const [bcv,setBcv] = useState(0);
  const [mode,setMode] = useState<Mode>("DIRECT");
  const [method,setMethod] = useState<PaymentMethod>("MOBILE_PAYMENT");
  const [reference,setReference] = useState("");
  const [percent,setPercent] = useState("40");
  const [casheaReference,setCasheaReference] = useState("");
  const [dueDate,setDueDate] = useState("");
  const [sale,setSale] = useState<CasheaSale|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");

  async function load() {
    const [o,i,p,r,c] = await Promise.all([
      supabase.from("orders").select("status,order_number,customer_id").eq("id",orderId).single(),
      supabase.from("order_items").select("charged_ves_amount,charged_ref_amount").eq("order_id",orderId),
      supabase.from("payments").select("id,value_ves").eq("order_id",orderId),
      supabase.rpc("get_current_rates"),
      supabase.from("cashea_sales").select("id,status,initial_percent,gross_ref,initial_ref,financed_ref,commission_ref").eq("order_id",orderId).maybeSingle(),
    ]);
    const e=o.error||i.error||p.error||r.error||c.error;
    if(e){setError(e.message);return;}
    setStatus(o.data.status); setOrderNumber(o.data.order_number); setCustomerId(o.data.customer_id);
    setTotalVes((i.data??[]).reduce((a:number,x:any)=>a+Number(x.charged_ves_amount||0),0));
    setTotalRef((i.data??[]).reduce((a:number,x:any)=>a+Number(x.charged_ref_amount||0),0));
    setPaidVes((p.data??[]).reduce((a:number,x:any)=>a+Number(x.value_ves||0),0)); setPaymentCount((p.data??[]).length);
    const rr=Array.isArray(r.data)?r.data[0]:r.data; setBcv(Number(rr?.bcv_rate??0));
    setSale(c.data?{...c.data,initial_percent:Number(c.data.initial_percent),gross_ref:Number(c.data.gross_ref),initial_ref:Number(c.data.initial_ref),financed_ref:Number(c.data.financed_ref),commission_ref:Number(c.data.commission_ref)} as CasheaSale:null);
  }
  useEffect(()=>{load();},[orderId]);

  const remainingVes=Math.max(totalVes-paidVes,0);
  const remainingRef=bcv>0?remainingVes/bcv:0;
  const pct=Number(percent);
  const casheaInitialRef=Number.isFinite(pct)?totalRef*pct/100:0;
  const casheaFinancedRef=Math.max(totalRef-casheaInitialRef,0);
  const installmentRef=casheaFinancedRef/3;
  const commissionRef=totalRef*.04;
  const canFinalize=status==="OPEN"&&totalRef>0;

  async function finishDirect(){
    if(!canFinalize||busy)return; setBusy(true);setError("");
    const {error}=remainingVes>1?await supabase.rpc("close_order_with_full_payment",{p_order_id:orderId,p_method:method,p_reference:reference.trim()||null}):await supabase.rpc("close_order",{p_order_id:orderId});
    setBusy(false); if(error)return setError(error.message); router.push(`/orders/${orderId}/receipt`);router.refresh();
  }
  async function finishCredit(){
    if(!canFinalize||!customerId||busy)return; setBusy(true);setError("");
    const {error}=await supabase.rpc("close_order_with_credit",{p_order_id:orderId,p_due_date:dueDate||null});
    setBusy(false);if(error)return setError(error.message);router.push(`/orders/${orderId}/receipt`);router.refresh();
  }
  async function finishCashea(){
    if(!canFinalize||paymentCount>0||!Number.isFinite(pct)||pct<=0||pct>=100||busy)return; setBusy(true);setError("");
    const {error}=await supabase.rpc("close_order_with_cashea",{p_order_id:orderId,p_initial_percent:pct,p_initial_payment_method:method,p_payment_reference:reference.trim()||null,p_cashea_reference:casheaReference.trim()||null});
    setBusy(false);if(error)return setError(error.message);router.push(`/orders/${orderId}/receipt`);router.refresh();
  }

  if(sale) return <section className="card stack" style={{borderColor:"rgba(124,92,255,.5)"}}><div className="row-between"><div><div className="eyebrow">CASHEA · {orderNumber}</div><strong>{sale.status==="SETTLED"?"Liquidado":"Financiamiento activo"}</strong></div><span className="pill ok">{sale.initial_percent}% inicial</span></div><div className="grid grid-3"><div><div className="muted small">VENTA</div><strong>{fmtRef(sale.gross_ref)}</strong></div><div><div className="muted small">INICIAL</div><strong>{fmtRef(sale.initial_ref)}</strong></div><div><div className="muted small">POR RECIBIR</div><strong>{fmtRef(sale.financed_ref)}</strong></div></div><Link className="btn btn-ghost btn-block" href="/cashea">Seguimiento Cashea</Link></section>;
  if(status!=="OPEN") return null;

  return <section className="card stack" style={{borderColor:"rgba(255,93,21,.55)"}}>
    <div className="row-between"><div><div className="eyebrow">FINALIZAR ORDEN</div><h2 className="section-title" style={{marginBottom:2}}>Cobrar y cerrar</h2><div className="muted small">Un solo paso final. Elige cómo se liquida la orden.</div></div><div style={{textAlign:"right"}}><div className="money-lg">{fmtRef(totalRef)}</div><div className="muted small">Pendiente {fmtVes(remainingVes)}</div></div></div>
    <div className="segmented"><button className={`btn ${mode==="DIRECT"?"btn-primary":"btn-ghost"}`} onClick={()=>setMode("DIRECT")}>Pago completo</button><button className={`btn ${mode==="CASHEA"?"btn-primary":"btn-ghost"}`} onClick={()=>setMode("CASHEA")}>Cashea</button><button className={`btn ${mode==="CREDIT"?"btn-primary":"btn-ghost"}`} onClick={()=>setMode("CREDIT")}>Crédito LC</button></div>

    {mode==="DIRECT"&&<div className="stack"><div className="muted small">Si todavía falta saldo, se registra este pago por el monto exacto pendiente y la OS se cierra inmediatamente.</div><label><span className="label">Forma de pago final</span><select className="select" value={method} onChange={e=>setMethod(e.target.value as PaymentMethod)}>{METHODS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><input className="input" value={reference} onChange={e=>setReference(e.target.value)} placeholder="Referencia opcional"/><button className="btn btn-primary btn-block" style={{minHeight:56}} disabled={!canFinalize||busy} onClick={finishDirect}>{busy?"Cerrando…":remainingVes>1?`Cobrar ${fmtVes(remainingVes)} y cerrar`:`Cerrar orden ahora`}</button></div>}

    {mode==="CASHEA"&&<div className="stack"><div className="grid grid-3">{[40,50,60].map(v=><button key={v} className={`btn ${pct===v?"btn-primary":""}`} onClick={()=>setPercent(String(v))}>{v}%</button>)}</div><label><span className="label">Inicial personalizada</span><input className="input" type="number" min="1" max="99" step="0.01" value={percent} onChange={e=>setPercent(e.target.value)}/></label><label><span className="label">Cómo recibiste la inicial</span><select className="select" value={method} onChange={e=>setMethod(e.target.value as PaymentMethod)}>{METHODS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><input className="input" value={reference} onChange={e=>setReference(e.target.value)} placeholder="Referencia del pago inicial · opcional"/><input className="input" value={casheaReference} onChange={e=>setCasheaReference(e.target.value)} placeholder="Referencia / operación Cashea · opcional"/><div className="card stack"><div className="row-between"><span>Inicial</span><strong>{fmtRef(casheaInitialRef)}</strong></div><div className="row-between"><span>Saldo Cashea</span><strong>{fmtRef(casheaFinancedRef)}</strong></div><div className="row-between"><span>3 cuotas estimadas</span><strong>{fmtRef(installmentRef)} c/u</strong></div><div className="row-between"><span>Comisión 4%</span><strong>{fmtRef(commissionRef)}</strong></div></div>{paymentCount>0&&<div className="error">Para usar Cashea elimina primero los pagos ya cargados. La inicial se registra automáticamente al confirmar.</div>}<button className="btn btn-primary btn-block" style={{minHeight:56}} disabled={!canFinalize||busy||paymentCount>0||pct<=0||pct>=100} onClick={finishCashea}>{busy?"Registrando Cashea…":`Registrar Cashea y cerrar · ${pct||0}% inicial`}</button></div>}

    {mode==="CREDIT"&&<div className="stack"><div className="muted small">Cierra la OS y deja el saldo real pendiente en Crédito LC.</div><label><span className="label">Fecha esperada · opcional</span><input className="input" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>{!customerId&&<div className="error">Crédito LC requiere un cliente asociado.</div>}<button className="btn btn-primary btn-block" style={{minHeight:56}} disabled={!canFinalize||busy||!customerId||remainingVes<=1} onClick={finishCredit}>{busy?"Cerrando…":`Cerrar con Crédito LC · ${fmtRef(remainingRef)}`}</button></div>}

    {error&&<div className="error">{error}</div>}
  </section>;
}

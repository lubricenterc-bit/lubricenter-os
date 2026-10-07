"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtDate, fmtVes, fmtRate } from "@/lib/format";
import { ReceiptPrintButton } from "@/components/receipt-print-button";

type Run = { payroll_version:number;commission_usd:number;commission_ves:number;commission_hard_usd:number|null;commission_bcv_usd:number|null; id: string; employee_id: string; period_start: string; period_end: string; fixed_ref: number; variable_ref: number; adjustments_ref: number; total_ref: number; status: string; created_at: string };
type SalaryPayment = {id:string;paid_on:string;salary_ref:number;bcv_rate:number;bcv_effective_at:string;amount_ves:number;reference:string|null};
type Account = {id:string;name:string;account_type:string;currency:string};
type PayrollPayment={id:string;paid_on:string;currency:string;amount_original:number;usd_equivalent:number;bcv_rate:number|null;reference:string|null;note:string|null;payment_mode:string};
const today = () => new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas"}).format(new Date());
export default function PayrollReceipt() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [name, setName] = useState("");
  const [lines, setLines] = useState<{id:string;description:string;amount_ref:number}[]>([]);
  const [work,setWork]=useState<any[]>([]);
  const [error, setError] = useState("");
  const [salaryPayment,setSalaryPayment]=useState<SalaryPayment|null>(null);
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [payments,setPayments]=useState<PayrollPayment[]>([]);
  const [payAmount,setPayAmount]=useState("");
  const [payNote,setPayNote]=useState("");
  const [paymentDate,setPaymentDate]=useState(today);
  const [accountId,setAccountId]=useState("");
  const [reference,setReference]=useState("");
  const [rate,setRate]=useState<{value:number;effective_at:string}|null>(null);
  const [saving,setSaving]=useState(false);
  useEffect(() => { (async () => {
    const r = await supabase.from("payroll_runs").select("*").eq("id", id).single();
    if (r.error) return setError(r.error.message);
    const [e,a,j,p,accountsResult,paymentsResult] = await Promise.all([
      supabase.from("employees").select("name").eq("id",r.data.employee_id).single(),
      supabase.from("payroll_accruals").select("id,description,amount_ref").eq("payroll_run_id",id).order("occurred_at"),
      supabase.from("payroll_adjustments").select("id,note,adjustment_type,amount_ref").eq("payroll_run_id",id).order("occurred_on"),
      supabase.from("payroll_salary_payments").select("id,paid_on,salary_ref,bcv_rate,bcv_effective_at,amount_ves,reference").eq("payroll_run_id",id).maybeSingle(),
      supabase.from("financial_accounts").select("id,name,account_type,currency").eq("active",true).in("account_type",["BANK","CASH","CLEARING"]).in("currency",["USD","VES"]).order("currency").order("name"),
      supabase.from("payroll_payments").select("id,paid_on,currency,amount_original,usd_equivalent,bcv_rate,reference,note,payment_mode").eq("payroll_run_id",id).order("paid_on"),
    ]);
    if (e.error || a.error || j.error || p.error || accountsResult.error || paymentsResult.error) return setError((e.error || a.error || j.error || p.error || accountsResult.error || paymentsResult.error)!.message);
    if(r.data.payroll_version>=2){const w=await supabase.from("payroll_work_items").select("*").eq("payroll_run_id",id).order("earned_at");if(w.error)return setError(w.error.message);setWork(w.data??[]);}
    setRun(r.data); setName(e.data.name); setSalaryPayment(p.data);setAccounts(accountsResult.data??[]);setAccountId(accountsResult.data?.[0]?.id??"");setPayments(paymentsResult.data??[]);
    setLines([...(a.data ?? []).map(x=>({...x,description:x.description || "Comisión"})),...(j.data ?? []).map(x=>({id:x.id,description:x.note || x.adjustment_type,amount_ref:x.amount_ref}))]);
  })(); },[id]);
  useEffect(()=>{let active=true;setRate(null);void supabase.from("exchange_rates").select("value,effective_at").eq("rate_type","BCV").lte("effective_at",`${paymentDate}T23:59:59-04:00`).order("effective_at",{ascending:false}).limit(1).then(({data})=>{if(active&&data?.[0])setRate({value:Number(data[0].value),effective_at:data[0].effective_at});});return()=>{active=false;};},[paymentDate]);
  async function registerSalaryPayment(){if(!run||!rate)return;setSaving(true);setError("");const {error:paymentError}=await supabase.rpc("payroll_record_salary_payment",{p_run_id:run.id,p_account_id:accountId,p_paid_on:paymentDate,p_reference:reference.trim()||null});if(paymentError){setError(paymentError.message);setSaving(false);return;}const result=await supabase.from("payroll_salary_payments").select("id,paid_on,salary_ref,bcv_rate,bcv_effective_at,amount_ves,reference").eq("payroll_run_id",run.id).single();setSaving(false);if(result.error)return setError(result.error.message);setSalaryPayment(result.data);}
  const paidUsd=payments.reduce((sum,p)=>sum+Number(p.usd_equivalent||0),0);
  const outstanding=run?Math.max(Number(run.total_ref)-paidUsd,0):0;
  const selectedAccount=accounts.find(a=>a.id===accountId);
  async function registerPayrollPayment(){if(!run||!selectedAccount||!Number(payAmount))return;setSaving(true);setError("");const {error:paymentError}=await supabase.rpc("payroll_record_payment",{p_run_id:run.id,p_account_id:accountId,p_paid_on:paymentDate,p_amount_original:Number(payAmount),p_reference:reference.trim()||null,p_note:payNote.trim()||null});if(paymentError){setError(paymentError.message);setSaving(false);return;}const result=await supabase.from("payroll_payments").select("id,paid_on,currency,amount_original,usd_equivalent,bcv_rate,reference,note,payment_mode").eq("payroll_run_id",run.id).order("paid_on");setSaving(false);if(result.error)return setError(result.error.message);setPayments(result.data??[]);setPayAmount("");setReference("");setPayNote("");}
  return <main className="receipt-screen">
    <div className="receipt-actions no-print"><Link className="btn" href="/payroll">Volver a nómina</Link>{run && <ReceiptPrintButton />}</div>
    {error && <div className="error" role="alert">{error}</div>}
    {!run && !error && <p>Preparando recibo…</p>}
    {work.length>0&&<details className="no-print card"><summary>Detalle de trabajos y motivos de ajustes</summary>{work.map(w=><div className="card" key={w.id}><Link href={`/orders/${w.order_id}`}>{w.order_number}</Link> · {w.description}<div>Obligación: {w.decision==="EXCLUDE"?"$0.00":`${Number(w.obligation_usd??0).toFixed(2)}`} · {w.payout_mode==='HARD_USD'?'USD reales':'Bs a BCV del pago'} · {w.decision==="EXCLUDE"?"Excluido":"Liquidado"}</div>{w.reason&&<div>Motivo: {w.reason}</div>}</div>)}</details>}
    {run?.payroll_version===2&&Number(run.fixed_ref)>0&&<section className="no-print card stack" style={{marginBottom:16}}><h2>Pago del sueldo fijo</h2>{salaryPayment?<p>Pagado el {salaryPayment.paid_on}: <strong>{fmtRef(salaryPayment.salary_ref)} × BCV {fmtRate(salaryPayment.bcv_rate)} = {fmtVes(salaryPayment.amount_ves)}</strong>. Referencia: {salaryPayment.reference||"efectivo"}.</p>:<><p className="muted">La liquidación conserva el sueldo en dólares de referencia. Registra el pago cuando lo hagas para congelar la tasa BCV y la salida en Bs.</p><label><span className="label">Día en que se pagó</span><input className="input" type="date" max={today()} value={paymentDate} onChange={e=>setPaymentDate(e.target.value)}/></label><div>{rate?`${fmtRef(run.fixed_ref)} × BCV ${fmtRate(rate.value)} = ${fmtVes(Number(run.fixed_ref)*rate.value)} · tasa publicada ${new Date(rate.effective_at).toLocaleDateString("es-VE",{timeZone:"America/Caracas"})}`:"Sin tasa BCV disponible para esa fecha"}</div><label><span className="label">Cuenta de pago en Bs</span><select className="select" value={accountId} onChange={e=>setAccountId(e.target.value)}><option value="">Selecciona cuenta</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label><span className="label">Referencia bancaria</span><input className="input" value={reference} onChange={e=>setReference(e.target.value)} placeholder="Últimos 4 dígitos si fue pago móvil"/></label><button className="btn btn-primary" disabled={saving||!rate||!accountId||((accounts.find(a=>a.id===accountId)?.account_type)==="BANK"&&reference.replace(/\D/g,"").length<4)} onClick={registerSalaryPayment}>Registrar pago real en Bs</button></>}</section>}
    {run && <article className="receipt-paper"><header className="receipt-header"><img src="/lubricenter-logo.png" alt="Lubricenter" /><div className="receipt-brand">LUBRICENTER</div><div>{run.payroll_version===2&&Number(run.fixed_ref)>0&&!salaryPayment?"LIQUIDACIÓN DE NÓMINA":"RECIBO DE NÓMINA"}</div></header>
      <div className="receipt-title-row" style={{display:"block"}}><h1>{name}</h1><div>{run.period_start.slice(0,10)} al {run.period_end.slice(0,10)}</div><div>Liquidación: {fmtDate(run.created_at)}</div><div>Ref. {run.id.slice(0,8).toUpperCase()}</div><strong>{run.payroll_version===2&&Number(run.fixed_ref)>0&&!salaryPayment?"SUELDO FIJO PENDIENTE DE REGISTRO":run.status === "SETTLED" ? "LIQUIDADA" : run.status}</strong></div>
      <section className="receipt-lines">{work.map(w=><div className="payroll-receipt-line" key={w.id}><span>{w.order_number} · {w.description}{w.decision==="EXCLUDE"?" · EXCLUIDO":""}</span><strong>{w.decision==="EXCLUDE"?"$0.00":`${Number(w.obligation_usd??0).toFixed(2)} · ${w.payout_mode==='HARD_USD'?'USD':'Bs a BCV'}`}</strong></div>)}{lines.map(l=><div className="payroll-receipt-line" key={l.id}><span>{l.description}</span><strong>{fmtRef(l.amount_ref)}</strong></div>)}</section>
      <section className="receipt-payments"><div className="payroll-receipt-line"><span>Sueldo fijo REF</span><strong>{fmtRef(run.fixed_ref)}</strong></div>{salaryPayment&&<><div className="payroll-receipt-line"><span>BCV del pago · {salaryPayment.paid_on}</span><strong>{fmtRate(salaryPayment.bcv_rate)}/$</strong></div><div className="payroll-receipt-line"><strong>Sueldo fijo pagado</strong><strong>{fmtVes(salaryPayment.amount_ves)}</strong></div></>}{run.payroll_version===3?<><div className="payroll-receipt-line"><strong>Comisiones totales</strong><strong>${Number(run.variable_ref).toFixed(2)}</strong></div><div className="payroll-receipt-line"><span>A pagar en USD</span><strong>${Number(run.commission_hard_usd??0).toFixed(2)}</strong></div><div className="payroll-receipt-line"><span>A pagar en Bs a BCV del día</span><strong>${Number(run.commission_bcv_usd??0).toFixed(2)}</strong></div><div className="payroll-receipt-line"><span>Ajustes separados REF</span><strong>{fmtRef(run.adjustments_ref)}</strong></div></>:run.payroll_version===2?<><div className="payroll-receipt-line"><strong>Comisiones USD</strong><strong>${Number(run.commission_usd).toFixed(2)}</strong></div><div className="payroll-receipt-line"><strong>Comisiones Bs</strong><strong>{fmtVes(run.commission_ves)}</strong></div><div className="payroll-receipt-line"><span>Ajustes separados REF</span><strong>{fmtRef(run.adjustments_ref)}</strong></div></>:<><div className="payroll-receipt-line"><span>Comisiones REF</span><strong>{fmtRef(run.variable_ref)}</strong></div><div className="payroll-receipt-line"><span>Ajustes REF</span><strong>{fmtRef(run.adjustments_ref)}</strong></div><div className="payroll-receipt-line"><strong>TOTAL REF</strong><strong>{fmtRef(run.total_ref)}</strong></div></>}</section>
      <div className="receipt-footer">{run.payroll_version===2&&Number(run.fixed_ref)>0&&!salaryPayment?"Revisado por":"Recibido por"}: __________________<br /><br />Documento interno · Lubricenter</div>
    </article>}
  </main>;
}
"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtDate, fmtVes } from "@/lib/format";
import { ReceiptPrintButton } from "@/components/receipt-print-button";

type Run = { payroll_version:number;commission_usd:number;commission_ves:number; id: string; employee_id: string; period_start: string; period_end: string; fixed_ref: number; variable_ref: number; adjustments_ref: number; total_ref: number; status: string; created_at: string };
export default function PayrollReceipt() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [name, setName] = useState("");
  const [lines, setLines] = useState<{id:string;description:string;amount_ref:number}[]>([]);
  const [work,setWork]=useState<any[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { (async () => {
    const r = await supabase.from("payroll_runs").select("*").eq("id", id).single();
    if (r.error) return setError(r.error.message);
    const [e,a,j] = await Promise.all([
      supabase.from("employees").select("name").eq("id",r.data.employee_id).single(),
      supabase.from("payroll_accruals").select("id,description,amount_ref").eq("payroll_run_id",id).order("occurred_at"),
      supabase.from("payroll_adjustments").select("id,note,adjustment_type,amount_ref").eq("payroll_run_id",id).order("occurred_on"),
    ]);
    if (e.error || a.error || j.error) return setError((e.error || a.error || j.error)!.message);
    if(r.data.payroll_version===2){const w=await supabase.from("payroll_work_items").select("*").eq("payroll_run_id",id).order("earned_at");if(w.error)return setError(w.error.message);setWork(w.data??[]);}
    setRun(r.data); setName(e.data.name);
    setLines([...(a.data ?? []).map(x=>({...x,description:x.description || "Comisión"})),...(j.data ?? []).map(x=>({id:x.id,description:x.note || x.adjustment_type,amount_ref:x.amount_ref}))]);
  })(); },[id]);
  return <main className="receipt-screen">
    <div className="receipt-actions no-print"><Link className="btn" href="/payroll">Volver a nómina</Link>{run && <ReceiptPrintButton />}</div>
    {error && <div className="error" role="alert">{error}</div>}
    {!run && !error && <p>Preparando recibo…</p>}
    {work.length>0&&<details className="no-print card"><summary>Detalle de trabajos y motivos de ajustes</summary>{work.map(w=><div className="card" key={w.id}><Link href={`/orders/${w.order_id}`}>{w.order_number}</Link> · {w.description}<div>Original: {w.original_amount} {w.currency} · Final: {w.decision==="EXCLUDE"?0:w.amount} {w.currency} · {w.decision==="EXCLUDE"?"Excluido":"Liquidado"}</div>{w.reason&&<div>Motivo: {w.reason}</div>}</div>)}</details>}
    {run && <article className="receipt-paper"><header className="receipt-header"><img src="/lubricenter-logo.png" alt="Lubricenter" /><div className="receipt-brand">LUBRICENTER</div><div>RECIBO DE NÓMINA</div></header>
      <div className="receipt-title-row" style={{display:"block"}}><h1>{name}</h1><div>{run.period_start.slice(0,10)} al {run.period_end.slice(0,10)}</div><div>Liquidación: {fmtDate(run.created_at)}</div><div>Ref. {run.id.slice(0,8).toUpperCase()}</div><strong>{run.status === "SETTLED" ? "LIQUIDADA" : run.status}</strong></div>
      <section className="receipt-lines">{work.map(w=><div className="payroll-receipt-line" key={w.id}><span>{w.order_number} · {w.description}{w.decision==="EXCLUDE"?" · EXCLUIDO":""}</span><strong>{w.decision==="EXCLUDE"?"0":w.currency==="USD"?`${Number(w.amount).toFixed(2)} USD`:fmtVes(w.amount)}</strong></div>)}{lines.map(l=><div className="payroll-receipt-line" key={l.id}><span>{l.description}</span><strong>{fmtRef(l.amount_ref)}</strong></div>)}</section>
      <section className="receipt-payments"><div className="payroll-receipt-line"><span>Sueldo fijo REF</span><strong>{fmtRef(run.fixed_ref)}</strong></div>{run.payroll_version===2?<><div className="payroll-receipt-line"><strong>Comisiones USD</strong><strong>${Number(run.commission_usd).toFixed(2)}</strong></div><div className="payroll-receipt-line"><strong>Comisiones Bs</strong><strong>{fmtVes(run.commission_ves)}</strong></div><div className="payroll-receipt-line"><span>Ajustes separados REF</span><strong>{fmtRef(run.adjustments_ref)}</strong></div></>:<><div className="payroll-receipt-line"><span>Comisiones REF</span><strong>{fmtRef(run.variable_ref)}</strong></div><div className="payroll-receipt-line"><span>Ajustes REF</span><strong>{fmtRef(run.adjustments_ref)}</strong></div><div className="payroll-receipt-line"><strong>TOTAL REF</strong><strong>{fmtRef(run.total_ref)}</strong></div></>}</section>
      <div className="receipt-footer">Recibido por: __________________<br /><br />Documento interno · Lubricenter</div>
    </article>}
  </main>;
}


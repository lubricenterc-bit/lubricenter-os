"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtDate } from "@/lib/format";
import { ReceiptPrintButton } from "@/components/receipt-print-button";

type Run = { id: string; employee_id: string; period_start: string; period_end: string; fixed_ref: number; variable_ref: number; adjustments_ref: number; total_ref: number; status: string; created_at: string };
export default function PayrollReceipt() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [name, setName] = useState("");
  const [lines, setLines] = useState<{id:string;description:string;amount_ref:number}[]>([]);
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
    setRun(r.data); setName(e.data.name);
    setLines([...(a.data ?? []).map(x=>({...x,description:x.description || "Comisión"})),...(j.data ?? []).map(x=>({id:x.id,description:x.note || x.adjustment_type,amount_ref:x.amount_ref}))]);
  })(); },[id]);
  return <main className="receipt-screen">
    <div className="receipt-actions no-print"><Link className="btn" href="/payroll">Volver a nómina</Link>{run && <ReceiptPrintButton />}</div>
    {error && <div className="error" role="alert">{error}</div>}
    {!run && !error && <p>Preparando recibo…</p>}
    {run && <article className="receipt-paper"><header className="receipt-header"><img src="/lubricenter-logo.png" alt="Lubricenter" /><div className="receipt-brand">LUBRICENTER</div><div>RECIBO DE NÓMINA</div></header>
      <div className="receipt-title-row"><h1>{name}</h1><div>{run.period_start} al {run.period_end}</div><div>Liquidación: {fmtDate(run.created_at)}</div><div>Ref. {run.id.slice(0,8).toUpperCase()}</div><strong>{run.status === "SETTLED" ? "LIQUIDADA" : run.status}</strong></div>
      <section className="receipt-lines">{lines.map(l=><div className="payroll-receipt-line" key={l.id}><span>{l.description}</span><strong>{fmtRef(l.amount_ref)}</strong></div>)}</section>
      <section className="receipt-payments"><div className="payroll-receipt-line"><span>Sueldo fijo</span><strong>{fmtRef(run.fixed_ref)}</strong></div><div className="payroll-receipt-line"><span>Comisiones</span><strong>{fmtRef(run.variable_ref)}</strong></div><div className="payroll-receipt-line"><span>Ajustes / deducciones</span><strong>{fmtRef(run.adjustments_ref)}</strong></div><div className="payroll-receipt-line"><strong>TOTAL LIQUIDADO</strong><strong>{fmtRef(run.total_ref)}</strong></div></section>
      <div className="receipt-footer">Recibido por: __________________<br /><br />Documento interno · Lubricenter</div>
    </article>}
  </main>;
}


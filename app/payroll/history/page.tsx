"use client";

import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import {supabase} from "@/lib/supabase";

type Change={occurred_at:string;reason:string|null;before_decision:string|null;after_decision:string|null;before_amount:string|null;after_amount:string|null;before_reason:string|null;after_reason:string|null};
type Work={id:string;order_id:string;order_number:string;description:string;earned_at:string;source_type:string;payout_mode:string|null;decision_at_settlement:string;reason_at_settlement:string|null;amount_at_settlement:number;late_posting:boolean;carried_from_prior_week:boolean;settled_in_this_run:boolean;timeline:Change[]};
type Adjustment={id:string;type:string;amount_ref:number;note:string;decision:string;occurred_on:string;included_in_run:boolean;late_posting:boolean};
type Advance={id:string;paid_on:string;usd_equivalent:number;applied_usd:number;currency:string;amount_original:number;account_code:string;reference:string|null;note:string;movement_id:string};
type Payment={id:string;paid_on:string;currency:string;amount_original:number;usd_equivalent:number;payment_mode:string;component:string|null;reference:string|null;note:string|null;account_code:string|null;ledger_movement_id:string|null};
type AdminRun={id:string;employee_id:string;employee_name:string;period_start:string;period_end:string;created_at:string;fixed_ref:number;variable_ref:number;adjustments_ref:number;total_ref:number;paid_usd:number;advances_applied_usd:number;advances:Advance[];outstanding_usd:number;work:Work[];adjustments:Adjustment[];payments:Payment[];admin_snapshot:any|null};
type WeekReport={start:string;end:string;runs:AdminRun[]};
type RunOption={period_end:string;employee_id:string};
function dateOnly(value:string){return new Date(value).toLocaleString("es-VE",{timeZone:"America/Caracas",year:"numeric",month:"short",day:"numeric"});}
const usd=(n:number)=>"$"+Number(n||0).toFixed(2);
function statusOf(w:Work){return ({PAY:"Incluido / a pagar",HOLD:"Prorrogado (no pagado)",EXCLUDE:"Excluido (no pagado)",LATE_POSTING:"Registrado después del cierre"} as Record<string,string>)[w.decision_at_settlement]||w.decision_at_settlement;}
function fileCsv(report:WeekReport,run:AdminRun){
 const columns=["Semana","Empleado","Tipo","Orden","Descripción","Decisión al liquidar","Monto USD","Motivo","Fecha"];
 const rows=[
 ...run.work.map(w=>[report.start+"–"+report.end,run.employee_name,"Trabajo",w.order_number,w.description,statusOf(w),w.amount_at_settlement,w.reason_at_settlement||"",w.earned_at]),
 ...run.adjustments.map(a=>[report.start+"–"+report.end,run.employee_name,"Ajuste","",a.type,a.late_posting?"Registrado después del cierre":a.decision,a.included_in_run?a.amount_ref:0,a.note,a.occurred_on]),
 ...run.advances.map(a=>[report.start+"–"+report.end,run.employee_name,"Anticipo",a.account_code,a.note,"Entregado antes de liquidar",a.applied_usd,a.reference||"",a.paid_on]),
 ...run.payments.map(p=>[report.start+"–"+report.end,run.employee_name,"Pago",p.account_code||"",p.component||p.payment_mode,p.payment_mode,p.usd_equivalent,p.note||"",p.paid_on])
 ];
 const csv=[columns,...rows].map(row=>row.map(s=>'"'+String(s??"").replaceAll('"','""')+'"').join(",")).join("\r\n");
 const blob=new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"});
 const url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download=`nomina-administrativa-${run.employee_name.replace(/\s/g,"-")}-${report.end}.csv`;
 document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}

export default function PayrollHistory(){
 const [weeks,setWeeks]=useState<string[]>([]),[week,setWeek]=useState(""),[report,setReport]=useState<WeekReport|null>(null);
 const [error,setError]=useState(""),[loading,setLoading]=useState(true),[authorized,setAuthorized]=useState(false),[employee,setEmployee]=useState("ALL");
 useEffect(()=>{let active=true;(async()=>{try{
  const auth=await supabase.rpc("can_administer_orders");
  if(auth.error||auth.data!==true)throw new Error("Solo administración puede consultar el historial interno de nómina.");
  const r=await supabase.from("payroll_runs").select("period_end,employee_id").eq("status","SETTLED").order("period_end",{ascending:false}).limit(150);
  if(r.error)throw r.error;
  const available=Array.from(new Set((r.data??[] as RunOption[]).map(x=>x.period_end)));
  if(active){setAuthorized(true);setWeeks(available);setWeek(available[0]||"");if(!available.length)setLoading(false);}
 }catch(e){if(active){setError((e as Error).message);setLoading(false);}}})();return()=>{active=false;};},[]);
 useEffect(()=>{if(!authorized||!week)return;let active=true;setLoading(true);setError("");
  void (async()=>{const r=await supabase.rpc("payroll_admin_week_history",{p_end:week});
   if(!active)return;
   if(r.error){setError(r.error.message);setReport(null);}
   else setReport(r.data as WeekReport);setLoading(false);
  })();return()=>{active=false;};
 },[authorized,week]);
 const visible=useMemo(()=>report?.runs.filter(r=>employee==="ALL"||r.employee_id===employee)??[],[report,employee]);
 return <main className="container stack">
  <div className="row-between"><div><div className="eyebrow">CONTABILIDAD INTERNA · SOLO ADMINISTRACIÓN</div><h1>Historial administrativo de nómina</h1>
   <p className="muted">Registra cómo se llegó a cada liquidación: trabajo incluido, prorrogado, excluido, ajustes, pagos y modificaciones posteriores. No sustituye al recibo del empleado.</p></div>
   <Link className="btn" href="/payroll">Volver a nómina</Link></div>
  {error&&<div className="error" role="alert">{error}</div>}
  {authorized&&<section className="card stack">
    <div className="row" style={{flexWrap:"wrap"}}>
      <label><span className="label">Semana liquidada</span><select className="select" value={week} onChange={e=>{setWeek(e.target.value);setEmployee("ALL");}}>
       {weeks.map(d=><option key={d} value={d}>Cierre {d}</option>)}</select></label>
      {report&&<label><span className="label">Empleado</span><select className="select" value={employee} onChange={e=>setEmployee(e.target.value)}>
        <option value="ALL">Todos</option>{report.runs.map(r=><option key={r.id} value={r.employee_id}>{r.employee_name}</option>)}
       </select></label>}
    </div>
    {report&&<div className="muted small">Semana {report.start} al {report.end} · {report.runs.length} liquidación(es) · lo registrado después se muestra separado del cierre original.</div>}
   </section>}
  {loading&&<p className="muted">Cargando evidencia administrativa…</p>}
  {!loading&&authorized&&weeks.length===0&&<section className="card">Todavía no hay liquidaciones registradas.</section>}
  {!loading&&report&&visible.map(run=>{
    const held=run.work.filter(w=>w.decision_at_settlement==="HOLD");
    const excluded=run.work.filter(w=>w.decision_at_settlement==="EXCLUDE");
    const late=run.work.filter(w=>w.late_posting);
    const included=run.work.filter(w=>w.decision_at_settlement==="PAY"&&!w.late_posting);
    const carried=included.filter(w=>w.carried_from_prior_week);
    return <section className="card stack" key={run.id}>
      <div className="row-between" style={{flexWrap:"wrap"}}>
       <div><h2>{run.employee_name}</h2><div className="muted small">Liquidado: {dateOnly(run.created_at)} · ref. {run.id.slice(0,8).toUpperCase()}</div></div>
       <div className="row" style={{flexWrap:"wrap"}}><Link className="btn" href={`/payroll/${run.id}/receipt`}>Factura / pagos</Link>
        <button className="btn" onClick={()=>fileCsv(report,run)}>Exportar historial CSV</button></div>
      </div>
      <div className="grid grid-3">
       <div className="card"><span className="muted small">Total liquidado</span><strong>{usd(run.total_ref)}</strong></div>
       <div className="card"><span className="muted small">Pagado registrado</span><strong>{usd(run.paid_usd)}</strong></div>
       <div className="card"><span className="muted small">Anticipos aplicados</span><strong>{usd(run.advances_applied_usd||0)}</strong></div><div className="card"><span className="muted small">Saldo pendiente</span><strong>{usd(run.outstanding_usd)}</strong></div>
      </div>
      <div className="muted small">Sueldo fijo {usd(run.fixed_ref)} · comisiones {usd(run.variable_ref)} · ajustes netos {usd(run.adjustments_ref)}</div>
      <div><strong>¿Qué se hizo esta semana?</strong><p className="muted small">
       {included.length} trabajo(s) incluidos · {held.length} prorrogados · {excluded.length} excluidos · {late.length} contabilizados posteriormente.
       {carried.length>0?` ${carried.length} comisión(es) trasladadas de períodos anteriores.`:""}
      </p></div>
      <details open><summary><strong>Detalle de todos los trabajos ({run.work.length})</strong></summary>
       <div className="stack" style={{marginTop:12}}>{run.work.map(w=><article className="card stack" key={w.id}>
         <div className="row-between" style={{flexWrap:"wrap"}}><div><Link href={`/orders/${w.order_id}`}><strong>{w.order_number}</strong></Link> · {w.description}</div>
          <strong>{usd(w.amount_at_settlement)}</strong></div>
         <div>{statusOf(w)}{w.carried_from_prior_week?" · Arrastrado de semana anterior":""}</div>
         {w.reason_at_settlement&&<div className="muted small">Motivo: {w.reason_at_settlement}</div>}
         <div className="muted small">Trabajo: {dateOnly(w.earned_at)} · modalidad {w.payout_mode==="HARD_USD"?"Divisas":"Bolívares BCV"}</div>
         {w.late_posting&&<div className="error">No formó parte de esta liquidación. Su comisión debe revisarse en el próximo período, sin modificar esta factura.</div>}
         {w.timeline.length>0&&<details><summary>Ver cada cambio ({w.timeline.length})</summary>
           <div className="stack" style={{marginTop:8}}>{w.timeline.map((h,i)=><div className="muted small" key={i}>
            <strong>{dateOnly(h.occurred_at)}:</strong> {h.before_decision||"Sin estado"} → {h.after_decision||"Sin estado"}
             {h.before_amount!==h.after_amount?` · ${usd(Number(h.before_amount||0))} → ${usd(Number(h.after_amount||0))}`:""}
             {h.reason?` · ${h.reason}`:""} {h.after_reason&&h.after_reason!==h.reason?` · Motivo final: ${h.after_reason}`:""}
           </div>)}</div></details>}
        </article>)}
        {run.work.length===0&&<p className="muted">Sin trabajos asociados a esta liquidación.</p>}</div>
      </details>
      <details><summary><strong>Bonos, descuentos y otras decisiones ({run.adjustments.length})</strong></summary>
       <div className="stack" style={{marginTop:10}}>
       {run.adjustments.map(a=><div className="card" key={a.id}><strong>{a.type} · {usd(a.amount_ref)}</strong>
        <div>{a.included_in_run?"Incluido en el cierre":a.late_posting?"Creado después del cierre":"No incluido en este cierre"} · {a.decision}</div>
        {a.note&&<div className="muted small">{a.note}</div>}</div>)}
       {run.adjustments.length===0&&<p className="muted">Sin ajustes.</p>}
       </div>
      </details>
      <details open><summary><strong>Anticipos (egresos separados) y pagos ({run.advances?.length||0} + {run.payments.length})</strong></summary>
       <div className="stack" style={{marginTop:10}}>{(run.advances||[]).map(a=><div className="card" key={a.id}>
   <strong>Anticipo entregado {a.paid_on} · aplicado {usd(a.applied_usd)}</strong>
   <div className="muted small">{a.account_code} · {a.currency==="VES"?"Bs ":"$"}{Number(a.amount_original).toFixed(2)} · Ref. {a.reference||"Sin referencia"}</div>
   <div>{a.note}</div><div className="muted small">Salida de caja registrada una sola vez; no se genera al liquidar.</div>
  </div>)}{run.payments.map(p=><div className="card" key={p.id}>
         <div className="row-between"><strong>{usd(p.usd_equivalent)} · {p.paid_on}</strong><span>{p.payment_mode==="HISTORICAL_MANUAL"?"Regularización histórica":"Pago registrado"}</span></div>
         <div className="muted small">{p.currency==="VES"?`Bs ${Number(p.amount_original).toFixed(2)}`:`${p.currency} ${Number(p.amount_original).toFixed(2)}`} · {p.account_code||"Sin cuenta de caja"} · Ref. {p.reference||"No aplica"}</div>
         {p.payment_mode==="HISTORICAL_MANUAL"&&<div className="muted small">No generó movimiento bancario retroactivo.</div>}
         {p.note&&<div>{p.note}</div>}</div>)}
         {run.payments.length===0&&<div className="error">Liquidación sin pagos registrados.</div>}</div>
      </details>
      <p className="muted small">{run.admin_snapshot?"Evidencia original del cierre conservada en un registro de auditoría inmutable.":"Liquidación anterior a la mejora: se reconstruye el historial utilizando los registros originales de nómina y sus cambios."}</p>
    </section>;
  })}
 </main>;
}

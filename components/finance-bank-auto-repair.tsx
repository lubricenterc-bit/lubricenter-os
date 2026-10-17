"use client";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
type Candidate={payment_id:string;order_id:string;order_number:string;external_transaction_id:string;
 recorded_account:string;actual_account:string;reference:string;recorded_ves:number;verified_ves:number;paid_at:string};
const fmt=(value:number)=>"Bs "+Number(value).toLocaleString("es-VE",{minimumFractionDigits:2,maximumFractionDigits:2});
export function FinanceBankAutoRepair({from,to,onApplied}:{from:string;to:string;onApplied:()=>Promise<void>}){
 const [rows,setRows]=useState<Candidate[]>([]);
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [notice,setNotice]=useState(""),[error,setError]=useState(""),[checked,setChecked]=useState(false);
 async function load(){
   setLoading(true);setError("");
   try{const r=await supabase.rpc("finance_exact_bank_mismatches",{p_from:from,p_to:to});
     if(r.error)throw r.error;setRows((r.data??[]) as Candidate[]);setChecked(true);
   }catch(e){setError((e as Error).message);}finally{setLoading(false);}
 }
 useEffect(()=>{setRows([]);setChecked(false);setNotice("");setError("");},[from,to]);
 async function apply(){
   if(busy||rows.length===0)return;
   setBusy(true);setError("");setNotice("");
   try{const r=await supabase.rpc("finance_autofix_bank_mismatches",{p_from:from,p_to:to});
     if(r.error)throw r.error;
     const data=r.data as {corrected:number;skipped:number;errors:{payment_id:string;error:string}[]};
     setNotice(`Bancos corregidos con evidencia: ${data.corrected}. No modificados: ${data.skipped}.`);
     if(data.errors?.length)setError(data.errors.map(x=>x.error).join(" · "));
     await load();await onApplied();
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="card stack">
   <h2 className="section-title">Corregir errores humanos de banco automáticamente</h2>
   <p className="muted small">Busca coincidencias únicas entre pago y extracto: misma referencia, importe con diferencia máxima de Bs 0,01 y fecha cercana. Si hay duplicados, varias coincidencias, conciliaciones previas o falta el extracto, no modifica nada.</p>
   <button className="btn" onClick={load} disabled={loading||busy}>
     {loading?"Buscando evidencia…":"Analizar pagos y bancos"}
   </button>
   {checked&&rows.length===0&&<p className="muted small">No hay errores de banco respaldados por una coincidencia bancaria única entre las fuentes importadas. Esto no significa que los extractos pendientes estén conciliados.</p>}
   {rows.length>0&&<>
     <div className="row-between"><strong>{rows.length} rectificación(es) segura(s) identificada(s)</strong><span className="pill">Esperando aprobación</span></div>
     {rows.map(row=><div className="row-between" key={row.payment_id}>
       <div><strong>{row.order_number}</strong><div className="muted small">Ref. {row.reference} · {row.recorded_account} → {row.actual_account}</div></div>
       <strong>{fmt(row.verified_ves)}</strong>
     </div>)}
     <button className="btn btn-primary" disabled={busy} onClick={apply}>
       {busy?"Corrigiendo…":`Aplicar las ${rows.length} correcciones verificadas`}
     </button>
   </>}
   {notice&&<div className="success" role="status">{notice}</div>}
   {error&&<div className="error" role="alert">{error}</div>}
 </section>;
}

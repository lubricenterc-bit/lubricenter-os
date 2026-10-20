"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { businessInstant,caracasInput } from "@/lib/order-admin";
export function OrderDateEditor({date,ensureOrder,onSaved}:{date?:string;ensureOrder:()=>Promise<string>;onSaved:(id:string)=>Promise<void>}) {
 const [value,setValue]=useState(caracasInput(date)),[busy,setBusy]=useState(false),[error,setError]=useState(""),[preview,setPreview]=useState("");
 useEffect(()=>{setValue(caracasInput(date));},[date]);
 useEffect(()=>{let active=true;setPreview('Buscando tasas…');supabase.rpc('get_exchange_rates_for_date',{p_date:value.slice(0,10)||null}).then(({data,error})=>{if(!active)return;const r=Array.isArray(data)?data[0]:data;setPreview(error?error.message:'BCV '+r.bcv_rate+' (desde '+r.bcv_date+') · Operativa '+r.operative_rate+' (desde '+r.operative_date+')');});return()=>{active=false;};},[value]);
 async function save(){setBusy(true);setError("");try{const id=await ensureOrder();const r=await supabase.rpc("set_order_date",{p_order_id:id,p_business_at:businessInstant(value)});if(r.error)throw r.error;await onSaved(id);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <details className="card"><summary>Fecha de atención / registrar una venta atrasada</summary><div className="stack"><label><span className="label">Fecha y hora de la venta · Venezuela</span><input type="datetime-local" className="input" value={value} max={caracasInput()} onChange={e=>setValue(e.target.value)}/></label><p className="muted small">Antes de cobrar, se aplican las tasas históricas y se recalculan los importes de la orden. Una orden con pagos requiere una corrección auditada para cambiar la fecha.</p><div className="muted small" role="status">{preview}</div>{error&&<div className="error" role="alert">{error}</div>}<button className="btn" disabled={busy||!value} onClick={save}>{busy?"Guardando…":"Guardar fecha de atención"}</button></div></details>;
}


"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { businessInstant,caracasInput } from "@/lib/order-admin";
export function OrderDateEditor({date,ensureOrder,onSaved}:{date?:string;ensureOrder:()=>Promise<string>;onSaved:(id:string)=>Promise<void>}) {
 const [value,setValue]=useState(caracasInput(date)),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{setValue(caracasInput(date));},[date]);
 async function save(){setBusy(true);setError("");try{const id=await ensureOrder();const r=await supabase.rpc("set_order_date",{p_order_id:id,p_business_at:businessInstant(value)});if(r.error)throw r.error;await onSaved(id);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <details className="card"><summary>Fecha de atención / registrar una venta atrasada</summary><div className="stack"><label><span className="label">Fecha y hora de la venta · Venezuela</span><input type="datetime-local" className="input" value={value} max={caracasInput()} onChange={e=>setValue(e.target.value)}/></label><p className="muted small">Se usará en la venta, pagos iniciales y servicio. Los precios y tasas siguen siendo los del registro; revisa los importes al cargar una venta anterior.</p>{error&&<div className="error" role="alert">{error}</div>}<button className="btn" disabled={busy||!value} onClick={save}>{busy?"Guardando…":"Guardar fecha de atención"}</button></div></details>;
}


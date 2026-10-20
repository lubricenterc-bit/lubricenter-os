"use client";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
import {caracasInput} from "@/lib/order-admin";
type DailyRate={business_date:string;bcv_rate:number;operative_rate:number;bcv_date:string;operative_date:string};
export function DailyRateHistory(){
 const today=caracasInput().slice(0,10);
 const [to,setTo]=useState(today),[rows,setRows]=useState<DailyRate[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(false);
 useEffect(()=>{let active=true;setLoading(true);setError("");
  const start=new Date(to+"T12:00:00Z");start.setUTCDate(start.getUTCDate()-13);
  supabase.rpc("get_exchange_rate_history",{p_from:start.toISOString().slice(0,10),p_to:to}).then(({data,error})=>{
   if(!active)return;setLoading(false);if(error){setError(error.message);setRows([]);}else setRows(data??[]);
  });return()=>{active=false;};
 },[to]);
 return <details className="card stack"><summary>Histórico diario de tasas</summary><div className="stack"><label>Consultar 14 días hasta<input className="input" type="date" value={to} max={today} onChange={e=>{if(e.target.value)setTo(e.target.value);}}/></label><p className="muted small">Cada día muestra la tasa guardada que le corresponde. Si no hubo una nueva publicación, se conserva la última registrada y su fecha de origen.</p>{loading&&<div role="status">Cargando historial…</div>}{error&&<div className="error" role="alert">{error}</div>}<div style={{overflowX:"auto"}}><table style={{width:"100%",textAlign:"left"}}><thead><tr><th>Día</th><th>BCV</th><th>Operativa</th><th>Origen BCV / operativa</th></tr></thead><tbody>{rows.map(r=><tr key={r.business_date}><td>{r.business_date}</td><td>{Number(r.bcv_rate).toLocaleString("es-VE",{maximumFractionDigits:6})}</td><td>{Number(r.operative_rate).toLocaleString("es-VE",{maximumFractionDigits:6})}</td><td className="muted small">{r.bcv_date} / {r.operative_date}</td></tr>)}</tbody></table></div></div></details>;
}

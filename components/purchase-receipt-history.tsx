"use client";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef} from "@/lib/format";
type Receipt={id:string;received_on:string;location_name:string;notes:string|null;items:Array<{id:string;description:string;quantity:number;unit_cost_ref:number;average_before:number|null;average_after:number|null}>};
export function PurchaseReceiptHistory({invoiceId}:{invoiceId:string}){
 const [rows,setRows]=useState<Receipt[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;supabase.rpc("purchase_receipt_history",{p_invoice_id:invoiceId}).then(r=>{if(!active)return;setLoading(false);if(r.error)setError(r.error.message);else setRows(r.data??[])});return()=>{active=false}},[invoiceId]);
 return <div className="stack">{loading&&<div className="muted">Cargando comprobantes…</div>}{error&&<div className="error">{error}</div>}
 {rows.map(r=><article className="order-item stack" key={r.id}><strong>{r.received_on} · {r.location_name}</strong>{r.notes&&<div className="muted small">{r.notes}</div>}{r.items.map(x=><div className="small" key={x.id}>{x.description} · {Number(x.quantity)} unidades · costo {fmtRef(x.unit_cost_ref)}{x.average_after!=null&&<div className="muted">Promedio global: {x.average_before==null?"sin registro":fmtRef(x.average_before)} → {fmtRef(x.average_after)}</div>}</div>)}</article>)}
 {!loading&&!error&&!rows.length&&<div className="muted">Sin recepciones.</div>}
 <p className="muted small">El costo refleja cada línea de la factura. Impuestos, fletes y descuentos generales se muestran aparte y aún no se distribuyen al costo de inventario.</p></div>;
}

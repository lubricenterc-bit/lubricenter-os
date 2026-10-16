"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef} from "@/lib/format";
type Movement={id:string;quantity_delta:number;movement_type:string;note:string;occurred_at:string;location_name:string;unit_cost_ref:number|null;average_cost_before:number|null;average_cost_after:number|null;supplier_invoice_id:string|null;invoice_number:string|null};
export function InventoryHistory({item,location,onClose}:{item:{id:string;sku:string;description:string};location:{id:string;name:string};onClose:()=>void}){
 const [rows,setRows]=useState<Movement[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;supabase.rpc("inventory_item_history",{p_inventory_item_id:item.id,p_location_id:location.id}).then(r=>{if(!active)return;setLoading(false);if(r.error)setError(r.error.message);else setRows(r.data??[])});return()=>{active=false}},[item.id,location.id]);
 return <div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Movimientos y costos"><div className="row-between"><div><h2>Movimientos y costos</h2><div>{item.sku} · {location.name}</div></div><button className="btn btn-ghost" onClick={onClose}>Cerrar</button></div>
 <p className="muted small">Últimos 100 movimientos de esta sede. El costo promedio se calcula para el artículo entre todas las sedes.</p>
 {loading&&<p>Cargando historial…</p>}{error&&<div className="error">{error}</div>}
 {rows.map(r=><article className="card stack" key={r.id}><div className="row-between"><strong>{Number(r.quantity_delta)>0?"+":""}{Number(r.quantity_delta)} unidades</strong><span>{new Date(r.occurred_at).toLocaleString("es-VE",{timeZone:"America/Caracas"})}</span></div><div>{r.note||r.movement_type}</div>
 {r.unit_cost_ref!=null&&<div className="muted small">Costo unitario: {fmtRef(r.unit_cost_ref)} · Promedio: {r.average_cost_before==null?"sin registro":fmtRef(r.average_cost_before)} → {r.average_cost_after==null?"sin registro":fmtRef(r.average_cost_after)}</div>}
 {r.supplier_invoice_id&&<Link href={`/purchases/${r.supplier_invoice_id}`}>Ver factura {r.invoice_number}</Link>}</article>)}
 {!loading&&!rows.length&&!error&&<p className="muted">Sin movimientos registrados en esta sede.</p>}
 </section></div>;
}

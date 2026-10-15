"use client";
import {useEffect,useRef,useState} from "react";
import {supabase} from "@/lib/supabase";
import {readPendingReceipt,receiptStorageKey,validateReceiptQuantities,type ReceiptRequest} from "@/lib/purchase-receipts";

type Line={id:string;description:string;quantity:number;received_quantity:number};
type Location={id:string;code:string;name:string};
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

export function PurchaseReceiveSheet({invoiceId,lines,locations,onCancel,onDone}:{invoiceId:string;lines:Line[];locations:Location[];onCancel:()=>void;onDone:()=>void|Promise<void>}){
  const [date,setDate]=useState(today());
  const [location,setLocation]=useState(locations.find(x=>x.code==="CABUDARE")?.id??"");
  const [notes,setNotes]=useState("");
  const [qty,setQty]=useState<Record<string,number>>(()=>Object.fromEntries(lines.map(x=>[x.id,0])));
  const [pending,setPending]=useState<ReceiptRequest|null>(null);
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const inFlight=useRef(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    try{const saved=readPendingReceipt(localStorage,invoiceId);setPending(saved);
      if(saved){setDate(saved.p_received_on);setLocation(saved.p_location_id);setNotes(saved.p_notes??"");setQty(Object.fromEntries(saved.p_items.map(x=>[x.line_id,x.quantity])));}
      setReady(true);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  },[invoiceId]);
  async function save(){
    if(inFlight.current||!ready)return;
    setError("");
    const validation=validateReceiptQuantities(lines,qty);
    if(!pending&&(validation||!location||!date||date>today())){setError(validation||"Selecciona sede y fecha válidas.");return;}
    const request=pending??{
      p_request_id:crypto.randomUUID(),p_invoice_id:invoiceId,p_location_id:location,p_received_on:date,
      p_items:lines.map(x=>({line_id:x.id,quantity:qty[x.id]??0})).filter(x=>x.quantity>0),p_notes:notes.trim()||null
    };
    try{localStorage.setItem(receiptStorageKey(invoiceId),JSON.stringify(request));}
    catch{setError("No se pudo guardar el identificador de recepción. Habilita el almacenamiento del navegador antes de continuar.");return;}
    setPending(request);inFlight.current=true;setBusy(true);
    try{
      const result=await supabase.rpc("inventory_receive_purchase",request);
      if(result.error){
        // A database validation error is an atomic rollback. Transport failures
        // keep the exact payload durable across close, reload and reconnect.
        if(/^(P0001|22|23)/.test(result.error.code??"")){
          localStorage.removeItem(receiptStorageKey(invoiceId));setPending(null);
        }
        setError(result.error.message);return;
      }
      localStorage.removeItem(receiptStorageKey(invoiceId));setPending(null);
      window.dispatchEvent(new CustomEvent("lubricenter:inventory-updated"));
      await onDone();
    }catch{setError("No se pudo confirmar la respuesta. Reintenta la misma recepción para recuperar el comprobante sin duplicar entradas.");}
    finally{inFlight.current=false;setBusy(false);}
  }
  return <div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Recibir mercancía">
    <div className="row-between"><h2>Recibir mercancía</h2><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cerrar</button></div>
    <p className="muted small">Indica las cantidades que llegaron físicamente y su sede. La recepción conserva su comprobante al reintentar.</p>
    {pending&&<div className="card">Hay una recepción pendiente de confirmación. Reintenta para recuperar su resultado antes de cambiar cantidades.</div>}
    <fieldset disabled={busy||!!pending||!ready} style={{border:0,padding:0}} className="stack">
      <div className="grid grid-2"><label><span className="label">Fecha de recepción</span><input className="input" type="date" max={today()} value={date} onChange={e=>setDate(e.target.value)}/></label>
      <label><span className="label">Sede de destino</span><select className="select" value={location} onChange={e=>setLocation(e.target.value)}><option value="">Selecciona sede…</option>{locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label></div>
      {lines.map(x=><label className="card row-between" key={x.id}><div><strong>{x.description}</strong><div className="muted small">Pendiente: {Number(x.quantity)-Number(x.received_quantity)}</div></div><input aria-label={`Cantidad recibida: ${x.description}`} className="input" style={{width:140}} type="number" min="0" max={Math.max(0,Number(x.quantity)-Number(x.received_quantity))} step="0.01" value={qty[x.id]??0} onChange={e=>setQty(q=>({...q,[x.id]:Number(e.target.value)}))}/></label>)}
      <label><span className="label">Nota de recepción</span><input className="input" value={notes} onChange={e=>setNotes(e.target.value)}/></label>
    </fieldset>
    {error&&<div className="error" role="alert">{error}</div>}
    <button className="btn btn-primary" disabled={busy||!ready||(!pending&&(!location||!!validateReceiptQuantities(lines,qty)))} onClick={()=>void save()}>{busy?"Confirmando…":pending?"Reintentar y recuperar comprobante":"Confirmar entrada al inventario"}</button>
  </section></div>;
}

"use client";

import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import {useParams,useRouter} from "next/navigation";
import {supabase} from "@/lib/supabase";
import {fmtRef,fmtVes} from "@/lib/format";
import {CASHEA_INITIAL_METHODS,casheaCurrency,type CasheaInitialMethod} from "@/lib/cashea-split";

type InitialLine = {id:string;source_id:string|null;method:CasheaInitialMethod;amount:string;reference:string};
type Sale = {id:string;initial_percent:number;gross_ref:number;initial_ref:number;financed_ref:number;bcv_rate_snapshot:number;cashea_reference:string;status:string};
type Invoice = {id:string;order_number:string;status:string};
const methods = new Set<string>(CASHEA_INITIAL_METHODS.map(([key])=>key));
const newLine=():InitialLine=>({id:crypto.randomUUID(),source_id:null,method:"TRANSFER_BDV",amount:"",reference:""});
function valueInBolivars(line:InitialLine,rate:number) {
 const amount=Number(line.amount);
 return Number.isFinite(amount)&&amount>0?(casheaCurrency(line.method)==="USD"?Math.round(amount*rate*100)/100:amount):0;
}
export default function CorrectInitialPage(){
 const {id}=useParams<{id:string}>(),router=useRouter();
 const [order,setOrder]=useState<Invoice|null>(null),[sale,setSale]=useState<Sale|null>(null);
 const [lines,setLines]=useState<InitialLine[]>([]);
 const [percent,setPercent]=useState("40"),[initialUsdInput,setInitialUsdInput]=useState(""),[reason,setReason]=useState(""),[confirmed,setConfirmed]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [duplicateReference,setDuplicateReference]=useState(false);
 useEffect(()=>{let alive=true;(async()=>{try{
   const rights=await supabase.rpc("can_administer_orders");
   if(rights.error||rights.data!==true)throw new Error("Solo el administrador puede rectificar cobros cerrados.");
   const [o,c,p,history]=await Promise.all([
     supabase.from("orders").select("id,order_number,status").eq("id",id).single(),
     supabase.from("cashea_sales").select("id,initial_percent,gross_ref,initial_ref,financed_ref,bcv_rate_snapshot,cashea_reference,status").eq("order_id",id).maybeSingle(),
     supabase.from("payments").select("id,method,amount_original,reference").eq("order_id",id).order("paid_at"),
     supabase.rpc("order_installment_payment_ids",{p_order_id:id})
   ]);
   const err=o.error||c.error||p.error||history.error;
   if(err)throw err;
   if(!c.data||o.data.status!=="CLOSED"||c.data.status==="CANCELLED")throw new Error("Esta orden no tiene un cobro Cashea cerrado vigente.");
   const installmentIds=new Set<string>((history.data??[]) as string[]);
   const initial=(p.data??[]).filter(x=>!installmentIds.has(x.id)&&methods.has(x.method));
   if(initial.length===0)throw new Error("No se encontraron cobros de la inicial.");
   if(alive){
     setSale(c.data as Sale);setOrder(o.data as Invoice);setPercent(String(c.data.initial_percent));setInitialUsdInput(Number(c.data.initial_ref).toFixed(2));
     setLines(initial.map(x=>({id:x.id,source_id:x.id,method:x.method as CasheaInitialMethod,amount:String(x.amount_original),reference:x.reference||""})));
   }
   const prior=await supabase.from("cashea_sales").select("id,status,order_id").eq("cashea_reference",c.data.cashea_reference).neq("order_id",id);
   if(alive&&prior.data?.length)setDuplicateReference(true);
 }catch(e){if(alive)setError((e as Error).message);}finally{if(alive)setLoading(false);}})();return()=>{alive=false;};},[id]);
 const quote=useMemo(()=>{
   if(!sale)return null;
   const pct=Number(percent),rate=Number(sale.bcv_rate_snapshot);
   const valid=Number.isFinite(pct)&&pct>0&&pct<100&&rate>0;
   const initialRef=valid?Math.round(sale.gross_ref*pct/100*10000)/10000:0;
   const initialVes=Math.round(initialRef*rate*100)/100;
   const paidVes=Math.round(lines.reduce((n,line)=>n+valueInBolivars(line,rate),0)*100)/100;
   const difference=Math.round((paidVes-initialVes)*100)/100;
   const tolerance=Math.max(1,Math.round(rate*0.5*100)/100);
   const methodsValid=lines.length>=1&&lines.length<=8&&lines.every(l=>{
     const amount=Number(l.amount);const ref=l.reference.trim();
     return methods.has(l.method)&&Number.isFinite(amount)&&amount>0&&/^\d+(?:\.\d{1,2})?$/.test(l.amount)&&
       (["TRANSFER_BDV","TRANSFER_BNC"].includes(l.method)?/^\d{4,32}$/.test(ref):
        ["ZELLE","BINANCE"].includes(l.method)?ref.length>=4:true);
   });
   return {initialRef,initialVes,financedRef:sale.gross_ref-initialRef,paidVes,difference,tolerance,
     valid:valid&&methodsValid&&Math.abs(difference)<=tolerance};
 },[sale,percent,lines]);
 function update(id:string,patch:Partial<InitialLine>){setLines(a=>a.map(x=>x.id===id?{...x,...patch}:x));setConfirmed(false);setError("");}
 function refillLast(){
   if(!quote||!sale||lines.length===0)return;
   const final=lines[lines.length-1];const preceding=lines.slice(0,-1).reduce((sum,line)=>sum+valueInBolivars(line,Number(sale.bcv_rate_snapshot)),0);
   const remaining=Math.max(quote.initialVes-preceding,0);
   const amount=casheaCurrency(final.method)==="USD"?remaining/Number(sale.bcv_rate_snapshot):remaining;
   update(final.id,{amount:amount.toFixed(2)});
 }
 async function save(){
   if(!quote?.valid||!confirmed||busy||reason.trim().length<8||!sale)return;
   setBusy(true);setError("");setNotice("");
   try{
     const {data,error:saveError}=await supabase.rpc("correct_cashea_initial",{
       p_order_id:id,p_reason:reason.trim(),p_initial_percent:Number(percent),p_confirmed:true,
       p_lines:lines.map(l=>({source_id:l.source_id,method:l.method,amount:l.amount,reference:l.reference.trim()||null}))
     });
     if(saveError)throw saveError;
     if(!data?.ok)throw new Error("La corrección no devolvió una confirmación.");
     setNotice("Cobro corregido con auditoría. No se anuló ni volvió a crear la orden.");
     router.replace(`/orders/${id}`);
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <main className="container stack">
   <div className="row-between"><h1>Rectificar cobro · {order?.order_number||"Cashea"}</h1><Link className="btn" href={`/orders/${id}`}>Volver</Link></div>
   {loading&&<p>Cargando movimientos originales…</p>}{error&&<div className="error" role="alert">{error}</div>}
   {notice&&<div className="success" role="status">{notice}</div>}
   {sale&&!loading&&<>
     <section className="card stack">
       <h2>Simular nuevamente la inicial</h2>
       <p className="muted">Esto corrige los cobros recibidos, el banco, el porcentaje y las cuotas pendientes, sin anular la venta, crear un segundo cobro ni simular una devolución bancaria. Se conserva la tasa BCV original.</p>
       <div className="row-between"><span>Venta total</span><strong>{fmtRef(sale.gross_ref)}</strong></div>
       <div className="row-between"><span>Inicial registrada</span><strong>{fmtRef(sale.initial_ref)} · {sale.initial_percent}%</strong></div>
       {duplicateReference&&<div className="muted small">Hay otro registro con este mismo número Cashea (posiblemente una orden anulada). No se creará ninguna operación nueva.</div>}
       <div className="grid grid-2"><label><span className="label">Nueva inicial (%)</span>
          <input className="input" type="number" min="0.000001" max="99.999999" step="any" value={percent} onChange={e=>{setPercent(e.target.value);const v=Number(e.target.value);setInitialUsdInput(v>0?(Number(sale.gross_ref)*v/100).toFixed(2):"");setConfirmed(false);}}/>
       </label><label><span className="label">Inicial USD · importe acordado en Cashea</span>
          <input className="input" type="number" min="0.01" step="0.01" value={initialUsdInput}
          onChange={e=>{setInitialUsdInput(e.target.value);const v=Number(e.target.value);setPercent(v>0?(v/Number(sale.gross_ref)*100).toFixed(8):"0");setConfirmed(false);}}/>
       </label></div>
       <div className="row-between"><span>Inicial calculada</span><strong>{fmtRef(quote?.initialRef||0)} · {fmtVes(quote?.initialVes||0)}</strong></div>
       <div className="row-between"><span>Queda en 3 cuotas</span><strong>{fmtRef(quote?.financedRef||0)}</strong></div>
     </section>
     <section className="card stack">
       <div className="row-between"><h2>¿Dónde ingresó cada pago?</h2><button className="btn" type="button" disabled={busy||lines.length>=8}
         onClick={()=>{setLines(a=>[...a,newLine()]);setConfirmed(false);}}>+ Agregar pago</button></div>
       {lines.map((line,index)=><div className="order-item stack" key={line.id}>
         <div className="row-between"><strong>Pago {index+1}{line.source_id?" · existente":" · nuevo"}</strong>
           {lines.length>1&&<button className="btn btn-ghost" disabled={busy}
            onClick={()=>{setLines(a=>a.filter(x=>x.id!==line.id));setConfirmed(false);}}>Quitar</button>}</div>
         <label><span className="label">Cuenta receptora real</span>
           <select className="select" disabled={busy} value={line.method} onChange={e=>update(line.id,{method:e.target.value as CasheaInitialMethod,reference:""})}>
             {CASHEA_INITIAL_METHODS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
           </select></label>
         <div className="grid grid-2"><label><span className="label">Monto recibido · {casheaCurrency(line.method)==="USD"?"USD":"Bs"}</span>
             <input className="input" disabled={busy} inputMode="decimal" value={line.amount} onChange={e=>update(line.id,{amount:e.target.value})}/></label>
           <label><span className="label">Referencia {["TRANSFER_BDV","TRANSFER_BNC","ZELLE","BINANCE"].includes(line.method)?"· obligatoria":""}</span>
             <input className="input" disabled={busy} value={line.reference} onChange={e=>update(line.id,{reference:e.target.value})}/></label>
         </div>
       </div>)}
       <button className="btn" type="button" disabled={busy} onClick={refillLast}>Completar el último pago con el monto calculado</button>
       <div className="row-between"><strong>Dinero registrado</strong><strong>{fmtVes(quote?.paidVes||0)}</strong></div>
       <div className="row-between"><span>Diferencia frente a la nueva inicial</span><strong>{fmtVes(quote?.difference||0)}</strong></div>
       <p className="muted small">Tolerancia de pago móvil: hasta medio dólar BCV. El ajuste queda en la auditoría. Las cuotas ya pagadas se preservan.</p>
       {!quote?.valid&&<div className="error">Revisa el porcentaje, los montos o las referencias. No se aplicarán cambios mientras la simulación no cuadre.</div>}
     </section>
     <section className="card stack">
       <label><span className="label">Motivo de la corrección · obligatorio</span>
         <textarea className="input" value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}} placeholder="Ej. El pago entró a BNC y seleccioné BDV por error; Cashea confirmó otra inicial."/>
       </label>
       <label className="row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
         Confirmo que los montos y las cuentas corresponden al dinero realmente recibido. No se está realizando una devolución.</label>
       <button className="btn btn-primary" type="button" onClick={save} disabled={busy||!confirmed||!quote?.valid||reason.trim().length<8}>
         {busy?"Guardando rectificación…":"Confirmar corrección auditada"}</button>
     </section>
   </>}
 </main>;
}

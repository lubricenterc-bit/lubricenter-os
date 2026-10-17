"use client";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef} from "@/lib/format";
export type CasheaPayrollOption={
 accrual_id:string;employee_id:string;order_id:string;order_number:string;description:string;
 full_commission_ref:number;cashea_sale_id:string;gross_ref:number;cashea_service_fee_ref:number;initial_ref:number;financed_ref:number;
 cashea_reference:string;commission_from_collections:number;amount_to_advance:number;
 mode:"AS_COLLECTED"|"FULL_UPFRONT";advance_adjustment_id:string|null;
 advance_already_liquidated:boolean;
 installments:{installment_no:number;due_date:string;amount_ref:number;paid_ref:number;status:string}[];
};
export function CasheaPayrollChoices({employeeId,options,periodEnd,disabled,onUpdated}:{
 employeeId:string;options:CasheaPayrollOption[];periodEnd:string;disabled:boolean;onUpdated:()=>Promise<void>;
}){
 const [edit,setEdit]=useState<string|null>(null),[mode,setMode]=useState<"AS_COLLECTED"|"FULL_UPFRONT">("AS_COLLECTED");
 const [reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const relevant=options.filter(o=>o.employee_id===employeeId);
 if(!relevant.length)return null;
 async function save(item:CasheaPayrollOption){
   if(reason.trim().length<8||busy)return;
   setBusy(true);setError("");
   try{
    const r=await supabase.rpc("payroll_cashea_set_policy",{
     p_accrual_id:item.accrual_id,p_mode:mode,p_period_end:periodEnd,p_reason:reason.trim()
    });
    if(r.error)throw r.error;
    setEdit(null);setReason("");await onUpdated();
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="card stack">
   <div><h3>Cashea · decisión de comisión al revisar nómina</h3>
   <p className="muted small">Puedes pagar solo lo que Cashea ya cobró o adelantar la comisión pendiente. Una cuota cubierta por adelanto no volverá a generar pago.</p></div>
   {relevant.map(item=><div className="card stack" key={item.accrual_id}>
    <div className="row-between" style={{flexWrap:"wrap"}}>
      <div><strong>{item.order_number}</strong> · {item.description}</div>
      <strong>{fmtRef(item.full_commission_ref)} comisión total</strong>
    </div>
    <div>Por cobros registrados: <strong>{fmtRef(item.commission_from_collections)}</strong> · Restante: <strong>{fmtRef(item.amount_to_advance)}</strong></div>
    <div className="muted small">Venta Cashea {fmtRef(item.gross_ref)} · inicial {fmtRef(item.initial_ref)} · financiado {fmtRef(item.financed_ref)}</div>
    <div className="muted small"><strong>Cargo de Cashea: {fmtRef(item.cashea_service_fee_ref)} · lo asume Lubricenter.</strong> No se descuenta del 40% del mecánico ni del bono del ayudante.</div>
    <div><strong>Decisión:</strong> {item.mode==="FULL_UPFRONT"?"Adelanto completo":"Pago conforme lleguen cuotas"}
      {item.advance_already_liquidated?" · Ya liquidado (bloqueado)":""}</div>
    <details><summary>Ver vencimientos Cashea</summary>
      {item.installments.map(p=><div key={p.installment_no} className="muted small">
        Cuota {p.installment_no}: {fmtRef(p.amount_ref)} · {p.due_date} · cobrado {fmtRef(p.paid_ref)} · {p.status}
      </div>)}</details>
    {edit===item.accrual_id&&<div className="stack">
      <label><span className="label">Acuerdo con el mecánico</span>
        <select className="select" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}>
        <option value="AS_COLLECTED">Pagar conforme se reciban las cuotas</option>
        <option value="FULL_UPFRONT">Pagar también el saldo pendiente esta semana</option></select></label>
      <div className="card">
        {mode==="FULL_UPFRONT"?
        "Se agregará una comisión anticipada de "+fmtRef(item.amount_to_advance)+" a esta nómina. El negocio la adelanta con su dinero.":
        "Solo se paga lo cobrado. Cada cuota posterior generará su parte en la nómina correspondiente."}
      </div>
      <label><span className="label">Motivo / acuerdo</span>
        <textarea className="input" rows={2} value={reason} onChange={e=>setReason(e.target.value)}
         placeholder="Ej. Revisado con Cheo: espera tres cuotas, o anticipo total autorizado."/></label>
      {error&&<div className="error" role="alert">{error}</div>}
      <div className="row"><button className="btn btn-primary" disabled={busy||reason.trim().length<8||(mode==="FULL_UPFRONT"&&item.amount_to_advance<.01)} onClick={()=>void save(item)}>
       {busy?"Guardando…":"Guardar decisión con auditoría"}</button><button className="btn" disabled={busy} onClick={()=>setEdit(null)}>Cancelar</button></div>
    </div>}
    {edit!==item.accrual_id&&<button className="btn" disabled={disabled||item.advance_already_liquidated} onClick={()=>{setEdit(item.accrual_id);setMode(item.mode);setReason("");setError("");}}>
      Decidir pago de comisión</button>}
   </div>)}
 </section>;
}
export type PayrollOrderItem={
 id:string;order_id:string;description:string;item_type:string;business_area:string;charged_ref_amount:number;
 worker_share_ref_snapshot:number|null;assistant_bonus_ref_snapshot:number|null;worker_employee_id:string|null;
};
type OrderPayment={id:string;method:string;value_ref:number;currency:string;amount_original:number;reference:string|null};
type Sale={id:string;cashea_reference:string;initial_ref:number;financed_ref:number;gross_ref:number;status:string};
type Part={installment_no:number;amount_ref:number;paid_ref:number;due_date:string;status:string};
export function PayrollOrderPeek({id,onClose,employees}:{
 id:string;onClose:()=>void;employees:{id:string;name:string}[];
}){
 const [items,setItems]=useState<PayrollOrderItem[]>([]),[payments,setPayments]=useState<OrderPayment[]>([]);
 const [sale,setSale]=useState<Sale|null>(null),[parts,setParts]=useState<Part[]>([]);
 const [error,setError]=useState(""),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;void (async()=>{
  try{
   const [i,p,s]=await Promise.all([
    supabase.from("order_items").select("id,order_id,description,item_type,business_area,charged_ref_amount,worker_share_ref_snapshot,assistant_bonus_ref_snapshot,worker_employee_id").eq("order_id",id),
    supabase.from("payments").select("id,method,value_ref,currency,amount_original,reference").eq("order_id",id),
    supabase.from("cashea_sales").select("id,cashea_reference,initial_ref,financed_ref,gross_ref,status").eq("order_id",id).maybeSingle()
   ]);
   const bad=[i,p,s].find(x=>x.error);if(bad?.error)throw bad.error;
   if(!active)return;
   setItems(i.data??[]);setPayments(p.data??[]);setSale(s.data);
   if(s.data){const partsResult=await supabase.from("cashea_installments").select("installment_no,amount_ref,paid_ref,due_date,status").eq("cashea_sale_id",s.data.id).order("installment_no");
    if(partsResult.error)throw partsResult.error;if(active)setParts(partsResult.data??[]);}
  }catch(e){if(active)setError((e as Error).message);}finally{if(active)setLoading(false);}
 })();return()=>{active=false;};},[id]);
 return <div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Detalle completo de la orden">
   <div className="row-between" style={{flexWrap:"wrap"}}><h2>Detalle de orden · nómina</h2><button className="btn btn-primary" onClick={onClose}>Volver al mismo lugar</button></div>
   {loading&&<p>Cargando trabajo, pagos y cuotas…</p>}{error&&<div className="error">{error}</div>}
   {!loading&&<><h3>Repuestos y servicios</h3>
    {items.map(item=><div className="card stack" key={item.id}>
      <div className="row-between"><strong>{item.description}</strong><strong>{fmtRef(item.charged_ref_amount)}</strong></div>
      <div className="muted small">{item.business_area} · {item.item_type} · Mecánico {employees.find(x=>x.id===item.worker_employee_id)?.name||"No asignado"}
       {item.worker_share_ref_snapshot!=null?" · Comisión "+fmtRef(item.worker_share_ref_snapshot):""}
       {item.assistant_bonus_ref_snapshot!=null?" · Ayudante "+fmtRef(item.assistant_bonus_ref_snapshot):""}</div>
    </div>)}
    <h3>Cobros de la orden</h3>{payments.map(p=><div className="card" key={p.id}>{p.method} · {fmtRef(p.value_ref)} · {p.currency} {Number(p.amount_original).toFixed(2)} · Ref. {p.reference||"Sin referencia"}</div>)}
    {sale&&<><h3>Cashea · referencia {sale.cashea_reference}</h3><div className="card">Venta {fmtRef(sale.gross_ref)} · inicial {fmtRef(sale.initial_ref)} · saldo financiado {fmtRef(sale.financed_ref)}</div>
      {parts.map(p=><div className="card" key={p.installment_no}>Cuota {p.installment_no} · vence {p.due_date} · {fmtRef(p.amount_ref)} · recibido {fmtRef(p.paid_ref)} · {p.status}</div>)}</>}
   </>}
  <button className="btn btn-primary" onClick={onClose}>Cerrar y continuar revisando</button>
 </section></div>;
}

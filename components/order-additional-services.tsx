"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OsIcon } from "@/components/os-icon";
import { OrderExtrasChecklist } from "@/components/order-extras-checklist";
import { supabase } from "@/lib/supabase";
import {
  EMPTY_ORDER_EXTRAS, normalizeOrderExtras, orderExtrasRpcParams,
  validateOrderExtras, type OrderExtras
} from "@/lib/order-extras";

type Props = { orderId: string };

export function OrderAdditionalServices({ orderId }: Props) {
  const [extras,setExtras] = useState<OrderExtras>({...EMPTY_ORDER_EXTRAS});
  const [status,setStatus] = useState<"OPEN"|"CLOSED"|"CANCELLED"|null>(null);
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [notice,setNotice] = useState("");
  const [error,setError] = useState("");
  const [dirty,setDirty] = useState(false);

  async function load() {
    setLoading(true);
    const result=await supabase.from("orders").select(
      "status,crm_additional_services,crm_bonuses,crm_observations"
    ).eq("id",orderId).single();
    setLoading(false);
    if(result.error){setError(result.error.message);return;}
    setError("");
    setStatus(result.data.status as "OPEN"|"CLOSED"|"CANCELLED");
    setExtras(normalizeOrderExtras(result.data));
    setDirty(false);
  }

  useEffect(()=>{void load();},[orderId]);

  async function save() {
    if(saving||status!=="OPEN")return;
    const validation=validateOrderExtras(extras);
    if(validation){setError(validation);return;}
    setSaving(true);setError("");setNotice("");
    const result=await supabase.rpc("set_order_crm_extras",orderExtrasRpcParams(orderId,extras));
    setSaving(false);
    if(result.error){setError(result.error.message);return;}
    setNotice("Servicios, cortesías y notas guardados. Se incluirán automáticamente en el resumen al cliente.");
    await load();
  }

  function update(next: OrderExtras) {
    setExtras(next);
    setDirty(true);
    setNotice("");
  }

  return <section className="card stack oce-order-panel">
    <div className="row-between oce-order-header">
      <div>
        <div className="eyebrow">CAMBIO DE ACEITE · ATENCIÓN AL CLIENTE</div>
        <h2 className="section-title" style={{margin:"5px 0"}}>Servicios adicionales y notas</h2>
        <p className="muted small" style={{margin:0}}>Selecciona los servicios realizados, añade cortesías y escribe recomendaciones sin entrar al CRM.</p>
      </div>
      <span className="pill">{status==="CLOSED"?"ORDEN CERRADA":status==="OPEN"?"ORDEN ABIERTA":"CARGANDO"}</span>
    </div>
    {error&&<div className="error" role="alert">{error}</div>}
    {notice&&<div className="success" role="status">{notice}</div>}
    {loading
      ? <div className="muted small">Cargando servicios guardados…</div>
      : <OrderExtrasChecklist value={extras} onChange={update} disabled={status!=="OPEN"||saving}/>}
    {status==="OPEN" && <div className="oce-order-actions">
      <button className="btn btn-primary" disabled={saving||loading||!dirty} onClick={()=>void save()}>
        {saving?"Guardando…":dirty?"Guardar servicios y notas":"Servicios y notas guardados"}
      </button>
      {dirty&&<span className="oce-unsaved"><OsIcon name="alert" size={15}/> Tienes cambios sin guardar.</span>}
    </div>}
    {status==="CLOSED"&&<div className="muted small">Estos son los servicios y las notas registrados antes de cerrar la orden.</div>}
    <div className="muted small">No modifica el importe del servicio. <Link href={`/orders/${orderId}/delivery`}>Ver estado preventivo y CRM avanzado</Link>.</div>
  </section>;
}

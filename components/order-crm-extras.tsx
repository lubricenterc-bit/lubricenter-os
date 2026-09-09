"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Props = { orderId: string };

type OrderCrm = {
  status: "OPEN" | "CLOSED" | "CANCELLED";
  health_status: "GREEN" | "YELLOW" | "RED" | null;
  health_notes: string | null;
  crm_additional_services: string[] | null;
  crm_bonuses: string[] | null;
  crm_observations: string | null;
};

function splitLines(value: string) {
  return value.split("\n").map(x => x.trim()).filter(Boolean);
}

export function OrderCrmExtras({ orderId }: Props) {
  const [order, setOrder] = useState<OrderCrm | null>(null);
  const [health, setHealth] = useState<"GREEN" | "YELLOW" | "RED">("GREEN");
  const [healthNotes, setHealthNotes] = useState("");
  const [additional, setAdditional] = useState("");
  const [bonuses, setBonuses] = useState("");
  const [observations, setObservations] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const { data, error } = await supabase.from("orders")
      .select("status,health_status,health_notes,crm_additional_services,crm_bonuses,crm_observations")
      .eq("id", orderId).single();
    if (error) return setError(error.message);
    const row = data as OrderCrm;
    setOrder(row);
    setHealth((row.health_status || "GREEN") as any);
    setHealthNotes(row.health_notes || "");
    setAdditional((row.crm_additional_services || []).join("\n"));
    setBonuses((row.crm_bonuses || []).join("\n"));
    setObservations(row.crm_observations || "");
  }

  useEffect(() => { load(); }, [orderId]);

  async function save() {
    setBusy(true); setError(""); setNotice("");
    const [{ error: he }, { error: ce }] = await Promise.all([
      supabase.rpc("set_order_health", { p_order_id: orderId, p_health_status: health, p_health_notes: healthNotes.trim() || null }),
      supabase.rpc("set_order_crm_extras", {
        p_order_id: orderId,
        p_additional_services: splitLines(additional),
        p_bonuses: splitLines(bonuses),
        p_observations: observations.trim() || null,
      }),
    ]);
    setBusy(false);
    if (he || ce) return setError((he || ce)?.message || "No pude guardar la información CRM.");
    setNotice("Salida y CRM guardados. El mensaje post-servicio usará estos datos al cerrar la orden.");
    await load();
  }

  const locked = order?.status !== "OPEN";

  return <section className="card stack">
    <div className="row-between">
      <div><div className="eyebrow">SALIDA · CRM</div><h2 className="section-title" style={{ marginBottom: 2 }}>Experiencia post-servicio</h2><div className="muted small">Esto no cambia el total de la orden. Sirve para el mensaje al cliente y el historial de atención.</div></div>
      <span className={`pill ${health === "GREEN" ? "ok" : "warn"}`}>{health === "GREEN" ? "TODO OK" : health === "YELLOW" ? "PREVENTIVO" : "SEGURIDAD"}</span>
    </div>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <div className="grid grid-2">
      <label><span className="label">Estado de salida</span><select className="select" value={health} disabled={locked} onChange={e => setHealth(e.target.value as any)}><option value="GREEN">✅ Todo OK</option><option value="YELLOW">⚠️ Preventivo</option><option value="RED">🛑 Seguridad</option></select></label>
      <label><span className="label">Detalle de salud / pendiente</span><input className="input" value={healthNotes} disabled={locked} onChange={e => setHealthNotes(e.target.value)} placeholder="Ej. Pastillas delanteras próximas a reemplazo" /></label>
    </div>

    <div className="grid grid-2">
      <label><span className="label">Servicios adicionales incluidos</span><textarea className="input" rows={5} value={additional} disabled={locked} onChange={e => setAdditional(e.target.value)} placeholder={'Uno por línea\nRevisión de niveles\nCalibración de cauchos'} /><span className="muted small">Úsalos cuando forman parte de la atención pero no son una línea de cobro separada.</span></label>
      <label><span className="label">Bonificaciones / regalos</span><textarea className="input" rows={5} value={bonuses} disabled={locked} onChange={e => setBonuses(e.target.value)} placeholder={'Uno por línea\nLimpieza de parabrisas\nAditivo de cortesía'} /><span className="muted small">Quedan visibles en el mensaje post-servicio sin afectar caja ni nómina.</span></label>
    </div>

    <label><span className="label">Observaciones para el cliente</span><textarea className="input" rows={4} value={observations} disabled={locked} onChange={e => setObservations(e.target.value)} placeholder="Notas que quieras incluir en el mensaje final." /></label>

    {!locked ? <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar salida y CRM"}</button> : <div className="muted small">La orden ya está cerrada. Si necesitas corregir el texto antes de enviarlo, podrás editar el mensaje directamente desde CRM.</div>}
  </section>;
}

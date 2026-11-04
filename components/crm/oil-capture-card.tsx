"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { captureBlocks } from "@/lib/crm";

type Status = { needs: boolean; optional?: boolean; oil: string | null };
type Known = { vehicle_id: string; plate: string; make: string | null; model: string | null; customer_name: string | null; phone: string | null } | null;

/** Venta rápida con aceite: pide placa y teléfono para que el cliente entre a
 *  Seguimiento. Si no quiere dar datos, se registra y se sigue.
 *  - needs: hubo cambio de aceite → bloquea hasta anotar la placa o marcar que no quiso.
 *  - optional: aceite sin cambio (litros sueltos) → tarjeta plegada que no bloquea. */
export function OilCaptureCard({ orderId, onBlockingChange }: { orderId: string; onBlockingChange: (blocking: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [plate, setPlate] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [known, setKnown] = useState<Known>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    void supabase.rpc("crm_capture_status", { p_order_id: orderId }).then(({ data, error }) => {
      if (!alive) return;
      // Si la consulta falla no se bloquea la venta.
      const s = error ? { needs: false, optional: false, oil: null } : (data as Status);
      setStatus(s);
      onBlockingChange(captureBlocks(s));
    });
    return () => { alive = false; };
  }, [orderId, onBlockingChange]);

  async function lookup() {
    const clean = plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length < 5) { setKnown(null); return; }
    const { data } = await supabase.rpc("crm_capture_lookup", { p_plate: clean });
    const k = (data ?? null) as Known;
    setKnown(k);
    if (k?.phone && !phone) setPhone(k.phone);
    if (k?.customer_name && !name) setName(k.customer_name);
  }

  async function save() {
    setBusy(true); setError("");
    const { error } = await supabase.rpc("crm_capture_sale", {
      p_order_id: orderId, p_plate: plate, p_phone: phone, p_name: name || null,
      p_make: known ? null : make || null, p_model: known ? null : model || null,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setSaved("Listo: el carro quedó registrado y el cliente entra a Seguimiento.");
    onBlockingChange(false);
  }

  async function skip() {
    setBusy(true); setError("");
    const { error } = await supabase.rpc("crm_capture_skip", { p_order_id: orderId, p_reason: "El cliente no quiso dar datos" });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setSaved("Anotado: el cliente no quiso dar datos.");
    onBlockingChange(false);
  }

  if (!status || (!status.needs && !status.optional)) return null;
  if (saved) return <div className="success" role="status">{saved}</div>;
  if (!status.needs && !expanded) {
    return <div className="crm-capture crm-capture-optional">
      <button type="button" className="btn btn-ghost" aria-expanded={false} onClick={() => setExpanded(true)}>¿Fue para un cambio de aceite? Anotar placa</button>
    </div>;
  }

  return <div className="crm-capture" role="group" aria-labelledby={`capture-${orderId}`}>
    <strong id={`capture-${orderId}`}>¿De qué carro es el aceite?</strong>
    <span className="crm-capture-note">{status.needs ? "Pide la placa y el WhatsApp para avisarle cuando le toque el próximo cambio." : "Opcional: si fue para un cambio de aceite, anota la placa para avisarle del próximo."}</span>
    <div className="crm-capture-grid">
      <label><span className="label">Placa</span>
        <input className="input" autoFocus value={plate} maxLength={10} onChange={e => setPlate(e.target.value.toUpperCase())} onBlur={() => void lookup()} placeholder="AB123CD" /></label>
      <label><span className="label">WhatsApp</span>
        <input className="input" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0414 123 4567" /></label>
      <label><span className="label">Nombre (opcional)</span>
        <input className="input" value={name} onChange={e => setName(e.target.value)} /></label>
      {!known && plate.replace(/[^A-Za-z0-9]/g, "").length >= 5 && <>
        <label><span className="label">Marca (opcional)</span><input className="input" value={make} onChange={e => setMake(e.target.value)} placeholder="Chevrolet" /></label>
        <label><span className="label">Modelo (opcional)</span><input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="Aveo" /></label>
      </>}
    </div>
    {known && <span className="crm-capture-note">Ya lo conocemos: {[known.make, known.model].filter(Boolean).join(" ") || "carro registrado"}{known.customer_name ? ` de ${known.customer_name}` : ""}.</span>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="crm-capture-actions">
      <button className="btn btn-primary" disabled={busy || plate.replace(/[^A-Za-z0-9]/g, "").length < 5 || phone.replace(/\D/g, "").length < 10} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar datos del carro"}</button>
      {status.needs
        ? <button className="btn btn-ghost" disabled={busy} onClick={() => void skip()}>El cliente no quiso dar datos</button>
        : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setExpanded(false)}>Ahora no</button>}
    </div>
  </div>;
}

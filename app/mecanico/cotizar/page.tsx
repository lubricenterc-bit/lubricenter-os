"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { haptic } from "@/lib/haptics";
import { PROPOSAL_LABEL, since, type LaborProposal, type MechanicOrder } from "@/lib/mechanic";

export default function MechanicQuotePage() {
  return <Suspense fallback={null}><MechanicQuote /></Suspense>;
}

/**
 * Cotizar mano de obra: el mecánico propone el precio de un trabajo y el mostrador
 * (Edgar o Ender) lo acepta y se lo pasa al cliente. No crea ni cambia la orden.
 */
function MechanicQuote() {
  const params = useSearchParams();
  const [jobs, setJobs] = useState<MechanicOrder[]>([]);
  const [mine, setMine] = useState<LaborProposal[]>([]);
  const [orderId, setOrderId] = useState(params.get("orden") || "");
  const [plate, setPlate] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadMine = useCallback(async () => {
    const { data } = await supabase.rpc("mechanic_my_proposals");
    setMine(((data ?? []) as LaborProposal[]).map(p => ({ ...p, amount_ref: Number(p.amount_ref) })));
  }, []);
  useEffect(() => {
    supabase.rpc("mechanic_my_jobs").then(({ data }) => setJobs((data ?? []) as MechanicOrder[]));
    void loadMine();
  }, [loadMine]);

  const value = Number(amount.replace(",", "."));
  const valid = description.trim().length >= 3 && value > 0 && (orderId || plate.trim() || vehicle.trim());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) { setError("Escribe el trabajo, el precio y el vehículo."); return; }
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("mechanic_propose_labor", {
      p_description: description.trim(), p_amount_ref: value, p_order_id: orderId || null,
      p_plate: orderId ? null : plate.trim() || null, p_vehicle: orderId ? null : vehicle.trim() || null,
      p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    haptic("success");
    setNotice("Enviada. En el mostrador la revisan y se la pasan al cliente.");
    setDescription(""); setAmount(""); setNotes("");
    await loadMine();
  }

  return <div className="os-mech-page">
    <header className="os-mech-title">
      <h1>Cotizar mano de obra</h1>
      <p>Propón el precio de un trabajo. El mostrador lo revisa y se lo pasa al cliente.</p>
    </header>

    <form className="os-mech-card os-mech-form" onSubmit={submit}>
      <label>
        <span className="label">Vehículo</span>
        <select className="select" value={orderId} onChange={e => setOrderId(e.target.value)}>
          <option value="">Otro vehículo (escribir placa)</option>
          {jobs.map(job => <option key={job.order_id} value={job.order_id}>{[job.plate, job.vehicle].filter(Boolean).join(" · ") || job.order_number}</option>)}
        </select>
      </label>
      {!orderId && <div className="os-mech-two">
        <label><span className="label">Placa</span><input className="input" value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} autoCapitalize="characters" /></label>
        <label><span className="label">Carro</span><input className="input" value={vehicle} onChange={e => setVehicle(e.target.value)} placeholder="Ej. Corolla 2015" /></label>
      </div>}
      <label>
        <span className="label">Trabajo</span>
        <textarea className="textarea" rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Ej. Cambio de pastillas delanteras y rectificar discos" maxLength={500} />
      </label>
      <label>
        <span className="label">Precio de la mano de obra (REF $)</span>
        <input className="input os-mech-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.,]/g, ""))} placeholder="0" />
      </label>
      <label>
        <span className="label">Nota (opcional)</span>
        <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej. el cliente trae los repuestos" maxLength={300} />
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success" role="status">{notice}</div>}
      <button type="submit" className="btn btn-primary" disabled={busy || !valid}>{busy ? "Enviando…" : "Enviar al mostrador"}</button>
    </form>

    {mine.length > 0 && <h2 className="os-mech-section">Mis propuestas</h2>}
    {mine.map(item => <article key={item.id} className="os-mech-card is-compact">
      <div className="os-mech-card-top">
        <strong>{[item.plate, item.vehicle].filter(Boolean).join(" · ") || item.order_number}</strong>
        <span className={"os-mech-proposal is-" + item.status.toLowerCase()}>{PROPOSAL_LABEL[item.status]}</span>
      </div>
      <p>{item.description}</p>
      <p className="os-mech-meta">{fmtRef(item.amount_ref)} · {since(item.created_at)}{item.review_note ? ` · «${item.review_note}»` : ""}</p>
    </article>)}
  </div>;
}

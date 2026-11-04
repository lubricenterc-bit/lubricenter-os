"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OsIcon } from "@/components/os-icon";
import { supabase } from "@/lib/supabase";
import { KIND_LABEL, addDays, caracasToday, displayName, waLink, type CrmQueueItem } from "@/lib/crm";

type Phase = "compose" | "confirm";
type Done = { item: CrmQueueItem; action: "SENT" | "SNOOZED" | "SKIPPED" | "OPT_OUT" };

/** Contactar hoy: un cliente por pantalla. El sistema trae el mensaje listo;
 *  la persona abre WhatsApp, lo envía y confirma. Nada se envía solo. */
export function ContactTunnel({ queue, sentToday, cap, onClose }: {
  queue: CrmQueueItem[]; sentToday: number; cap: number; onClose: (changed: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("compose");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done[]>([]);
  const [dir, setDir] = useState<"next" | "back">("next");
  const primaryRef = useRef<HTMLButtonElement>(null);

  const item = queue[index];
  const finished = index >= queue.length;
  const message = item ? (drafts[item.id] ?? item.message) : "";
  const sentNow = done.filter(d => d.action === "SENT").length;

  useEffect(() => { primaryRef.current?.focus(); }, [index, phase]);

  const advance = useCallback((entry: Done) => {
    setDone(list => [...list, entry]);
    setDir("next"); setPhase("compose"); setEditing(false); setError("");
    setIndex(i => i + 1);
  }, []);

  function openWhatsapp() {
    if (!item) return;
    if (message.trim().length < 20) { setError("El mensaje está vacío o muy corto."); return; }
    const w = window.open(waLink(item.wa_phone, message), "_blank", "noopener,noreferrer");
    if (w) w.opener = null;
    setPhase("confirm"); setError("");
  }

  async function confirmSent() {
    if (!item || busy) return;
    setBusy(true); setError("");
    const r = item.type === "POST_SERVICE"
      ? await supabase.rpc("crm_record_post_service_sent", { p_followup_id: item.id, p_message: message })
      : await supabase.rpc("crm_record_send", { p_service_record_id: item.id, p_kind: item.kind, p_message: message });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    advance({ item, action: "SENT" });
  }

  async function snooze() {
    if (!item || busy) return;
    setBusy(true); setError("");
    const today = caracasToday();
    const r = item.type === "POST_SERVICE"
      ? await supabase.rpc("crm_skip_post_service", { p_followup_id: item.id, p_until: addDays(today, 1) })
      : await supabase.rpc("crm_record_outcome", { p_service_record_id: item.id, p_outcome: "SNOOZE", p_date: addDays(today, 7), p_notes: null });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    advance({ item, action: "SNOOZED" });
  }

  async function optOut() {
    if (!item || busy || !item.customer_id) return;
    if (!window.confirm(`¿${displayName(item.customer_name)} pidió no recibir mensajes? No se le volverá a escribir por ningún carro.`)) return;
    setBusy(true); setError("");
    let r;
    if (item.type === "REMINDER") {
      r = await supabase.rpc("crm_record_outcome", { p_service_record_id: item.id, p_outcome: "OPT_OUT", p_date: null, p_notes: null });
    } else {
      r = await supabase.rpc("set_crm_contact_permission", { p_customer_id: item.customer_id, p_status: "OPT_OUT", p_evidence: "El cliente pidió no recibir mensajes" });
      if (!r.error) r = await supabase.rpc("crm_skip_post_service", { p_followup_id: item.id, p_until: null });
    }
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    advance({ item, action: "OPT_OUT" });
  }

  function skip() { if (item) advance({ item, action: "SKIPPED" }); }

  async function undo() {
    const last = done.at(-1);
    if (!last || busy) return;
    setBusy(true); setError("");
    let r: { error: { message: string } | null } = { error: null };
    if (last.action !== "SKIPPED") {
      if (last.item.type === "POST_SERVICE") {
        r = await supabase.rpc("crm_undo_post_service", { p_followup_id: last.item.id });
      } else if (last.action === "SNOOZED") {
        r = await supabase.rpc("set_maintenance_reminder_status", { p_service_record_id: last.item.id, p_status: "PENDING", p_snoozed_until: null });
      } else if (last.action === "SENT") {
        r = await supabase.rpc("crm_undo_last", { p_service_record_id: last.item.id });
      } else if (last.action === "OPT_OUT" && last.item.customer_id) {
        r = { error: { message: "Para quitar el bloqueo de «No quiere mensajes», pídeselo al administrador." } };
      }
    }
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    setDone(list => list.slice(0, -1));
    setDir("back"); setPhase("compose"); setEditing(false);
    setIndex(i => Math.max(0, i - 1));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (e.key === "Escape") { e.preventDefault(); onClose(done.length > 0); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); void undo(); return; }
      if (typing || finished) return;
      if (e.key === "Enter") { e.preventDefault(); if (phase === "compose") openWhatsapp(); else void confirmSent(); }
      else if (e.key.toLowerCase() === "s") { e.preventDefault(); skip(); }
      else if (e.key.toLowerCase() === "p") { e.preventDefault(); void snooze(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return <div className="crm-tunnel" role="dialog" aria-modal="true" aria-label="Contactar hoy">
    <header className="crm-tunnel-top">
      <div className="crm-progress" aria-hidden="true">
        {queue.map((q, i) => <span key={q.id} className={i < index ? "is-done" : i === index ? "is-now" : ""} />)}
      </div>
      <div className="crm-tunnel-bar">
        <span>{finished ? "Terminado" : `Mensaje ${index + 1} de ${queue.length}`}</span>
        <span className="crm-tunnel-count">Enviados hoy: {sentToday + sentNow} de {cap}</span>
        <button className="crm-link" onClick={() => void undo()} disabled={!done.length || busy}>Deshacer</button>
        <button className="crm-link" onClick={() => onClose(done.length > 0)}>Salir</button>
      </div>
    </header>

    {finished ? <section className="crm-slide crm-slide-end">
      <OsIcon name="check" size={44} />
      <h2>Listo por hoy</h2>
      <p>Enviaste {sentNow} {sentNow === 1 ? "mensaje" : "mensajes"}.
        {done.some(d => d.action === "SKIPPED") ? " Los que saltaste vuelven a aparecer mañana." : ""}</p>
      <p className="crm-muted">Cuando los clientes respondan, anota qué dijeron en «Esperando respuesta».</p>
      <button ref={primaryRef} className="btn btn-primary crm-big" onClick={() => onClose(true)}>Volver a Seguimiento</button>
    </section> : <section key={item.id + phase} className={"crm-slide is-" + dir}>
      <div className="crm-eyebrow">
        <span className={"crm-kind is-" + item.kind.toLowerCase()}>{KIND_LABEL[item.kind]}</span>
        {item.step && item.max_steps && item.max_steps > 1 ? <span>Mensaje {item.step} de {item.max_steps} a este cliente</span> : null}
      </div>
      <h2 className="crm-name">{displayName(item.customer_name)}</h2>
      <p className="crm-car"><OsIcon name="car" size={18} /> {item.vehicle || "Vehículo"}{item.plate ? <span className="crm-plate">{item.plate}</span> : null}</p>
      <p className="crm-why">{item.why}</p>
      {item.warning && <div className="crm-warning"><OsIcon name="alert" size={17} /> {item.warning}</div>}

      {phase === "compose" ? <>
        <div className="crm-message">
          <div className="crm-message-head">
            <span>Mensaje que se va a enviar</span>
            <button className="crm-link" onClick={() => setEditing(v => !v)}>{editing ? "Listo" : "Editar"}</button>
          </div>
          {editing
            ? <textarea autoFocus value={message} rows={9} maxLength={item.type === "POST_SERVICE" ? 4000 : 1800}
                onChange={e => setDrafts(d => ({ ...d, [item.id]: e.target.value }))} aria-label="Editar mensaje" />
            : <p className="crm-message-text">{message}</p>}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="crm-actions">
          <button ref={primaryRef} className="btn btn-primary crm-big" disabled={busy} onClick={openWhatsapp}>
            <OsIcon name="arrow" size={18} /> Abrir WhatsApp <kbd>Enter</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={skip}>Saltar <kbd>S</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={() => void snooze()}>
            {item.type === "POST_SERVICE" ? "Mañana" : "Posponer 7 días"} <kbd>P</kbd></button>
        </div>
        <button className="crm-link crm-danger" disabled={busy} onClick={() => void optOut()}>El cliente no quiere mensajes</button>
      </> : <>
        <div className="crm-confirm">
          <h3>¿Lo enviaste?</h3>
          <p>Se abrió WhatsApp con el mensaje listo. Envíalo allá y vuelve aquí.</p>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="crm-actions">
          <button ref={primaryRef} className="btn btn-primary crm-big" disabled={busy} onClick={() => void confirmSent()}>
            <OsIcon name="check" size={18} /> {busy ? "Guardando…" : "Sí, lo envié"} <kbd>Enter</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={() => setPhase("compose")}>No, volver</button>
          <button className="btn crm-mid" disabled={busy} onClick={skip}>Saltar <kbd>S</kbd></button>
        </div>
        <button className="crm-link" disabled={busy} onClick={openWhatsapp}>Abrir WhatsApp otra vez</button>
      </>}
    </section>}
  </div>;
}

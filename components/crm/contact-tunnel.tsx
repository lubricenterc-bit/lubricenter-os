"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OsIcon } from "@/components/os-icon";
import { supabase } from "@/lib/supabase";
import {
  KIND_LABEL, OUTCOMES, addDays, caracasToday, dismissReasons, displayName, moveToEnd, shortDate, waLink,
  type CrmOutcome, type CrmQueueItem, type DismissReason,
} from "@/lib/crm";

type Phase = "compose" | "confirm" | "dismiss";
type Action = "SENT" | "SNOOZED" | "DISMISSED" | "OUTCOME" | "OPT_OUT";
type Done = { item: CrmQueueItem; action: Action; label: string };
type RpcResult = { error: { message: string } | null };

const REPLY_OUTCOMES: CrmOutcome[] = ["BOOKED", "POSTPONED", "DECLINED"];

/** Contactar: un cliente por pantalla. El sistema trae el mensaje listo; la persona
 *  abre WhatsApp, lo envía y confirma. Abrir WhatsApp queda guardado en la base, así
 *  que la confirmación no se pierde aunque la página se recargue al volver. */
export function ContactTunnel({ queue, pending = [], sentToday, cap, onClose }: {
  queue: CrmQueueItem[]; pending?: CrmQueueItem[]; sentToday: number; cap: number; onClose: (changed: boolean) => void;
}) {
  const [list, setList] = useState<CrmQueueItem[]>(() => [...pending, ...queue.filter(q => !pending.some(p => p.id === q.id))]);
  const [attempts, setAttempts] = useState<Record<string, string>>(() =>
    Object.fromEntries(pending.filter(p => p.attempt_id).map(p => [p.id, p.attempt_id as string])));
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>(() => (pending.length ? "confirm" : "compose"));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [replyHidden, setReplyHidden] = useState<Record<string, boolean>>({});
  const [bookingFor, setBookingFor] = useState<string | null>(null);
  const [bookingDate, setBookingDate] = useState(addDays(caracasToday(), 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState<Done[]>([]);
  const [dir, setDir] = useState<"next" | "back">("next");
  const primaryRef = useRef<HTMLButtonElement>(null);

  const item = list[index];
  const finished = index >= list.length;
  const message = item ? (drafts[item.id] ?? item.message) : "";
  const attemptId = item ? attempts[item.id] : undefined;
  const sentNow = done.filter(d => d.action === "SENT").length;
  const askReply = !!item && item.type === "REMINDER" && !!item.last_sent_at && !replyHidden[item.id] && phase === "compose";

  useEffect(() => { primaryRef.current?.focus(); }, [index, phase]);

  const go = useCallback((next: number, nextDir: "next" | "back", nextList = list) => {
    setDir(nextDir); setEditing(false); setError(""); setNotice(""); setBookingFor(null);
    setIndex(next);
    const target = nextList[next];
    setPhase(target && attempts[target.id] ? "confirm" : "compose");
  }, [attempts, list]);

  const advance = useCallback((entry: Done) => {
    setDone(d => [...d, entry]);
    go(index + 1, "next");
  }, [go, index]);

  async function run(fn: () => PromiseLike<RpcResult>): Promise<boolean> {
    setBusy(true); setError("");
    const r = await fn();
    setBusy(false);
    if (r.error) { setError(r.error.message); return false; }
    return true;
  }

  /** Abre la pestaña en el mismo toque (si no, el navegador la bloquea) y la lleva a
   *  WhatsApp solo cuando la base confirma que todavía toca escribirle. */
  async function openWhatsapp() {
    if (!item || busy) return;
    if (message.trim().length < 20) { setError("El mensaje está vacío o muy corto."); return; }
    const link = waLink(item.wa_phone, message);
    const tab = window.open("", "_blank");
    setBusy(true); setError("");
    const r = await supabase.rpc("crm_open_send", { p_type: item.type, p_id: item.id, p_kind: item.kind, p_message: message });
    setBusy(false);
    if (r.error) { tab?.close(); setError(r.error.message); return; }
    setAttempts(a => ({ ...a, [item.id]: (r.data as { attempt_id: string }).attempt_id }));
    if (tab && !tab.closed) { try { tab.opener = null; } catch { /* sin acceso */ } tab.location.href = link; }
    else window.location.href = link;
    setPhase("confirm");
  }

  function reopenWhatsapp() {
    if (!item) return;
    const tab = window.open(waLink(item.wa_phone, message), "_blank", "noopener,noreferrer");
    if (!tab) window.location.href = waLink(item.wa_phone, message);
  }

  async function confirmSent() {
    if (!item || !attemptId || busy) return;
    if (await run(() => supabase.rpc("crm_confirm_send", { p_attempt_id: attemptId, p_sent: true }))) {
      advance({ item, action: "SENT", label: "Enviado" });
    }
  }

  async function notSent() {
    if (!item || !attemptId || busy) return;
    if (await run(() => supabase.rpc("crm_confirm_send", { p_attempt_id: attemptId, p_sent: false }))) {
      setAttempts(a => { const n = { ...a }; delete n[item.id]; return n; });
      setPhase("compose");
    }
  }

  /** Para lo que ya se envió desde el teléfono sin abrir WhatsApp desde aquí. */
  async function wroteElsewhere() {
    if (!item || busy) return;
    setBusy(true); setError("");
    let id = attemptId;
    if (!id) {
      const r = await supabase.rpc("crm_open_send", { p_type: item.type, p_id: item.id, p_kind: item.kind, p_message: message });
      if (r.error) { setBusy(false); setError(r.error.message); return; }
      id = (r.data as { attempt_id: string }).attempt_id;
    }
    const c = await supabase.rpc("crm_confirm_send", { p_attempt_id: id, p_sent: true });
    setBusy(false);
    if (c.error) { setError(c.error.message); return; }
    advance({ item, action: "SENT", label: "Ya se le había escrito" });
  }

  async function dismiss(reason: DismissReason) {
    if (!item || busy) return;
    const label = dismissReasons(item.type).find(r => r.id === reason)?.label ?? "No enviar";
    if (await run(() => supabase.rpc("crm_dismiss", { p_type: item.type, p_id: item.id, p_reason: reason }))) {
      setAttempts(a => { const n = { ...a }; delete n[item.id]; return n; });
      advance({ item, action: "DISMISSED", label });
    }
  }

  async function snooze() {
    if (!item || busy) return;
    const today = caracasToday();
    const ok = await run(() => item.type === "POST_SERVICE"
      ? supabase.rpc("crm_skip_post_service", { p_followup_id: item.id, p_until: addDays(today, 1) })
      : supabase.rpc("crm_record_outcome", { p_service_record_id: item.id, p_outcome: "SNOOZE", p_date: addDays(today, 7), p_notes: null }));
    if (ok) advance({ item, action: "SNOOZED", label: item.type === "POST_SERVICE" ? "Para mañana" : "Pospuesto 7 días" });
  }

  async function outcome(o: CrmOutcome, day?: string) {
    if (!item || busy) return;
    const ok = await run(() => supabase.rpc("crm_record_outcome", { p_service_record_id: item.id, p_outcome: o, p_date: day ?? null, p_notes: null }));
    if (ok) advance({ item, action: "OUTCOME", label: OUTCOMES.find(x => x.id === o)?.label ?? "Anotado" });
  }

  async function optOut() {
    if (!item || busy || !item.customer_id) return;
    if (!window.confirm(`¿${displayName(item.customer_name)} pidió no recibir mensajes? No se le volverá a escribir por ningún carro.`)) return;
    const ok = await run(async () => {
      if (item.type === "REMINDER") {
        return supabase.rpc("crm_record_outcome", { p_service_record_id: item.id, p_outcome: "OPT_OUT", p_date: null, p_notes: null });
      }
      const r = await supabase.rpc("set_crm_contact_permission", { p_customer_id: item.customer_id, p_status: "OPT_OUT", p_evidence: "El cliente pidió no recibir mensajes" });
      return r.error ? r : supabase.rpc("crm_dismiss", { p_type: "POST_SERVICE", p_id: item.id, p_reason: "NOT_NEEDED" });
    });
    if (ok) advance({ item, action: "OPT_OUT", label: "No quiere mensajes" });
  }

  /** «Después»: lo manda al final de la lista de hoy. */
  function later() {
    if (!item) return;
    if (index >= list.length - 1) { setNotice("Es el último de la lista. Envíalo, posponlo o elige «No enviar»."); return; }
    const next = moveToEnd(list, index);
    setList(next);
    go(index, "next", next);
    setNotice(`${displayName(item.customer_name)} quedó al final de la lista.`);
  }

  async function undo() {
    const last = done.at(-1);
    if (!last || busy) return;
    const it = last.item;
    let r: RpcResult = { error: null };
    if (last.action === "OPT_OUT") {
      r = { error: { message: "«No quiere mensajes» se quita desde la ficha del cliente." } };
    } else if (it.type === "POST_SERVICE") {
      r = await supabase.rpc("crm_undo_post_service", { p_followup_id: it.id });
    } else if (last.action === "SNOOZED") {
      r = await supabase.rpc("set_maintenance_reminder_status", { p_service_record_id: it.id, p_status: "PENDING", p_snoozed_until: null });
    } else {
      r = await supabase.rpc("crm_undo_last", { p_service_record_id: it.id });
    }
    if (r.error) { setError(r.error.message); return; }
    setDone(d => d.slice(0, -1));
    setAttempts(a => { const n = { ...a }; delete n[it.id]; return n; });
    setDir("back"); setEditing(false); setError(""); setNotice(""); setPhase("compose");
    setIndex(i => Math.max(0, i - 1));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT";
      if (e.key === "Escape") {
        e.preventDefault();
        if (phase === "dismiss") setPhase("compose"); else onClose(done.length > 0);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); void undo(); return; }
      if (typing || finished || busy || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "Enter") { e.preventDefault(); if (phase === "compose") void openWhatsapp(); else if (phase === "confirm") void confirmSent(); }
      else if (k === "d" && phase !== "dismiss") { e.preventDefault(); later(); }
      else if (k === "n" && phase === "compose") { e.preventDefault(); setPhase("dismiss"); }
      else if (k === "p" && phase === "compose") { e.preventDefault(); void snooze(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const summary = done.reduce<Record<string, number>>((m, d) => { m[d.label] = (m[d.label] ?? 0) + 1; return m; }, {});

  return <div className="crm-tunnel" role="dialog" aria-modal="true" aria-label="Contactar hoy">
    <header className="crm-tunnel-top">
      <div className="crm-progress" aria-hidden="true">
        {list.map((q, i) => <span key={q.id} className={i < index ? "is-done" : i === index ? "is-now" : ""} />)}
      </div>
      <div className="crm-tunnel-bar">
        <span>{finished ? "Terminado" : `Mensaje ${index + 1} de ${list.length}`}</span>
        <span className="crm-tunnel-count">Enviados hoy: {sentToday + sentNow} de {cap}</span>
        <button className="crm-link" onClick={() => void undo()} disabled={!done.length || busy}>Deshacer</button>
        <button className="crm-link" onClick={() => onClose(done.length > 0)}>Salir</button>
      </div>
    </header>

    {finished ? <section className="crm-slide crm-slide-end">
      <OsIcon name="check" size={44} />
      <h2>Listo por hoy</h2>
      <p>Enviaste {sentNow} {sentNow === 1 ? "mensaje" : "mensajes"}.</p>
      {Object.keys(summary).length > 0 && <p className="crm-muted">{Object.entries(summary).map(([k, n]) => `${k}: ${n}`).join(" · ")}</p>}
      <p className="crm-muted">Cuando los clientes respondan, anota qué dijeron en «Esperando respuesta».</p>
      <button ref={primaryRef} className="btn btn-primary crm-big" onClick={() => onClose(true)}>Volver a Seguimiento</button>
    </section> : <section key={item.id + phase} className={"crm-slide is-" + dir}>
      <div className="crm-eyebrow">
        <span className={"crm-kind is-" + item.kind.toLowerCase()}>{KIND_LABEL[item.kind] ?? item.kind}</span>
        {item.step && item.max_steps && item.max_steps > 1 ? <span>Mensaje {item.step} de {item.max_steps} a este cliente</span> : null}
      </div>
      <h2 className="crm-name">{displayName(item.customer_name)}</h2>
      <p className="crm-car"><OsIcon name="car" size={18} /> {item.vehicle || "Vehículo"}{item.plate ? <span className="crm-plate">{item.plate}</span> : null}</p>
      <p className="crm-why">{item.why}</p>
      {item.warning && <div className="crm-warning"><OsIcon name="alert" size={17} /> {item.warning}</div>}
      {notice && <div className="crm-note-line" role="status">{notice}</div>}

      {askReply && <div className="crm-reply">
        <strong>Le escribiste el {shortDate(item.last_sent_at)} · ¿Respondió?</strong>
        {bookingFor === item.id ? <div className="crm-reply-row">
          <label className="crm-date">¿Qué día viene?<input type="date" className="input" min={caracasToday()} value={bookingDate} onChange={e => setBookingDate(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={busy || !bookingDate} onClick={() => void outcome("BOOKED", bookingDate)}>Guardar cita</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setBookingFor(null)}>Cancelar</button>
        </div> : <div className="crm-reply-row">
          {REPLY_OUTCOMES.map(o => <button key={o} className="crm-chip" disabled={busy} title={OUTCOMES.find(x => x.id === o)?.hint}
            onClick={() => o === "BOOKED" ? setBookingFor(item.id) : void outcome(o)}>{OUTCOMES.find(x => x.id === o)?.label}</button>)}
          <button className="crm-chip" disabled={busy} onClick={() => void dismiss("ALREADY_DONE")}>Ya lo hizo</button>
          <button className="crm-chip is-quiet" disabled={busy} onClick={() => setReplyHidden(h => ({ ...h, [item.id]: true }))}>No respondió · seguir</button>
        </div>}
      </div>}

      {phase === "compose" && <>
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
          <button ref={primaryRef} className="btn btn-primary crm-big" disabled={busy} onClick={() => void openWhatsapp()}>
            <OsIcon name="arrow" size={18} /> {busy ? "Revisando…" : "Abrir WhatsApp"} <kbd>Enter</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={() => setPhase("dismiss")}>No enviar <kbd>N</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={later}>Después <kbd>D</kbd></button>
        </div>
        <div className="crm-secondary">
          <button className="crm-link" disabled={busy} onClick={() => void snooze()}>{item.type === "POST_SERVICE" ? "Mañana" : "Posponer 7 días"} <kbd>P</kbd></button>
          <button className="crm-link" disabled={busy} onClick={() => void wroteElsewhere()}>Ya le escribí por otro lado</button>
          <button className="crm-link crm-danger" disabled={busy} onClick={() => void optOut()}>El cliente no quiere mensajes</button>
        </div>
      </>}

      {phase === "dismiss" && <>
        <div className="crm-confirm is-light">
          <h3>¿Por qué no se envía?</h3>
          <p>Sale de pendientes. Puedes deshacerlo en los próximos 15 minutos.</p>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="crm-reasons">
          {dismissReasons(item.type).map((r, i) => <button key={r.id} ref={i === 0 ? primaryRef : undefined} className="crm-reason" disabled={busy} onClick={() => void dismiss(r.id)}>
            <strong>{r.label}</strong><small>{r.hint}</small></button>)}
        </div>
        <button className="crm-link" disabled={busy} onClick={() => setPhase("compose")}>Volver al mensaje <kbd>Esc</kbd></button>
      </>}

      {phase === "confirm" && <>
        <div className="crm-confirm">
          <h3>¿Lo enviaste?</h3>
          <p>{item.opened_at && !done.length && index < pending.length
            ? `${item.why}. Si lo enviaste, confírmalo; si no, vuelve al mensaje.`
            : "Se abrió WhatsApp con el mensaje listo. Envíalo allá y vuelve aquí: esto queda guardado aunque la página se recargue."}</p>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="crm-actions">
          <button ref={primaryRef} className="btn btn-primary crm-big" disabled={busy} onClick={() => void confirmSent()}>
            <OsIcon name="check" size={18} /> {busy ? "Guardando…" : "Sí, lo envié"} <kbd>Enter</kbd></button>
          <button className="btn crm-mid" disabled={busy} onClick={() => void notSent()}>No se envió</button>
          <button className="btn crm-mid" disabled={busy} onClick={later}>Después <kbd>D</kbd></button>
        </div>
        <div className="crm-secondary">
          <button className="crm-link" disabled={busy} onClick={reopenWhatsapp}>Abrir WhatsApp otra vez</button>
        </div>
      </>}
    </section>}
  </div>;
}

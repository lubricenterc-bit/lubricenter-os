"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Note = { id: string; note: string; kind: "NOTE" | "POR_COBRAR"; created_at: string };

/**
 * Notas de la orden: siempre disponibles (abierta, cerrada o anulada) para dejar constancia de algo
 * especial. No se editan ni se borran. Las de «Por cobrar» se crean al cobrar con ese método.
 */
export function OrderNotes({ orderId, refreshKey = 0 }: { orderId: string; refreshKey?: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("order_notes").select("id,note,kind,created_at").eq("order_id", orderId).order("created_at");
    if (error) return setError(error.message);
    setNotes((data ?? []) as Note[]);
  }, [orderId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("add_order_note", { p_order_id: orderId, p_note: text });
    setBusy(false);
    if (error) return setError(error.message);
    setText(""); await load();
  }

  return <section className="card stack" aria-label="Notas de la orden">
    <div className="row-between"><h2 className="section-title">Notas</h2><span className="muted small">{notes.length ? `${notes.length} nota(s)` : "Sin notas"}</span></div>
    {notes.map(n => <div key={n.id} className="stack" style={{ borderTop: "1px solid var(--border, #ddd)", paddingTop: 8 }}>
      <div>{n.kind === "POR_COBRAR" && <span className="pill">Por cobrar</span>} {n.note}</div>
      <small className="muted">{new Date(n.created_at).toLocaleString("es-VE", { timeZone: "America/Caracas", dateStyle: "short", timeStyle: "short" })}</small>
    </div>)}
    <label><span className="label">Agregar nota (algo especial de esta orden)</span>
      <textarea className="input" rows={2} maxLength={1000} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="Ej. El cliente pagará el resto el lunes" /></label>
    {error && <div className="error" role="alert">{error}</div>}
    <button type="button" className="btn" disabled={busy || !text.trim()} onClick={add}>{busy ? "Guardando…" : "Guardar nota"}</button>
  </section>;
}

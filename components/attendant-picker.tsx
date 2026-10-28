"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/** Mientras todos entran con la misma cuenta, cada orden guarda quién la atendió. */
export const ATTENDANTS = ["Edgar", "Ender", "Santiago"] as const;
const KEY = "lubricenter:attendant";

export function readAttendant(): string {
  try { return window.localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
function writeAttendant(name: string) {
  try { window.localStorage.setItem(KEY, name); } catch { /* sin almacenamiento: se pregunta cada vez */ }
  window.dispatchEvent(new CustomEvent("lubricenter:attendant", { detail: name }));
}

/** Guarda quién atiende en la orden; si no hay nadie elegido, no hace nada. */
export async function stampAttendant(orderId: string | null | undefined, name = readAttendant()) {
  if (!orderId || !name) return;
  await supabase.rpc("set_order_attendant", { p_order_id: orderId, p_attendant: name });
}

export function useAttendant() {
  const [name, setName] = useState("");
  useEffect(() => {
    setName(readAttendant());
    const on = (e: Event) => setName((e as CustomEvent<string>).detail ?? readAttendant());
    window.addEventListener("lubricenter:attendant", on);
    return () => window.removeEventListener("lubricenter:attendant", on);
  }, []);
  return name;
}

export function AttendantPicker({ orderId, onChange }: { orderId?: string | null; onChange?: (name: string) => void }) {
  const current = useAttendant();
  const [error, setError] = useState("");
  async function choose(name: string) {
    setError("");
    writeAttendant(name);
    onChange?.(name);
    if (orderId) {
      const { error } = await supabase.rpc("set_order_attendant", { p_order_id: orderId, p_attendant: name });
      if (error) setError(error.message);
    }
  }
  return <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
    <span className="muted small">¿Quién atiende?</span>
    {ATTENDANTS.map(n => <button key={n} type="button" className={`btn ${current === n ? "btn-primary" : "btn-ghost"}`}
      aria-pressed={current === n} onClick={() => void choose(n)}>{n}</button>)}
    {!current && <span className="muted small">Toca tu nombre una vez; se recuerda en este equipo.</span>}
    {error && <span className="error small">{error}</span>}
  </div>;
}

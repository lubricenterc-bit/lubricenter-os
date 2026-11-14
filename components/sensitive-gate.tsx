"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { clearSessionCache } from "@/lib/session-cache";
import { OsIcon } from "@/components/os-icon";

/**
 * Pide el PIN del dueño antes de mostrar un módulo sensible (finanzas, ganancias,
 * conciliaciones, nómina). Lo usa el perfil ADMIN (Edgar).
 *
 * El shell lo vuelve a cerrar cada vez que se sale de esos módulos, así que se pide
 * el PIN en cada entrada. Mientras está abierto, la base le da a Edgar el rol ADMIN
 * de finanzas por 30 minutos como máximo (unlock_sensitive); al vencer, se vuelve a pedir.
 */
export function SensitiveGate({ unlockedUntil, onUnlock, moduleName }: {
  unlockedUntil: number | null;
  onUnlock: (until: number) => void;
  moduleName: string;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const expired = unlockedUntil != null && unlockedUntil <= Date.now();

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) { setError("El PIN tiene de 4 a 8 números."); return; }
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("unlock_sensitive", { p_pin: pin });
    setBusy(false);
    setPin("");
    if (error) { setError(error.message.replace(/^.*?:\s*/, "") || "No se pudo verificar el PIN."); inputRef.current?.focus(); return; }
    // El rol de finanzas cambió: que las pantallas lo pidan de nuevo.
    clearSessionCache();
    onUnlock(new Date(String(data)).getTime());
  }

  return <main className="container os-sensitive-gate">
    <form className="card os-sensitive-card" onSubmit={submit}>
      <span className="os-sensitive-icon" aria-hidden="true"><OsIcon name="shield" size={28} /></span>
      <h1>{moduleName}</h1>
      <p>{expired ? "Pasaron 30 minutos. " : ""}Es información sensible: escribe el PIN del dueño para entrar. Se vuelve a pedir cada vez que entres.</p>
      <label>
        <span className="label">PIN</span>
        <input ref={inputRef} className="input os-sensitive-pin" type="password" inputMode="numeric" autoComplete="off"
          pattern="\d*" maxLength={8} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} aria-describedby="os-sensitive-help" />
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <button type="submit" className="btn btn-primary" disabled={busy || pin.length < 4}>{busy ? "Verificando…" : "Entrar"}</button>
      <small id="os-sensitive-help">Cinco intentos fallidos bloquean el PIN por 15 minutos.</small>
    </form>
  </main>;
}

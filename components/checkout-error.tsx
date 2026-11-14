"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { isPriceOverrideError, priceOverrideText } from "@/lib/price-override";

/**
 * Error de cobro. Si el servidor rechazó una rebaja mayor al límite (REBAJA_SIN_AUTORIZACION),
 * ofrece pedir el PIN del dueño: se valida en el servidor y deja una autorización de un solo uso
 * (30 minutos) para la próxima venta de esta persona. Después basta con volver a cobrar.
 */
export function CheckoutError({ message }: { message: string | null | undefined }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [granted, setGranted] = useState(false);
  if (!message) return null;
  if (!isPriceOverrideError(message)) return <div className="error" role="alert">{message}</div>;

  async function authorize() {
    if (!/^\d{4,8}$/.test(pin)) return setNote("Escribe el PIN del dueño (4 a 8 números).");
    setBusy(true); setNote("");
    const { data, error } = await supabase.rpc("authorize_price_override", { p_owner_pin: pin });
    setBusy(false); setPin("");
    if (error) return setNote(error.message);
    const result = data as { ok?: boolean; error?: string } | null;
    if (!result?.ok) return setNote(result?.error ?? "No se pudo autorizar.");
    setGranted(true);
  }

  return <div className="error stack" role="alert">
    <span>{priceOverrideText(message)}</span>
    {granted
      ? <strong>Rebaja autorizada por el dueño. Vuelve a tocar «Cobrar» (vale para una venta, 30 minutos).</strong>
      : <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input className="input" type="password" inputMode="numeric" autoComplete="off" aria-label="PIN del dueño"
            placeholder="PIN del dueño" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} style={{ maxWidth: 160 }} />
          <button type="button" className="btn" disabled={busy} onClick={authorize}>{busy ? "Verificando…" : "Autorizar rebaja"}</button>
        </div>}
    {note && <small>{note}</small>}
  </div>;
}

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/** En la ficha del cliente: si pidió no recibir mensajes, se ve aquí y se puede revertir. */
export function ContactPermissionBanner({ customerId }: { customerId: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void supabase.from("crm_contact_permissions").select("status,evidence").eq("customer_id", customerId).maybeSingle()
      .then(({ data }) => { if (alive) { setStatus(data?.status ?? null); setEvidence(data?.evidence ?? null); } });
    return () => { alive = false; };
  }, [customerId]);

  async function allow() {
    if (!window.confirm("¿El cliente pidió volver a recibir los recordatorios por WhatsApp?")) return;
    setBusy(true); setError("");
    const { error: e } = await supabase.rpc("set_crm_contact_permission", {
      p_customer_id: customerId, p_status: "OPT_IN", p_evidence: "El cliente pidió volver a recibir mensajes",
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setStatus("OPT_IN");
  }

  if (status !== "OPT_OUT") return null;
  return <div className="crm-optout" role="status">
    <span><strong>No quiere mensajes.</strong> {evidence ? `Motivo: ${evidence}.` : ""} No se le escribe por ningún carro.</span>
    <button className="btn" disabled={busy} onClick={() => void allow()}>{busy ? "Guardando…" : "Volver a permitir mensajes"}</button>
    {error && <span className="error">{error}</span>}
  </div>;
}

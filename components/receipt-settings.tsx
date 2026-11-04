"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Header = { branch: string; address: string; whatsapp: string; instagram: string; rif: string; legend: string };
const EMPTY: Header = { branch: "Cabudare", address: "", whatsapp: "", instagram: "", rif: "", legend: "Nota de entrega · Documento no fiscal" };
const FIELDS: { key: keyof Header; label: string; placeholder: string }[] = [
  { key: "branch", label: "Sucursal", placeholder: "Cabudare" },
  { key: "address", label: "Dirección", placeholder: "Av. Intercomunal, local 3" },
  { key: "whatsapp", label: "WhatsApp", placeholder: "0414 123 4567" },
  { key: "instagram", label: "Instagram", placeholder: "lubricenter" },
  { key: "rif", label: "RIF", placeholder: "J-12345678-9" },
  { key: "legend", label: "Leyenda al pie", placeholder: "Nota de entrega · Documento no fiscal" },
];

/** Encabezado y estilo del total del recibo de 58 mm. Los campos vacíos no se imprimen. */
export function ReceiptSettings() {
  const [header, setHeader] = useState<Header>(EMPTY);
  const [style, setStyle] = useState<"BLOCK" | "BORDER">("BLOCK");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.from("app_settings").select("key,value").in("key", ["receipt_header", "receipt_total_style"]).then(({ data }) => {
      for (const row of data ?? []) {
        if (row.key === "receipt_header" && row.value && typeof row.value === "object") {
          const v = row.value as Record<string, string | null>;
          setHeader(h => Object.fromEntries(Object.keys(h).map(k => [k, v[k] ?? ""])) as Header);
        }
        if (row.key === "receipt_total_style" && (row.value === "BLOCK" || row.value === "BORDER")) setStyle(row.value);
      }
    });
  }, []);

  async function save() {
    setBusy(true); setError(""); setMessage("");
    const { error: e } = await supabase.rpc("set_receipt_settings", { p_header: header, p_total_style: style });
    setBusy(false);
    if (e) setError(e.message);
    else setMessage("Listo: el recibo usará estos datos desde la próxima impresión.");
  }

  return <section className="card stack" aria-labelledby="receipt-settings-title">
    <div className="row-between"><h2 id="receipt-settings-title" className="section-title">Recibo de 58 mm</h2><span className="pill ok">EDITABLE</span></div>
    <p className="muted small">Lo que dejes vacío no sale en el recibo. Solo el dueño puede guardar cambios.</p>
    <div className="grid grid-2">
      {FIELDS.map(f => <label key={f.key}><span className="label">{f.label}</span>
        <input className="input" value={header[f.key]} maxLength={120} placeholder={f.placeholder}
          onChange={e => setHeader({ ...header, [f.key]: e.target.value })} /></label>)}
      <label><span className="label">Total</span>
        <select className="select" value={style} onChange={e => setStyle(e.target.value as "BLOCK" | "BORDER")}>
          <option value="BLOCK">Bloque negro</option>
          <option value="BORDER">Recuadro</option>
        </select></label>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="success" role="status">{message}</div>}
    <div className="row">
      <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar recibo"}</button>
      <Link className="btn btn-ghost" href="/orders">Probar con una orden</Link>
    </div>
  </section>;
}

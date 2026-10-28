"use client";

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Currency = "VES" | "REF" | "USD";
const CURRENCIES: { id: Currency; label: string }[] = [
  { id: "VES", label: "Bolívares" },
  { id: "REF", label: "$ BCV" },
  { id: "USD", label: "$ divisas / efectivo" },
];

/**
 * "Compré algo para este trabajo": el cliente lo paga, pero solo el recargo es ganancia.
 * Cheo no cobra porcentaje sobre esta línea y no descuenta inventario.
 */
export function PassThroughSheet({ ensureOrder, rates, onDone, onCancel }: {
  ensureOrder: () => Promise<string>; rates: { bcv: number; operative: number };
  onDone: (orderId: string) => void | Promise<void>; onCancel: () => void;
}) {
  const [description, setDescription] = useState("");
  const [costText, setCostText] = useState("");
  const [currency, setCurrency] = useState<Currency>("REF");
  const [markup, setMarkup] = useState<number | null>(0);
  const [chargeText, setChargeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const cost = Number(costText.replace(",", "."));
  const costRef = useMemo(() => {
    if (!Number.isFinite(cost) || cost <= 0 || !(rates.bcv > 0)) return 0;
    if (currency === "REF") return cost;
    if (currency === "VES") return cost / rates.bcv;
    return rates.operative > 0 ? cost * rates.operative / rates.bcv : 0;
  }, [cost, currency, rates]);
  const charge = markup == null ? Number(chargeText.replace(",", ".")) : Math.round(costRef * (1 + markup / 100) * 100) / 100;
  const profit = Number.isFinite(charge) ? charge - costRef : 0;
  const valid = description.trim().length > 1 && costRef > 0 && Number.isFinite(charge) && charge >= costRef - 0.01;

  async function save() {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const { error } = await supabase.rpc("add_pass_through_item", {
        p_order_id: id, p_description: description.trim(), p_cost_amount: cost, p_cost_currency: currency,
        p_charge_ref: Math.round(charge * 100) / 100,
      });
      if (error) throw error;
      await onDone(id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-label="Compra para el trabajo">
    <div className="row-between">
      <div><h2 style={{ margin: 0 }}>Compré algo para este trabajo</h2>
        <div className="muted small">El cliente lo paga, pero solo el recargo cuenta como ganancia. Cheo no cobra sobre esto.</div></div>
      <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cerrar</button>
    </div>
    <label className="stack" style={{ gap: 6 }}><span className="label">1. ¿Qué compraste?</span>
      <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Ej. Pila de gasolina Hammer" autoFocus /></label>
    <div className="stack" style={{ gap: 6 }}>
      <span className="label">2. ¿Cuánto pagaste?</span>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {CURRENCIES.map(c => <button key={c.id} type="button" className={`btn ${currency === c.id ? "btn-primary" : "btn-ghost"}`} aria-pressed={currency === c.id} onClick={() => setCurrency(c.id)}>{c.label}</button>)}
      </div>
      <input className="input" inputMode="decimal" value={costText} onChange={e => setCostText(e.target.value)} placeholder={currency === "VES" ? "Monto en Bs" : "Monto en $"} style={{ fontSize: 20 }} />
      {costRef > 0 && currency !== "REF" && <span className="muted small">Equivale a {fmtRef(costRef)} BCV</span>}
    </div>
    <div className="stack" style={{ gap: 6 }}>
      <span className="label">3. ¿Cuánto le cobras al cliente?</span>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {[0, 10, 20].map(m => <button key={m} type="button" className={`btn ${markup === m ? "btn-primary" : "btn-ghost"}`} style={{ minHeight: 48 }} onClick={() => setMarkup(m)}>{m === 0 ? "Al costo" : `+${m}%`}</button>)}
        <button type="button" className={`btn ${markup == null ? "btn-primary" : "btn-ghost"}`} style={{ minHeight: 48 }} onClick={() => { setMarkup(null); setChargeText(costRef ? costRef.toFixed(2) : ""); }}>Otro monto</button>
      </div>
      {markup == null && <input className="input" inputMode="decimal" value={chargeText} onChange={e => setChargeText(e.target.value)} placeholder="Monto en $ BCV" />}
    </div>
    <div className="card">
      {costRef > 0 && Number.isFinite(charge)
        ? <><strong>Cobras {fmtRef(charge)}</strong> <span className="muted">· {fmtVes(charge * rates.bcv)}</span>
          <div className="muted small">Pagaste {fmtRef(costRef)} · ganancia de tienda {fmtRef(Math.max(profit, 0))}</div>
          {charge < costRef - 0.01 && <div className="error">Estás cobrando menos de lo que pagaste.</div>}</>
        : <span className="muted">Escribe lo que pagaste para ver el cobro.</span>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    <button className="btn btn-primary btn-block" style={{ minHeight: 52 }} disabled={!valid || busy} onClick={() => void save()}>
      {busy ? "Guardando…" : valid ? `Agregar a la orden · ${fmtRef(charge)}` : "Completa los 3 pasos"}
    </button>
  </div></div>;
}

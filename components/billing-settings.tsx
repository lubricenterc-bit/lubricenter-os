"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { casheaSurchargePercent } from "@/lib/domain/economics";

const KEYS = ["discount_free_limit_percent", "cashea_opportunity_monthly_percent", "cashea_financing_days", "store_markup_percent", "cashea_commission_percent"] as const;
type Values = Record<(typeof KEYS)[number], string>;

/** Mis configuraciones · cobros: tope de descuento, PIN del dueño y cálculo del recargo Cashea. */
export function BillingSettings() {
  const [owner, setOwner] = useState(false);
  const [values, setValues] = useState<Values>({ discount_free_limit_percent: "10", cashea_opportunity_monthly_percent: "5", cashea_financing_days: "45", store_markup_percent: "35", cashea_commission_percent: "4" });
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinNew, setPinNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.rpc("can_administer_orders").then(({ data }) => setOwner(data === true));
    supabase.from("app_settings").select("key,value").in("key", [...KEYS]).then(({ data }) => {
      if (!data) return;
      setValues(v => { const next = { ...v }; for (const row of data) next[row.key as keyof Values] = String(row.value); return next; });
    });
  }, []);

  if (!owner) return null;
  const num = (k: keyof Values) => Number(values[k].replace(",", "."));
  const surcharge40 = casheaSurchargePercent({ commissionPercent: num("cashea_commission_percent"), initialPercent: 40, monthlyOpportunityPercent: num("cashea_opportunity_monthly_percent"), financingDays: num("cashea_financing_days") });

  async function save() {
    setBusy(true); setError(""); setMessage("");
    const { error } = await supabase.rpc("set_billing_settings", {
      p_discount_free_limit_percent: num("discount_free_limit_percent"),
      p_cashea_opportunity_monthly_percent: num("cashea_opportunity_monthly_percent"),
      p_cashea_financing_days: num("cashea_financing_days"),
      p_store_markup_percent: num("store_markup_percent"),
    });
    setBusy(false);
    if (error) return setError(error.message);
    setMessage("Configuración de cobros guardada.");
  }
  async function changePin() {
    setBusy(true); setError(""); setMessage("");
    const { error } = await supabase.rpc("set_owner_pin", { p_current: pinCurrent, p_new: pinNew });
    setBusy(false);
    if (error) return setError(error.message);
    setPinCurrent(""); setPinNew(""); setMessage("PIN del dueño actualizado.");
  }
  const field = (k: keyof Values, label: string, hint: string) => <label className="stack" style={{ gap: 4 }}>
    <span className="label">{label}</span>
    <input className="input" inputMode="decimal" value={values[k]} onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))} />
    <span className="muted small">{hint}</span>
  </label>;

  return <section className="card stack">
    <div className="row-between"><h2 className="section-title">Cobros · descuentos y Cashea</h2><span className="pill">SOLO DUEÑO</span></div>
    <div className="grid grid-2">
      {field("discount_free_limit_percent", "Descuento libre hasta (%)", "Más que esto pide el PIN del dueño.")}
      {field("store_markup_percent", "Recargo de tienda sobre costo (%)", "Para estimar el costo cuando un producto no tiene costo real.")}
      {field("cashea_opportunity_monthly_percent", "Rendimiento mensual del dinero (%)", "Lo que te rinde el dinero en un mes; define el costo de esperar las cuotas.")}
      {field("cashea_financing_days", "Días de financiamiento Cashea", "Plazo con el que se calcula el costo de las cuotas.")}
    </div>
    <div className="card">Con estos valores, el recargo Cashea sobre la mano de obra es <strong>{surcharge40 == null ? "—" : surcharge40.toLocaleString("es-VE", { maximumFractionDigits: 2 }) + "%"}</strong> con 40% de inicial (comisión {values.cashea_commission_percent}%).</div>
    <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Guardar configuración de cobros</button>
    <div className="divider" />
    <div className="stack" style={{ gap: 8 }}>
      <strong>PIN del dueño para descuentos grandes</strong>
      <div className="grid grid-2">
        <label><span className="label">PIN actual</span><input className="input" type="password" inputMode="numeric" autoComplete="off" value={pinCurrent} onChange={e => setPinCurrent(e.target.value.replace(/\D/g, ""))} /></label>
        <label><span className="label">PIN nuevo (4 a 8 números)</span><input className="input" type="password" inputMode="numeric" autoComplete="off" value={pinNew} onChange={e => setPinNew(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
      <button className="btn" disabled={busy || pinNew.length < 4} onClick={() => void changePin()}>Cambiar PIN</button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="success" role="status">{message}</div>}
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function SettingsPage() {
  const [bcv, setBcv] = useState(0);
  const [operative, setOperative] = useState(0);
  const [step, setStep] = useState(10);
  const [mode, setMode] = useState("nearest");
  const [rules, setRules] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: rates, error: re }, { data: settings, error: se }, { data: cr, error: ce }] = await Promise.all([
      supabase.rpc("get_current_rates"),
      supabase.from("app_settings").select("key,value").in("key", ["price_rounding_step", "price_rounding_mode"]),
      supabase.from("compensation_rules").select("id,employee_id,rule_type,value,valid_from,valid_to,employees(name,code)").order("valid_from", { ascending: false }),
    ]);
    if (re || se || ce) setError(re?.message || se?.message || ce?.message || "Error cargando configuración");
    const row = Array.isArray(rates) ? rates[0] : rates;
    setBcv(Number(row?.bcv_rate ?? 0)); setOperative(Number(row?.operative_rate ?? 0));
    for (const s of settings ?? []) {
      if (s.key === "price_rounding_step") setStep(Number(s.value));
      if (s.key === "price_rounding_mode") setMode(String(s.value).replaceAll('"', ''));
    }
    setRules(cr ?? []);
  }
  useEffect(() => { load(); }, []);

  async function saveRates() {
    setMessage(""); setError("");
    const { error } = await supabase.rpc("set_exchange_rates", { p_bcv: bcv, p_operative: operative });
    if (error) return setError(error.message);
    setMessage("Tasas guardadas como nuevos registros históricos. Las órdenes anteriores no cambian.");
    await load();
  }

  async function saveRounding() {
    setMessage(""); setError("");
    const { error } = await supabase.rpc("set_pricing_settings", { p_rounding_step: step, p_rounding_mode: mode });
    if (error) return setError(error.message);
    setMessage("Política de redondeo actualizada.");
  }

  return <main className="container stack">
    <div><h1 style={{ marginBottom: 4 }}>Configuración</h1><div className="muted">Cambios nuevos; nunca se reescribe el histórico financiero.</div></div>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}

    <section className="card stack">
      <h2 className="section-title">Tasas</h2>
      <div className="grid grid-2">
        <label><span className="label">BCV oficial</span><input className="input" type="number" min="0" step="0.0001" value={bcv || ""} onChange={e => setBcv(Number(e.target.value))} /></label>
        <label><span className="label">Operativa / P2P</span><input className="input" type="number" min="0" step="0.0001" value={operative || ""} onChange={e => setOperative(Number(e.target.value))} /></label>
      </div>
      <button className="btn btn-primary" onClick={saveRates}>Guardar nuevas tasas</button>
    </section>

    <section className="card stack">
      <h2 className="section-title">Redondeo catálogo</h2>
      <div className="grid grid-2">
        <label><span className="label">Paso Bs</span><input className="input" type="number" min="1" value={step} onChange={e => setStep(Number(e.target.value))} /></label>
        <label><span className="label">Modo</span><select className="select" value={mode} onChange={e => setMode(e.target.value)}><option value="nearest">Más cercano</option><option value="down">Hacia abajo</option><option value="up">Hacia arriba</option></select></label>
      </div>
      <button className="btn" onClick={saveRounding}>Guardar redondeo</button>
    </section>

    <section className="card" style={{ overflowX: "auto" }}>
      <h2 className="section-title">Reglas económicas vigentes / históricas</h2>
      <table className="table"><thead><tr><th>Empleado</th><th>Regla</th><th>Valor</th><th>Desde</th><th>Hasta</th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}><td>{r.employees?.name ?? "—"}</td><td>{r.rule_type}</td><td>{r.value}</td><td>{r.valid_from}</td><td>{r.valid_to ?? "vigente"}</td></tr>)}
      </tbody></table>
      <p className="muted small">Build 0.1: las reglas se versionan en base de datos. La edición visual completa de reglas entra en 0.2 para evitar borrar histórico por accidente.</p>
    </section>
  </main>;
}

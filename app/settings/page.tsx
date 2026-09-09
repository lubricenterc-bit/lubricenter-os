"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const DEFAULT_POST_SERVICE_TEMPLATE = `Hola *{{nombre}}*! 👋

Gracias por tu visita a *Lubricenter*. Aquí está el resumen de tu servicio:

{{vehiculo_bloque}}
{{servicios_bloque}}
{{productos_bloque}}
{{cambio_aceite_bloque}}
{{servicios_adicionales_bloque}}
{{bonificaciones_bloque}}
{{observaciones_bloque}}
{{estado_bloque}}
{{proximo_servicio_bloque}}

¡Gracias por preferir *Lubricenter*!`;

function formatDate(value: string | null) {
  if (!value) return "Sin sincronizar";
  return new Date(value).toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SettingsPage() {
  const [bcv, setBcv] = useState(0);
  const [operative, setOperative] = useState(0);
  const [bcvAt, setBcvAt] = useState<string | null>(null);
  const [operativeAt, setOperativeAt] = useState<string | null>(null);
  const [catalogAt, setCatalogAt] = useState<string | null>(null);
  const [catalogProducts, setCatalogProducts] = useState(0);
  const [step, setStep] = useState(10);
  const [mode, setMode] = useState("nearest");
  const [rules, setRules] = useState<any[]>([]);
  const [crmTemplate, setCrmTemplate] = useState(DEFAULT_POST_SERVICE_TEMPLATE);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busyTemplate, setBusyTemplate] = useState(false);

  async function load() {
    setError("");
    const [{ data: sync, error: sy }, { data: settings, error: se }, { data: cr, error: ce }] = await Promise.all([
      supabase.rpc("get_pricing_sync_status"),
      supabase.from("app_settings").select("key,value").in("key", ["price_rounding_step", "price_rounding_mode", "crm_post_service_template"]),
      supabase.from("compensation_rules").select("id,employee_id,rule_type,value,valid_from,valid_to,employees(name,code)").order("valid_from", { ascending: false }),
    ]);
    if (sy || se || ce) setError(sy?.message || se?.message || ce?.message || "Error cargando configuración");
    const row = Array.isArray(sync) ? sync[0] : sync;
    setBcv(Number(row?.bcv_rate ?? 0));
    setOperative(Number(row?.operative_rate ?? 0));
    setBcvAt(row?.bcv_effective_at ?? null);
    setOperativeAt(row?.operative_effective_at ?? null);
    setCatalogAt(row?.catalog_synced_at ?? null);
    setCatalogProducts(Number(row?.catalog_products ?? 0));
    for (const s of settings ?? []) {
      if (s.key === "price_rounding_step") setStep(Number(s.value));
      if (s.key === "price_rounding_mode") setMode(String(s.value).replaceAll('"', ''));
      if (s.key === "crm_post_service_template") setCrmTemplate(typeof s.value === "string" ? s.value : String(s.value ?? DEFAULT_POST_SERVICE_TEMPLATE).replace(/^"|"$/g, ""));
    }
    setRules(cr ?? []);
  }
  useEffect(() => { load(); }, []);

  async function saveRounding() {
    setMessage(""); setError("");
    const { error } = await supabase.rpc("set_pricing_settings", { p_rounding_step: step, p_rounding_mode: mode });
    if (error) return setError(error.message);
    setMessage("Política de redondeo actualizada. Verifica que siga coincidiendo con la fórmula de Notion.");
  }

  async function saveCrmTemplate() {
    setBusyTemplate(true); setMessage(""); setError("");
    const { error } = await supabase.rpc("set_crm_post_service_template", { p_template: crmTemplate });
    setBusyTemplate(false);
    if (error) return setError(error.message);
    setMessage("Plantilla post-servicio guardada. Las próximas órdenes cerradas usarán este formato.");
  }

  const rateTimes = [bcvAt, operativeAt].filter(Boolean) as string[];
  const rateFresh = rateTimes.length === 2 && Math.max(...rateTimes.map(v => Date.now() - new Date(v).getTime())) <= 3 * 3600000;
  const catalogFresh = !!catalogAt && Date.now() - new Date(catalogAt).getTime() <= 24 * 3600000;

  return <main className="container stack">
    <div><h1 style={{ marginBottom: 4 }}>Configuración</h1><div className="muted">Notion manda sobre catálogo y tasas. Lubricenter OS controla operación, CRM y trazabilidad.</div></div>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}

    <section className="card stack">
      <div className="row-between"><h2 className="section-title">Mensaje post-servicio · CRM</h2><span className="pill ok">EDITABLE</span></div>
      <div className="muted small">Este es el formato predeterminado. Puedes cambiar texto, emojis, orden y eliminar secciones. Los datos entre llaves se rellenan automáticamente al cerrar cada orden.</div>
      <textarea className="input" style={{ minHeight: 420, fontFamily: "monospace", whiteSpace: "pre-wrap" }} value={crmTemplate} onChange={e => setCrmTemplate(e.target.value)} />
      <div className="card">
        <strong>Variables disponibles</strong>
        <div className="muted small" style={{ lineHeight: 1.8 }}>
          {"{{nombre}} · {{orden}} · {{vehiculo}} · {{placa}} · {{kilometraje}}"}<br />
          {"{{vehiculo_bloque}} · {{servicios_bloque}} · {{productos_bloque}} · {{cambio_aceite_bloque}}"}<br />
          {"{{servicios_adicionales_bloque}} · {{bonificaciones_bloque}} · {{observaciones_bloque}}"}<br />
          {"{{estado_bloque}} · {{proximo_servicio_bloque}}"}<br />
          {"{{servicios_lista}} · {{productos_lista}} · {{servicios_adicionales_lista}} · {{bonificaciones_lista}} · {{observaciones}}"}
        </div>
      </div>
      <div className="grid grid-2">
        <button className="btn btn-primary" disabled={busyTemplate} onClick={saveCrmTemplate}>{busyTemplate ? "Guardando…" : "Guardar plantilla CRM"}</button>
        <button className="btn btn-ghost" onClick={() => setCrmTemplate(DEFAULT_POST_SERVICE_TEMPLATE)}>Restaurar formato base</button>
      </div>
      <div className="muted small">Los mensajes que ya estén pendientes en CRM conservan su texto actual para no cambiar comunicaciones sin que lo notes. Allí podrás editarlos o regenerarlos con la plantilla nueva.</div>
    </section>

    <section className="card stack">
      <div className="row-between"><h2 className="section-title">Tasas maestras · Notion</h2><span className={`pill ${rateFresh ? "ok" : "warn"}`}>{rateFresh ? "SINCRONIZADAS" : "REVISAR"}</span></div>
      <div className="grid grid-2">
        <div className="card"><div className="label">BCV oficial</div><div className="money-lg">{bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div><div className="muted small">{formatDate(bcvAt)}</div></div>
        <div className="card"><div className="label">Operativa / P2P</div><div className="money-lg">{operative.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div><div className="muted small">{formatDate(operativeAt)}</div></div>
      </div>
      <div className="muted small">Estas tasas no se editan aquí. Modifícalas en Notion; el OS sincroniza y conserva el histórico.</div>
    </section>

    <section className="card stack">
      <div className="row-between"><h2 className="section-title">Catálogo maestro · Notion</h2><span className={`pill ${catalogFresh ? "ok" : "warn"}`}>{catalogFresh ? "ACTUALIZADO" : "REVISAR"}</span></div>
      <div className="grid grid-2"><div><div className="label">Productos disponibles</div><div className="money-lg">{catalogProducts}</div></div><div><div className="label">Última sincronización</div><strong>{formatDate(catalogAt)}</strong></div></div>
      {!catalogFresh && <div className="error">Los productos automáticos se bloquean cuando el catálogo está demasiado viejo para evitar precios silenciosamente desactualizados.</div>}
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
      <p className="muted small">Las reglas se versionan para que una modificación futura no reescriba nóminas anteriores.</p>
    </section>
  </main>;
}

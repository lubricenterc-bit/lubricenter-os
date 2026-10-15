"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { FinanceNotifications } from '@/components/finance-notifications';

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
  const [nativeCatalog,setNativeCatalog]=useState(false);
  const [control,setControl]=useState<{bcv_last_fetch?:string;bcv_next?:{value:number;fecha_valor:string}}|null>(null);
  const [bcv, setBcv] = useState(0);
  const [operative, setOperative] = useState(0);
  const [manualOperative, setManualOperative] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [rateRole, setRateRole] = useState("");
  const [savingOperative, setSavingOperative] = useState(false);
  const [bcvAt, setBcvAt] = useState<string | null>(null);
  const [operativeAt, setOperativeAt] = useState<string | null>(null);
  const [catalogAt, setCatalogAt] = useState<string | null>(null);
  const [catalogProducts, setCatalogProducts] = useState(0);
  const [step, setStep] = useState(0.01);
  const [mode, setMode] = useState("nearest");
  const [rules, setRules] = useState<any[]>([]);
  const [crmTemplate, setCrmTemplate] = useState(DEFAULT_POST_SERVICE_TEMPLATE);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busyTemplate, setBusyTemplate] = useState(false);
  const [checkingPrices, setCheckingPrices] = useState(false);

  async function load(showConfirmation = false) {
    if (showConfirmation) setCheckingPrices(true);
    setError("");
    const [{ data: sync, error: sy }, { data: settings, error: se }, { data: cr, error: ce }, { data: financeRole },{data:rateControl,error:rateError}] = await Promise.all([
      supabase.rpc("get_pricing_sync_status"),
      supabase.from("app_settings").select("key,value").in("key", ["price_rounding_step", "price_rounding_mode", "crm_post_service_template","catalog_authority"]),
      supabase.from("compensation_rules").select("id,employee_id,rule_type,value,valid_from,valid_to,employees(name,code)").order("valid_from", { ascending: false }),
      supabase.rpc("finance_role"),
      supabase.rpc("get_exchange_rate_control_status"),
    ]);
    setControl(rateControl);
    if (sy || se || ce || rateError) setError(sy?.message || se?.message || ce?.message || rateError?.message || "Error cargando configuración");
    const row = Array.isArray(sync) ? sync[0] : sync;
    setBcv(Number(row?.bcv_rate ?? 0));
    setOperative(Number(row?.operative_rate ?? 0));
    setManualOperative(String(row?.operative_rate ?? ""));
    setRateRole(String(financeRole ?? ""));
    setBcvAt(row?.bcv_effective_at ?? null);
    setOperativeAt(row?.operative_effective_at ?? null);
    setCatalogAt(row?.catalog_synced_at ?? null);
    setCatalogProducts(Number(row?.catalog_products ?? 0));
    setNativeCatalog(settings?.some(s=>s.key==="catalog_authority"&&s.value==="LUBRICENTER_OS")??false);
    for (const s of settings ?? []) {
      if (s.key === "price_rounding_step") setStep(Number(s.value));
      if (s.key === "price_rounding_mode") setMode(String(s.value).replaceAll('"', ''));
      if (s.key === "crm_post_service_template") setCrmTemplate(typeof s.value === "string" ? s.value : String(s.value ?? DEFAULT_POST_SERVICE_TEMPLATE).replace(/^"|"$/g, ""));
    }
    setRules(cr ?? []);
    if (showConfirmation) {
      setCheckingPrices(false);
      if (!(sy || se || ce)) setMessage("Tasas y estado del catálogo actualizados.");
    }
  }
  useEffect(() => {
    load();
    const onPricingUpdate = () => load();
    window.addEventListener("lubricenter:pricing-updated", onPricingUpdate);
    return () => window.removeEventListener("lubricenter:pricing-updated", onPricingUpdate);
  }, []);

  async function saveRounding() {
    setMessage(""); setError("");
    const { error } = await supabase.rpc("set_pricing_settings", { p_rounding_step: step, p_rounding_mode: mode });
    if (error) return setError(error.message);
    setMessage("Política de redondeo actualizada. Los nuevos cálculos usarán esta política.");
  }

  async function saveOperative() {
    const next=Number(manualOperative.replace(",","."));
    setError("");setMessage("");
    if(!Number.isFinite(next)||next<=0||next>=1000000){
      setError("Escribe una tasa operativa positiva válida.");return;
    }
    setSavingOperative(true);
    const {error:saveError,data}=await supabase.rpc("set_operative_manual",{
      p_value:next,p_note:manualReason.trim()||null
    });
    setSavingOperative(false);
    if(saveError){setError(saveError.message);return;}
    setManualReason("");
    setMessage(data?.changed?"Tasa operativa actualizada y registrada en auditoría.":"La tasa operativa ya tenía ese valor.");
    await load();
  }

  async function saveCrmTemplate() {
    setBusyTemplate(true); setMessage(""); setError("");
    const { error } = await supabase.rpc("set_crm_post_service_template", { p_template: crmTemplate });
    setBusyTemplate(false);
    if (error) return setError(error.message);
    setMessage("Plantilla post-servicio guardada. Las próximas órdenes cerradas usarán este formato.");
  }

  const rateFresh = bcv > 0 && operative > 0 && !!bcvAt && new Date(bcvAt).getTime() <= Date.now() && Date.now()-new Date(bcvAt).getTime() <= 10*86400000;
  const catalogFresh = !!catalogAt && Date.now() - new Date(catalogAt).getTime() <= 24 * 3600000;

  return <main className="container stack">
    <div><h1 style={{ marginBottom: 4 }}>Configuración</h1><div className="muted">Catálogo de productos, tasas y reglas de operación.</div></div>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}

    <FinanceNotifications />
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
      <div className="row-between">
        <h2 className="section-title">Control independiente de tasas</h2>
        <span className={`pill ${rateFresh?"ok":"warn"}`}>{rateFresh?"TASAS DISPONIBLES":"REVISAR BCV"}</span>
      </div>
      <div className="grid grid-2">
        <div className="card stack">
          <div className="label">BCV · {nativeCatalog?"captador automático":"fuente en transición"}</div>
          <div className="money-lg">{bcv.toLocaleString("es-VE",{maximumFractionDigits:6})}</div>
          <div className="muted small">Fecha valor vigente: {formatDate(bcvAt)}</div>
          <p className="muted small">El captador guarda por separado la fecha de publicación y la fecha valor. Una tasa anunciada para una fecha futura no reemplaza anticipadamente la actual.</p>
        </div>
        <div className="card stack">
          <div className="label">Tasa operativa · manual</div>
          <div className="money-lg">{operative.toLocaleString("es-VE",{maximumFractionDigits:6})}</div>
          <div className="muted small">Último cambio: {formatDate(operativeAt)}</div>
          <p className="muted small">{nativeCatalog?"La tasa operativa se administra manualmente.":"La fuente anterior sigue activa hasta verificar el cambio de tasas."}</p>
        </div>
      </div>
      <div className="muted small">Última consulta del captador: {formatDate(control?.bcv_last_fetch??null)}{control?.bcv_next?` · Próxima fecha valor: ${control.bcv_next.fecha_valor} (${control.bcv_next.value} Bs/USD)`:""}</div>
      <label><span className="label">Nueva tasa operativa (Bs por USD)</span>
        <input className="input" type="text" inputMode="decimal" value={manualOperative}
          onChange={e=>setManualOperative(e.target.value)} placeholder="Ej. 1061,32"
          disabled={rateRole!=="OWNER"||!nativeCatalog}/>
      </label>
      <label><span className="label">Motivo o referencia (opcional)</span>
        <input className="input" value={manualReason} onChange={e=>setManualReason(e.target.value)}
          placeholder="Ej. Ajuste comercial por nuevo costo de reposición"
          disabled={rateRole!=="OWNER"||!nativeCatalog}/>
      </label>
      {rateRole==="OWNER"&&nativeCatalog?
        <button className="btn btn-primary" disabled={savingOperative} onClick={saveOperative}>
          {savingOperative?"Guardando tasa…":"Guardar nueva tasa operativa"}
        </button>:
        <p className="muted small">La edición manual se habilita para la cuenta propietaria al completar la transición.</p>}
      <div className="muted small">El cambio afecta cálculos nuevos. Las órdenes y cobros anteriores conservan sus tasas registradas.</div>
      <button className="btn btn-ghost" disabled={checkingPrices} onClick={()=>load(true)}>
        {checkingPrices?"Comprobando…":"Actualizar estado de tasas"}
      </button>
      <p className="muted small">Para días no hábiles la pantalla operativa utiliza la última fecha valor ya vigente. Los criterios tributarios de facturación en feriados pueden ser distintos y deben revisarse por separado.</p>
    </section>

    <section className="card stack">
      <div className="row-between"><h2 className="section-title">Catálogo maestro · {nativeCatalog?"Lubricenter OS":"Notion (transición)"}</h2><span className={`pill ${catalogFresh ? "ok" : "warn"}`}>{catalogFresh ? "ACTUALIZADO" : "REVISAR"}</span></div>
      <div className="grid grid-2"><div><div className="label">Productos disponibles</div><div className="money-lg">{catalogProducts}</div></div><div><div className="label">{nativeCatalog?"Estado del catálogo":"Última sincronización"}</div><strong>{formatDate(catalogAt)}</strong></div></div>
      <div className="row"><Link className="btn" href="/catalog/manage">Administrar catálogo</Link><Link className="btn btn-ghost" href="/expenses">Compras y proveedores</Link></div>
      {!catalogFresh && <div className="error">Los productos automáticos se bloquean cuando el catálogo está demasiado viejo para evitar precios silenciosamente desactualizados.</div>}
    </section>

    <section className="card stack">
      <h2 className="section-title">Redondeo catálogo</h2>
      <div className="grid grid-2">
        <label><span className="label">Paso Bs</span><input className="input" type="number" min="0.01" step="0.01" value={step} onChange={e => setStep(Number(e.target.value))} /></label>
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

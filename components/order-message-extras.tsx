"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const ADDITIONAL_OPTIONS = [
  "Calibración de presión de los cauchos",
  "Chequeo de fluidos",
  "Revisión del filtro de aire",
];

const BONUS_OPTIONS = [
  "Relleno de líquido limpiaparabrisas",
  "Limpieza bajo el capó con ducha marina",
];

type Extras = {
  crm_additional_services: string[] | null;
  crm_bonuses: string[] | null;
  crm_observations: string | null;
};

export function OrderMessageExtras({ orderId, ensureOrder, onSaved, onBusyChange }: {
  orderId: string | null;
  ensureOrder: () => Promise<string>;
  onSaved: (id: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [additional, setAdditional] = useState<string[]>([]);
  const [bonuses, setBonuses] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [customKind, setCustomKind] = useState<"additional" | "bonus">("additional");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!orderId) return;
    let active = true;
    const load = () => supabase.from("orders").select("crm_additional_services,crm_bonuses,crm_observations")
      .eq("id", orderId).single().then(({ data, error }) => {
        if (!active) return;
        if (error) setError(error.message);
        else {
          setAdditional((data as Extras).crm_additional_services ?? []);
          setBonuses((data as Extras).crm_bonuses ?? []);
        }
      });
    const onUpdate = (event: Event) => { if ((event as CustomEvent<string>).detail === orderId) load(); };
    load();
    window.addEventListener("lubricenter:order-extras-updated", onUpdate);
    return () => { active = false; window.removeEventListener("lubricenter:order-extras-updated", onUpdate); };
  }, [orderId]);

  async function save(kind: "additional" | "bonus", value: string, selected: boolean) {
    if (busy) return;
    const label = value.trim();
    if (!label) return setError("Escribe el detalle que quieres agregar.");
    setBusy(true); onBusyChange(true); setError(""); setNotice("");
    try {
      const id = await ensureOrder();
      const { data, error: readError } = await supabase.from("orders")
        .select("crm_additional_services,crm_bonuses,crm_observations").eq("id", id).single();
      if (readError) throw readError;
      const current = data as Extras;
      const nextAdditional = [...(current.crm_additional_services ?? [])];
      const nextBonuses = [...(current.crm_bonuses ?? [])];
      const target = kind === "additional" ? nextAdditional : nextBonuses;
      const match = (item: string) => item.toLocaleLowerCase("es-VE") === label.toLocaleLowerCase("es-VE");
      const next = selected ? (target.some(match) ? target : [...target, label]) : target.filter(item => !match(item));
      const { error: saveError } = await supabase.rpc("set_order_crm_extras", {
        p_order_id: id,
        p_additional_services: kind === "additional" ? next : nextAdditional,
        p_bonuses: kind === "bonus" ? next : nextBonuses,
        p_observations: current.crm_observations,
      });
      if (saveError) throw saveError;
      setAdditional(kind === "additional" ? next : nextAdditional);
      setBonuses(kind === "bonus" ? next : nextBonuses);
      setCustom("");
      setNotice("Guardado para el mensaje del cliente.");
      window.dispatchEvent(new CustomEvent("lubricenter:order-extras-updated", { detail: id }));
      await onSaved(id);
    } catch (e: any) {
      setError(e.message ?? "No pudimos guardar el detalle. Inténtalo de nuevo.");
    } finally { setBusy(false); onBusyChange(false); }
  }

  const customItems = [
    ...additional.filter(item => !ADDITIONAL_OPTIONS.includes(item)).map(item => ({ kind: "additional" as const, label: item })),
    ...bonuses.filter(item => !BONUS_OPTIONS.includes(item)).map(item => ({ kind: "bonus" as const, label: item })),
  ];

  return <section className="card stack" aria-label="Detalles para el mensaje del cliente">
    <div><div className="eyebrow">MENSAJE AL CLIENTE</div><h2 className="section-title">Detalles de la atención</h2><p className="muted small">Marca solo lo que realmente hiciste. Se guarda al instante y aparecerá en el resumen al cerrar la orden.</p></div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    <div className="grid grid-2">
      <div className="stack"><strong>🔧 También hicimos</strong>{ADDITIONAL_OPTIONS.map(option => <label key={option} className="card" style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><input type="checkbox" checked={additional.includes(option)} disabled={busy} onChange={event => save("additional", option, event.target.checked)} /><span>{option}</span></label>)}</div>
      <div className="stack"><strong>🎁 De cortesía</strong>{BONUS_OPTIONS.map(option => <label key={option} className="card" style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><input type="checkbox" checked={bonuses.includes(option)} disabled={busy} onChange={event => save("bonus", option, event.target.checked)} /><span>{option}</span></label>)}</div>
    </div>
    {!!customItems.length && <div className="stack"><span className="label">Otros detalles guardados</span>{customItems.map(item => <div key={`${item.kind}:${item.label}`} className="row-between"><span>{item.kind === "bonus" ? "🎁" : "🔧"} {item.label}</span><button className="btn btn-ghost" disabled={busy} onClick={() => save(item.kind, item.label, false)}>Quitar</button></div>)}</div>}
    <div className="grid grid-2"><label><span className="label">Agregar otro detalle</span><input className="input" value={custom} disabled={busy} onChange={event => setCustom(event.target.value)} placeholder="Ej. Limpieza de bornes" /></label><label><span className="label">Mostrar como</span><select className="select" value={customKind} disabled={busy} onChange={event => setCustomKind(event.target.value as "additional" | "bonus")}><option value="additional">Trabajo adicional</option><option value="bonus">Cortesía</option></select></label></div>
    <button className="btn" disabled={busy || !custom.trim()} onClick={() => save(customKind, custom, true)}>{busy ? "Guardando…" : "+ Agregar detalle"}</button>
  </section>;
}

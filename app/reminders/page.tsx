"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Reminder = {
  service_record_id: string;
  vehicle_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  current_odometer: number | null;
  performed_at: string;
  service_odometer: number | null;
  oil_brand: string | null;
  oil_viscosity: string | null;
  oil_filter_code: string | null;
  next_service_odometer: number | null;
  next_service_date: string | null;
  reminder_status: "PENDING" | "SENT" | "SNOOZED";
  snoozed_until: string | null;
  sent_at: string | null;
  urgency: "DUE" | "SOON" | "UPCOMING" | "SENT" | "SNOOZED";
};

type Filter = "ACTION" | "ALL" | "SENT";

function cleanWhatsapp(value: string | null) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("58")) return digits;
  if (digits.startsWith("0")) return `58${digits.slice(1)}`;
  if (digits.startsWith("4") && digits.length === 10) return `58${digits}`;
  return digits;
}

function reminderMessage(r: Reminder) {
  const name = (r.customer_name || "").trim() || "amigo";
  const vehicle = [r.make, r.model].filter(Boolean).join(" ") || "tu vehículo";
  const plate = r.plate ? `\n🔢 *Placa:* ${r.plate}` : "";
  const km = r.next_service_odometer ? `\n📈 *Kilometraje estimado:* Deberías estar cerca de los *${r.next_service_odometer.toLocaleString("es-VE")} km*.` : "";
  return `Hola *${name}*! 👋\n\nTe escribimos de *Lubricenter* para recordarte que ya es hora de consentir tu vehículo. 🛠️\n\nSegún nuestros registros:\n🚗 *Vehículo:* ${vehicle}${plate}\n\n🗓️ *Motivo:* Ya corresponde revisar tu próximo servicio.${km}\n\n¡Es un buen momento para agendar tu próxima visita! Te esperamos con el mejor servicio.`;
}

function formatDate(value: string | null) {
  if (!value) return "Sin fecha";
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" });
}

export default function RemindersPage() {
  const [rows, setRows] = useState<Reminder[]>([]);
  const [filter, setFilter] = useState<Filter>("ACTION");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    const { data, error } = await supabase
      .from("maintenance_reminders_current")
      .select("*")
      .order("next_service_date", { ascending: true, nullsFirst: false })
      .limit(1000);
    if (error) return setError(error.message);
    setRows((data ?? []) as Reminder[]);
  }

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => rows.filter(r => {
    if (filter === "SENT") return r.urgency === "SENT";
    if (filter === "ACTION") return ["DUE", "SOON"].includes(r.urgency);
    return true;
  }), [rows, filter]);

  const due = rows.filter(r => r.urgency === "DUE").length;
  const soon = rows.filter(r => r.urgency === "SOON").length;
  const sent = rows.filter(r => r.urgency === "SENT").length;

  async function setStatus(r: Reminder, status: "PENDING" | "SENT" | "SNOOZED", snoozedUntil?: string) {
    setBusyId(r.service_record_id); setError(""); setNotice("");
    const { error } = await supabase.rpc("set_maintenance_reminder_status", {
      p_service_record_id: r.service_record_id,
      p_status: status,
      p_snoozed_until: status === "SNOOZED" ? snoozedUntil : null,
    });
    setBusyId(null);
    if (error) return setError(error.message);
    setNotice(status === "SENT" ? "Recordatorio marcado como enviado." : status === "SNOOZED" ? "Recordatorio pospuesto 7 días." : "Recordatorio reactivado.");
    await load();
  }

  function openWhatsapp(r: Reminder) {
    const phone = cleanWhatsapp(r.customer_phone);
    if (!phone) return setError("Este cliente no tiene un número de WhatsApp válido registrado.");
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(reminderMessage(r))}`, "_blank", "noopener,noreferrer");
  }

  function snoozeSevenDays(r: Reminder) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setStatus(r, "SNOOZED", d.toISOString().slice(0, 10));
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">ATENCIÓN AL CLIENTE</div><h1>Recordatorios</h1><p>Los avisos de mantenimiento viven dentro de Lubricenter OS. Abre WhatsApp con el mensaje listo y conserva el estado del seguimiento.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className="grid grid-3">
      <div className="card"><div className="muted small">VENCIDOS</div><div className="kpi">{due}</div><div className="muted">Enviar ahora</div></div>
      <div className="card"><div className="muted small">PRÓXIMOS 14 DÍAS</div><div className="kpi">{soon}</div><div className="muted">Seguimiento preventivo</div></div>
      <div className="card"><div className="muted small">ENVIADOS</div><div className="kpi">{sent}</div><div className="muted">Último servicio de cada vehículo</div></div>
    </section>

    <section className="card stack">
      <div className="segmented">
        <button className={`btn ${filter === "ACTION" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("ACTION")}>Por atender</button>
        <button className={`btn ${filter === "ALL" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("ALL")}>Todos</button>
        <button className={`btn ${filter === "SENT" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("SENT")}>Enviados</button>
      </div>
      <div className="muted small">{visible.length} recordatorios visibles</div>
    </section>

    <section className="stack">
      {visible.map(r => {
        const canWhatsapp = !!cleanWhatsapp(r.customer_phone);
        const vehicle = [r.make, r.model, r.year].filter(Boolean).join(" · ");
        return <article className="card stack" key={r.service_record_id}>
          <div className="row-between">
            <div><div className="row"><strong>{r.customer_name || "Cliente sin nombre"}</strong><span className={`pill ${r.urgency === "DUE" ? "warn" : r.urgency === "SENT" ? "ok" : ""}`}>{r.urgency === "DUE" ? "VENCIDO" : r.urgency === "SOON" ? "PRÓXIMO" : r.urgency === "SENT" ? "ENVIADO" : r.urgency === "SNOOZED" ? "POSPUESTO" : "PROGRAMADO"}</span></div><div>{[r.plate, vehicle].filter(Boolean).join(" · ") || "Vehículo"}</div><div className="muted small">{r.customer_phone || "Sin teléfono"}</div></div>
            <div style={{ textAlign: "right" }}><div className="label">PRÓXIMO</div><strong>{formatDate(r.next_service_date)}</strong>{r.next_service_odometer != null && <div className="muted small">{r.next_service_odometer.toLocaleString("es-VE")} km</div>}</div>
          </div>
          <div className="muted small">Último aceite: {[r.oil_brand, r.oil_viscosity, r.oil_filter_code ? `Filtro ${r.oil_filter_code}` : null].filter(Boolean).join(" · ") || "Sin detalle"}</div>
          {r.urgency !== "SENT" ? <div className="grid grid-2">
            <button className="btn btn-primary" disabled={!canWhatsapp || busyId === r.service_record_id} onClick={() => openWhatsapp(r)}>Abrir WhatsApp</button>
            <button className="btn" disabled={busyId === r.service_record_id} onClick={() => setStatus(r, "SENT")}>{busyId === r.service_record_id ? "Guardando…" : "Marcar enviado"}</button>
            <button className="btn btn-ghost" disabled={busyId === r.service_record_id} onClick={() => snoozeSevenDays(r)}>Posponer 7 días</button>
          </div> : <button className="btn btn-ghost" disabled={busyId === r.service_record_id} onClick={() => setStatus(r, "PENDING")}>Reabrir recordatorio</button>}
          {!canWhatsapp && <div className="error">Falta un teléfono válido en el cliente. Corrígelo en Clientes para habilitar WhatsApp.</div>}
        </article>;
      })}
      {!visible.length && <div className="card muted">No hay recordatorios en esta vista. Los próximos aparecerán automáticamente cuando cierres cambios de aceite con próxima fecha o kilometraje.</div>}
    </section>
  </main>;
}

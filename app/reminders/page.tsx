"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Followup = {
  id: string;
  order_id: string;
  order_number: string;
  followup_type: string;
  status: "PENDING" | "SENT" | "SNOOZED";
  message: string;
  sent_at: string | null;
  snoozed_until: string | null;
  closed_at: string | null;
  health_status: "GREEN" | "YELLOW" | "RED";
  customer_name: string | null;
  customer_phone: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
};

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

type Tab = "POST_SERVICE" | "MAINTENANCE";
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
  const d = value.length <= 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" });
}

export default function CrmPage() {
  const [tab, setTab] = useState<Tab>("POST_SERVICE");
  const [filter, setFilter] = useState<Filter>("ACTION");
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [drafts, setDrafts] = useState<Record<string,string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    const [{ data: f, error: fe }, { data: r, error: re }] = await Promise.all([
      supabase.from("customer_followups_current").select("*").eq("followup_type", "POST_SERVICE").order("closed_at", { ascending: false, nullsFirst: false }).limit(500),
      supabase.from("maintenance_reminders_current").select("*").order("next_service_date", { ascending: true, nullsFirst: false }).limit(1000),
    ]);
    if (fe || re) return setError((fe || re)?.message ?? "No pude cargar el CRM.");
    const rows = (f ?? []) as Followup[];
    setFollowups(rows);
    setDrafts(prev => {
      const next = { ...prev };
      for (const row of rows) if (next[row.id] == null) next[row.id] = row.message;
      return next;
    });
    setReminders((r ?? []) as Reminder[]);
  }

  useEffect(() => { load(); }, []);

  const visibleFollowups = useMemo(() => followups.filter(f => {
    if (filter === "SENT") return f.status === "SENT";
    if (filter === "ACTION") return f.status === "PENDING" || (f.status === "SNOOZED" && (!f.snoozed_until || f.snoozed_until <= new Date().toISOString().slice(0,10)));
    return true;
  }), [followups, filter]);

  const visibleReminders = useMemo(() => reminders.filter(r => {
    if (filter === "SENT") return r.urgency === "SENT";
    if (filter === "ACTION") return ["DUE", "SOON"].includes(r.urgency);
    return true;
  }), [reminders, filter]);

  const postPending = followups.filter(f => f.status === "PENDING").length;
  const due = reminders.filter(r => r.urgency === "DUE").length;
  const soon = reminders.filter(r => r.urgency === "SOON").length;

  function openWhatsapp(phoneValue: string | null, message: string) {
    const phone = cleanWhatsapp(phoneValue);
    if (!phone) return setError("Este cliente no tiene un número de WhatsApp válido registrado.");
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  async function saveDraft(f: Followup) {
    setBusyId(f.id); setError(""); setNotice("");
    const text = drafts[f.id] ?? f.message;
    const { error } = await supabase.rpc("update_customer_followup_message", { p_followup_id: f.id, p_message: text });
    setBusyId(null);
    if (error) return setError(error.message);
    setNotice("Mensaje guardado. Puedes enviarlo por WhatsApp con este texto.");
    setFollowups(rows => rows.map(x => x.id === f.id ? { ...x, message: text } : x));
  }

  async function regenerate(f: Followup) {
    setBusyId(f.id); setError(""); setNotice("");
    const { data, error } = await supabase.rpc("regenerate_customer_followup_message", { p_followup_id: f.id });
    setBusyId(null);
    if (error) return setError(error.message);
    const text = String(data ?? "");
    setDrafts(d => ({ ...d, [f.id]: text }));
    setFollowups(rows => rows.map(x => x.id === f.id ? { ...x, message: text } : x));
    setNotice("Mensaje regenerado con la plantilla actual de Configuración.");
  }

  async function setFollowupStatus(f: Followup, status: "PENDING" | "SENT" | "SNOOZED", snoozedUntil?: string) {
    setBusyId(f.id); setError(""); setNotice("");
    if (status === "SENT" && (drafts[f.id] ?? f.message) !== f.message) {
      const { error: saveError } = await supabase.rpc("update_customer_followup_message", { p_followup_id: f.id, p_message: drafts[f.id] });
      if (saveError) { setBusyId(null); return setError(saveError.message); }
    }
    const { error } = await supabase.rpc("set_customer_followup_status", {
      p_followup_id: f.id,
      p_status: status,
      p_snoozed_until: status === "SNOOZED" ? snoozedUntil : null,
    });
    setBusyId(null);
    if (error) return setError(error.message);
    setNotice(status === "SENT" ? "Mensaje post-servicio marcado como enviado." : status === "SNOOZED" ? "Seguimiento pospuesto." : "Seguimiento reabierto.");
    await load();
  }

  async function setReminderStatus(r: Reminder, status: "PENDING" | "SENT" | "SNOOZED", snoozedUntil?: string) {
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

  function snoozeDate(days: number) {
    const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10);
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">CRM · EXPERIENCIA DEL CLIENTE</div><h1>Seguimiento</h1><p>El mensaje post-servicio es editable. El mantenimiento queda separado para contactar al cliente cuando corresponda.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className="grid grid-3">
      <div className="card"><div className="muted small">POST-SERVICIO PENDIENTE</div><div className="kpi">{postPending}</div><div className="muted">Enviar al terminar la visita</div></div>
      <div className="card"><div className="muted small">MANTENIMIENTOS VENCIDOS</div><div className="kpi">{due}</div><div className="muted">Contactar ahora</div></div>
      <div className="card"><div className="muted small">PRÓXIMOS 14 DÍAS</div><div className="kpi">{soon}</div><div className="muted">Seguimiento preventivo</div></div>
    </section>

    <section className="card stack">
      <div className="segmented">
        <button className={`btn ${tab === "POST_SERVICE" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("POST_SERVICE")}>Post-servicio · {postPending}</button>
        <button className={`btn ${tab === "MAINTENANCE" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("MAINTENANCE")}>Mantenimiento · {due + soon}</button>
      </div>
      <div className="segmented">
        <button className={`btn ${filter === "ACTION" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("ACTION")}>Por atender</button>
        <button className={`btn ${filter === "ALL" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("ALL")}>Todos</button>
        <button className={`btn ${filter === "SENT" ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter("SENT")}>Enviados</button>
      </div>
    </section>

    {tab === "POST_SERVICE" ? <section className="stack">
      {visibleFollowups.map(f => {
        const phoneOk = !!cleanWhatsapp(f.customer_phone);
        const vehicle = [f.plate, f.make, f.model, f.year].filter(Boolean).join(" · ") || "Sin vehículo";
        const draft = drafts[f.id] ?? f.message;
        const changed = draft !== f.message;
        return <article className="card stack" key={f.id}>
          <div className="row-between">
            <div><div className="row"><strong>{f.customer_name || "Cliente sin nombre"}</strong><span className={`pill ${f.status === "SENT" ? "ok" : "warn"}`}>{f.status === "SENT" ? "ENVIADO" : f.status === "SNOOZED" ? "POSPUESTO" : "PENDIENTE"}</span></div><div>{vehicle}</div><div className="muted small">{f.customer_phone || "Sin teléfono"} · {formatDate(f.closed_at)}</div></div>
            <Link href={`/orders/${f.order_id}`} className="btn btn-ghost">{f.order_number}</Link>
          </div>

          <label><span className="label">Mensaje para WhatsApp</span><textarea className="input" style={{ minHeight: 280, whiteSpace: "pre-wrap" }} value={draft} disabled={f.status === "SENT"} onChange={e => setDrafts(d => ({ ...d, [f.id]: e.target.value }))} /></label>
          {f.status !== "SENT" && <div className="grid grid-2">
            <button className="btn" disabled={!changed || busyId === f.id} onClick={() => saveDraft(f)}>{busyId === f.id ? "Guardando…" : changed ? "Guardar edición" : "Sin cambios"}</button>
            <button className="btn btn-ghost" disabled={busyId === f.id} onClick={() => regenerate(f)}>Regenerar con plantilla</button>
          </div>}

          {f.status !== "SENT" ? <div className="grid grid-2">
            <button className="btn btn-primary" disabled={!phoneOk || busyId === f.id} onClick={() => openWhatsapp(f.customer_phone, draft)}>Abrir WhatsApp</button>
            <button className="btn" disabled={busyId === f.id} onClick={() => setFollowupStatus(f, "SENT")}>{busyId === f.id ? "Guardando…" : "Marcar enviado"}</button>
            <button className="btn btn-ghost" disabled={busyId === f.id} onClick={() => setFollowupStatus(f, "SNOOZED", snoozeDate(1))}>Posponer 1 día</button>
          </div> : <button className="btn btn-ghost" disabled={busyId === f.id} onClick={() => setFollowupStatus(f, "PENDING")}>Reabrir seguimiento</button>}
          {!phoneOk && <div className="error">Falta un WhatsApp válido. Corrige el teléfono del cliente antes de enviar.</div>}
        </article>;
      })}
      {!visibleFollowups.length && <div className="card muted">No hay mensajes post-servicio pendientes en esta vista. Cada orden cerrada con cliente genera uno automáticamente.</div>}
    </section> : <section className="stack">
      {visibleReminders.map(r => {
        const phoneOk = !!cleanWhatsapp(r.customer_phone);
        const vehicle = [r.make, r.model, r.year].filter(Boolean).join(" · ");
        const msg = reminderMessage(r);
        return <article className="card stack" key={r.service_record_id}>
          <div className="row-between">
            <div><div className="row"><strong>{r.customer_name || "Cliente sin nombre"}</strong><span className={`pill ${r.urgency === "DUE" ? "warn" : r.urgency === "SENT" ? "ok" : ""}`}>{r.urgency === "DUE" ? "VENCIDO" : r.urgency === "SOON" ? "PRÓXIMO" : r.urgency === "SENT" ? "ENVIADO" : r.urgency === "SNOOZED" ? "POSPUESTO" : "PROGRAMADO"}</span></div><div>{[r.plate, vehicle].filter(Boolean).join(" · ") || "Vehículo"}</div><div className="muted small">{r.customer_phone || "Sin teléfono"}</div></div>
            <div style={{ textAlign: "right" }}><div className="label">PRÓXIMO</div><strong>{formatDate(r.next_service_date)}</strong>{r.next_service_odometer != null && <div className="muted small">{r.next_service_odometer.toLocaleString("es-VE")} km</div>}</div>
          </div>
          <details className="card"><summary><strong>Ver mensaje</strong></summary><div style={{ whiteSpace: "pre-wrap", marginTop: 12 }} className="small">{msg}</div></details>
          {r.urgency !== "SENT" ? <div className="grid grid-2">
            <button className="btn btn-primary" disabled={!phoneOk || busyId === r.service_record_id} onClick={() => openWhatsapp(r.customer_phone, msg)}>Abrir WhatsApp</button>
            <button className="btn" disabled={busyId === r.service_record_id} onClick={() => setReminderStatus(r, "SENT")}>{busyId === r.service_record_id ? "Guardando…" : "Marcar enviado"}</button>
            <button className="btn btn-ghost" disabled={busyId === r.service_record_id} onClick={() => setReminderStatus(r, "SNOOZED", snoozeDate(7))}>Posponer 7 días</button>
          </div> : <button className="btn btn-ghost" disabled={busyId === r.service_record_id} onClick={() => setReminderStatus(r, "PENDING")}>Reabrir recordatorio</button>}
          {!phoneOk && <div className="error">Falta un teléfono válido en el cliente. Corrígelo en Clientes para habilitar WhatsApp.</div>}
        </article>;
      })}
      {!visibleReminders.length && <div className="card muted">No hay recordatorios de mantenimiento en esta vista.</div>}
    </section>}
  </main>;
}

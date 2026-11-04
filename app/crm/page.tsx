"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ContactTunnel } from "@/components/crm/contact-tunnel";
import { OsIcon } from "@/components/os-icon";
import { supabase } from "@/lib/supabase";
import {
  KIND_LABEL, OUTCOMES, TEMPLATE_HELP, addDays, caracasToday, displayName, estimateMinutes, shortDate, waLink,
  type CrmBoard, type CrmOutcome, type CrmResults, type CrmTemplateKind,
} from "@/lib/crm";
import { NumberInput } from "@/components/number-field";

type Tab = "TODAY" | "WAITING" | "BOOKED" | "FIX" | "RESULTS" | "ALL" | "MESSAGES";
type Journey = {
  service_record_id: string; vehicle_id: string; customer_id: string; customer_name: string | null;
  customer_phone: string | null; wa_phone: string | null; plate: string | null; make: string | null; model: string | null;
  performed_at: string; cycle_due: string; days_from_due: number; status: string; next_kind: string | null;
  sent_count: number; last_sent_at: string | null; eligible_on: string | null; last_outcome: string | null; last_outcome_on: string | null;
};
type Template = { kind: CrmTemplateKind; body: string };

const STATUS_LABEL: Record<string, string> = {
  READY: "Para contactar", SCHEDULED: "Programado", UPCOMING: "Todavía no le toca", WAITING_REPLY: "Esperando respuesta",
  BOOKED: "Tiene cita", CLOSED: "Cerrado", CLOSED_NO_REPLY: "Sin respuesta", NO_PHONE: "Falta WhatsApp", OPTED_OUT: "No quiere mensajes",
};
const OUTCOME_LABEL: Record<string, string> = {
  BOOKED: "Agendó", POSTPONED: "Más adelante", REPLIED: "Respondió", DECLINED: "No le interesa",
  SOLD_VEHICLE: "Vendió el carro", CLOSED_NO_REPLY: "Sin respuesta",
};
const TEMPLATE_ORDER: CrmTemplateKind[] = ["PRE", "DUE", "FINAL", "RECOVERY", "RECONNECT"];

function money(n: number) {
  return "REF " + n.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CrmPage() {
  const [tab, setTab] = useState<Tab>("TODAY");
  const [board, setBoard] = useState<CrmBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tunnel, setTunnel] = useState(false);

  async function load() {
    setLoading(true); setError("");
    const { data, error } = await supabase.rpc("crm_board");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setBoard(data as CrmBoard);
  }
  useEffect(() => { void load(); }, []);

  const queue = board?.queue ?? [];
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "TODAY", label: "Hoy", count: queue.length },
    { id: "WAITING", label: "Esperando respuesta", count: board?.waiting.length },
    { id: "BOOKED", label: "Citas", count: board?.booked.length },
    { id: "FIX", label: "Corregir datos", count: board?.fix.length },
    { id: "RESULTS", label: "Resultados" },
    { id: "ALL", label: "Todos los vehículos" },
    { id: "MESSAGES", label: "Mensajes y reglas" },
  ];

  if (tunnel && board) {
    return <ContactTunnel queue={queue} sentToday={board.sent_today} cap={board.cap}
      onClose={changed => { setTunnel(false); if (changed) void load(); }} />;
  }

  return <main className="container crm">
    <header className="crm-head">
      <div>
        <div className="crm-crumb">Clientes</div>
        <h1>Seguimiento</h1>
      </div>
      <p>El sistema elige a quién escribirle hoy y prepara el mensaje. Tú lo envías por WhatsApp y anotas qué respondió el cliente.</p>
    </header>

    <nav className="crm-tabs" aria-label="Secciones de seguimiento">
      {tabs.map(t => <button key={t.id} className={tab === t.id ? "is-active" : ""} onClick={() => { setTab(t.id); setNotice(""); }}>
        {t.label}{typeof t.count === "number" && t.count > 0 ? <span>{t.count}</span> : null}
      </button>)}
    </nav>

    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    {loading && !board ? <p className="crm-muted">Preparando la lista de hoy…</p> : null}

    {board && tab === "TODAY" && <TodayView board={board} onStart={() => setTunnel(true)} />}
    {board && tab === "WAITING" && <WaitingView board={board} onChanged={msg => { setNotice(msg); void load(); }} onError={setError} />}
    {board && tab === "BOOKED" && <BookedView board={board} />}
    {board && tab === "FIX" && <FixView board={board} onChanged={msg => { setNotice(msg); void load(); }} onError={setError} />}
    {tab === "RESULTS" && <ResultsView onError={setError} />}
    {tab === "ALL" && <AllView onChanged={msg => { setNotice(msg); void load(); }} onError={setError} />}
    {tab === "MESSAGES" && <MessagesView cap={board?.cap ?? 15} onChanged={msg => { setNotice(msg); void load(); }} onError={setError} />}
  </main>;
}

function TodayView({ board, onStart }: { board: CrmBoard; onStart: () => void }) {
  const q = board.queue;
  const post = q.filter(x => x.type === "POST_SERVICE").length;
  return <section className="crm-today">
    <div className="crm-hero">
      <div>
        <span className="crm-hero-label">Para enviar hoy</span>
        <strong className="crm-hero-number">{q.length}</strong>
        <span className="crm-hero-note">{q.length ? `unos ${estimateMinutes(q.length)} min` : board.sent_today >= board.cap ? "Ya llegaste al máximo de hoy" : "No hay mensajes pendientes"}</span>
      </div>
      <div className="crm-hero-side">
        <div><span>Enviados hoy</span><strong>{board.sent_today} de {board.cap}</strong></div>
        <div><span>Esperan su turno</span><strong>{Math.max(board.ready_total - q.length, 0)}</strong></div>
        <button className="btn btn-primary crm-big" disabled={!q.length} onClick={onStart}>
          <OsIcon name="arrow" size={18} /> Empezar</button>
      </div>
    </div>
    {q.length > 0 && <>
      <h2 className="crm-section">En la lista de hoy</h2>
      <ol className="crm-rows">
        {q.map((x, i) => <li key={x.id} className="crm-row">
          <span className="crm-row-n">{i + 1}</span>
          <span className="crm-row-main"><strong>{displayName(x.customer_name)}</strong><small>{[x.vehicle, x.plate].filter(Boolean).join(" ")}</small></span>
          <span className={"crm-kind is-" + x.kind.toLowerCase()}>{KIND_LABEL[x.kind]}</span>
          <span className="crm-row-why">{x.why}</span>
        </li>)}
      </ol>
      <p className="crm-muted">Primero van {post ? "los postservicios, luego " : ""}los cambios que vencen esta semana y después los clientes por recuperar. Máximo {board.cap} mensajes al día para cuidar el número.</p>
    </>}
  </section>;
}

function OutcomeButtons({ serviceRecordId, onChanged, onError, compact }: {
  serviceRecordId: string; onChanged: (msg: string) => void; onError: (msg: string) => void; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [dateFor, setDateFor] = useState(false);
  const [date, setDate] = useState(addDays(caracasToday(), 1));
  async function record(outcome: CrmOutcome, day?: string) {
    if (outcome === "OPT_OUT" && !window.confirm("¿El cliente pidió no recibir mensajes? No se le volverá a escribir por ningún carro.")) return;
    setBusy(true); onError("");
    const { error } = await supabase.rpc("crm_record_outcome", { p_service_record_id: serviceRecordId, p_outcome: outcome, p_date: day ?? null, p_notes: null });
    setBusy(false);
    if (error) { onError(error.message); return; }
    const o = OUTCOMES.find(x => x.id === outcome);
    onChanged(`Anotado: ${o?.label}. ${o?.hint ?? ""}`);
  }
  if (dateFor) return <div className="crm-outcomes">
    <label className="crm-date">¿Qué día viene?<input type="date" className="input" min={caracasToday()} value={date} onChange={e => setDate(e.target.value)} /></label>
    <button className="btn btn-primary" disabled={busy || !date} onClick={() => void record("BOOKED", date)}>Guardar cita</button>
    <button className="btn btn-ghost" disabled={busy} onClick={() => setDateFor(false)}>Cancelar</button>
  </div>;
  return <div className={"crm-outcomes" + (compact ? " is-compact" : "")}>
    {OUTCOMES.map(o => <button key={o.id} title={o.hint} className={"crm-chip" + (o.danger ? " is-danger" : "")} disabled={busy}
      onClick={() => o.needsDate ? setDateFor(true) : void record(o.id)}>{o.label}</button>)}
  </div>;
}

function WaitingView({ board, onChanged, onError }: { board: CrmBoard; onChanged: (m: string) => void; onError: (m: string) => void }) {
  if (!board.waiting.length) return <p className="crm-empty">Nadie está esperando respuesta. Cuando envíes mensajes, aparecen aquí para anotar qué contestó el cliente.</p>;
  return <section>
    <p className="crm-muted">Si el cliente respondió, toca lo que dijo. Si no ha respondido, no hagas nada: el sistema le manda el siguiente mensaje cuando toque.</p>
    <ul className="crm-cards">
      {board.waiting.map(w => <li key={w.id} className="crm-card">
        <div className="crm-card-top">
          <div><strong>{displayName(w.customer_name)}</strong><small>{[w.vehicle, w.plate].filter(Boolean).join(" ")}</small></div>
          <div className="crm-card-meta">Le escribiste el {shortDate(w.last_sent_at)} · mensaje {w.sent_count}
            {w.wa_phone && <a className="crm-link" href={`https://wa.me/${w.wa_phone}`} target="_blank" rel="noopener noreferrer">Abrir chat</a>}</div>
        </div>
        <OutcomeButtons serviceRecordId={w.id} onChanged={onChanged} onError={onError} />
      </li>)}
    </ul>
  </section>;
}

function BookedView({ board }: { board: CrmBoard }) {
  if (!board.booked.length) return <p className="crm-empty">No hay citas anotadas. Cuando un cliente agende, toca «Agendó» y pon el día.</p>;
  const today = caracasToday();
  return <ul className="crm-rows">
    {board.booked.map(b => <li key={b.id} className="crm-row">
      <span className={"crm-day" + (b.date === today ? " is-today" : "")}>{b.date === today ? "Hoy" : shortDate(b.date)}</span>
      <span className="crm-row-main"><strong>{displayName(b.customer_name)}</strong><small>{[b.vehicle, b.plate].filter(Boolean).join(" ")}</small></span>
      {b.wa_phone && <a className="crm-link" href={`https://wa.me/${b.wa_phone}`} target="_blank" rel="noopener noreferrer">Abrir chat</a>}
    </li>)}
    <li className="crm-muted crm-note">Cuando el carro llegue y se registre su cambio de aceite, la cita se cierra sola como «Volvió».</li>
  </ul>;
}

function FixView({ board, onChanged, onError }: { board: CrmBoard; onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function save(customerId: string) {
    setBusy(customerId); onError("");
    const { error } = await supabase.rpc("crm_fix_phone", { p_customer_id: customerId, p_phone: phones[customerId] ?? "" });
    setBusy(null);
    if (error) { onError(error.message); return; }
    onChanged("Teléfono guardado. El cliente vuelve a la lista cuando le toque.");
  }
  if (!board.fix.length) return <p className="crm-empty">Todos los clientes activos tienen un WhatsApp válido.</p>;
  return <section>
    <p className="crm-muted">Estos clientes no tienen un celular válido o alguien marcó «Número equivocado». Si consigues el número, escríbelo aquí.</p>
    <ul className="crm-rows">
      {board.fix.map(f => <li key={f.customer_id} className="crm-row crm-fix">
        <span className="crm-row-main"><strong>{displayName(f.customer_name)}</strong><small>{f.vehicles}</small></span>
        <span className="crm-row-why">{f.flagged ? `Número equivocado: ${f.phone}` : f.phone ? `No es un celular válido: ${f.phone}` : "Sin teléfono"}</span>
        <input className="input" inputMode="tel" placeholder="0414 123 4567" value={phones[f.customer_id] ?? ""}
          onChange={e => setPhones(p => ({ ...p, [f.customer_id]: e.target.value }))} aria-label={"Nuevo teléfono de " + displayName(f.customer_name)} />
        <button className="btn" disabled={busy === f.customer_id || (phones[f.customer_id] ?? "").replace(/\D/g, "").length < 10} onClick={() => void save(f.customer_id)}>Guardar</button>
      </li>)}
    </ul>
  </section>;
}

function ResultsView({ onError }: { onError: (m: string) => void }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState<CrmResults | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase.rpc("crm_results", { p_days: days }).then(({ data, error }) => {
      if (!alive) return;
      if (error) onError(error.message); else setR(data as CrmResults);
    });
    return () => { alive = false; };
  }, [days, onError]);
  const sent = r ? r.reminders_sent + r.post_service_sent : 0;
  const capture = r && r.oil_orders ? Math.round(100 * r.oil_orders_with_vehicle / r.oil_orders) : null;
  return <section>
    <div className="crm-period">
      {[7, 30, 90].map(d => <button key={d} className={d === days ? "is-active" : ""} onClick={() => setDays(d)}>Últimos {d} días</button>)}
    </div>
    {!r ? <p className="crm-muted">Calculando…</p> : <>
      <div className="crm-strip">
        <div><span>Mensajes enviados</span><strong>{sent}</strong><small>{r.post_service_sent} postservicio · {r.reminders_sent} recordatorios</small></div>
        <div><span>Respondieron</span><strong>{r.answered}</strong><small>{r.booked} agendaron</small></div>
        <div><span>Volvieron</span><strong>{r.returned}</strong><small>Cambio de aceite hasta 45 días después del mensaje</small></div>
        <div><span>Facturado por los que volvieron</span><strong>{money(Number(r.returned_ref))}</strong><small>Total de esas órdenes</small></div>
      </div>
      <h2 className="crm-section">Captura en el mostrador</h2>
      <div className="crm-strip">
        <div><span>Ventas con aceite</span><strong>{r.oil_orders}</strong><small>Órdenes cerradas en el período</small></div>
        <div><span>Con placa</span><strong>{capture === null ? "—" : capture + "%"}</strong><small>{r.oil_orders_with_vehicle} de {r.oil_orders}</small></div>
        <div><span>No quiso dar datos</span><strong>{r.oil_orders_skipped}</strong><small>Registrado en Venta rápida</small></div>
        <div><span>Pidieron no recibir mensajes</span><strong>{r.opted_out}</strong><small>Bloqueados para siempre</small></div>
      </div>
    </>}
  </section>;
}

function AllView({ onChanged, onError }: { onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Journey[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [count, setCount] = useState(60);
  async function load() {
    const { data, error } = await supabase.from("crm_vehicle_journeys")
      .select("service_record_id,vehicle_id,customer_id,customer_name,customer_phone,wa_phone,plate,make,model,performed_at,cycle_due,days_from_due,status,next_kind,sent_count,last_sent_at,eligible_on,last_outcome,last_outcome_on")
      .order("cycle_due", { ascending: true }).limit(2000);
    if (error) onError(error.message); else setRows((data ?? []) as Journey[]);
  }
  useEffect(() => { void load(); }, []);
  const counts = useMemo(() => rows.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}), [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("es-VE");
    return rows.filter(r => (status === "ALL" || r.status === status) &&
      (!q || [r.customer_name, r.plate, r.customer_phone, r.make, r.model].filter(Boolean).join(" ").toLocaleLowerCase("es-VE").includes(q)));
  }, [rows, query, status]);
  return <section>
    <div className="crm-filters">
      <label className="crm-search"><OsIcon name="search" size={17} />
        <input value={query} onChange={e => { setQuery(e.target.value); setCount(60); }} placeholder="Buscar cliente, placa, carro o teléfono" aria-label="Buscar" /></label>
      <select className="input" value={status} onChange={e => { setStatus(e.target.value); setCount(60); }} aria-label="Filtrar por estado">
        <option value="ALL">Todos ({rows.length})</option>
        {Object.keys(STATUS_LABEL).filter(k => counts[k]).map(k => <option key={k} value={k}>{STATUS_LABEL[k]} ({counts[k]})</option>)}
      </select>
    </div>
    <table className="crm-table">
      <thead><tr><th>Cliente</th><th>Carro</th><th>Último cambio</th><th>Le toca</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        {visible.slice(0, count).map(r => <Fragment key={r.service_record_id}>
          <tr className={open === r.service_record_id ? "is-open" : ""}>
            <td><strong>{displayName(r.customer_name)}</strong><small>{r.customer_phone || "Sin teléfono"}</small></td>
            <td>{[r.make, r.model].filter(Boolean).join(" ") || "—"}<small>{r.plate}</small></td>
            <td className="num">{shortDate(r.performed_at)}</td>
            <td className="num">{shortDate(r.cycle_due)}<small>{r.days_from_due > 0 ? `hace ${r.days_from_due} días` : r.days_from_due === 0 ? "hoy" : `en ${-r.days_from_due} días`}</small></td>
            <td><span className={"crm-status is-" + r.status.toLowerCase()}>{STATUS_LABEL[r.status] ?? r.status}</span>
              <small>{r.last_outcome ? OUTCOME_LABEL[r.last_outcome] ?? "" : r.sent_count ? `${r.sent_count} ${r.sent_count === 1 ? "mensaje" : "mensajes"}` : ""}
                {r.status === "SCHEDULED" && r.eligible_on ? ` · próximo ${shortDate(r.eligible_on)}` : ""}</small></td>
            <td><button className="crm-link" onClick={() => setOpen(open === r.service_record_id ? null : r.service_record_id)}>{open === r.service_record_id ? "Cerrar" : "Anotar"}</button></td>
          </tr>
          {open === r.service_record_id && <tr className="crm-table-detail"><td colSpan={6}>
            <OutcomeButtons compact serviceRecordId={r.service_record_id} onError={onError}
              onChanged={m => { setOpen(null); onChanged(m); void load(); }} />
            <div className="crm-detail-links">
              <Link href={"/vehicles/" + r.vehicle_id}>Ver carro</Link>
              <Link href={"/customers/" + r.customer_id}>Ficha del cliente</Link>
            </div>
          </td></tr>}
        </Fragment>)}
      </tbody>
    </table>
    {visible.length > count && <button className="btn btn-ghost" onClick={() => setCount(c => c + 60)}>Ver más ({visible.length - count})</button>}
  </section>;
}

function MessagesView({ cap, onChanged, onError }: { cap: number; onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [capDraft, setCapDraft] = useState(String(cap));
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void supabase.from("crm_message_templates").select("kind,body").then(({ data, error }) => {
      if (error) onError(error.message); else setTemplates((data ?? []) as Template[]);
    });
  }, [onError]);
  async function saveTemplate(kind: CrmTemplateKind) {
    setBusy(kind); onError("");
    const { error } = await supabase.rpc("crm_save_template", { p_kind: kind, p_body: drafts[kind] });
    setBusy(null);
    if (error) { onError(error.message); return; }
    setTemplates(t => t.map(x => x.kind === kind ? { ...x, body: drafts[kind] } : x));
    setDrafts(d => { const n = { ...d }; delete n[kind]; return n; });
    onChanged("Mensaje guardado. Los próximos envíos usan este texto.");
  }
  async function saveCap() {
    setBusy("cap"); onError("");
    const { error } = await supabase.rpc("crm_set_daily_cap", { p_cap: Number(capDraft) });
    setBusy(null);
    if (error) { onError(error.message); return; }
    onChanged("Máximo diario actualizado.");
  }
  const sorted = TEMPLATE_ORDER.map(k => templates.find(t => t.kind === k)).filter((t): t is Template => !!t);
  return <section className="crm-messages">
    <div className="crm-rules">
      <h2 className="crm-section">Reglas</h2>
      <ul>
        <li>Postservicio entre el día de la visita y 3 días después. A los 5 días vence.</li>
        <li>Primer aviso 7 días antes de la fecha recomendada. Segundo, 10 días después si no responde. Tercero y último, 14 días después.</li>
        <li>A quien se le pasó la fecha hace más de un mes: 2 mensajes. Más de un año: 1 mensaje.</li>
        <li>Nunca dos mensajes a la misma persona en menos de 14 días, aunque tenga varios carros.</li>
        <li>Si registra un cambio de aceite nuevo, el seguimiento se cierra solo.</li>
      </ul>
      <label className="crm-cap">Máximo de mensajes por día
        <NumberInput className="input" kind="qty" min={1} max={60} value={capDraft} onChange={e => setCapDraft(e.target.value)} />
        <button className="btn" disabled={busy === "cap" || Number(capDraft) === cap} onClick={() => void saveCap()}>Guardar</button>
      </label>
    </div>
    <h2 className="crm-section">Textos de los recordatorios</h2>
    <p className="crm-muted">Puedes usar {"{{nombre}}"}, {"{{vehiculo}}"}, {"{{placa}}"}, {"{{ultimo_cambio}}"}, {"{{fecha}}"}, {"{{aceite}}"} y {"{{km}}"}. El texto del postservicio se edita en Configuración.</p>
    {sorted.map(t => {
      const value = drafts[t.kind] ?? t.body;
      return <div key={t.kind} className="crm-template">
        <div className="crm-template-head"><strong>{KIND_LABEL[t.kind]}</strong><span>{TEMPLATE_HELP[t.kind]}</span></div>
        <textarea className="input" rows={7} value={value} maxLength={1500} onChange={e => setDrafts(d => ({ ...d, [t.kind]: e.target.value }))} />
        {drafts[t.kind] !== undefined && drafts[t.kind] !== t.body && <div className="crm-template-actions">
          <button className="btn btn-primary" disabled={busy === t.kind} onClick={() => void saveTemplate(t.kind)}>Guardar</button>
          <button className="btn btn-ghost" onClick={() => setDrafts(d => { const n = { ...d }; delete n[t.kind]; return n; })}>Descartar</button>
        </div>}
      </div>;
    })}
  </section>;
}

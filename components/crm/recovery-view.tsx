"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  RECOVERY_CELLS, contactText, contactableToday, displayName, dueText, shortDate,
  type CrmQueueItem, type RecoveryBucket, type RecoveryRow, type RecoverySort, type RecoverySummaryItem,
} from "@/lib/crm";
import { LoadingBlock } from "@/components/skeleton";

const STATUS: Record<string, string> = {
  READY: "Para contactar", SCHEDULED: "Programado", UPCOMING: "Todavía no le toca", WAITING_REPLY: "Esperando respuesta",
  BOOKED: "Tiene cita", CLOSED_NO_REPLY: "Sin respuesta · 2.º intento", DORMANT: "En cartera",
};
const ACTIONS: { id: "RETURNED" | "OTHER_SHOP" | "OPT_OUT"; label: string; done: string; danger?: boolean }[] = [
  { id: "RETURNED", label: "Ya volvió", done: "Anotado: ya volvió. Empieza un ciclo nuevo desde hoy." },
  { id: "OTHER_SHOP", label: "Lo hizo en otro lado", done: "Anotado: lo hizo en otro lado. Empieza un ciclo nuevo." },
  { id: "OPT_OUT", label: "No contactar", done: "Anotado: no se le vuelve a escribir.", danger: true },
];

function ref(n: number) {
  return "$" + Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function RecoveryView({ bucket, sort, onBucket, onSort, onStartTunnel, onError }: {
  bucket: RecoveryBucket; sort: RecoverySort;
  onBucket: (b: RecoveryBucket) => void; onSort: (s: RecoverySort) => void;
  onStartTunnel: (queue: CrmQueueItem[], sentToday: number, cap: number, source: string) => void;
  onError: (msg: string) => void;
}) {
  const [summary, setSummary] = useState<RecoverySummaryItem[] | null>(null);
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loadingRows, setLoadingRows] = useState(false);
  const [queueInfo, setQueueInfo] = useState<{ remaining: number; eligible: number; cap: number; reserved: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const reqId = useRef(0);

  const loadSummary = useCallback(async () => {
    const { data, error } = await supabase.rpc("crm_recovery_summary");
    if (error) { onError(error.message); return; }
    setSummary(data as RecoverySummaryItem[]);
  }, [onError]);

  const loadQueueInfo = useCallback(async () => {
    const { data, error } = await supabase.rpc("crm_bucket_queue", { p_bucket: bucket, p_limit: 0 });
    if (!error && data) setQueueInfo({ remaining: Number(data.remaining), eligible: Number(data.eligible), cap: Number(data.cap), reserved: Number(data.reserved_post_service ?? 0) });
  }, [bucket]);

  const loadRows = useCallback(async (offset: number) => {
    const id = ++reqId.current;
    setLoadingRows(true);
    const { data, error } = await supabase.rpc("crm_recovery_list", { p_bucket: bucket, p_sort: sort, p_query: debounced || null, p_limit: 50, p_offset: offset });
    if (id !== reqId.current) return;
    setLoadingRows(false);
    if (error) { onError(error.message); return; }
    const r = data as { total: number; rows: RecoveryRow[] };
    setTotal(r.total);
    setRows(prev => offset ? [...prev, ...r.rows] : r.rows);
  }, [bucket, sort, debounced, onError]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { void loadQueueInfo(); }, [loadQueueInfo]);
  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(t); }, [query]);
  useEffect(() => { setDone({}); void loadRows(0); }, [loadRows]);

  async function startBucket() {
    onError("");
    const { data, error } = await supabase.rpc("crm_bucket_queue", { p_bucket: bucket, p_limit: null });
    if (error) { onError(error.message); return; }
    if (!data.queue.length) {
      onError(!data.remaining ? `Llegaste al máximo de hoy (${data.cap}). Mañana siguen.`
        : Number(data.reserved_post_service) >= Number(data.remaining) ? "El cupo de hoy queda para los postservicios pendientes. Envíalos desde «Hoy»."
        : "Nadie de este tramo está para escribirle hoy.");
      return;
    }
    onStartTunnel(data.queue as CrmQueueItem[], Number(data.sent_today), Number(data.cap), "bucket-" + bucket);
  }

  async function write(row: RecoveryRow) {
    onError("");
    const { data, error } = await supabase.rpc("crm_queue_item", { p_service_record_id: row.service_record_id });
    if (error) { onError(error.message); return; }
    onStartTunnel([data as CrmQueueItem], Number(data.sent_today), Number(data.cap), "item-" + row.service_record_id);
  }

  async function act(row: RecoveryRow, action: typeof ACTIONS[number]) {
    if (action.id === "OPT_OUT" && !window.confirm("¿El cliente pidió no recibir mensajes? No se le volverá a escribir por ningún carro.")) return;
    setBusy(row.service_record_id); onError("");
    const { error } = await supabase.rpc("crm_record_outcome", { p_service_record_id: row.service_record_id, p_outcome: action.id, p_date: null, p_notes: null });
    setBusy(null);
    if (error) { onError(error.message); return; }
    setDone(d => ({ ...d, [row.service_record_id]: action.id }));
    void loadSummary();
  }

  async function undo(row: RecoveryRow) {
    setBusy(row.service_record_id); onError("");
    const action = done[row.service_record_id];
    if (action === "OPT_OUT") {
      setBusy(null);
      onError("«No contactar» no se deshace desde aquí. Corrígelo en la ficha del cliente.");
      return;
    }
    const { error } = await supabase.rpc("crm_undo_last", { p_service_record_id: row.service_record_id });
    setBusy(null);
    if (error) { onError(error.message); return; }
    setDone(d => { const n = { ...d }; delete n[row.service_record_id]; return n; });
    void loadSummary();
  }

  const current = summary?.find(s => s.bucket === bucket);
  // El cupo de los postservicios pendientes queda reservado.
  const n = queueInfo ? contactableToday(Math.max(queueInfo.remaining - queueInfo.reserved, 0), queueInfo.eligible) : 0;

  return <section className="crm-rec">
    <div className="crm-rec-strip" role="tablist" aria-label="Tramos de vencimiento">
      {RECOVERY_CELLS.map(code => {
        const s = summary?.find(x => x.bucket === code);
        const empty = !s || s.vehicles === 0;
        return <button key={code} role="tab" aria-selected={code === bucket}
          className={"crm-rec-cell" + (code === bucket ? " is-active" : "") + (empty ? " is-empty" : "")}
          onClick={() => onBucket(code)}>
          <strong>{s ? s.vehicles : "—"}</strong>
          <span className="crm-rec-label">{s?.label ?? code}</span>
          {s && <small>{s.customers} {s.customers === 1 ? "cliente" : "clientes"} · {ref(s.lifetime_ref)} históricos</small>}
          {s && code === "POOL"
            ? <small>{s.dormant ?? 0} en cartera · {s.second_pending ?? 0} esperan 2.º intento</small>
            : s && <small>{s.contacted} ya contactados{s.no_phone ? ` · ${s.no_phone} sin teléfono` : ""}</small>}
        </button>;
      })}
    </div>

    <div className="crm-rec-bar">
      {bucket !== "POOL" && <button className="btn btn-primary" disabled={!queueInfo || n === 0} onClick={() => void startBucket()}>
        Contactar este tramo ({n} hoy)</button>}
      {queueInfo && queueInfo.remaining === 0 && <span className="crm-muted">Llegaste al máximo de hoy ({queueInfo.cap}). Mañana siguen.</span>}
      <input className="input crm-rec-search" type="search" value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Buscar nombre, placa, teléfono o modelo" aria-label="Buscar en este tramo" />
      <label className="crm-rec-sort">Ordenar
        <select className="select" value={sort} onChange={e => onSort(e.target.value as RecoverySort)}>
          <option value="PRIORITY">Prioridad (más valor)</option>
          <option value="RECENT">Más recientes</option>
          <option value="OLDEST">Más antiguos</option>
        </select></label>
    </div>
    <p className="crm-muted">{bucket === "POOL"
      ? "No respondieron: reciben una segunda oportunidad a los 120 días del último mensaje. Los que tampoco responden quedan en la cartera para promociones de reenganche."
      : "Las fechas estimadas usan el último cambio + 90 días porque no hay suficiente historial de kilometraje."}</p>

    {current && current.vehicles === 0 && !loadingRows && <p className="crm-empty">No hay vehículos en este tramo.</p>}
    <ul className="crm-rec-list">
      {rows.map(r => {
        const did = done[r.service_record_id];
        return <li key={r.service_record_id} className={"crm-rec-row" + (did ? " is-done" : "")}>
          <div className="crm-rec-who">
            <strong>{displayName(r.customer_name)}</strong>
            <small>{[r.make, r.model].filter(Boolean).join(" ") || "Vehículo"}{r.plate ? ` · ${r.plate}` : ""}</small>
          </div>
          <div className="crm-rec-due">
            <strong>{dueText(r.days_from_due)}</strong>
            {r.estimated && <small className="crm-rec-tag">fecha estimada</small>}
            <small>Último cambio {shortDate(r.performed_at)}{r.oil_brand || r.oil_viscosity ? ` · ${[r.oil_brand, r.oil_viscosity].filter(Boolean).join(" ")}` : ""}</small>
          </div>
          <div className="crm-rec-meta">
            <small>{contactText(r.sent_count, r.last_sent_at)}</small>
            <small>{STATUS[r.status] ?? r.status}</small>
            <small className="crm-rec-value">{ref(r.lifetime_ref)} · {r.visits} {r.visits === 1 ? "visita" : "visitas"}</small>
          </div>
          <div className="crm-rec-actions">
            {did ? <>
              <span className="crm-muted">{ACTIONS.find(a => a.id === did)?.done}</span>
              {did !== "OPT_OUT" && <button className="btn btn-ghost" disabled={busy === r.service_record_id} onClick={() => void undo(r)}>Deshacer</button>}
            </> : <>
              <button className="btn" disabled={busy === r.service_record_id || r.status !== "READY"} title={r.status !== "READY" ? "Hoy no le toca mensaje" : undefined} onClick={() => void write(r)}>Escribir</button>
              {ACTIONS.map(a => <button key={a.id} className={"crm-chip" + (a.danger ? " is-danger" : "")} disabled={busy === r.service_record_id} onClick={() => void act(r, a)}>{a.label}</button>)}
            </>}
          </div>
        </li>;
      })}
    </ul>
    {loadingRows && <LoadingBlock label="Cargando datos…" kind="list" />}
    {!loadingRows && rows.length < total && <button className="btn btn-ghost" onClick={() => void loadRows(rows.length)}>Ver más ({total - rows.length})</button>}
  </section>;
}

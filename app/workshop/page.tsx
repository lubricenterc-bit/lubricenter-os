"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { BrandIcon, Gotin, prefersCalm, replay, useLive } from "@/components/gotin";
import { OsIcon } from "@/components/os-icon";
import { BRAND_ICONS, type BrandIconName } from "@/lib/brand-art";

type WorkflowStatus = "RECEIVED" | "DIAGNOSIS" | "IN_PROGRESS" | "WAITING_PART" | "READY";
type BoardRow = {
  id: string;
  order_number: string;
  workflow_status: WorkflowStatus;
  workflow_updated_at: string;
  opened_at: string;
  health_status: string;
  is_walk_in: boolean;
  customer_name: string | null;
  customer_phone: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  current_odometer: number | null;
  item_count: number;
  current_total_ref: number;
  service_areas: string | null;
};

const columns: { key: WorkflowStatus; title: string; short: string; icon: BrandIconName; empty: string }[] = [
  { key: "RECEIVED", title: "Recibidos", short: "RECIBIDO", icon: "car", empty: "Nadie esperando turno." },
  { key: "DIAGNOSIS", title: "Diagnóstico", short: "DIAGNÓSTICO", icon: "lens", empty: "Nada en revisión." },
  { key: "IN_PROGRESS", title: "En trabajo", short: "EN TRABAJO", icon: "wrench", empty: "Las manos están libres." },
  { key: "WAITING_PART", title: "Esperando repuesto", short: "REPUESTO", icon: "hourglass", empty: "Sin repuestos pendientes." },
  { key: "READY", title: "Listos", short: "LISTO", icon: "flag", empty: "Nada por entregar todavía." },
];

/** El paso natural de cada etapa; el selector sigue permitiendo cualquier cambio. */
const NEXT: Partial<Record<WorkflowStatus, [WorkflowStatus, string]>> = {
  RECEIVED: ["DIAGNOSIS", "Pasar a diagnóstico"],
  DIAGNOSIS: ["IN_PROGRESS", "Empezar trabajo"],
  IN_PROGRESS: ["READY", "Marcar listo"],
  WAITING_PART: ["IN_PROGRESS", "Llegó el repuesto"],
};

function labelArea(value: string | null) {
  return (value || "").replaceAll("WORKSHOP", "Taller").replaceAll("ELECTROAUTO", "Electroauto").replaceAll("OIL_CHANGE", "Aceite");
}

function age(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export default function WorkshopPage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const boardLive = useLive<HTMLDivElement>();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const moved = useRef<{ id: string; from: DOMRect } | null>(null);

  async function load() {
    setError("");
    const { data, error } = await supabase
      .from("workshop_board_current")
      .select("*")
      .order("workflow_updated_at", { ascending: true })
      .limit(500);
    setLoaded(true);
    if (error) return setError(error.message);
    setRows((data ?? []).map((r: any) => ({ ...r, item_count: Number(r.item_count ?? 0), current_total_ref: Number(r.current_total_ref ?? 0) })) as BoardRow[]);
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60000);
    return () => window.clearInterval(timer);
  }, []);

  const grouped = useMemo(() => Object.fromEntries(columns.map(c => [c.key, rows.filter(r => r.workflow_status === c.key)])) as Record<WorkflowStatus, BoardRow[]>, [rows]);

  // Las tarjetas viajan a su nueva columna: se mide antes del cambio y se anima la diferencia (FLIP).
  function measure() {
    const map = new Map<string, DOMRect>();
    boardRef.current?.querySelectorAll<HTMLElement>("[data-card]").forEach(card => map.set(card.dataset.card!, card.getBoundingClientRect()));
    return map;
  }
  useLayoutEffect(() => {
    const first = before.current;
    if (!first) return;
    before.current = null;
    const travelled = moved.current;
    moved.current = null;
    if (prefersCalm()) return;
    boardRef.current?.querySelectorAll<HTMLElement>("[data-card]").forEach(card => {
      const old = first.get(card.dataset.card!);
      if (!old || typeof card.animate !== "function") return;
      const now = card.getBoundingClientRect();
      const dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const isMoved = travelled?.id === card.dataset.card;
      card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: isMoved ? 560 : 380, easing: isMoved ? "cubic-bezier(.34, 1.56, .64, 1)" : "cubic-bezier(.23, 1, .32, 1)" })
        .onfinish = () => { if (isMoved) replay(card, "is-landing", 600); };
    });
    if (travelled) puff(travelled.from);
  }, [rows]);

  function puff(rect: DOMRect) {
    const cloud = document.createElement("span");
    cloud.className = "os-puff";
    cloud.setAttribute("aria-hidden", "true");
    cloud.innerHTML = '<span class="bi-wrap">' + BRAND_ICONS.puff() + "</span>";
    cloud.style.left = rect.left + rect.width / 2 - 55 + "px";
    cloud.style.top = rect.top + rect.height / 2 - 37 + "px";
    document.body.appendChild(cloud);
    window.setTimeout(() => cloud.remove(), 600);
  }

  async function move(row: BoardRow, status: WorkflowStatus) {
    if (row.workflow_status === status) return;
    setBusyId(row.id); setError(""); setNotice("");
    const { error } = await supabase.rpc("set_order_workflow_status", { p_order_id: row.id, p_status: status });
    setBusyId(null);
    if (error) return setError(error.message);
    setNotice(`${row.order_number} → ${columns.find(c => c.key === status)?.title ?? status}`);
    const first = measure();
    const from = first.get(row.id);
    before.current = first;
    moved.current = from ? { id: row.id, from } : null;
    await load();
  }

  const setBoard = (element: HTMLDivElement | null) => { boardRef.current = element; boardLive(element); };

  return <main className="container os-workshop">
    <header className="os-page-head">
      <div><h1>Taller</h1><p>Una sola vista para saber qué llegó, qué está en diagnóstico, qué se está trabajando, qué espera repuesto y qué ya está listo.</p></div>
      <div className="os-workshop-side">
        <dl className="os-workshop-figures">
          <div><dt>Vehículos abiertos</dt><dd>{loaded ? rows.length : "—"}</dd></div>
          <div><dt>En trabajo</dt><dd>{loaded ? grouped.IN_PROGRESS.length : "—"}</dd></div>
          <div className="is-ready"><dt>Listos</dt><dd>{loaded ? grouped.READY.length : "—"}</dd></div>
        </dl>
        <Link className="btn btn-primary" href="/orders/new"><OsIcon name="plus" size={18} /> Nueva orden o servicio rápido <kbd>F3</kbd></Link>
      </div>
    </header>

    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success os-workshop-notice" role="status"><BrandIcon name="flag" />{notice}</div>}

    <div className="os-board-wrap">
      <div className="os-board" ref={setBoard}>
        {columns.map(col => {
          const list = grouped[col.key];
          const next = NEXT[col.key];
          const busy = (col.key === "IN_PROGRESS" || col.key === "WAITING_PART") && list.length > 0;
          return <section key={col.key} className={"os-col" + (col.key === "IN_PROGRESS" ? " is-flow" : "") + (busy ? " on" : "")} aria-labelledby={"os-col-" + col.key}>
            <header className="os-col-head hov"><BrandIcon name={col.icon} /><h2 id={"os-col-" + col.key}>{col.title}</h2><b key={list.length} className="os-col-count">{list.length}</b></header>
            <div className="os-cards">
              {list.map(row => {
                const vehicle = row.is_walk_in ? "Servicio rápido · sin vehículo" : [row.make, row.model, row.year].filter(Boolean).join(" · ") || "Vehículo por asociar";
                const old = Date.now() - new Date(row.workflow_updated_at).getTime() > 24 * 3600000 && col.key !== "READY";
                return <article className={"os-wcard" + (busyId === row.id ? " is-busy" : "")} key={row.id} data-card={row.id}>
                  <div className="os-wcard-top">
                    {row.plate && !row.is_walk_in ? <span className="os-plate"><small>VENEZUELA</small><b>{row.plate}</b></span> : <span className="os-plate is-walkin"><b>Sin placa</b></span>}
                    <span className={"os-age" + (old ? " is-old" : "")}><OsIcon name="clock" size={14} />{age(row.workflow_updated_at)}</span>
                  </div>
                  <div className="os-wcard-main">
                    <h3>{vehicle}</h3>
                    <p>{row.is_walk_in ? "Sin historial ni seguimiento CRM" : row.customer_name || row.customer_phone || "Cliente por asociar"}</p>
                  </div>
                  <div className="os-wcard-meta">
                    <span className="os-wcard-order">{row.order_number}</span>
                    {labelArea(row.service_areas).split(",").filter(Boolean).map(area => <span key={area} className="os-area">{area.trim()}</span>)}
                    {!row.service_areas && <span className="os-area is-empty">Sin trabajo agregado aún</span>}
                  </div>
                  <div className="os-wcard-sum"><span>{row.item_count} línea(s){row.current_odometer != null ? ` · ${row.current_odometer.toLocaleString("es-VE")} km` : ""}</span><b>{fmtRef(row.current_total_ref)}</b></div>
                  <div className="os-wcard-actions">
                    {next
                      ? <button type="button" className="os-go" disabled={busyId === row.id} onClick={() => move(row, next[0])}>{busyId === row.id ? "Moviendo…" : next[1]}<OsIcon name="arrow" size={15} /></button>
                      : <Link className="os-go is-final" href={`/orders/${row.id}`}>Abrir orden<OsIcon name="arrow" size={15} /></Link>}
                    <div className="os-wcard-links">
                      <label className="os-move">
                        <select className="select" value={row.workflow_status} disabled={busyId === row.id} aria-label={"Estado operativo de " + row.order_number} onChange={e => move(row, e.target.value as WorkflowStatus)}>{columns.map(x => <option key={x.key} value={x.key}>{x.short}</option>)}</select></label>
                      {next && <Link className="os-wcard-open" href={`/orders/${row.id}`}>Abrir orden</Link>}
                    </div>
                  </div>
                </article>;
              })}
              {!list.length && <div className="os-col-empty">{loaded ? <><Gotin pose={col.key === "READY" ? "flag" : "idle"} />{col.empty}</> : "Cargando…"}</div>}
            </div>
          </section>;
        })}
      </div>
    </div>

    <p className="os-workshop-foot">Al cerrar una orden, el vehículo sale automáticamente de este tablero como ENTREGADO. El tablero se actualiza solo cada minuto y también después de cada cambio de estado.</p>
  </main>;
}

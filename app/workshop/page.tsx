"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";

type WorkflowStatus = "RECEIVED" | "DIAGNOSIS" | "IN_PROGRESS" | "WAITING_PART" | "READY";
type BoardRow = {
  id: string;
  order_number: string;
  workflow_status: WorkflowStatus;
  workflow_updated_at: string;
  opened_at: string;
  health_status: string;
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

const columns: { key: WorkflowStatus; title: string; short: string }[] = [
  { key: "RECEIVED", title: "Recibidos", short: "RECIBIDO" },
  { key: "DIAGNOSIS", title: "Diagnóstico", short: "DIAGNÓSTICO" },
  { key: "IN_PROGRESS", title: "En trabajo", short: "EN TRABAJO" },
  { key: "WAITING_PART", title: "Esperando repuesto", short: "REPUESTO" },
  { key: "READY", title: "Listos", short: "LISTO" },
];

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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    const { data, error } = await supabase
      .from("workshop_board_current")
      .select("*")
      .order("workflow_updated_at", { ascending: true })
      .limit(500);
    if (error) return setError(error.message);
    setRows((data ?? []).map((r: any) => ({ ...r, item_count: Number(r.item_count ?? 0), current_total_ref: Number(r.current_total_ref ?? 0) })) as BoardRow[]);
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60000);
    return () => window.clearInterval(timer);
  }, []);

  const grouped = useMemo(() => Object.fromEntries(columns.map(c => [c.key, rows.filter(r => r.workflow_status === c.key)])) as Record<WorkflowStatus, BoardRow[]>, [rows]);

  async function move(row: BoardRow, status: WorkflowStatus) {
    if (row.workflow_status === status) return;
    setBusyId(row.id); setError(""); setNotice("");
    const { error } = await supabase.rpc("set_order_workflow_status", { p_order_id: row.id, p_status: status });
    setBusyId(null);
    if (error) return setError(error.message);
    setNotice(`${row.order_number} → ${columns.find(c => c.key === status)?.title ?? status}`);
    await load();
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">OPERACIÓN DEL TALLER</div><h1>Vehículos en proceso</h1><p>Una sola vista para saber qué llegó, qué está en diagnóstico, qué se está trabajando, qué espera repuesto y qué ya está listo.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className="grid grid-3">
      <div className="card"><div className="muted small">VEHÍCULOS ABIERTOS</div><div className="kpi">{rows.length}</div><div className="muted">Con vehículo o trabajo asociado</div></div>
      <div className="card"><div className="muted small">EN TRABAJO</div><div className="kpi">{grouped.IN_PROGRESS.length}</div><div className="muted">Trabajo activo</div></div>
      <div className="card"><div className="muted small">LISTOS</div><div className="kpi">{grouped.READY.length}</div><div className="muted">Pendientes por cobrar / entregar</div></div>
    </section>

    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12, alignItems: "start" }}>
      {columns.map(col => <div className="card stack" key={col.key}>
        <div className="row-between"><strong>{col.title}</strong><span className="pill">{grouped[col.key].length}</span></div>
        {grouped[col.key].map(row => {
          const vehicle = [row.plate, row.make, row.model, row.year].filter(Boolean).join(" · ") || "Vehículo";
          return <article className="card stack" key={row.id}>
            <div className="row-between"><div><strong>{row.order_number}</strong><div>{vehicle}</div><div className="muted small">{row.customer_name || row.customer_phone || "Cliente sin nombre"}</div></div><span className="pill warn">{age(row.workflow_updated_at)}</span></div>
            <div className="muted small">{labelArea(row.service_areas) || "Sin trabajo agregado aún"} · {row.item_count} línea(s) · {fmtRef(row.current_total_ref)}</div>
            {row.current_odometer != null && <div className="muted small">Kilometraje: {row.current_odometer.toLocaleString("es-VE")} km</div>}
            <label><span className="label">Estado operativo</span><select className="select" value={row.workflow_status} disabled={busyId === row.id} onChange={e => move(row, e.target.value as WorkflowStatus)}>{columns.map(x => <option key={x.key} value={x.key}>{x.short}</option>)}</select></label>
            <Link className="btn btn-primary btn-block" href={`/orders/${row.id}`}>Abrir orden</Link>
          </article>;
        })}
        {!grouped[col.key].length && <div className="muted small">Sin vehículos en esta etapa.</div>}
      </div>)}
    </section>

    <section className="card muted small">Al cerrar una orden, el vehículo sale automáticamente de este tablero como ENTREGADO. El tablero se actualiza solo cada minuto y también después de cada cambio de estado.</section>
  </main>;
}

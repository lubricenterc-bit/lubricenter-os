"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { financeDateStep, financePeriodLabel, financeToday } from "@/lib/finance/management-report";

type Area = {
  revenue_ref: number; cost_ref: number; mechanics_ref: number; cashea_commission_ref: number; profit_ref: number;
  lines: number; orders: number; estimated_cost_ref: number | null; pass_through_revenue_ref: number | null;
};
type Line = {
  order_id: string; order_number: string; day: string; area: "TIENDA" | "TALLER"; role: string; description: string;
  revenue_ref: number; cost_ref: number; mechanics_ref: number; cashea_ref: number; profit_ref: number; estimated: boolean;
};
type Report = {
  areas: Partial<Record<"TIENDA" | "TALLER", Area>>;
  total_profit_ref: number; orders: number;
  daily: { day: string; tienda: number | null; taller: number | null }[];
  top_store: { description: string; quantity: number; revenue_ref: number; profit_ref: number; cost_estimated: boolean }[];
  top_workshop: { order_number: string; description: string; revenue_ref: number; profit_ref: number }[];
  missing_cost: { description: string; revenue_ref: number; lines: number }[];
  lines: Line[];
};
type Preset = "TODAY" | "WEEK" | "MONTH" | "RANGE";

/** Semana de nómina: sábado a viernes. */
function weekStart(today: string) {
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); // 0 domingo … 6 sábado
  return financeDateStep(today, -((dow + 1) % 7));
}

const ROLE_LABEL: Record<string, string> = {
  PRODUCT: "Producto", LABOR: "Mano de obra", OIL_LABOR: "Servicio Lubricenter",
  PASS_THROUGH: "Compra para el trabajo", CASHEA_SURCHARGE: "Recargo Cashea",
};

export default function ProfitPage() {
  const today = financeToday();
  const [preset, setPreset] = useState<Preset>("WEEK");
  const [from, setFrom] = useState(weekStart(today));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<"TIENDA" | "TALLER" | null>(null);

  function choose(p: Preset) {
    setPreset(p);
    if (p === "TODAY") { setFrom(today); setTo(today); }
    if (p === "WEEK") { setFrom(weekStart(today)); setTo(today); }
    if (p === "MONTH") { setFrom(today.slice(0, 8) + "01"); setTo(today); }
  }

  useEffect(() => {
    let active = true;
    if (!from || !to || from > to) return;
    setLoading(true); setError("");
    supabase.rpc("finance_profit_report", { p_from: from, p_to: to }).then(({ data, error }) => {
      if (!active) return;
      if (error) setError(error.message); else setReport(data as Report);
      setLoading(false);
    });
    return () => { active = false; };
  }, [from, to]);

  const store = report?.areas.TIENDA;
  const shop = report?.areas.TALLER;
  const estimatedShare = store && store.cost_ref > 0 ? Math.round((Number(store.estimated_cost_ref ?? 0) / store.cost_ref) * 100) : 0;
  const maxDay = useMemo(() => Math.max(1, ...(report?.daily ?? []).map(d => Math.max(Number(d.tienda ?? 0), 0) + Math.max(Number(d.taller ?? 0), 0))), [report]);
  const detailLines = (report?.lines ?? []).filter(l => l.area === detail);

  return <main className="container stack">
    <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Ganancias</h1>
        <div className="muted">Cuánto le quedó a Lubricenter, ítem por ítem. No resta gastos: el balance se hace aparte.</div>
      </div>
      <Link className="btn btn-ghost" href="/finance">Resumen financiero</Link>
    </div>

    <section className="card stack">
      <div className="segmented">
        {([["TODAY", "Hoy"], ["WEEK", "Esta semana"], ["MONTH", "Este mes"], ["RANGE", "Fechas"]] as [Preset, string][]).map(([p, label]) =>
          <button key={p} className={`btn ${preset === p ? "btn-primary" : "btn-ghost"}`} onClick={() => choose(p)}>{label}</button>)}
      </div>
      {preset === "RANGE" && <div className="grid grid-2">
        <label><span className="label">Desde</span><input className="input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label><span className="label">Hasta</span><input className="input" type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} /></label>
      </div>}
      <div className="muted small">{financePeriodLabel(from, to)}{preset === "WEEK" ? " · semana de nómina, sábado a viernes" : ""} · solo órdenes cerradas · montos en $ BCV</div>
    </section>

    {error && <div className="error" role="alert">{error}</div>}
    {loading && !report ? <div className="card muted">Calculando ganancias…</div> : report && <>
      <section className="grid grid-2">
        <AreaCard title="Tienda" subtitle="Todo lo que es solo de Lubricenter" area={store}
          rows={[["Vendido", store?.revenue_ref], ["Costo", store?.cost_ref != null ? -store.cost_ref : null]]}
          note={store ? `${estimatedShare}% del costo es estimado (precio ÷ 1,35)` : undefined}
          onOpen={() => setDetail(detail === "TIENDA" ? null : "TIENDA")} open={detail === "TIENDA"} />
        <AreaCard title="Taller" subtitle="Lo que se reparte con Cheo y Alexis" area={shop}
          rows={[["Mano de obra cobrada", shop?.revenue_ref], ["Cheo y Alexis", shop?.mechanics_ref != null ? -shop.mechanics_ref : null], ["Comisión Cashea", shop?.cashea_commission_ref ? -shop.cashea_commission_ref : null]]}
          onOpen={() => setDetail(detail === "TALLER" ? null : "TALLER")} open={detail === "TALLER"} />
      </section>

      <section className="card row-between">
        <div><div className="muted small">GANANCIA TOTAL DEL PERÍODO</div><div className="kpi">{fmtRef(report.total_profit_ref)}</div></div>
        <div className="muted small" style={{ textAlign: "right" }}>{report.orders} órdenes cerradas</div>
      </section>

      {detail && <section className="card stack">
        <div className="row-between"><h2 className="section-title" style={{ margin: 0 }}>Ítems de {detail === "TIENDA" ? "tienda" : "taller"}</h2><button className="btn btn-ghost" onClick={() => setDetail(null)}>Cerrar</button></div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr style={{ textAlign: "left" }}><th>Orden</th><th>Ítem</th><th style={{ textAlign: "right" }}>Vendido</th><th style={{ textAlign: "right" }}>{detail === "TIENDA" ? "Costo" : "Mecánicos"}</th><th style={{ textAlign: "right" }}>Ganancia</th></tr></thead>
            <tbody>{detailLines.map((l, i) => <tr key={l.order_number + i} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
              <td><Link href={`/orders/${l.order_id}`}>{l.order_number}</Link><div className="muted small">{l.day}</div></td>
              <td>{l.description}<div className="muted small">{ROLE_LABEL[l.role] ?? l.role}{l.estimated ? " · costo estimado" : ""}</div></td>
              <td style={{ textAlign: "right" }}>{fmtRef(l.revenue_ref)}</td>
              <td style={{ textAlign: "right" }}>{fmtRef(detail === "TIENDA" ? l.cost_ref : l.mechanics_ref + l.cashea_ref)}</td>
              <td style={{ textAlign: "right" }}><strong>{fmtRef(l.profit_ref)}</strong></td>
            </tr>)}</tbody>
          </table>
        </div>
        {!detailLines.length && <div className="muted">Sin ítems en este período.</div>}
      </section>}

      {report.daily.length > 1 && <section className="card stack">
        <h2 className="section-title" style={{ margin: 0 }}>Ganancia por día</h2>
        <div className="row muted small" style={{ gap: 16 }}><span><Swatch color="var(--accent, #ff5d15)" /> Tienda</span><span><Swatch color="#7aa7ff" /> Taller</span></div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 140 }} role="img" aria-label="Ganancia diaria de tienda y taller">
          {report.daily.map(d => {
            const t = Math.max(Number(d.tienda ?? 0), 0), w = Math.max(Number(d.taller ?? 0), 0);
            return <div key={d.day} title={`${d.day}: tienda ${fmtRef(t)} · taller ${fmtRef(w)}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
              <div style={{ height: `${(w / maxDay) * 100}%`, background: "#7aa7ff", borderRadius: "4px 4px 0 0" }} />
              <div style={{ height: `${(t / maxDay) * 100}%`, background: "var(--accent, #ff5d15)" }} />
              <div className="muted" style={{ fontSize: 10, textAlign: "center", marginTop: 4 }}>{d.day.slice(8)}</div>
            </div>;
          })}
        </div>
      </section>}

      <section className="grid grid-2">
        <div className="card stack">
          <h2 className="section-title" style={{ margin: 0 }}>Productos que más dejaron</h2>
          {report.top_store.map(p => <div className="row-between" key={p.description}>
            <div><div>{p.description}</div><div className="muted small">{p.quantity} uds. · vendido {fmtRef(p.revenue_ref)}{p.cost_estimated ? " · costo estimado" : ""}</div></div>
            <strong>{fmtRef(p.profit_ref)}</strong></div>)}
          {!report.top_store.length && <div className="muted">Sin ventas de productos.</div>}
        </div>
        <div className="card stack">
          <h2 className="section-title" style={{ margin: 0 }}>Trabajos que más dejaron</h2>
          {report.top_workshop.map(j => <div className="row-between" key={j.order_number + j.description}>
            <div><div>{j.description}</div><div className="muted small">{j.order_number} · cobrado {fmtRef(j.revenue_ref)}</div></div>
            <strong>{fmtRef(j.profit_ref)}</strong></div>)}
          {!report.top_workshop.length && <div className="muted">Sin trabajos de taller.</div>}
        </div>
      </section>

      {report.missing_cost.length > 0 && <details className="card">
        <summary><strong>Para que el número sea exacto: productos sin costo real ({report.missing_cost.length})</strong></summary>
        <p className="muted small">Mientras no tengan costo cargado, se calcula como precio ÷ 1,35. Ordenados por cuánto venden.</p>
        <div className="stack">{report.missing_cost.map(m => <div className="row-between" key={m.description}>
          <span>{m.description}</span><span className="muted small">{fmtRef(m.revenue_ref)} vendido · {m.lines} línea(s)</span></div>)}</div>
      </details>}
    </>}
  </main>;
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color, marginRight: 4 }} />;
}

function AreaCard({ title, subtitle, area, rows, note, onOpen, open }: {
  title: string; subtitle: string; area?: Area; rows: [string, number | null | undefined][];
  note?: string; onOpen: () => void; open: boolean;
}) {
  return <article className="card stack">
    <div><div className="muted small">{subtitle.toUpperCase()}</div><h2 style={{ margin: "4px 0 0" }}>{title}</h2></div>
    <div><div className="muted small">GANANCIA</div><div className="kpi">{fmtRef(area?.profit_ref ?? 0)}</div></div>
    <div className="stack" style={{ gap: 4 }}>
      {rows.filter(([, v]) => v != null).map(([label, v]) => <div className="row-between muted" key={label}><span>{label}</span><span>{Number(v) < 0 ? "−" : ""}{fmtRef(Math.abs(Number(v)))}</span></div>)}
      {area?.pass_through_revenue_ref ? <div className="muted small">Incluye {fmtRef(area.pass_through_revenue_ref)} de compras para trabajos (solo cuenta su recargo).</div> : null}
    </div>
    {note && <div className="muted small">{note}</div>}
    <button className="btn btn-ghost" onClick={onOpen}>{open ? "Ocultar ítems" : `Ver ${area?.lines ?? 0} ítems`}</button>
  </article>;
}

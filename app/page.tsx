"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Dashboard = {
  localDate: string;
  closedOrdersToday: number;
  salesVesToday: number;
  salesRefToday: number;
  collectedVesToday: number;
  collectedRefToday: number;
  openOrders: number;
  activeVehicles: number;
  received: number;
  diagnosis: number;
  inProgress: number;
  waitingParts: number;
  ready: number;
  postService: number;
  maintenanceDue: number;
  maintenanceSoon: number;
  receivablesOpen: number;
  receivablesOutstandingVes: number;
  payrollPendingRef: number;
  inventoryReview: number;
  inventoryNegative: number;
  bcv: number;
  operative: number;
};

const EMPTY: Dashboard = {
  localDate: "", closedOrdersToday: 0, salesVesToday: 0, salesRefToday: 0,
  collectedVesToday: 0, collectedRefToday: 0, openOrders: 0, activeVehicles: 0,
  received: 0, diagnosis: 0, inProgress: 0, waitingParts: 0, ready: 0,
  postService: 0, maintenanceDue: 0, maintenanceSoon: 0, receivablesOpen: 0,
  receivablesOutstandingVes: 0, payrollPendingRef: 0, inventoryReview: 0,
  inventoryNegative: 0, bcv: 0, operative: 0,
};

function dateLabel(value: string) {
  if (!value) return "Hoy";
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-VE", {
    weekday: "long", day: "numeric", month: "long",
  });
}

export default function HomePage() {
  const [data, setData] = useState<Dashboard>(EMPTY);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setError("");
    const { data: result, error } = await supabase.rpc("dashboard_overview");
    setLoading(false);
    if (error) return setError(error.message);
    const row = Array.isArray(result) ? result[0] : result;
    if (!row) return;
    setData({
      localDate: row.local_date ?? "",
      closedOrdersToday: Number(row.closed_orders_today ?? 0),
      salesVesToday: Number(row.sales_ves_today ?? 0),
      salesRefToday: Number(row.sales_ref_today ?? 0),
      collectedVesToday: Number(row.collected_ves_today ?? 0),
      collectedRefToday: Number(row.collected_ref_today ?? 0),
      openOrders: Number(row.open_orders ?? 0),
      activeVehicles: Number(row.active_vehicles ?? 0),
      received: Number(row.vehicles_received ?? 0),
      diagnosis: Number(row.vehicles_diagnosis ?? 0),
      inProgress: Number(row.vehicles_in_progress ?? 0),
      waitingParts: Number(row.vehicles_waiting_parts ?? 0),
      ready: Number(row.vehicles_ready ?? 0),
      postService: Number(row.post_service_action ?? 0),
      maintenanceDue: Number(row.maintenance_due ?? 0),
      maintenanceSoon: Number(row.maintenance_soon ?? 0),
      receivablesOpen: Number(row.receivables_open ?? 0),
      receivablesOutstandingVes: Number(row.receivables_outstanding_ves ?? 0),
      payrollPendingRef: Number(row.payroll_pending_ref ?? 0),
      inventoryReview: Number(row.inventory_review ?? 0),
      inventoryNegative: Number(row.inventory_negative ?? 0),
      bcv: Number(row.bcv_rate ?? 0),
      operative: Number(row.operative_rate ?? 0),
    });
  }

  useEffect(() => { load(); }, []);

  return <main className="container stack">
    {error && <div className="error">{error}</div>}

    <section className="brand-hero">
      <div>
        <div className="eyebrow">CENTRO DE CONTROL · {dateLabel(data.localDate).toUpperCase()}</div>
        <h1>¿Qué está pasando ahora?</h1>
        <p>Ventas rápidas al mostrador, operación del taller, clientes y dinero desde un solo sistema.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    <section className="grid grid-3">
      <Link className="btn btn-primary btn-block" style={{ padding: 18, fontSize: 17 }} href="/quick-sale">$ Venta rápida</Link>
      <Link className="btn btn-block" style={{ padding: 18 }} href="/orders/new">＋ Nueva orden</Link>
      <button className="btn btn-block" style={{ padding: 18 }} onClick={load}>{loading ? "Cargando…" : "↻ Actualizar"}</button>
    </section>

    <section className="card stack" style={{ borderColor: "rgba(255,93,21,.4)" }}>
      <div className="row-between"><div><div className="eyebrow">MOSTRADOR</div><h2 className="section-title" style={{ marginBottom: 0 }}>Cotiza y cobra sin frenar la atención</h2></div><Link href="/quick-sale" className="btn btn-primary">Abrir venta</Link></div>
      <div className="muted small">Busca precio sin crear una OS. Si hay stock lo descuenta al cerrar; si no hay stock confirmado puedes vender desde catálogo o manualmente. Para pagos mixtos, Crédito LC o un cliente específico, la misma venta continúa como orden completa.</div>
    </section>

    <section className="card stack">
      <div className="row-between">
        <div><div className="eyebrow">OPERACIÓN</div><h2 className="section-title" style={{ marginBottom: 0 }}>Vehículos y órdenes activas</h2></div>
        <Link href="/workshop" className="btn btn-ghost">Abrir Taller</Link>
      </div>
      <div className="grid grid-2">
        <div className="card brand-card"><div className="muted small">VEHÍCULOS ACTIVOS</div><div className="kpi">{data.activeVehicles}</div><div className="muted small">Carros que siguen dentro del flujo operativo.</div></div>
        <Link href="/orders" className="card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">ÓRDENES ABIERTAS</div><div className="kpi">{data.openOrders}</div><div className="muted small">Incluye taller y ventas todavía sin cerrar.</div></Link>
      </div>
      <div className="grid grid-3">
        <div><div className="muted small">RECIBIDOS</div><strong>{data.received}</strong></div>
        <div><div className="muted small">DIAGNÓSTICO</div><strong>{data.diagnosis}</strong></div>
        <div><div className="muted small">EN TRABAJO</div><strong>{data.inProgress}</strong></div>
        <div><div className="muted small">ESPERA REPUESTO</div><strong>{data.waitingParts}</strong></div>
        <div><div className="muted small">LISTOS</div><strong>{data.ready}</strong></div>
      </div>
    </section>

    <section className="card stack">
      <div className="row-between">
        <div><div className="eyebrow">CLIENTES · CRM</div><h2 className="section-title" style={{ marginBottom: 0 }}>Comunicaciones que requieren atención</h2></div>
        <Link href="/reminders" className="btn btn-ghost">Abrir CRM</Link>
      </div>
      <div className="grid grid-3">
        <Link href="/reminders" className="card brand-card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">POST-SERVICIO</div><div className="kpi">{data.postService}</div><div className="muted small">Mensajes pendientes</div></Link>
        <Link href="/reminders" className="card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">MANTENIMIENTO VENCIDO</div><div className="kpi">{data.maintenanceDue}</div><div className="muted small">Contactar ahora</div></Link>
        <Link href="/reminders" className="card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">PRÓXIMOS</div><div className="kpi">{data.maintenanceSoon}</div><div className="muted small">Próximos 14 días</div></Link>
      </div>
    </section>

    <section className="card stack">
      <div className="row-between">
        <div><div className="eyebrow">FINANZAS</div><h2 className="section-title" style={{ marginBottom: 0 }}>Dinero y obligaciones</h2></div>
        <Link href="/cash" className="btn btn-ghost">Abrir Caja</Link>
      </div>
      <div className="grid grid-2">
        <div className="card"><div className="muted small">VENTAS CERRADAS HOY</div><div className="kpi">{fmtRef(data.salesRefToday)}</div><div className="muted small">{fmtVes(data.salesVesToday)} · {data.closedOrdersToday} órdenes</div></div>
        <div className="card brand-card"><div className="muted small">COBRADO HOY</div><div className="kpi">{fmtRef(data.collectedRefToday)}</div><div className="muted small">{fmtVes(data.collectedVesToday)} · incluye abonos</div></div>
        <Link href="/receivables" className="card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">CRÉDITO LC PENDIENTE</div><div className="kpi">{fmtVes(data.receivablesOutstandingVes)}</div><div className="muted small">{data.receivablesOpen} cuentas abiertas</div></Link>
        <Link href="/payroll" className="card" style={{ color: "inherit", textDecoration: "none" }}><div className="muted small">NÓMINA VARIABLE PENDIENTE</div><div className="kpi">{fmtRef(data.payrollPendingRef)}</div><div className="muted small">Devengos aún no liquidados</div></Link>
      </div>
    </section>

    {(data.inventoryReview > 0 || data.inventoryNegative > 0) && <section className="card stack" style={{ borderColor: "rgba(255,93,21,.5)" }}>
      <div className="row-between"><div><div className="eyebrow">ATENCIÓN ADMINISTRATIVA</div><strong>Inventario pendiente de depuración</strong></div><Link href="/inventory" className="btn btn-ghost">Revisar</Link></div>
      <div className="muted small">{data.inventoryReview} referencias requieren revisión · {data.inventoryNegative} con existencia negativa importada.</div>
    </section>}

    <section className="card stack">
      <div className="row-between"><strong>Accesos por área</strong><Link href="/more" className="btn btn-ghost">Ver todo</Link></div>
      <div className="grid grid-3">
        <Link href="/quick-sale" className="btn">$ Venta</Link>
        <Link href="/orders" className="btn">▤ Órdenes</Link>
        <Link href="/customers" className="btn">◉ Clientes</Link>
        <Link href="/inventory" className="btn">▦ Inventario</Link>
        <Link href="/receivables" className="btn">$ Cobros</Link>
        <Link href="/payroll" className="btn">% Nómina</Link>
      </div>
    </section>

    <section className="card">
      <div className="row-between"><strong>Tasas actuales · Notion</strong><Link href="/settings" className="pill ok">Fuente maestra</Link></div>
      <div className="divider" />
      <div className="grid grid-2">
        <div><div className="muted small">BCV OFICIAL</div><div className="money-lg">{data.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div></div>
        <div><div className="muted small">OPERATIVA / P2P</div><div className="money-lg">{data.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div></div>
      </div>
    </section>
  </main>;
}

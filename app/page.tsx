"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Dashboard = {
  ordersToday: number;
  salesVes: number;
  salesRef: number;
  openOrders: number;
  payrollPending: number;
  bcv: number;
  operative: number;
};

export default function HomePage() {
  const [data, setData] = useState<Dashboard>({ ordersToday: 0, salesVes: 0, salesRef: 0, openOrders: 0, payrollPending: 0, bcv: 0, operative: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("dashboard_today");
      if (error) return setError(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row) setData({
        ordersToday: Number(row.orders_today ?? 0),
        salesVes: Number(row.sales_ves ?? 0),
        salesRef: Number(row.sales_ref ?? 0),
        openOrders: Number(row.open_orders ?? 0),
        payrollPending: Number(row.payroll_pending_ref ?? 0),
        bcv: Number(row.bcv_rate ?? 0),
        operative: Number(row.operative_rate ?? 0),
      });
    })();
  }, []);

  return (
    <main className="container stack">
      {error && <div className="error">{error}</div>}

      <section className="brand-hero">
        <div><div className="eyebrow">LUBRICENTER OS</div><h1>Atender cliente</h1><p>Abre la operación que necesitas. Las órdenes, el inventario, los cobros y el historial quedan conectados en un solo sistema.</p></div>
        <img src="/lubricenter-logo.png" alt="Lubricenter" />
      </section>

      <section className="grid quick-actions">
        <Link className="card brand-card" href="/oil-change"><span className="emoji">◉</span><strong>Cambio de aceite</strong><span className="muted small">Cliente · vehículo · aceite · filtro · próximo servicio</span></Link>
        <Link className="card" href="/inventory"><span className="emoji">▦</span><strong>Inventario</strong><span className="muted small">Existencias reales · aceites · filtros · conteos</span></Link>
        <Link className="card" href="/orders/new"><span className="emoji">＋</span><strong>Nueva orden</strong><span className="muted small">Tienda · Taller · Electroauto</span></Link>
        <Link className="card" href="/customers"><span className="emoji">♙</span><strong>Clientes</strong><span className="muted small">Buscar, registrar y ver vehículos</span></Link>
        <Link className="card" href="/orders"><span className="emoji">▤</span><strong>Órdenes</strong><span className="muted small">Abiertas, cerradas y Crédito LC</span></Link>
        <Link className="card" href="/receivables"><span className="emoji">$</span><strong>Cobros pendientes</strong><span className="muted small">Crédito LC y abonos</span></Link>
        <Link className="card" href="/payroll"><span className="emoji">%</span><strong>Nómina</strong><span className="muted small">Cheo y Alexis</span></Link>
      </section>

      <h2 className="section-title">Hoy</h2>
      <section className="grid grid-3">
        <div className="card"><div className="muted small">VENTAS CERRADAS</div><div className="kpi">{fmtRef(data.salesRef)}</div><div className="muted">{fmtVes(data.salesVes)}</div></div>
        <div className="card"><div className="muted small">ÓRDENES</div><div className="kpi">{data.ordersToday}</div><div className="muted">{data.openOrders} abiertas</div></div>
        <div className="card"><div className="muted small">NÓMINA VARIABLE PENDIENTE</div><div className="kpi">{fmtRef(data.payrollPending)}</div><div className="muted">Aún no liquidada</div></div>
      </section>

      <section className="card">
        <div className="row-between"><strong>Tasas actuales</strong><Link href="/settings" className="pill ok">Configurar</Link></div>
        <div className="divider" />
        <div className="grid grid-2">
          <div><div className="muted small">BCV OFICIAL</div><div className="money-lg">{data.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div></div>
          <div><div className="muted small">OPERATIVA / P2P</div><div className="money-lg">{data.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</div></div>
        </div>
      </section>
    </main>
  );
}

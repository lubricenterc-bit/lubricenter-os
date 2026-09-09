"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Order = {
  id: string;
  order_number: string;
  status: string;
  customer_id: string | null;
  vehicle_id: string | null;
  opened_at: string;
  closed_at: string | null;
  workflow_status: string;
  item_count: number;
  current_total_ves: number;
  current_total_ref: number;
  paid_ves: number;
  paid_ref: number;
  service_areas: string | null;
  financial_status: string;
  receivable_status: string | null;
  outstanding_ves: number | null;
  due_date: string | null;
  crm_state: string;
};
type Customer = { id: string; name: string | null; phone: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null };
type Filter = "ACTIVE" | "HISTORY" | "CREDIT" | "ALL";

const WORKFLOW: Record<string,string> = {
  RECEIVED: "RECIBIDO",
  DIAGNOSIS: "DIAGNÓSTICO",
  IN_PROGRESS: "EN TRABAJO",
  WAITING_PARTS: "ESPERA REPUESTO",
  READY: "LISTO",
  DELIVERED: "ENTREGADO",
};

const FINANCE: Record<string,string> = {
  NOT_STARTED: "SIN COBRAR",
  UNPAID: "SIN COBRAR",
  PARTIAL: "PAGO PARCIAL",
  PAID_PENDING_CLOSE: "PAGADO",
  PAID: "PAGADO",
  CREDIT_LC: "CRÉDITO LC",
};

const CRM: Record<string,string> = {
  NOT_APPLICABLE: "CRM —",
  NO_FOLLOWUP: "CRM —",
  PENDING: "CRM PENDIENTE",
  SNOOZED: "CRM POSPUESTO",
  SENT: "CRM ENVIADO",
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      supabase.from("order_status_current").select("*").order("opened_at", { ascending: false }).limit(300),
      supabase.from("customers").select("id,name,phone").limit(1000),
      supabase.from("vehicles").select("id,plate,make,model").limit(1500),
    ]);
    if (oe || ce || ve) return setError((oe || ce || ve)?.message ?? "No pude cargar las órdenes.");
    setOrders((o ?? []).map((x:any) => ({
      ...x,
      item_count: Number(x.item_count ?? 0),
      current_total_ves: Number(x.current_total_ves ?? 0),
      current_total_ref: Number(x.current_total_ref ?? 0),
      paid_ves: Number(x.paid_ves ?? 0),
      paid_ref: Number(x.paid_ref ?? 0),
      outstanding_ves: x.outstanding_ves == null ? null : Number(x.outstanding_ves),
    })) as Order[]);
    setCustomers((c ?? []) as Customer[]);
    setVehicles((v ?? []) as Vehicle[]);
  }
  useEffect(() => { load(); }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const vehicleMap = useMemo(() => new Map(vehicles.map(v => [v.id, v])), [vehicles]);

  const filtered = useMemo(() => orders.filter(o => {
    if (filter === "ACTIVE" && o.status !== "OPEN") return false;
    if (filter === "HISTORY" && o.status === "OPEN") return false;
    if (filter === "CREDIT" && o.financial_status !== "CREDIT_LC") return false;
    const c = o.customer_id ? customerMap.get(o.customer_id) : undefined;
    const v = o.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
    const haystack = `${o.order_number} ${c?.name ?? ""} ${c?.phone ?? ""} ${v?.plate ?? ""} ${v?.make ?? ""} ${v?.model ?? ""} ${o.service_areas ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), [orders, filter, search, customerMap, vehicleMap]);

  const activeCount = orders.filter(o => o.status === "OPEN").length;
  const creditRows = orders.filter(o => o.financial_status === "CREDIT_LC");
  const creditTotal = creditRows.reduce((a, r) => a + Number(r.outstanding_ves || 0), 0);

  async function deleteOrder(o: Order) {
    if (o.status !== "OPEN") return;
    const confirmed = window.confirm(`¿Eliminar ${o.order_number}?\n\nHazlo solo si es una orden duplicada o creada por error. Las órdenes cerradas no se pueden borrar.`);
    if (!confirmed) return;
    setDeletingId(o.id); setError("");
    const { error } = await supabase.rpc("delete_open_order", { p_order_id: o.id, p_reason: "Orden duplicada o creada por error desde listado de órdenes" });
    setDeletingId(null);
    if (error) return setError(error.message);
    await load();
  }

  function operationLabel(o: Order) {
    if (o.status === "CLOSED") return "ENTREGADO";
    if (!o.vehicle_id) return "VENTA ABIERTA";
    return WORKFLOW[o.workflow_status] ?? o.workflow_status ?? "ABIERTA";
  }

  function financeClass(status: string) {
    return status === "PAID" || status === "PAID_PENDING_CLOSE" ? "ok" : "warn";
  }

  function crmClass(state: string) {
    return state === "SENT" ? "ok" : state === "PENDING" || state === "SNOOZED" ? "warn" : "";
  }

  return <main className="container stack">
    <div className="row-between">
      <div><h1 style={{ marginBottom: 4 }}>Órdenes</h1><div className="muted">Una misma OS muestra por separado operación, dinero y CRM.</div></div>
      <Link href="/orders/new" className="btn btn-primary">+ Nueva</Link>
    </div>

    <section className="grid grid-2">
      <div className="card"><div className="muted small">ACTIVAS</div><div className="kpi">{activeCount}</div><div className="muted small">Todavía requieren alguna acción operativa o de cobro.</div></div>
      <div className="card"><div className="muted small">CRÉDITO LC PENDIENTE</div><div className="kpi">{fmtVes(creditTotal)}</div><div className="muted small">{creditRows.length} cuenta{creditRows.length === 1 ? "" : "s"} por cobrar.</div></div>
    </section>

    {error && <div className="error">{error}</div>}

    <section className="card stack">
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar orden, cliente, teléfono, placa o área" />
      <div className="segmented">
        {(["ACTIVE","HISTORY","CREDIT","ALL"] as Filter[]).map(f => <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f === "ACTIVE" ? "Activas" : f === "HISTORY" ? "Historial" : f === "CREDIT" ? "Crédito LC" : "Todas"}</button>)}
      </div>
    </section>

    <section className="stack">
      {filtered.map(o => {
        const c = o.customer_id ? customerMap.get(o.customer_id) : undefined;
        const v = o.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
        const remaining = Math.max(o.current_total_ves - o.paid_ves, 0);
        return <article className="card stack" key={o.id}>
          <Link href={`/orders/${o.id}`} style={{ color: "inherit", textDecoration: "none" }} className="stack">
            <div className="row-between">
              <div><div className="muted small">{fmtDate(o.closed_at ?? o.opened_at)}</div><div className="money-lg">{o.order_number}</div></div>
              <span className={`pill ${o.status === "CLOSED" ? "ok" : "warn"}`}>{o.status === "OPEN" ? "ABIERTA" : "CERRADA"}</span>
            </div>

            <div><strong>{c?.name || c?.phone || "Cliente no asignado"}</strong><div className="muted small">{v ? [v.plate, v.make, v.model].filter(Boolean).join(" · ") : "Sin vehículo"}{o.service_areas ? ` · ${o.service_areas}` : ""}</div></div>

            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <span className={`pill ${o.status === "CLOSED" || o.workflow_status === "READY" ? "ok" : "warn"}`}>🔧 {operationLabel(o)}</span>
              <span className={`pill ${financeClass(o.financial_status)}`}>💰 {FINANCE[o.financial_status] ?? o.financial_status}</span>
              <span className={`pill ${crmClass(o.crm_state)}`}>♡ {CRM[o.crm_state] ?? o.crm_state}</span>
            </div>

            <div className="row-between">
              <div className="muted small">{o.financial_status === "PARTIAL" ? `${fmtVes(remaining)} por cobrar` : o.financial_status === "CREDIT_LC" ? `${fmtVes(o.outstanding_ves || 0)} en Crédito LC${o.due_date ? ` · vence ${o.due_date}` : ""}` : `${o.item_count} líneas`}</div>
              <div style={{ textAlign: "right" }}><strong>{fmtRef(o.current_total_ref)}</strong><div className="muted small">{fmtVes(o.current_total_ves)}</div></div>
            </div>
          </Link>
          {o.status === "OPEN" && <button className="btn btn-ghost btn-block" style={{ borderColor: "rgba(255,80,80,.45)", color: "#ff8b8b" }} disabled={deletingId === o.id} onClick={() => deleteOrder(o)}>{deletingId === o.id ? "Eliminando…" : "Eliminar duplicada"}</button>}
        </article>;
      })}
      {!filtered.length && <div className="card muted">No hay órdenes que coincidan con este filtro.</div>}
    </section>
  </main>;
}

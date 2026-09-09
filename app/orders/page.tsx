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
  total_ves: number;
  total_ref: number;
};
type Customer = { id: string; name: string | null; phone: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null };
type Receivable = { id: string; order_id: string; status: string; outstanding_ves: number; due_date: string | null };
type Filter = "ALL" | "OPEN" | "CLOSED" | "CREDIT";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: c, error: ce }, { data: v, error: ve }, { data: r, error: re }] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,opened_at,closed_at,total_ves,total_ref").order("opened_at", { ascending: false }).limit(200),
      supabase.from("customers").select("id,name,phone").limit(1000),
      supabase.from("vehicles").select("id,plate,make,model").limit(1500),
      supabase.from("receivables").select("id,order_id,status,outstanding_ves,due_date").order("created_at", { ascending: false }).limit(500),
    ]);
    if (oe || ce || ve || re) return setError((oe || ce || ve || re)?.message ?? "No pude cargar las órdenes.");
    setOrders((o ?? []) as Order[]);
    setCustomers((c ?? []) as Customer[]);
    setVehicles((v ?? []) as Vehicle[]);
    setReceivables((r ?? []) as Receivable[]);
  }
  useEffect(() => { load(); }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const vehicleMap = useMemo(() => new Map(vehicles.map(v => [v.id, v])), [vehicles]);
  const receivableMap = useMemo(() => new Map(receivables.map(r => [r.order_id, r])), [receivables]);

  const filtered = useMemo(() => orders.filter(o => {
    const credit = receivableMap.get(o.id);
    if (filter === "OPEN" && o.status !== "OPEN") return false;
    if (filter === "CLOSED" && o.status !== "CLOSED") return false;
    if (filter === "CREDIT" && !credit) return false;
    const c = o.customer_id ? customerMap.get(o.customer_id) : undefined;
    const v = o.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
    const haystack = `${o.order_number} ${c?.name ?? ""} ${c?.phone ?? ""} ${v?.plate ?? ""} ${v?.make ?? ""} ${v?.model ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), [orders, filter, search, customerMap, vehicleMap, receivableMap]);

  const openCount = orders.filter(o => o.status === "OPEN").length;
  const creditOpen = receivables.filter(r => r.status === "OPEN");
  const creditTotal = creditOpen.reduce((a, r) => a + Number(r.outstanding_ves || 0), 0);

  return (
    <main className="container stack">
      <div className="row-between">
        <div><h1 style={{ marginBottom: 4 }}>Órdenes</h1><div className="muted">Atiende, guarda y retoma órdenes desde cualquier equipo.</div></div>
        <Link href="/orders/new" className="btn btn-primary">+ Nueva</Link>
      </div>

      <section className="grid grid-2">
        <div className="card"><div className="muted small">ÓRDENES ABIERTAS</div><div className="kpi">{openCount}</div><div className="muted small">Puedes retomarlas sin perder items ni pagos.</div></div>
        <div className="card"><div className="muted small">CRÉDITO LC PENDIENTE</div><div className="kpi">{fmtVes(creditTotal)}</div><div className="muted small">{creditOpen.length} cuenta{creditOpen.length === 1 ? "" : "s"} por cobrar.</div></div>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="card stack">
        <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar orden, cliente, teléfono o placa" />
        <div className="segmented">
          {(["ALL","OPEN","CLOSED","CREDIT"] as Filter[]).map(f => <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f === "ALL" ? "Todas" : f === "OPEN" ? "Abiertas" : f === "CLOSED" ? "Cerradas" : "Crédito LC"}</button>)}
        </div>
      </section>

      <section className="stack">
        {filtered.map(o => {
          const c = o.customer_id ? customerMap.get(o.customer_id) : undefined;
          const v = o.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
          const credit = receivableMap.get(o.id);
          return <Link href={`/orders/${o.id}`} className="card stack" key={o.id}>
            <div className="row-between">
              <div><div className="muted small">{fmtDate(o.closed_at ?? o.opened_at)}</div><div className="money-lg">{o.order_number}</div></div>
              <span className={`pill ${o.status === "CLOSED" ? "ok" : "warn"}`}>{o.status === "OPEN" ? "ABIERTA" : o.status === "CLOSED" ? "CERRADA" : "CANCELADA"}</span>
            </div>
            <div>
              <strong>{c?.name || c?.phone || "Cliente no asignado"}</strong>
              <div className="muted small">{v ? [v.plate, v.make, v.model].filter(Boolean).join(" · ") : "Sin vehículo"}</div>
            </div>
            <div className="row-between">
              <div>{credit ? <><span className={`pill ${credit.status === "PAID" ? "ok" : "warn"}`}>Crédito LC {credit.status === "PAID" ? "pagado" : "pendiente"}</span>{credit.status === "OPEN" && <div className="muted small" style={{ marginTop: 6 }}>{fmtVes(credit.outstanding_ves)} por cobrar{credit.due_date ? ` · ${credit.due_date}` : ""}</div>}</> : <span className="muted small">{o.status === "OPEN" ? "Toca para continuar atendiendo" : "Toca para ver detalle"}</span>}</div>
              <div style={{ textAlign: "right" }}><strong>{fmtRef(o.total_ref)}</strong><div className="muted small">{fmtVes(o.total_ves)}</div></div>
            </div>
          </Link>;
        })}
        {!filtered.length && <div className="card muted">No hay órdenes que coincidan con este filtro.</div>}
      </section>
    </main>
  );
}

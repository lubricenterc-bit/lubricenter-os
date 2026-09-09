"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Order = {
  id: string;
  order_number: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  total_ves: number;
  total_ref: number;
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const { data, error } = await supabase.from("orders").select("id,order_number,status,opened_at,closed_at,total_ves,total_ref").order("opened_at", { ascending: false }).limit(100);
    if (error) setError(error.message); else setOrders((data ?? []) as Order[]);
  }
  useEffect(() => { load(); }, []);

  return (
    <main className="container stack">
      <div className="row-between"><div><h1 style={{ marginBottom: 4 }}>Órdenes</h1><div className="muted">Últimas 100 operaciones</div></div></div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ overflowX: "auto" }}>
        <table className="table">
          <thead><tr><th>Orden</th><th>Estado</th><th>Fecha</th><th>REF</th><th>Bs</th></tr></thead>
          <tbody>
            {orders.map(o => <tr key={o.id}>
              <td><strong>{o.order_number}</strong></td>
              <td><span className={`pill ${o.status === "CLOSED" ? "ok" : "warn"}`}>{o.status}</span></td>
              <td>{fmtDate(o.closed_at ?? o.opened_at)}</td>
              <td>{fmtRef(o.total_ref)}</td>
              <td>{fmtVes(o.total_ves)}</td>
            </tr>)}
            {!orders.length && <tr><td colSpan={5} className="muted">Todavía no hay órdenes.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}

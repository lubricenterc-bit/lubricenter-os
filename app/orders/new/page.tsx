"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; current_odometer: number | null };

export default function NewOrderPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
        supabase.from("customers").select("id,name,phone,document_id").order("updated_at", { ascending: false }).limit(1000),
        supabase.from("vehicles").select("id,customer_id,plate,make,model,year,current_odometer").order("updated_at", { ascending: false }).limit(1500),
      ]);
      if (ce || ve) return setError((ce || ve)?.message ?? "No pude cargar clientes y vehículos.");
      setCustomers((c ?? []) as Customer[]);
      setVehicles((v ?? []) as Vehicle[]);
    })();
  }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter(v => {
      const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
      const haystack = `${v.plate ?? ""} ${v.make ?? ""} ${v.model ?? ""} ${v.year ?? ""} ${c?.name ?? ""} ${c?.phone ?? ""} ${c?.document_id ?? ""}`.toLowerCase();
      return !q || haystack.includes(q);
    }).slice(0, 80);
  }, [vehicles, search, customerMap]);

  async function createOrder(vehicle?: Vehicle) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { data, error } = await supabase.rpc("create_order");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (vehicle) {
        const { error: partyError } = await supabase.rpc("set_order_party", {
          p_order_id: row.id,
          p_customer_id: vehicle.customer_id,
          p_vehicle_id: vehicle.id,
        });
        if (partyError) throw partyError;
      }
      router.push(`/orders/${row.id}`);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div>
        <div className="eyebrow">UNA SOLA ORDEN · TODO EL SERVICIO</div>
        <h1>Nueva orden</h1>
        <p>Una visita puede incluir cambio de aceite, productos, taller y electroauto dentro del mismo número OS.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className="card stack">
      <div className="row-between">
        <div><strong>Busca el vehículo</strong><div className="muted small">Al seleccionarlo, cliente y vehículo quedan asociados desde el inicio.</div></div>
        <Link className="btn btn-ghost" href="/customers">+ Cliente nuevo</Link>
      </div>
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Placa, cliente, teléfono, cédula, marca o modelo" autoFocus />
    </section>

    <section className="stack">
      {visible.map(v => {
        const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
        return <button key={v.id} className="card directory-option" style={{ padding: 16 }} disabled={busy} onClick={() => createOrder(v)}>
          <div className="row-between" style={{ width: "100%" }}>
            <div style={{ textAlign: "left" }}>
              <div className="money-lg">{v.plate || "SIN PLACA"}</div>
              <div>{[v.make, v.model, v.year].filter(Boolean).join(" · ") || "Vehículo"}</div>
              <div className="muted small">{c?.name || c?.phone || "Sin cliente"}{v.current_odometer != null ? ` · ${v.current_odometer.toLocaleString("es-VE")} km` : ""}</div>
            </div>
            <span className="btn btn-primary">Atender</span>
          </div>
        </button>;
      })}
      {!visible.length && <div className="card muted">No encontré vehículos con esa búsqueda. Puedes crear el cliente/vehículo o iniciar una venta sin vehículo.</div>}
    </section>

    <section className="card stack">
      <strong>Venta sin vehículo</strong>
      <div className="muted small">Para tienda o una operación rápida que no requiera historial automotriz.</div>
      <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => createOrder()}>{busy ? "Creando…" : "Crear orden sin vehículo"}</button>
    </section>
  </main>;
}

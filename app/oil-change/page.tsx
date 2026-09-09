"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; current_odometer: number | null };

export default function FastOilChangePage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      supabase.from("customers").select("id,name,phone,document_id").order("updated_at", { ascending: false }).limit(1000),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,current_odometer").order("updated_at", { ascending: false }).limit(1500),
    ]);
    if (ce || ve) return setError((ce || ve)?.message ?? "No pude cargar los vehículos.");
    setCustomers((c ?? []) as Customer[]);
    setVehicles((v ?? []) as Vehicle[]);
  }
  useEffect(() => { load(); }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter(v => {
      const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
      const haystack = `${v.plate ?? ""} ${v.make ?? ""} ${v.model ?? ""} ${v.year ?? ""} ${c?.name ?? ""} ${c?.phone ?? ""} ${c?.document_id ?? ""}`.toLowerCase();
      return !q || haystack.includes(q);
    }).slice(0,80);
  }, [vehicles, search, customerMap]);

  async function start(v: Vehicle) {
    setBusy(v.id); setError("");
    try {
      const { data, error } = await supabase.rpc("create_order");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const { error: pe } = await supabase.rpc("set_order_party", { p_order_id: row.id, p_customer_id: v.customer_id, p_vehicle_id: v.id });
      if (pe) throw pe;
      router.push(`/orders/${row.id}/oil-change`);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(null);
    }
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">ATENCIÓN RÁPIDA</div><h1>Cambio de aceite</h1><p>Busca al cliente o la placa, abre la orden y captura el mantenimiento en menos pasos.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className="card stack">
      <label><span className="label">Cliente o vehículo</span><input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Placa, nombre, teléfono, cédula, marca o modelo" autoFocus /></label>
      <div className="muted small">¿Cliente nuevo? Créalo primero en Clientes y vuelve aquí.</div>
    </section>

    <section className="stack">
      {filtered.map(v => {
        const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
        return <button key={v.id} className="card directory-option" style={{ padding: 16 }} disabled={!!busy} onClick={() => start(v)}>
          <div className="row-between" style={{ width: "100%" }}>
            <div style={{ textAlign: "left" }}><div className="money-lg">{v.plate || "SIN PLACA"}</div><div>{[v.make,v.model,v.year].filter(Boolean).join(" · ") || "Vehículo"}</div><div className="muted small">{c?.name || c?.phone || "Sin cliente"}{v.current_odometer != null ? ` · ${v.current_odometer.toLocaleString("es-VE")} km` : ""}</div></div>
            <span className="btn btn-primary">{busy === v.id ? "Abriendo…" : "Atender"}</span>
          </div>
        </button>;
      })}
      {!filtered.length && <div className="card muted">No encontré vehículos. Puedes registrar uno desde Clientes.</div>}
    </section>
  </main>;
}

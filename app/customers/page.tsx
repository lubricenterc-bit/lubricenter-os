"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef } from "@/lib/format";

type CustomerSummary = {
  customer_id: string; name: string | null; phone: string | null; document_id: string | null;
  created_at: string; vehicle_count: number; order_count: number; total_ref: number;
  last_visit_at: string | null; vehicles_text: string | null;
};
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null; year: number | null };

export default function CustomersPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [unassigned, setUnassigned] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCustomerForm, setShowCustomerForm] = useState(false);

  async function load(query = search) {
    setLoading(true); setError("");
    const [{ data: rows, error: ce }, { data: orphanRows, error: ve }] = await Promise.all([
      supabase.rpc("search_customer_master", { p_query: query.trim() || null, p_limit: 1000 }),
      supabase.from("vehicles").select("id,plate,make,model,year").is("customer_id", null).order("updated_at", { ascending: false }).limit(100),
    ]);
    setLoading(false);
    if (ce || ve) return setError((ce || ve)?.message ?? "No pude cargar el CRM.");
    setCustomers((rows ?? []) as CustomerSummary[]);
    setUnassigned((orphanRows ?? []) as Vehicle[]);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => load(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  async function createCustomer(form: FormData) {
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("upsert_customer", {
      p_name: String(form.get("name") || "").trim() || null,
      p_phone: String(form.get("phone") || "").trim() || null,
      p_document_id: String(form.get("document") || "").trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/customers/${data as string}`);
  }

  const customersWithVehicles = customers.filter(c => Number(c.vehicle_count) > 0).length;
  const orders = customers.reduce((sum, c) => sum + Number(c.order_count), 0);

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">CRM · BASE MAESTRA</div><h1>Clientes</h1><p>Encuentra a una persona por nombre, teléfono, documento o vehículo y abre toda su relación con Lubricenter.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className="grid grid-3">
      <div className="card"><div className="muted small">CLIENTES EN ESTA VISTA</div><div className="kpi">{customers.length}</div></div>
      <div className="card"><div className="muted small">CON VEHÍCULO</div><div className="kpi">{customersWithVehicles}</div></div>
      <div className="card"><div className="muted small">VISITAS REGISTRADAS</div><div className="kpi">{orders}</div></div>
    </section>

    <section className="card stack">
      <div className="row-between">
        <div><h2 className="section-title">Directorio central</h2><div className="muted small">La búsqueda también revisa placas, marcas y modelos.</div></div>
        <div className="row"><Link className="btn btn-ghost" href="/reminders">Seguimientos</Link><button className="btn btn-primary" onClick={() => setShowCustomerForm(true)}>+ Cliente</button></div>
      </div>
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nombre, teléfono, cédula, RIF, placa, marca o modelo…" autoFocus />
    </section>

    <section className="stack">
      {loading && <div className="card muted">Buscando…</div>}
      {!loading && customers.map(c => <Link href={`/customers/${c.customer_id}`} className="card crm-customer-row" key={c.customer_id}>
        <div className="crm-customer-main">
          <div className="row"><strong>{c.name || "Cliente sin nombre"}</strong><span className="pill">{Number(c.vehicle_count)} veh.</span></div>
          <div className="muted small">{[c.phone, c.document_id].filter(Boolean).join(" · ") || "Sin datos de contacto"}</div>
          <div className="small crm-vehicle-summary">{c.vehicles_text || "Sin vehículo asociado"}</div>
        </div>
        <div className="crm-customer-stats">
          <div><span className="muted small">VISITAS</span><strong>{Number(c.order_count)}</strong></div>
          <div><span className="muted small">ÚLTIMA</span><strong>{c.last_visit_at ? fmtDate(c.last_visit_at) : "Sin visitas"}</strong></div>
          <div><span className="muted small">TOTAL</span><strong>{fmtRef(Number(c.total_ref))}</strong></div>
          <span className="btn btn-ghost">Abrir ficha</span>
        </div>
      </Link>)}
      {!loading && !customers.length && <div className="card muted">No encontramos clientes con esa búsqueda.</div>}
    </section>

    {!!unassigned.length && <section className="card stack">
      <div className="row-between"><div><h2 className="section-title">Vehículos sin cliente</h2><div className="muted small">Puedes abrir una ficha y asociarla desde el cliente correcto.</div></div><span className="pill warn">{unassigned.length}</span></div>
      <div className="grid grid-2">{unassigned.slice(0, 12).map(v => <Link href={`/vehicles/${v.id}`} className="directory-option" key={v.id}><strong>{v.plate || "SIN PLACA"}</strong><span>{[v.make, v.model, v.year].filter(Boolean).join(" · ") || "Sin detalles"}</span></Link>)}</div>
    </section>}

    {showCustomerForm && <div className="overlay"><form className="sheet stack" action={createCustomer}>
      <div className="row-between"><div><h2 style={{ margin: 0 }}>Nuevo cliente</h2><div className="muted small">Después podrás asociar uno o varios vehículos.</div></div><button type="button" className="btn btn-ghost" onClick={() => setShowCustomerForm(false)}>Cerrar</button></div>
      <label><span className="label">Nombre</span><input name="name" className="input" autoFocus /></label>
      <div className="grid grid-2"><label><span className="label">Teléfono</span><input name="phone" className="input" inputMode="tel" /></label><label><span className="label">Cédula / RIF</span><input name="document" className="input" /></label></div>
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Guardando…" : "Guardar y abrir ficha"}</button>
    </form></div>}
  </main>;
}


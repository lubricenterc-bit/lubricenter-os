"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null; created_at: string };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null };

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [showVehicleForm, setShowVehicleForm] = useState(false);

  async function load() {
    setError("");
    const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      supabase.from("customers").select("id,name,phone,document_id,created_at").order("updated_at", { ascending: false }).limit(500),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").order("updated_at", { ascending: false }).limit(1000),
    ]);
    if (ce) setError(ce.message); else setCustomers((c ?? []) as Customer[]);
    if (ve) setError(ve.message); else setVehicles((v ?? []) as Vehicle[]);
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    const vehicleCustomerIds = new Set(vehicles.filter(v => `${v.plate ?? ""} ${v.make ?? ""} ${v.model ?? ""}`.toLowerCase().includes(q)).map(v => v.customer_id).filter(Boolean));
    return customers.filter(c => `${c.name ?? ""} ${c.phone ?? ""} ${c.document_id ?? ""}`.toLowerCase().includes(q) || vehicleCustomerIds.has(c.id));
  }, [customers, vehicles, search]);

  async function createCustomer(form: FormData) {
    setBusy(true); setError(""); setNotice("");
    const { data, error } = await supabase.rpc("upsert_customer", {
      p_name: String(form.get("name") || "").trim() || null,
      p_phone: String(form.get("phone") || "").trim() || null,
      p_document_id: String(form.get("document") || "").trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setSelectedCustomer(data as string);
    setShowCustomerForm(false);
    setNotice("Cliente guardado.");
    await load();
  }

  async function createVehicle(form: FormData) {
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("upsert_vehicle", {
      p_customer_id: selectedCustomer || null,
      p_plate: String(form.get("plate") || "").trim() || null,
      p_make: String(form.get("make") || "").trim() || null,
      p_model: String(form.get("model") || "").trim() || null,
      p_year: form.get("year") ? Number(form.get("year")) : null,
      p_engine: String(form.get("engine") || "").trim() || null,
      p_current_odometer: form.get("odometer") ? Number(form.get("odometer")) : null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setShowVehicleForm(false);
    setNotice("Vehículo guardado.");
    await load();
  }

  return (
    <main className="container stack">
      <section className="brand-hero">
        <div>
          <div className="eyebrow">CRM · LUBRICENTER</div>
          <h1>Clientes y vehículos</h1>
          <p>Una sola ficha para historial, kilometraje, crédito y próximos recordatorios.</p>
        </div>
        <img src="/lubricenter-logo.png" alt="Lubricenter" />
      </section>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <section className="card stack">
        <div className="row-between">
          <div><h2 className="section-title">Base de clientes</h2><div className="muted small">{customers.length} clientes · {vehicles.length} vehículos</div></div>
          <button className="btn btn-primary" onClick={() => setShowCustomerForm(true)}>+ Cliente</button>
        </div>
        <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, teléfono, cédula, placa, marca o modelo…" />
      </section>

      <section className="grid grid-2">
        {filtered.map(c => {
          const owned = vehicles.filter(v => v.customer_id === c.id);
          return <article className={`card customer-card ${selectedCustomer === c.id ? "customer-card-active" : ""}`} key={c.id} onClick={() => setSelectedCustomer(c.id)}>
            <div className="row-between"><div><strong>{c.name || "Cliente sin nombre"}</strong><div className="muted small">{c.phone || c.document_id || "Sin contacto"}</div></div><span className="pill">{owned.length} veh.</span></div>
            <div className="stack">
              {owned.map(v => <div className="vehicle-line" key={v.id}>
                <div><strong>{v.plate || "SIN PLACA"}</strong><div className="muted small">{[v.make, v.model, v.year].filter(Boolean).join(" · ") || "Vehículo sin detalle"}</div><div className="muted small">{v.current_odometer != null ? `${v.current_odometer.toLocaleString("es-VE")} km` : "Sin km"}</div></div>
                <Link href={`/vehicles/${v.id}`} className="btn btn-ghost" onClick={e => e.stopPropagation()}>Ver ficha</Link>
              </div>)}
              {!owned.length && <div className="muted small">Todavía no tiene vehículos registrados.</div>}
            </div>
          </article>;
        })}
        {!filtered.length && <div className="card muted">No encontramos coincidencias.</div>}
      </section>

      <button className="btn btn-block" disabled={!selectedCustomer} onClick={() => setShowVehicleForm(true)}>+ Agregar vehículo al cliente seleccionado</button>

      {showCustomerForm && <div className="overlay"><form className="sheet stack" action={createCustomer}>
        <div className="row-between"><div><h2 style={{ margin: 0 }}>Nuevo cliente</h2><div className="muted small">Nombre, teléfono o documento son suficientes para empezar.</div></div><button type="button" className="btn btn-ghost" onClick={() => setShowCustomerForm(false)}>Cerrar</button></div>
        <label><span className="label">Nombre</span><input name="name" className="input" autoFocus /></label>
        <div className="grid grid-2"><label><span className="label">Teléfono</span><input name="phone" className="input" inputMode="tel" /></label><label><span className="label">Cédula / RIF</span><input name="document" className="input" /></label></div>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Guardando…" : "Guardar cliente"}</button>
      </form></div>}

      {showVehicleForm && <div className="overlay"><form className="sheet stack" action={createVehicle}>
        <div className="row-between"><div><h2 style={{ margin: 0 }}>Nuevo vehículo</h2><div className="muted small">Se vinculará al cliente seleccionado.</div></div><button type="button" className="btn btn-ghost" onClick={() => setShowVehicleForm(false)}>Cerrar</button></div>
        <div className="grid grid-2">
          <label><span className="label">Placa</span><input name="plate" className="input" style={{ textTransform: "uppercase" }} autoFocus /></label>
          <label><span className="label">Marca</span><input name="make" className="input" /></label>
          <label><span className="label">Modelo</span><input name="model" className="input" /></label>
          <label><span className="label">Año</span><input name="year" type="number" className="input" /></label>
          <label><span className="label">Motor</span><input name="engine" className="input" /></label>
          <label><span className="label">Kilometraje</span><input name="odometer" type="number" min="0" className="input" /></label>
        </div>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Guardando…" : "Guardar vehículo"}</button>
      </form></div>}
    </main>
  );
}

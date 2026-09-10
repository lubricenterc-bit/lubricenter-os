"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null };
type Mode = "SEARCH" | "NEW";

function norm(value: string | null | undefined) {
  return (value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export default function NewOrderPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [mode, setMode] = useState<Mode>("SEARCH");
  const [search, setSearch] = useState("");
  const [vehicleCustomer, setVehicleCustomer] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      supabase.from("customers").select("id,name,phone,document_id").order("updated_at", { ascending: false }).limit(1200),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").order("updated_at", { ascending: false }).limit(1800),
    ]);
    if (ce || ve) return setError((ce || ve)?.message ?? "No pude cargar clientes y vehículos.");
    setCustomers((c ?? []) as Customer[]);
    setVehicles((v ?? []) as Vehicle[]);
  }
  useEffect(() => { load(); }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const q = norm(search.trim());
  const visibleVehicles = useMemo(() => {
    const rows = vehicles.filter(v => {
      if (!q) return true;
      const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
      return norm(`${v.plate ?? ""} ${v.make ?? ""} ${v.model ?? ""} ${v.year ?? ""} ${c?.name ?? ""} ${c?.phone ?? ""} ${c?.document_id ?? ""}`).includes(q);
    });
    return rows.slice(0, q ? 20 : 8);
  }, [vehicles, customerMap, q]);
  const visibleCustomers = useMemo(() => {
    if (!q) return [];
    return customers.filter(c => norm(`${c.name ?? ""} ${c.phone ?? ""} ${c.document_id ?? ""}`).includes(q)).slice(0, 10);
  }, [customers, q]);

  async function createOrder(customerId: string | null, vehicleId: string | null) {
    const { data, error } = await supabase.rpc("create_order");
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (customerId || vehicleId) {
      const { error: partyError } = await supabase.rpc("set_order_party", { p_order_id: row.id, p_customer_id: customerId, p_vehicle_id: vehicleId });
      if (partyError) throw partyError;
    }
    router.push(`/orders/${row.id}`);
  }

  async function attendVehicle(vehicle: Vehicle) {
    if (busy) return;
    setBusy(true); setError("");
    try { await createOrder(vehicle.customer_id, vehicle.id); }
    catch (e: any) { setError(e.message ?? String(e)); setBusy(false); }
  }

  async function createNewVisit(form: FormData) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const name = String(form.get("name") || "").trim();
      const phone = String(form.get("phone") || "").trim();
      const documentId = String(form.get("document") || "").trim();
      const plate = String(form.get("plate") || "").trim().toUpperCase();
      const make = String(form.get("make") || "").trim();
      const model = String(form.get("model") || "").trim();
      if (!name && !phone && !documentId) throw new Error("Ingresa nombre, teléfono o cédula del cliente.");
      if (!plate && !make && !model) throw new Error("Ingresa al menos placa, marca o modelo del vehículo.");
      const { data: customerId, error: ce } = await supabase.rpc("upsert_customer", { p_name: name || null, p_phone: phone || null, p_document_id: documentId || null });
      if (ce) throw ce;
      const { data: vehicleId, error: ve } = await supabase.rpc("upsert_vehicle", {
        p_customer_id: customerId,
        p_plate: plate || null,
        p_make: make || null,
        p_model: model || null,
        p_year: form.get("year") ? Number(form.get("year")) : null,
        p_engine: String(form.get("engine") || "").trim() || null,
        p_current_odometer: form.get("odometer") ? Number(form.get("odometer")) : null,
      });
      if (ve) throw ve;
      await createOrder(customerId as string, vehicleId as string);
    } catch (e: any) { setError(e.message ?? String(e)); setBusy(false); }
  }

  async function createVehicleForCustomer(form: FormData) {
    if (!vehicleCustomer || busy) return;
    setBusy(true); setError("");
    try {
      const { data: vehicleId, error: ve } = await supabase.rpc("upsert_vehicle", {
        p_customer_id: vehicleCustomer.id,
        p_plate: String(form.get("plate") || "").trim().toUpperCase() || null,
        p_make: String(form.get("make") || "").trim() || null,
        p_model: String(form.get("model") || "").trim() || null,
        p_year: form.get("year") ? Number(form.get("year")) : null,
        p_engine: String(form.get("engine") || "").trim() || null,
        p_current_odometer: form.get("odometer") ? Number(form.get("odometer")) : null,
      });
      if (ve) throw ve;
      await createOrder(vehicleCustomer.id, vehicleId as string);
    } catch (e: any) { setError(e.message ?? String(e)); setBusy(false); }
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">ATENCIÓN COMPLETA · UNA SOLA OS</div><h1>Nueva orden</h1><p>Crea o encuentra cliente y vehículo aquí mismo. Después agregas cambio de aceite, productos, taller, electroauto y el cobro.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    <section className="grid grid-2">
      <button className={`btn btn-block ${mode === "SEARCH" ? "btn-primary" : ""}`} onClick={() => { setMode("SEARCH"); setVehicleCustomer(null); }}>Buscar existente</button>
      <button className={`btn btn-block ${mode === "NEW" ? "btn-primary" : ""}`} onClick={() => { setMode("NEW"); setVehicleCustomer(null); }}>+ Cliente y vehículo nuevo</button>
    </section>

    {error && <div className="error">{error}</div>}

    {mode === "SEARCH" && <>
      <section className="card stack" style={{ borderColor: "rgba(255,93,21,.4)" }}>
        <div><strong>¿Quién llegó?</strong><div className="muted small">Busca por placa, nombre, teléfono, cédula, marca o modelo. No necesitas entrar al CRM.</div></div>
        <input className="input" value={search} onChange={e => { setSearch(e.target.value); setVehicleCustomer(null); }} placeholder="Ej. ABC12D, José, 0414..., Toyota..." autoFocus />
        {!search.trim() && <div className="muted small">Mostrando los vehículos más recientes. Escribe para buscar en toda la base.</div>}
      </section>

      {visibleVehicles.length > 0 && <section className="stack">
        <div className="row-between"><strong>Vehículos</strong><span className="pill">{visibleVehicles.length} resultados</span></div>
        {visibleVehicles.map(v => {
          const c = v.customer_id ? customerMap.get(v.customer_id) : undefined;
          return <button key={v.id} className="card directory-option" style={{ padding: 14, textAlign: "left" }} disabled={busy} onClick={() => attendVehicle(v)}>
            <div className="row-between" style={{ gap: 12 }}>
              <div><div className="money-lg">{v.plate || "SIN PLACA"}</div><strong>{[v.make, v.model, v.year].filter(Boolean).join(" · ") || "Vehículo"}</strong><div className="muted small">{c?.name || c?.phone || "Sin cliente"}{v.current_odometer != null ? ` · ${v.current_odometer.toLocaleString("es-VE")} km` : ""}</div></div>
              <span className="btn btn-primary">Atender</span>
            </div>
          </button>;
        })}
      </section>}

      {visibleCustomers.length > 0 && <section className="card stack">
        <div><strong>Clientes encontrados</strong><div className="muted small">Si el cliente llegó con otro carro, créalo aquí y abre la orden de una vez.</div></div>
        {visibleCustomers.map(c => <div key={c.id} className="row-between" style={{ gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
          <div><strong>{c.name || "Cliente sin nombre"}</strong><div className="muted small">{[c.phone, c.document_id].filter(Boolean).join(" · ") || "Sin datos adicionales"}</div></div>
          <button className="btn btn-ghost" onClick={() => setVehicleCustomer(c)}>+ Vehículo</button>
        </div>)}
      </section>}

      {search.trim() && !visibleVehicles.length && !visibleCustomers.length && <section className="card stack"><strong>No encontré ese cliente o vehículo.</strong><div className="muted small">Créalo sin salir de este flujo.</div><button className="btn btn-primary" onClick={() => setMode("NEW")}>Crear cliente + vehículo</button></section>}

      {vehicleCustomer && <div className="overlay"><form className="sheet stack" action={createVehicleForCustomer}>
        <div className="row-between"><div><h2 style={{ margin: 0 }}>Nuevo vehículo</h2><div className="muted small">Para {vehicleCustomer.name || vehicleCustomer.phone || "este cliente"}. Al guardar se abrirá la orden.</div></div><button type="button" className="btn btn-ghost" onClick={() => setVehicleCustomer(null)}>Cerrar</button></div>
        <div className="grid grid-2">
          <label><span className="label">Placa</span><input name="plate" className="input" style={{ textTransform: "uppercase" }} autoFocus /></label>
          <label><span className="label">Kilometraje</span><input name="odometer" type="number" min="0" className="input" /></label>
          <label><span className="label">Marca</span><input name="make" className="input" /></label>
          <label><span className="label">Modelo</span><input name="model" className="input" /></label>
          <label><span className="label">Año</span><input name="year" type="number" className="input" /></label>
          <label><span className="label">Motor</span><input name="engine" className="input" /></label>
        </div>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Creando orden…" : "Guardar vehículo y atender"}</button>
      </form></div>}
    </>}

    {mode === "NEW" && <form className="stack" action={createNewVisit}>
      <section className="card stack">
        <div><div className="eyebrow">1 · CLIENTE</div><strong>Datos mínimos</strong><div className="muted small">Nombre, teléfono o cédula son suficientes. Puedes completar lo demás después.</div></div>
        <label><span className="label">Nombre</span><input name="name" className="input" autoFocus /></label>
        <div className="grid grid-2"><label><span className="label">Teléfono / WhatsApp</span><input name="phone" className="input" inputMode="tel" /></label><label><span className="label">Cédula / RIF</span><input name="document" className="input" /></label></div>
      </section>
      <section className="card stack">
        <div><div className="eyebrow">2 · VEHÍCULO</div><strong>Identifica el carro</strong><div className="muted small">No tienes que crear el cliente y luego buscarlo: todo se guarda junto.</div></div>
        <div className="grid grid-2">
          <label><span className="label">Placa</span><input name="plate" className="input" style={{ textTransform: "uppercase" }} /></label>
          <label><span className="label">Kilometraje</span><input name="odometer" type="number" min="0" className="input" /></label>
          <label><span className="label">Marca</span><input name="make" className="input" /></label>
          <label><span className="label">Modelo</span><input name="model" className="input" /></label>
          <label><span className="label">Año</span><input name="year" type="number" className="input" /></label>
          <label><span className="label">Motor</span><input name="engine" className="input" /></label>
        </div>
      </section>
      <button className="btn btn-primary btn-block" style={{ minHeight: 58, fontSize: 17 }} disabled={busy}>{busy ? "Creando orden…" : "Crear cliente, vehículo y abrir orden"}</button>
    </form>}

    <section className="card stack">
      <div className="row-between"><div><strong>¿Solo viene a comprar?</strong><div className="muted small">No crees una orden compleja innecesaria.</div></div><Link href="/quick-sale" className="btn">Ir a Venta rápida</Link></div>
      <details><summary className="muted small" style={{ cursor: "pointer" }}>Abrir orden excepcional sin cliente ni vehículo</summary><button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} disabled={busy} onClick={() => { setBusy(true); setError(""); createOrder(null, null).catch((e: any) => { setError(e.message ?? String(e)); setBusy(false); }); }}>{busy ? "Creando…" : "Crear orden vacía"}</button></details>
    </section>
  </main>;
}

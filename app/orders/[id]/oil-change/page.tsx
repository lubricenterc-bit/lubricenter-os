"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Order = { id: string; order_number: string; status: string; customer_id: string | null; vehicle_id: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null; year: number | null; current_odometer: number | null };
type Customer = { id: string; name: string | null; phone: string | null };
type Rates = { bcv: number; operative: number };

export default function OilChangePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = params.id;
  const [order, setOrder] = useState<Order | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [description, setDescription] = useState("Cambio de aceite");
  const [baseRef, setBaseRef] = useState(0);
  const [customerRef, setCustomerRef] = useState(0);
  const [odometer, setOdometer] = useState("");
  const [oilBrand, setOilBrand] = useState("");
  const [viscosity, setViscosity] = useState("");
  const [liters, setLiters] = useState("");
  const [filterCode, setFilterCode] = useState("");
  const [nextKm, setNextKm] = useState("5000");
  const [nextMonths, setNextMonths] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: r, error: re }] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id").eq("id", orderId).single(),
      supabase.rpc("get_current_rates"),
    ]);
    if (oe || re) return setError((oe || re)?.message ?? "No pude cargar la orden.");
    const ord = o as Order;
    if (ord.status !== "OPEN") return setError("Esta orden ya no está abierta.");
    if (!ord.vehicle_id) return setError("Asocia un vehículo antes de registrar el cambio de aceite.");
    setOrder(ord);
    const rateRow = Array.isArray(r) ? r[0] : r;
    setRates({ bcv: Number(rateRow?.bcv_rate ?? 0), operative: Number(rateRow?.operative_rate ?? 0) });
    const [{ data: v, error: ve }, { data: c, error: ce }] = await Promise.all([
      supabase.from("vehicles").select("id,plate,make,model,year,current_odometer").eq("id", ord.vehicle_id).single(),
      ord.customer_id ? supabase.from("customers").select("id,name,phone").eq("id", ord.customer_id).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
    ]);
    if (ve || ce) return setError((ve || ce)?.message ?? "No pude cargar el vehículo.");
    const vr = v as Vehicle;
    setVehicle(vr);
    setCustomer((c ?? null) as Customer | null);
    if (vr.current_odometer != null) setOdometer(String(vr.current_odometer));
  }
  useEffect(() => { if (orderId) load(); }, [orderId]);

  const priceVes = customerRef * rates.bcv;
  const nextOdometer = odometer && nextKm ? Number(odometer) + Number(nextKm) : null;

  async function save() {
    if (!order || !vehicle) return;
    if (!odometer) return setError("Ingresa el kilometraje actual.");
    setBusy(true); setError("");
    const { error } = await supabase.rpc("add_oil_change_item", {
      p_order_id: order.id,
      p_description: description.trim() || "Cambio de aceite",
      p_base_ref: Number(baseRef || 0),
      p_customer_ref: Number(customerRef || 0),
      p_odometer: Number(odometer),
      p_oil_brand: oilBrand.trim() || null,
      p_oil_viscosity: viscosity.trim() || null,
      p_oil_quantity_liters: liters ? Number(liters) : null,
      p_filter_code: filterCode.trim() || null,
      p_next_km_interval: nextKm ? Number(nextKm) : 0,
      p_next_months: nextMonths ? Number(nextMonths) : 0,
    });
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/orders/${order.id}`);
    router.refresh();
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">SERVICIO · ACEITE</div><h1>Cambio de aceite</h1><p>{order?.order_number ?? "Orden"} · {customer?.name || customer?.phone || "Cliente"} · {vehicle?.plate || `${vehicle?.make ?? ""} ${vehicle?.model ?? ""}`.trim()}</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className="card stack">
      <div className="row-between"><div><div className="muted small">VEHÍCULO</div><strong>{vehicle ? [vehicle.plate, vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · ") : "Cargando…"}</strong></div><button className="btn btn-ghost" onClick={() => router.push(`/orders/${orderId}`)}>Volver a orden</button></div>
      <label><span className="label">Kilometraje actual *</span><input className="input" type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="Ej. 84500" /></label>
    </section>

    <section className="card stack">
      <h2 className="section-title">Aceite y filtro</h2>
      <div className="grid grid-2">
        <label><span className="label">Marca de aceite</span><input className="input" value={oilBrand} onChange={e => setOilBrand(e.target.value)} placeholder="Ej. Valvoline" /></label>
        <label><span className="label">Viscosidad</span><input className="input" value={viscosity} onChange={e => setViscosity(e.target.value)} placeholder="Ej. 15W-40" /></label>
        <label><span className="label">Cantidad · litros</span><input className="input" type="number" min="0" step="0.1" value={liters} onChange={e => setLiters(e.target.value)} placeholder="Ej. 4.5" /></label>
        <label><span className="label">Filtro / código</span><input className="input" value={filterCode} onChange={e => setFilterCode(e.target.value)} placeholder="Ej. PH3593A" /></label>
      </div>
      <label><span className="label">Descripción</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label>
    </section>

    <section className="card stack">
      <h2 className="section-title">Precio del servicio</h2>
      <div className="muted small">Si la mano de obra está incluida en los productos, puedes dejar ambos montos en 0 y luego agregar aceite/filtro como productos en la orden.</div>
      <div className="grid grid-2">
        <label><span className="label">Base REF</span><input className="input" type="number" min="0" step="0.01" value={baseRef || ""} onChange={e => setBaseRef(Number(e.target.value))} /></label>
        <label><span className="label">Cobro al cliente REF</span><input className="input" type="number" min="0" step="0.01" value={customerRef || ""} onChange={e => setCustomerRef(Number(e.target.value))} /></label>
      </div>
      <div className="row-between"><span className="muted">Valor aproximado</span><div style={{ textAlign: "right" }}><strong>{fmtRef(customerRef)}</strong><div className="muted small">{fmtVes(priceVes)}</div></div></div>
    </section>

    <section className="card stack">
      <h2 className="section-title">Próximo mantenimiento</h2>
      <div className="grid grid-2">
        <label><span className="label">Intervalo km</span><input className="input" type="number" min="0" step="500" value={nextKm} onChange={e => setNextKm(e.target.value)} /></label>
        <label><span className="label">Intervalo meses</span><input className="input" type="number" min="0" max="24" value={nextMonths} onChange={e => setNextMonths(e.target.value)} /></label>
      </div>
      <div className="success">Próxima referencia: <strong>{nextOdometer != null ? `${nextOdometer.toLocaleString("es-VE")} km` : "sin km"}</strong>{nextMonths ? ` · ${nextMonths} meses` : ""}. El recordatorio se activa cuando integremos n8n.</div>
    </section>

    <button className="btn btn-primary btn-block" disabled={busy || !vehicle || !odometer} onClick={save}>{busy ? "Guardando…" : "Guardar cambio de aceite en la orden"}</button>
  </main>;
}

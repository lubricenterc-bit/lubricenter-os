"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Vehicle = {
  id: string;
  customer_id: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  engine: string | null;
  current_odometer: number | null;
};
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type ServiceRecord = {
  id: string;
  order_id: string;
  service_type: string;
  description: string;
  odometer: number | null;
  oil_brand: string | null;
  oil_viscosity: string | null;
  oil_quantity_liters: number | null;
  oil_filter_code: string | null;
  next_service_odometer: number | null;
  next_service_date: string | null;
  charged_ref_amount: number;
  charged_ves_amount: number;
  performed_at: string;
};
type Order = { id: string; order_number: string; status: string; total_ref: number; total_ves: number; opened_at: string; closed_at: string | null };

export default function VehiclePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const vehicleId = params.id;
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    const { data: v, error: ve } = await supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").eq("id", vehicleId).single();
    if (ve) return setError(ve.message);
    const vr = v as Vehicle;
    setVehicle(vr);
    setOdometer(vr.current_odometer != null ? String(vr.current_odometer) : "");

    const [{ data: c, error: ce }, { data: s, error: se }, { data: o, error: oe }] = await Promise.all([
      vr.customer_id ? supabase.from("customers").select("id,name,phone,document_id").eq("id", vr.customer_id).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
      supabase.from("service_records").select("id,order_id,service_type,description,odometer,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,next_service_odometer,next_service_date,charged_ref_amount,charged_ves_amount,performed_at").eq("vehicle_id", vehicleId).order("performed_at", { ascending: false }).limit(200),
      supabase.from("orders").select("id,order_number,status,total_ref,total_ves,opened_at,closed_at").eq("vehicle_id", vehicleId).order("opened_at", { ascending: false }).limit(100),
    ]);
    if (ce || se || oe) return setError((ce || se || oe)?.message ?? "No pude cargar el historial.");
    setCustomer((c ?? null) as Customer | null);
    setServices((s ?? []) as ServiceRecord[]);
    setOrders((o ?? []) as Order[]);
  }

  useEffect(() => { if (vehicleId) load(); }, [vehicleId]);

  const latestOil = useMemo(() => services.find(s => s.service_type === "OIL_CHANGE") ?? null, [services]);
  const nextDueKm = latestOil?.next_service_odometer ?? null;
  const nextDueDate = latestOil?.next_service_date ?? null;
  const kmRemaining = nextDueKm != null && vehicle?.current_odometer != null ? nextDueKm - vehicle.current_odometer : null;
  const overdueKm = kmRemaining != null && kmRemaining <= 0;
  const overdueDate = nextDueDate ? new Date(`${nextDueDate}T23:59:59`) < new Date() : false;

  async function updateOdometer() {
    if (!vehicle || !odometer) return;
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("upsert_vehicle", {
      p_customer_id: vehicle.customer_id,
      p_plate: vehicle.plate,
      p_make: vehicle.make,
      p_model: vehicle.model,
      p_year: vehicle.year,
      p_engine: vehicle.engine,
      p_current_odometer: Number(odometer),
    });
    setBusy(false);
    if (error) return setError(error.message);
    setNotice("Kilometraje actualizado.");
    await load();
  }

  async function startOrder() {
    if (!vehicle) return;
    setBusy(true); setError("");
    try {
      const { data, error } = await supabase.rpc("create_order");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const { error: pe } = await supabase.rpc("set_order_party", { p_order_id: row.id, p_customer_id: vehicle.customer_id, p_vehicle_id: vehicle.id });
      if (pe) throw pe;
      router.push(`/orders/${row.id}`);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  }

  if (!vehicle && !error) return <main className="container"><div className="card muted">Cargando ficha del vehículo…</div></main>;

  return <main className="container stack">
    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}
    {vehicle && <>
      <section className="brand-hero">
        <div>
          <div className="eyebrow">FICHA DEL VEHÍCULO</div>
          <h1>{vehicle.plate || `${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() || "Vehículo"}</h1>
          <p>{[vehicle.make, vehicle.model, vehicle.year, vehicle.engine ? `Motor ${vehicle.engine}` : null].filter(Boolean).join(" · ")}</p>
        </div>
        <img src="/lubricenter-logo.png" alt="Lubricenter" />
      </section>

      <section className="grid grid-2">
        <div className="card stack">
          <div className="muted small">CLIENTE</div>
          <strong>{customer?.name || customer?.phone || "Sin cliente asociado"}</strong>
          <div className="muted small">{[customer?.phone, customer?.document_id].filter(Boolean).join(" · ")}</div>
          {customer && <Link href="/customers" className="btn btn-ghost">Ver clientes</Link>}
        </div>
        <div className="card stack">
          <div className="muted small">KILOMETRAJE ACTUAL</div>
          <div className="kpi">{vehicle.current_odometer != null ? `${vehicle.current_odometer.toLocaleString("es-VE")} km` : "Sin km"}</div>
          <div className="row"><input className="input" type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="Kilometraje" /><button className="btn" disabled={busy || !odometer} onClick={updateOdometer}>Actualizar</button></div>
        </div>
      </section>

      <section className="card stack" style={{ borderColor: overdueKm || overdueDate ? "rgba(255,92,92,.5)" : latestOil ? "rgba(255,93,21,.4)" : undefined }}>
        <div className="row-between"><div><div className="muted small">PRÓXIMO CAMBIO DE ACEITE</div><h2 className="section-title" style={{ marginBottom: 0 }}>{latestOil ? (overdueKm || overdueDate ? "Mantenimiento pendiente" : "Seguimiento activo") : "Sin planificación todavía"}</h2></div>{latestOil && <span className={`pill ${overdueKm || overdueDate ? "" : "ok"}`}>{overdueKm || overdueDate ? "REVISAR" : "AL DÍA"}</span>}</div>
        {latestOil ? <div className="grid grid-2"><div><div className="muted small">POR KILOMETRAJE</div><strong>{nextDueKm != null ? `${nextDueKm.toLocaleString("es-VE")} km` : "No definido"}</strong>{kmRemaining != null && <div className="muted small">{kmRemaining > 0 ? `Faltan ${kmRemaining.toLocaleString("es-VE")} km` : `Pasado por ${Math.abs(kmRemaining).toLocaleString("es-VE")} km`}</div>}</div><div><div className="muted small">POR FECHA</div><strong>{nextDueDate ?? "No definida"}</strong></div></div> : <div className="muted">Al cerrar un cambio de aceite desde una orden, esta ficha conservará el historial y la próxima referencia de mantenimiento.</div>}
      </section>

      <button className="btn btn-primary btn-block" disabled={busy} onClick={startOrder}>{busy ? "Creando orden…" : "+ Nueva orden para este vehículo"}</button>

      <section className="card stack">
        <div className="row-between"><div><h2 className="section-title">Historial de servicio</h2><div className="muted small">{services.length} trabajos registrados desde Lubricenter OS</div></div></div>
        {services.map(s => <div className="order-item" key={s.id}>
          <div className="row-between"><div><strong>{serviceLabel(s.service_type)} · {s.description}</strong><div className="muted small">{fmtDate(s.performed_at)}{s.odometer != null ? ` · ${s.odometer.toLocaleString("es-VE")} km` : ""}</div></div><Link href={`/orders/${s.order_id}`} className="btn btn-ghost">Orden</Link></div>
          {s.service_type === "OIL_CHANGE" && (s.oil_brand || s.oil_viscosity || s.oil_quantity_liters || s.oil_filter_code) && <div className="muted small">{[s.oil_brand,s.oil_viscosity,s.oil_quantity_liters ? `${s.oil_quantity_liters} L` : null,s.oil_filter_code ? `Filtro ${s.oil_filter_code}` : null].filter(Boolean).join(" · ")}</div>}
          <div className="row-between"><span className="muted small">Cobrado</span><div style={{ textAlign: "right" }}><strong>{fmtRef(s.charged_ref_amount)}</strong><div className="muted small">{fmtVes(s.charged_ves_amount)}</div></div></div>
        </div>)}
        {!services.length && <div className="muted">Todavía no hay servicios cerrados para este vehículo.</div>}
      </section>

      <section className="card stack">
        <div className="row-between"><h2 className="section-title">Órdenes del vehículo</h2><span className="pill">{orders.length}</span></div>
        {orders.slice(0,20).map(o => <Link href={`/orders/${o.id}`} className="row-between order-item" key={o.id}><div><strong>{o.order_number}</strong><div className="muted small">{fmtDate(o.closed_at ?? o.opened_at)} · {o.status === "OPEN" ? "Abierta" : "Cerrada"}</div></div><div style={{ textAlign: "right" }}><strong>{fmtRef(o.total_ref)}</strong><div className="muted small">{fmtVes(o.total_ves)}</div></div></Link>)}
        {!orders.length && <div className="muted">No hay órdenes asociadas.</div>}
      </section>
    </>}
  </main>;
}

function serviceLabel(type: string) {
  return ({ OIL_CHANGE: "Cambio de aceite", WORKSHOP: "Taller", ELECTROAUTO: "Electroauto", OTHER: "Servicio" } as Record<string,string>)[type] ?? type;
}

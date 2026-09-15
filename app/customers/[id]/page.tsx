"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null; created_at: string };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null; customer_name?: string | null };
type Order = { id: string; order_number: string; status: string; total_ref: number; total_ves: number; opened_at: string; closed_at: string | null };
type Service = { id: string; vehicle_id: string; order_id: string | null; service_type: string; description: string; odometer: number | null; performed_at: string; charged_ref_amount: number };
type History = { id: string; vehicle_id: string; source_system: string; first_seen_at: string | null; last_seen_at: string | null };
type Tab = "RESUMEN" | "ORDENES" | "SERVICIOS" | "RELACIONES";

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [allVehicles, setAllVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [tab, setTab] = useState<Tab>("RESUMEN");
  const [vehicleSearch, setVehicleSearch] = useState("");
  const [candidates, setCandidates] = useState<Vehicle[]>([]);
  const [showEdit, setShowEdit] = useState(false);
  const [showNewVehicle, setShowNewVehicle] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [pendingVehicle, setPendingVehicle] = useState<Vehicle | null>(null);
  const [relationMode, setRelationMode] = useState<"ATTACH" | "UNLINK">("ATTACH");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    const [cr, vr, ar, or, sr, hr] = await Promise.all([
      supabase.from("customers").select("id,name,phone,document_id,created_at").eq("id", id).maybeSingle(),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").eq("customer_id", id).order("updated_at", { ascending: false }),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").order("updated_at", { ascending: false }).limit(500),
      supabase.from("orders").select("id,order_number,status,total_ref,total_ves,opened_at,closed_at").eq("customer_id", id).order("opened_at", { ascending: false }).limit(250),
      supabase.from("service_records").select("id,vehicle_id,order_id,service_type,description,odometer,performed_at,charged_ref_amount").eq("customer_id", id).order("performed_at", { ascending: false }).limit(250),
      supabase.from("vehicle_customer_history").select("id,vehicle_id,source_system,first_seen_at,last_seen_at").eq("customer_id", id).order("last_seen_at", { ascending: false }).limit(250),
    ]);
    const firstError = [cr.error, vr.error, ar.error, or.error, sr.error, hr.error].find(Boolean);
    if (firstError) return setError(firstError.message);
    if (!cr.data) return setError("Cliente no encontrado.");
    setCustomer(cr.data as Customer); setVehicles((vr.data ?? []) as Vehicle[]); setAllVehicles((ar.data ?? []) as Vehicle[]);
    setOrders((or.data ?? []) as Order[]); setServices((sr.data ?? []) as Service[]); setHistory((hr.data ?? []) as History[]);
  }

  useEffect(() => { if (id) load(); }, [id]);

  const vehicleById = useMemo(() => new Map(allVehicles.map(v => [v.id, v])), [allVehicles]);
  useEffect(() => {
    if (!vehicleSearch.trim()) { setCandidates([]); return; }
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc("search_vehicles_for_customer", { p_customer_id: id, p_query: vehicleSearch, p_limit: 12 });
      if (error) setError(error.message); else setCandidates((data ?? []) as Vehicle[]);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [vehicleSearch, id]);
  const totalRef = orders.reduce((sum, order) => sum + Number(order.total_ref), 0);

  async function editCustomer(form: FormData) {
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("update_customer_profile", { p_customer_id: id, p_name: textValue(form, "name"), p_phone: textValue(form, "phone"), p_document_id: textValue(form, "document") });
    setBusy(false); if (error) return setError(error.message);
    setShowEdit(false); setNotice("Datos del cliente actualizados y registrados en el historial."); await load();
  }

  async function createVehicle(form: FormData) {
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("create_customer_vehicle", { p_customer_id: id, p_plate: textValue(form, "plate"), p_make: textValue(form, "make"), p_model: textValue(form, "model"), p_year: numberValue(form, "year"), p_engine: textValue(form, "engine"), p_current_odometer: numberValue(form, "odometer") });
    setBusy(false); if (error) return setError(error.message);
    setShowNewVehicle(false); setNotice("Vehículo creado y asociado."); await load();
  }

  function requestRelation(vehicle: Vehicle, mode: "ATTACH" | "UNLINK") { setPendingVehicle(vehicle); setRelationMode(mode); }

  async function changeRelation(form: FormData) {
    if (!pendingVehicle) return;
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("reassign_vehicle_customer", { p_vehicle_id: pendingVehicle.id, p_customer_id: relationMode === "ATTACH" ? id : null, p_reason: textValue(form, "reason") });
    setBusy(false); if (error) return setError(error.message);
    setPendingVehicle(null); setShowAttach(false); setVehicleSearch("");
    setNotice(relationMode === "ATTACH" ? "Vehículo asociado. El dueño anterior y el motivo quedaron en el historial." : "Vehículo desvinculado. Sus órdenes y servicios anteriores se conservaron.");
    await load();
  }

  async function startOrder(vehicle?: Vehicle) {
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("create_order");
    if (error) { setBusy(false); return setError(error.message); }
    const row = Array.isArray(data) ? data[0] : data;
    const { error: partyError } = await supabase.rpc("set_order_party", { p_order_id: row.id, p_customer_id: id, p_vehicle_id: vehicle?.id ?? null });
    if (partyError) { setBusy(false); return setError(partyError.message); }
    router.push(`/orders/${row.id}`);
  }

  if (!customer && !error) return <main className="container"><div className="card muted">Cargando ficha maestra…</div></main>;

  return <main className="container stack">
    {error && <div className="error">{error}</div>}{notice && <div className="success">{notice}</div>}
    {customer && <>
      <section className="brand-hero"><div><div className="eyebrow">CRM · FICHA MAESTRA</div><h1>{customer.name || "Cliente sin nombre"}</h1><p>{[customer.phone, customer.document_id].filter(Boolean).join(" · ") || "Sin datos de contacto"}</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>

      <div className="row crm-action-bar"><Link href="/customers" className="btn btn-ghost">← Clientes</Link><button className="btn" onClick={() => setShowEdit(true)}>Editar datos</button><button className="btn btn-primary" disabled={busy} onClick={() => startOrder()}>+ Nueva orden</button></div>

      <section className="grid grid-3"><div className="card"><div className="muted small">VEHÍCULOS ACTUALES</div><div className="kpi">{vehicles.length}</div></div><div className="card"><div className="muted small">VISITAS</div><div className="kpi">{orders.length}</div></div><div className="card"><div className="muted small">TOTAL REGISTRADO</div><div className="kpi">{fmtRef(totalRef)}</div></div></section>

      <section className="card crm-tabs">{(["RESUMEN","ORDENES","SERVICIOS","RELACIONES"] as Tab[]).map(value => <button key={value} className={`btn ${tab === value ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(value)}>{({ RESUMEN: "Resumen", ORDENES: "Órdenes", SERVICIOS: "Servicios", RELACIONES: "Historial de carros" } as Record<Tab,string>)[value]}</button>)}</section>

      {tab === "RESUMEN" && <>
        <section className="card stack"><div className="row-between"><div><h2 className="section-title">Vehículos asociados</h2><div className="muted small">Administra el vínculo actual sin borrar el historial.</div></div><div className="row"><button className="btn btn-ghost" onClick={() => setShowAttach(true)}>Asociar existente</button><button className="btn btn-primary" onClick={() => setShowNewVehicle(true)}>+ Nuevo vehículo</button></div></div>
          <div className="grid grid-2">{vehicles.map(v => <article className="card stack" key={v.id}><div className="row-between"><div><strong>{v.plate || "SIN PLACA"}</strong><div className="muted small">{vehicleLabel(v)}</div></div><span className="pill ok">ASOCIADO</span></div><div className="muted small">{v.current_odometer != null ? `${v.current_odometer.toLocaleString("es-VE")} km` : "Sin kilometraje"}</div><div className="row"><Link href={`/vehicles/${v.id}`} className="btn btn-ghost">Ver carro</Link><button className="btn btn-danger" onClick={() => requestRelation(v, "UNLINK")}>Desvincular</button><button className="btn" disabled={busy} onClick={() => startOrder(v)}>Nueva orden</button></div></article>)}</div>
          {!vehicles.length && <div className="muted">Este cliente no tiene vehículos asociados actualmente.</div>}
        </section>
        <section className="card stack"><div className="row-between"><h2 className="section-title">Actividad reciente</h2><button className="btn btn-ghost" onClick={() => setTab("ORDENES")}>Ver todas</button></div>{orders.slice(0, 5).map(o => <OrderRow key={o.id} order={o} />)}{!orders.length && <div className="muted">No hay visitas registradas.</div>}</section>
      </>}

      {tab === "ORDENES" && <section className="card stack"><div><h2 className="section-title">Órdenes y ventas</h2><div className="muted small">Historial completo asociado a este cliente.</div></div>{orders.map(o => <OrderRow key={o.id} order={o} />)}{!orders.length && <div className="muted">No hay órdenes asociadas.</div>}</section>}

      {tab === "SERVICIOS" && <section className="card stack"><div><h2 className="section-title">Servicios realizados</h2><div className="muted small">Incluye trabajos actuales e historial importado.</div></div>{services.map(s => { const v = vehicleById.get(s.vehicle_id); return <div className="order-item" key={s.id}><div className="row-between"><div><strong>{serviceLabel(s.service_type)} · {s.description}</strong><div className="muted small">{fmtDate(s.performed_at)}{v ? ` · ${v.plate || vehicleLabel(v)}` : ""}{s.odometer != null ? ` · ${s.odometer.toLocaleString("es-VE")} km` : ""}</div></div>{s.order_id ? <Link className="btn btn-ghost" href={`/orders/${s.order_id}`}>Orden</Link> : <span className="pill">HISTÓRICO</span>}</div></div>})}{!services.length && <div className="muted">No hay servicios registrados.</div>}</section>}

      {tab === "RELACIONES" && <section className="card stack"><div><h2 className="section-title">Historial de vehículos</h2><div className="muted small">Muestra carros actuales y anteriores. Las órdenes nunca se borran al cambiar un vínculo.</div></div>{history.map(h => { const v = vehicleById.get(h.vehicle_id); const current = v?.customer_id === id; return <div className="order-item row-between" key={h.id}><div><strong>{v?.plate || "Vehículo"}</strong><div className="muted small">{v ? vehicleLabel(v) : "Registro histórico"} · Desde {h.first_seen_at ? fmtDate(h.first_seen_at) : "fecha desconocida"} · Último registro {h.last_seen_at ? fmtDate(h.last_seen_at) : "sin fecha"}</div></div><span className={`pill ${current ? "ok" : ""}`}>{current ? "ACTUAL" : "ANTERIOR"}</span></div>})}{!history.length && <div className="muted">No hay cambios de relación registrados todavía.</div>}</section>}

      {showEdit && <div className="overlay"><form className="sheet stack" action={editCustomer}><div className="row-between"><h2 style={{ margin: 0 }}>Editar cliente</h2><button type="button" className="btn btn-ghost" onClick={() => setShowEdit(false)}>Cerrar</button></div><label><span className="label">Nombre</span><input name="name" className="input" defaultValue={customer.name ?? ""} autoFocus /></label><div className="grid grid-2"><label><span className="label">Teléfono</span><input name="phone" className="input" defaultValue={customer.phone ?? ""} /></label><label><span className="label">Cédula / RIF</span><input name="document" className="input" defaultValue={customer.document_id ?? ""} /></label></div><button className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Guardar cambios"}</button></form></div>}

      {showNewVehicle && <div className="overlay"><form className="sheet stack" action={createVehicle}><div className="row-between"><div><h2 style={{ margin: 0 }}>Nuevo vehículo</h2><div className="muted small">Quedará asociado a {customer.name || "este cliente"}.</div></div><button type="button" className="btn btn-ghost" onClick={() => setShowNewVehicle(false)}>Cerrar</button></div><div className="grid grid-2"><label><span className="label">Placa</span><input name="plate" className="input" autoFocus /></label><label><span className="label">Marca</span><input name="make" className="input" /></label><label><span className="label">Modelo</span><input name="model" className="input" /></label><label><span className="label">Año</span><input name="year" type="number" className="input" /></label><label><span className="label">Motor</span><input name="engine" className="input" /></label><label><span className="label">Kilometraje</span><input name="odometer" type="number" min="0" className="input" /></label></div><button className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Crear y asociar"}</button></form></div>}

      {showAttach && <div className="overlay"><div className="sheet stack"><div className="row-between"><div><h2 style={{ margin: 0 }}>Asociar vehículo existente</h2><div className="muted small">Busca por placa, marca, modelo o dueño actual.</div></div><button className="btn btn-ghost" onClick={() => { setShowAttach(false); setVehicleSearch(""); }}>Cerrar</button></div><input className="input" value={vehicleSearch} onChange={e => setVehicleSearch(e.target.value)} placeholder="Ej.: AB123CD, Toyota, Corolla…" autoFocus /><div className="directory-list stack">{candidates.map(v => <button className="directory-option" key={v.id} onClick={() => requestRelation(v, "ATTACH")}><strong>{v.plate || "SIN PLACA"}</strong><span>{vehicleLabel(v)} · {v.customer_id ? `Dueño actual: ${v.customer_name || "otro cliente"}` : "Sin cliente"}</span></button>)}{vehicleSearch && !candidates.length && <div className="muted">No encontramos otro vehículo con esa búsqueda.</div>}{!vehicleSearch && <div className="muted">Escribe al menos una parte de la placa, marca o modelo.</div>}</div></div></div>}

      {pendingVehicle && <div className="overlay"><form className="sheet stack" action={changeRelation}><div><div className="eyebrow">CAMBIO CON HISTORIAL</div><h2>{relationMode === "ATTACH" ? "Asociar vehículo" : "Desvincular vehículo"}</h2><p className="muted">{pendingVehicle.plate || vehicleLabel(pendingVehicle)}. Las órdenes y servicios anteriores se conservarán.</p></div><label><span className="label">Motivo del cambio</span><textarea name="reason" className="textarea" required minLength={3} placeholder={relationMode === "ATTACH" ? "Ej.: compra del vehículo, corrección del cliente…" : "Ej.: venta del vehículo, registro duplicado…"} autoFocus /></label><div className="grid grid-2"><button type="button" className="btn btn-ghost" onClick={() => setPendingVehicle(null)}>Cancelar</button><button className={relationMode === "UNLINK" ? "btn btn-danger" : "btn btn-primary"} disabled={busy}>{busy ? "Guardando…" : relationMode === "ATTACH" ? "Confirmar asociación" : "Confirmar desvinculación"}</button></div></form></div>}
    </>}
  </main>;
}

function textValue(form: FormData, name: string) { return String(form.get(name) || "").trim() || null; }
function numberValue(form: FormData, name: string) { const value = form.get(name); return value ? Number(value) : null; }
function vehicleLabel(v: Vehicle) { return [v.make, v.model, v.year, v.engine ? `Motor ${v.engine}` : null].filter(Boolean).join(" · ") || "Sin detalles"; }
function serviceLabel(type: string) { return ({ OIL_CHANGE: "Cambio de aceite", WORKSHOP: "Taller", ELECTROAUTO: "Electroauto", OTHER: "Servicio" } as Record<string,string>)[type] ?? type; }
function OrderRow({ order }: { order: Order }) { return <Link href={`/orders/${order.id}`} className="order-item row-between"><div><strong>{order.order_number}</strong><div className="muted small">{fmtDate(order.closed_at ?? order.opened_at)} · {order.status === "OPEN" ? "Abierta" : order.status === "CANCELLED" ? "Anulada" : "Cerrada"}</div></div><div style={{ textAlign: "right" }}><strong>{fmtRef(order.total_ref)}</strong><div className="muted small">{fmtVes(order.total_ves)}</div></div></Link>; }


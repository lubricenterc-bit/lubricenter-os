"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Order = { id: string; order_number: string; status: string; customer_id: string | null; vehicle_id: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null; year: number | null; current_odometer: number | null };
type Customer = { id: string; name: string | null; phone: string | null };
type Rates = { bcv: number; operative: number };
type PricingSync = { catalogSyncedAt: string | null; bcvEffectiveAt: string | null; operativeEffectiveAt: string | null };
type InventoryItem = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  quantity_on_hand: number;
  product_id: string | null;
  catalog_product_name: string | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  needs_review: boolean;
};

function syncLabel(value: string | null) {
  if (!value) return "sin sincronizar";
  return new Date(value).toLocaleString("es-VE", { timeZone: "America/Caracas", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OilChangePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = params.id;
  const [order, setOrder] = useState<Order | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [sync, setSync] = useState<PricingSync>({ catalogSyncedAt: null, bcvEffectiveAt: null, operativeEffectiveAt: null });
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [description, setDescription] = useState("Cambio de aceite");
  const [serviceBaseRef, setServiceBaseRef] = useState(0);
  const [serviceCustomerRef, setServiceCustomerRef] = useState(0);
  const [odometer, setOdometer] = useState("");
  const [oilId, setOilId] = useState("");
  const [oilSearch, setOilSearch] = useState("");
  const [oilUnits, setOilUnits] = useState("1");
  const [oilManualRef, setOilManualRef] = useState("");
  const [viscosity, setViscosity] = useState("");
  const [liters, setLiters] = useState("");
  const [filterId, setFilterId] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterUnits, setFilterUnits] = useState("1");
  const [filterManualRef, setFilterManualRef] = useState("");
  const [nextKm, setNextKm] = useState("5000");
  const [nextMonths, setNextMonths] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: r, error: re }, { data: inv, error: ie }, { data: ps, error: pe }] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id").eq("id", orderId).single(),
      supabase.rpc("get_current_rates"),
      supabase.from("inventory_current").select("id,sku,brand,description,category,quantity_on_hand,product_id,catalog_product_name,current_price_ves,current_ref_bcv,needs_review").eq("location_code", "CABUDARE").gt("quantity_on_hand", 0).order("brand").order("sku").limit(1000),
      supabase.rpc("get_pricing_sync_status"),
    ]);
    if (oe || re || ie || pe) return setError((oe || re || ie || pe)?.message ?? "No pude cargar la orden.");
    const ord = o as Order;
    if (ord.status !== "OPEN") return setError("Esta orden ya no está abierta.");
    if (!ord.vehicle_id) return setError("Asocia un vehículo antes de registrar el cambio de aceite.");
    setOrder(ord);
    const rateRow = Array.isArray(r) ? r[0] : r;
    setRates({ bcv: Number(rateRow?.bcv_rate ?? 0), operative: Number(rateRow?.operative_rate ?? 0) });
    const syncRow = Array.isArray(ps) ? ps[0] : ps;
    setSync({ catalogSyncedAt: syncRow?.catalog_synced_at ?? null, bcvEffectiveAt: syncRow?.bcv_effective_at ?? null, operativeEffectiveAt: syncRow?.operative_effective_at ?? null });
    setInventory((inv ?? []).map((x: any) => ({ ...x, quantity_on_hand: Number(x.quantity_on_hand ?? 0), current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves), current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv) })) as InventoryItem[]);
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

  const oils = useMemo(() => inventory.filter(i => ["Aceite Motor", "Aceite Motos"].includes(i.category ?? "") && !i.needs_review), [inventory]);
  const filters = useMemo(() => inventory.filter(i => i.category === "Filtro Aceite" && !i.needs_review), [inventory]);
  const visibleOils = useMemo(() => {
    const q = oilSearch.trim().toLowerCase();
    return q ? oils.filter(i => `${i.sku} ${i.brand ?? ""} ${i.description}`.toLowerCase().includes(q)) : oils;
  }, [oils, oilSearch]);
  const visibleFilters = useMemo(() => {
    const q = filterSearch.trim().toLowerCase();
    return q ? filters.filter(i => `${i.sku} ${i.brand ?? ""} ${i.description}`.toLowerCase().includes(q)) : filters;
  }, [filters, filterSearch]);
  const oil = inventory.find(i => i.id === oilId) ?? null;
  const filter = inventory.find(i => i.id === filterId) ?? null;
  const oilUnitRef = oil?.current_ref_bcv ?? (oilManualRef ? Number(oilManualRef) : 0);
  const filterUnitRef = filter?.current_ref_bcv ?? (filterManualRef ? Number(filterManualRef) : 0);
  const productRef = oilUnitRef * Number(oilUnits || 0) + (filter ? filterUnitRef * Number(filterUnits || 0) : 0);
  const totalPreviewRef = productRef + Number(serviceCustomerRef || 0);
  const nextOdometer = odometer && nextKm ? Number(odometer) + Number(nextKm) : null;
  const catalogAge = sync.catalogSyncedAt ? (Date.now() - new Date(sync.catalogSyncedAt).getTime()) / 3600000 : Infinity;
  const rateTimes = [sync.bcvEffectiveAt, sync.operativeEffectiveAt].filter(Boolean) as string[];
  const rateAge = rateTimes.length ? Math.max(...rateTimes.map(v => (Date.now() - new Date(v).getTime()) / 3600000)) : Infinity;
  const pricingFresh = catalogAge <= 24 && rateAge <= 3;

  function chooseOil(id: string) {
    setOilId(id);
    setOilManualRef("");
    const selected = inventory.find(i => i.id === id);
    if (selected) setViscosity(extractViscosity(selected.description));
  }

  function chooseFilter(id: string) {
    setFilterId(id);
    setFilterManualRef("");
  }

  async function save() {
    if (!order || !vehicle) return;
    if (!odometer) return setError("Ingresa el kilometraje actual.");
    if (!oil) return setError("Selecciona el aceite utilizado.");
    if (!pricingFresh && (oil.current_ref_bcv != null || filter?.current_ref_bcv != null)) return setError("Los precios automáticos de Notion están desactualizados. Espera la sincronización antes de cobrar con precio de catálogo.");
    if (Number(oilUnits) <= 0 || Number(oilUnits) > oil.quantity_on_hand) return setError(`Existencia insuficiente de ${oil.sku}.`);
    if (oil.current_ref_bcv == null && Number(oilManualRef) <= 0) return setError("Este aceite no tiene precio vinculado. Ingresa el precio unitario REF.");
    if (filter && (Number(filterUnits) <= 0 || Number(filterUnits) > filter.quantity_on_hand)) return setError(`Existencia insuficiente de ${filter.sku}.`);
    if (filter && filter.current_ref_bcv == null && Number(filterManualRef) <= 0) return setError("Este filtro no tiene precio vinculado. Ingresa el precio unitario REF.");

    setBusy(true); setError("");
    const { error } = await supabase.rpc("add_oil_change_package", {
      p_order_id: order.id,
      p_odometer: Number(odometer),
      p_description: description.trim() || "Cambio de aceite",
      p_service_base_ref: Number(serviceBaseRef || 0),
      p_service_customer_ref: Number(serviceCustomerRef || 0),
      p_oil_inventory_item_id: oil.id,
      p_oil_units: Number(oilUnits),
      p_oil_manual_unit_ref: oil.current_ref_bcv == null ? Number(oilManualRef) : null,
      p_oil_viscosity: viscosity.trim() || null,
      p_oil_quantity_liters: liters ? Number(liters) : null,
      p_filter_inventory_item_id: filter?.id ?? null,
      p_filter_units: filter ? Number(filterUnits) : 1,
      p_filter_manual_unit_ref: filter && filter.current_ref_bcv == null ? Number(filterManualRef) : null,
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
      <div><div className="eyebrow">SERVICIO · ACEITE · INVENTARIO</div><h1>Cambio de aceite</h1><p>{order?.order_number ?? "Orden"} · {customer?.name || customer?.phone || "Cliente"} · {vehicle?.plate || `${vehicle?.make ?? ""} ${vehicle?.model ?? ""}`.trim()}</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className={`card ${pricingFresh ? "success" : "error"}`}>
      <div className="row-between"><div><strong>Precios desde Notion</strong><div className="small">Catálogo {syncLabel(sync.catalogSyncedAt)} · tasas {syncLabel(sync.operativeEffectiveAt)}</div></div><span className={`pill ${pricingFresh ? "ok" : "warn"}`}>{pricingFresh ? "VIGENTE" : "DESACTUALIZADO"}</span></div>
    </section>

    <section className="card stack">
      <div className="row-between"><div><div className="muted small">VEHÍCULO</div><strong>{vehicle ? [vehicle.plate, vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · ") : "Cargando…"}</strong></div><button className="btn btn-ghost" onClick={() => router.push(`/orders/${orderId}`)}>Volver a orden</button></div>
      <label><span className="label">Kilometraje actual *</span><input className="input" type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="Ej. 84500" /></label>
    </section>

    <section className="card stack">
      <div><h2 className="section-title">1. Aceite del inventario</h2><div className="muted small">{oils.length} referencias de aceite con existencia disponible.</div></div>
      <input className="input" value={oilSearch} onChange={e => setOilSearch(e.target.value)} placeholder="Buscar aceite por marca, viscosidad o SKU…" />
      <select className="input" value={oilId} onChange={e => chooseOil(e.target.value)}>
        <option value="">Selecciona el aceite usado</option>
        {visibleOils.map(i => <option key={i.id} value={i.id}>{i.brand} · {i.description} · stock {i.quantity_on_hand}</option>)}
      </select>
      {oil && <div className="success">
        <div className="row-between"><div><strong>{oil.sku} · {oil.brand}</strong><div className="small">Disponible: {oil.quantity_on_hand}</div></div><div style={{ textAlign: "right" }}>{oil.current_ref_bcv != null ? <><strong>{fmtRef(oil.current_ref_bcv)}</strong><div className="small">{fmtVes(oil.current_price_ves ?? 0)} c/u · Notion</div></> : <strong>Precio manual</strong>}</div></div>
      </div>}
      <div className="grid grid-2">
        <label><span className="label">Unidades usadas *</span><input className="input" type="number" min="0.01" step="0.01" value={oilUnits} onChange={e => setOilUnits(e.target.value)} /></label>
        <label><span className="label">Litros reales en el motor</span><input className="input" type="number" min="0" step="0.1" value={liters} onChange={e => setLiters(e.target.value)} placeholder="Ej. 4.5" /></label>
        <label><span className="label">Viscosidad</span><input className="input" value={viscosity} onChange={e => setViscosity(e.target.value)} placeholder="Ej. 15W-40" /></label>
        {oil && oil.current_ref_bcv == null && <label><span className="label">Precio unitario REF *</span><input className="input" type="number" min="0" step="0.01" value={oilManualRef} onChange={e => setOilManualRef(e.target.value)} placeholder="Precio al cliente" /></label>}
      </div>
    </section>

    <section className="card stack">
      <div><h2 className="section-title">2. Filtro de aceite</h2><div className="muted small">Opcional. {filters.length} referencias con existencia.</div></div>
      <input className="input" value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder="Buscar código o marca del filtro…" />
      <select className="input" value={filterId} onChange={e => chooseFilter(e.target.value)}>
        <option value="">Sin filtro / cliente trae filtro</option>
        {visibleFilters.map(i => <option key={i.id} value={i.id}>{i.sku} · {i.brand} · stock {i.quantity_on_hand}</option>)}
      </select>
      {filter && <div className="success"><div className="row-between"><div><strong>{filter.sku} · {filter.brand}</strong><div className="small">{filter.description} · disponible {filter.quantity_on_hand}</div></div><div style={{ textAlign: "right" }}>{filter.current_ref_bcv != null ? <><strong>{fmtRef(filter.current_ref_bcv)}</strong><div className="small">{fmtVes(filter.current_price_ves ?? 0)} c/u · Notion</div></> : <strong>Precio manual</strong>}</div></div></div>}
      {filter && <div className="grid grid-2">
        <label><span className="label">Cantidad</span><input className="input" type="number" min="0.01" step="0.01" value={filterUnits} onChange={e => setFilterUnits(e.target.value)} /></label>
        {filter.current_ref_bcv == null && <label><span className="label">Precio unitario REF *</span><input className="input" type="number" min="0" step="0.01" value={filterManualRef} onChange={e => setFilterManualRef(e.target.value)} placeholder="Precio al cliente" /></label>}
      </div>}
    </section>

    <section className="card stack">
      <h2 className="section-title">3. Servicio y próximo mantenimiento</h2>
      <label><span className="label">Descripción</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="grid grid-2">
        <label><span className="label">Mano de obra base REF</span><input className="input" type="number" min="0" step="0.01" value={serviceBaseRef || ""} onChange={e => setServiceBaseRef(Number(e.target.value))} placeholder="0 si está incluida" /></label>
        <label><span className="label">Mano de obra cobrada REF</span><input className="input" type="number" min="0" step="0.01" value={serviceCustomerRef || ""} onChange={e => setServiceCustomerRef(Number(e.target.value))} placeholder="0 si está incluida" /></label>
        <label><span className="label">Próximo cambio · km</span><input className="input" type="number" min="0" step="500" value={nextKm} onChange={e => setNextKm(e.target.value)} /></label>
        <label><span className="label">Próximo cambio · meses</span><input className="input" type="number" min="0" max="24" value={nextMonths} onChange={e => setNextMonths(e.target.value)} /></label>
      </div>
      <div className="row-between"><span className="muted">Total agregado a la orden</span><div style={{ textAlign: "right" }}><strong>{fmtRef(totalPreviewRef)}</strong><div className="muted small">{fmtVes(totalPreviewRef * rates.bcv)}</div></div></div>
      <div className="muted small">Próxima referencia: {nextOdometer != null ? `${nextOdometer.toLocaleString("es-VE")} km` : "sin km"}{nextMonths ? ` · ${nextMonths} meses` : ""}.</div>
    </section>

    <button className="btn btn-primary btn-block" disabled={busy || !vehicle || !odometer || !oil} onClick={save}>{busy ? "Agregando inventario y servicio…" : "Agregar cambio de aceite a la orden"}</button>
    <div className="muted small" style={{ textAlign: "center" }}>El stock se descuenta al cerrar la orden. Si otra orden consumió la última unidad antes, el cierre se bloqueará para evitar inventario negativo.</div>
  </main>;
}

function extractViscosity(text: string) {
  const match = text.toUpperCase().match(/\b(?:0W[- ]?20|5W[- ]?20|5W[- ]?30|5W[- ]?40|10W[- ]?30|10W[- ]?40|15W[- ]?40|20W[- ]?50|25W[- ]?60|SAE\s?50)\b/);
  return match ? match[0].replace(" ", "-").replace(/^(\d+W)-(\d+)$/, "$1-$2") : "";
}

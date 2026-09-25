"use client";
import { matchesSearch } from "@/lib/domain/search";
import { isOilCandidate, isOilFilter, saleSource } from "@/lib/domain/oil-change";

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
  source: "INVENTORY" | "CATALOG" | "MANUAL";
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
  return new Date(value).toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractViscosity(value: string) {
  return value.match(/\b\d{1,2}\s*W\s*[-/]?\s*\d{2}\b/i)?.[0]?.replace(/\s+/g, "").replace("/", "-") ?? "";
}

function manualItem(id: string, name: string, category: string): InventoryItem {
  return { id, source: "MANUAL", sku: "MANUAL", brand: name.trim(), description: name.trim(), category,
    quantity_on_hand: 0, product_id: null, catalog_product_name: null, current_price_ves: null,
    current_ref_bcv: null, needs_review: false };
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
  const [loading, setLoading] = useState(true);

  const [description, setDescription] = useState("Cambio de aceite");
  const [serviceBaseRef, setServiceBaseRef] = useState("0");
  const [serviceCustomerRef, setServiceCustomerRef] = useState("0");
  const [odometer, setOdometer] = useState("");

  const [oilId, setOilId] = useState("");
  const [oilSearch, setOilSearch] = useState("");
  const [oilUnits, setOilUnits] = useState("1");
  const [oilPriceRef, setOilPriceRef] = useState("");
  const [manualOilName, setManualOilName] = useState("");
  const [viscosity, setViscosity] = useState("");
  const [liters, setLiters] = useState("");

  const [filterId, setFilterId] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterUnits, setFilterUnits] = useState("1");
  const [filterPriceRef, setFilterPriceRef] = useState("");
  const [manualFilterName, setManualFilterName] = useState("");

  const [nextKm, setNextKm] = useState("5000");
  const [nextMonths, setNextMonths] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const catalogAge = sync.catalogSyncedAt ? (Date.now() - new Date(sync.catalogSyncedAt).getTime()) / 3600000 : Infinity;
  const rateTimes = [sync.bcvEffectiveAt, sync.operativeEffectiveAt].filter(Boolean) as string[];
  const rateAge = rateTimes.length ? Math.max(...rateTimes.map(v => (Date.now() - new Date(v).getTime()) / 3600000)) : Infinity;
  const pricingFresh = catalogAge <= 24 && rateAge <= 3;

  async function load() {
    setLoading(true);
    setError("");
    setWarning("");
    const [orderRes, ratesRes, invRes, catalogRes, syncRes] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id").eq("id", orderId).single(),
      supabase.rpc("get_current_rates"),
      supabase.from("inventory_current").select("id,sku,brand,description,category,quantity_on_hand,product_id,catalog_product_name,current_price_ves,current_ref_bcv,needs_review").eq("location_code", "CABUDARE").order("sku").limit(1000),
      supabase.from("product_catalog_current").select("id,name,category,filter_code,current_price_ves,current_ref_bcv").eq("available", true).eq("active", true).order("name").limit(1000),
      supabase.rpc("get_pricing_sync_status"),
    ]);

    if (orderRes.error || ratesRes.error) {
      setError((orderRes.error || ratesRes.error)?.message ?? "No pude cargar el cambio de aceite.");
      setLoading(false);
      return;
    }
    if (invRes.error || catalogRes.error || syncRes.error) setWarning("No cargó alguna fuente de precios o productos. Puedes registrar el aceite usado manualmente y continuar; revisa el precio antes de guardar.");

    const ord = orderRes.data as Order;
    if (ord.status !== "OPEN") {
      setError("Esta orden ya no está abierta.");
      setLoading(false);
      return;
    }
    if (!ord.vehicle_id) {
      setError("Asocia un vehículo antes de registrar el cambio de aceite.");
      setLoading(false);
      return;
    }

    setOrder(ord);
    const rateRow = Array.isArray(ratesRes.data) ? ratesRes.data[0] : ratesRes.data;
    setRates({ bcv: Number(rateRow?.bcv_rate ?? 0), operative: Number(rateRow?.operative_rate ?? 0) });

    const syncRow = Array.isArray(syncRes.data) ? syncRes.data[0] : syncRes.data;
    setSync({
      catalogSyncedAt: syncRow?.catalog_synced_at ?? null,
      bcvEffectiveAt: syncRow?.bcv_effective_at ?? null,
      operativeEffectiveAt: syncRow?.operative_effective_at ?? null,
    });

    const stockItems = (invRes.data ?? []).map((x: any) => ({
      ...x,
      source: "INVENTORY" as const,
      quantity_on_hand: Number(x.quantity_on_hand ?? 0),
      current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves),
      current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv),
    }));
    const catalogItems = (catalogRes.data ?? []).map((x: any) => ({
      id: `catalog:${x.id}`,
      source: "CATALOG" as const,
      sku: x.filter_code || "CATÁLOGO",
      brand: x.name,
      description: x.name,
      category: x.category,
      quantity_on_hand: 0,
      product_id: x.id,
      catalog_product_name: x.name,
      current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves),
      current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv),
      needs_review: false,
    }));
    setInventory([...stockItems, ...catalogItems] as InventoryItem[]);

    const [vehicleRes, customerRes] = await Promise.all([
      supabase.from("vehicles").select("id,plate,make,model,year,current_odometer").eq("id", ord.vehicle_id).single(),
      ord.customer_id ? supabase.from("customers").select("id,name,phone").eq("id", ord.customer_id).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
    ]);

    if (vehicleRes.error || customerRes.error) {
      setError((vehicleRes.error || customerRes.error)?.message ?? "No pude cargar el vehículo.");
      setLoading(false);
      return;
    }

    const vr = vehicleRes.data as Vehicle;
    setVehicle(vr);
    setCustomer((customerRes.data ?? null) as Customer | null);
    if (vr.current_odometer != null) setOdometer(String(vr.current_odometer));
    setLoading(false);
  }

  useEffect(() => { if (orderId) load(); }, [orderId]);

  const oils = useMemo(() => inventory.filter(i => isOilCandidate(i) && !i.needs_review), [inventory]);
  const filters = useMemo(() => inventory.filter(i => isOilFilter(i) && !i.needs_review), [inventory]);
  const availableCatalogIds = useMemo(() => new Set(inventory.filter(i => i.source === "CATALOG").map(i => i.product_id).filter((id): id is string => !!id)), [inventory]);

  const visibleOils = useMemo(() => {
    const q = oilSearch.trim().toLowerCase();
    return q ? inventory.filter(i => !i.needs_review && !isOilFilter(i) && matchesSearch(`${i.sku} ${i.brand ?? ""} ${i.description} ${i.catalog_product_name ?? ""} ${i.category ?? ""}`, q)) : oils;
  }, [inventory, oils, oilSearch]);

  const visibleFilters = useMemo(() => {
    const q = filterSearch.trim().toLowerCase();
    return q ? filters.filter(i => matchesSearch(`${i.sku} ${i.brand ?? ""} ${i.description} ${i.catalog_product_name ?? ""}`, q)) : filters;
  }, [filters, filterSearch]);

  const oil = oilId === "manual:oil" ? manualItem(oilId, manualOilName, "Aceite manual") : inventory.find(i => i.id === oilId) ?? null;
  const filter = filterId === "manual:filter" ? manualItem(filterId, manualFilterName, "Filtro manual") : inventory.find(i => i.id === filterId) ?? null;
  const oilSaleSource = oil ? saleSource(oil, Number(oilUnits), availableCatalogIds) : null;
  const filterSaleSource = filter ? saleSource(filter, Number(filterUnits), availableCatalogIds) : "NONE";
  const oilUnitRef = Number(oilPriceRef || 0);
  const filterUnitRef = filter ? Number(filterPriceRef || 0) : 0;
  const productRef = oilUnitRef * Number(oilUnits || 0) + filterUnitRef * Number(filterUnits || 0);
  const totalPreviewRef = productRef + Number(serviceCustomerRef || 0);
  const nextOdometer = odometer && nextKm ? Number(odometer) + Number(nextKm) : null;

  function chooseOil(id: string) {
    setOilId(id);
    const selected = id === "manual:oil" ? manualItem(id, manualOilName || oilSearch, "Aceite manual") : inventory.find(i => i.id === id);
    setOilPriceRef(selected?.current_ref_bcv != null && pricingFresh ? selected.current_ref_bcv.toFixed(2) : "");
    if (selected) setViscosity(extractViscosity(`${selected.description} ${selected.catalog_product_name ?? ""}`));
  }

  function chooseFilter(id: string) {
    setFilterId(id);
    const selected = id === "manual:filter" ? manualItem(id, manualFilterName || filterSearch, "Filtro manual") : inventory.find(i => i.id === id);
    setFilterPriceRef(selected?.current_ref_bcv != null && pricingFresh ? selected.current_ref_bcv.toFixed(2) : "");
  }

  async function save() {
    if (busy || !order || !vehicle) return;
    if (!odometer || !Number.isInteger(Number(odometer)) || Number(odometer) < 0) return setError("Ingresa un kilometraje entero igual o mayor que cero.");
    if (liters && (!Number.isFinite(Number(liters)) || Number(liters) <= 0)) return setError("Los litros deben ser mayores que cero, o deja el campo vacío.");
    if ([serviceBaseRef, serviceCustomerRef, nextKm, nextMonths].some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) return setError("Revisa mano de obra e intervalos: deben ser números iguales o mayores que cero.");
    if (!Number.isInteger(Number(nextKm)) || !Number.isInteger(Number(nextMonths))) return setError("Los intervalos de kilómetros y meses deben ser enteros.");
    if (!oil) return setError("Selecciona el aceite utilizado.");
    if (oil.source === "MANUAL" && !manualOilName.trim()) return setError("Escribe el nombre exacto del aceite utilizado.");
    if (Number(nextKm) <= 0 && Number(nextMonths) <= 0) return setError("Indica el próximo mantenimiento en kilómetros o meses.");
    if (!Number.isFinite(Number(oilUnits)) || Number(oilUnits) <= 0) return setError("La cantidad de aceite debe ser mayor que cero.");
    if (!Number.isFinite(oilUnitRef) || oilUnitRef <= 0) return setError("Indica el precio REF a cobrar por el aceite.");
    if (filter && (!Number.isFinite(Number(filterUnits)) || Number(filterUnits) <= 0)) return setError("La cantidad de filtros debe ser mayor que cero.");
    if (filter?.source === "MANUAL" && !manualFilterName.trim()) return setError("Escribe el nombre del filtro utilizado.");
    if (filter && (!Number.isFinite(filterUnitRef) || filterUnitRef <= 0)) return setError("Indica el precio REF a cobrar por el filtro.");

    setBusy(true);
    setError("");
    const { error } = await supabase.rpc("add_oil_change_package_flexible", {
      p_order_id: order.id,
      p_odometer: Number(odometer),
      p_description: description.trim() || "Cambio de aceite",
      p_service_base_ref: Number(serviceBaseRef || 0),
      p_service_customer_ref: Number(serviceCustomerRef || 0),
      p_oil_source: oilSaleSource,
      p_oil_inventory_item_id: oilSaleSource === "INVENTORY" ? oil.id : null,
      p_oil_product_id: oilSaleSource === "CATALOG" ? oil.product_id : null,
      p_oil_description: oil.source === "INVENTORY" && oilSaleSource === "MANUAL" ? `${oil.sku} · ${oil.description}` : oil.description,
      p_oil_units: Number(oilUnits),
      p_oil_unit_ref: oilUnitRef,
      p_oil_brand: oil.brand?.trim() || oil.description,
      p_oil_viscosity: viscosity.trim() || null,
      p_oil_quantity_liters: liters ? Number(liters) : null,
      p_filter_source: filterSaleSource,
      p_filter_inventory_item_id: filterSaleSource === "INVENTORY" ? filter?.id : null,
      p_filter_product_id: filterSaleSource === "CATALOG" ? filter?.product_id : null,
      p_filter_description: filter?.source === "INVENTORY" && filterSaleSource === "MANUAL" ? `${filter.sku} · ${filter.description}` : filter?.description ?? null,
      p_filter_units: filter ? Number(filterUnits) : 1,
      p_filter_unit_ref: filter ? filterUnitRef : null,
      p_filter_code: filter?.source === "MANUAL" ? filter.description : filter?.sku ?? null,
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
    {warning && <div className="card brand-card">{warning}</div>}

    <section className={`card ${pricingFresh ? "success" : "brand-card"}`}>
      <div className="row-between">
        <div><strong>Precio sugerido desde Notion</strong><div className="small">Catálogo {syncLabel(sync.catalogSyncedAt)} · tasas {syncLabel(sync.operativeEffectiveAt)}</div></div>
        <span className={`pill ${pricingFresh ? "ok" : "warn"}`}>{pricingFresh ? "VIGENTE" : "PRECIO MANUAL"}</span>
      </div>
      <div className="muted small">Puedes modificar el precio a cobrar en esta orden. Eso no cambia el precio maestro de Notion.</div>
    </section>

    <section className="card stack">
      <div className="row-between">
        <div><div className="muted small">VEHÍCULO</div><strong>{vehicle ? [vehicle.plate, vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · ") : "Cargando…"}</strong></div>
        <button className="btn btn-ghost" onClick={() => router.push(`/orders/${orderId}`)}>Volver a orden</button>
      </div>
      <label><span className="label">Kilometraje actual *</span><input className="input" type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="Ej. 84500" /></label>
    </section>

    <section className="card stack">
      <div className="row-between"><div><h2 className="section-title">1. Aceite</h2><div className="muted small">{loading ? "Cargando…" : `${oils.length} opciones · inventario y catálogo`}</div></div><button className="btn btn-ghost" onClick={load} disabled={loading}>Recargar</button></div>
      {!loading && oils.length === 0 && <div className="card">No hay aceites clasificados. Busca por nombre en todo el catálogo o registra el aceite manualmente aquí.</div>}
      <input className="input" value={oilSearch} onChange={e => setOilSearch(e.target.value)} placeholder="Buscar aceite por marca, viscosidad, nombre o SKU…" />
      <div className="stack directory-list">{visibleOils.slice(0, 8).map(i => <button className={`directory-option ${oilId === i.id ? "selected" : ""}`} key={i.id} onClick={() => chooseOil(i.id)}><strong>{i.brand} · {i.sku}</strong><span>{i.description} · {i.source === "INVENTORY" ? `stock registrado ${i.quantity_on_hand}` : "Catálogo · no descuenta stock"}</span></button>)}</div>
      <div className="muted small">{visibleOils.length > 8 ? "Mostrando 8 coincidencias. Escribe marca o viscosidad para afinar." : !visibleOils.length ? "No aparece. Puedes escribir el aceite usado abajo y continuar." : "Selecciona el aceite y confirma cantidad y precio abajo."}</div>
      <button type="button" className="btn btn-ghost" onClick={() => { setManualOilName(oilSearch.trim()); setOilId("manual:oil"); setOilPriceRef(""); setViscosity(extractViscosity(oilSearch)); }}>+ Aceite nuevo o no sincronizado</button>
      {oilId === "manual:oil" && <label><span className="label">Nombre exacto del aceite usado *</span><input className="input" value={manualOilName} onChange={e => setManualOilName(e.target.value)} placeholder="Ej. FANFARO 15W40 semisintético" autoFocus /></label>}
      {oil && <div className="success stack">
        <div className="row-between"><div><strong>{oil.sku} · {oil.brand}</strong><div className="small">{oil.catalog_product_name || oil.description} · {oil.source === "INVENTORY" ? `disponible ${oil.quantity_on_hand}` : "se venderá sin descontar inventario"}</div></div><div style={{ textAlign: "right" }}>{oil.current_ref_bcv != null ? <><strong>{fmtRef(oil.current_ref_bcv)}</strong><div className="small">{fmtVes(oil.current_price_ves ?? 0)} sugerido</div></> : <strong>Sin precio sugerido</strong>}</div></div>
      </div>}
      {oil?.source === "INVENTORY" && oilSaleSource !== "INVENTORY" && <div className="card brand-card">La cantidad supera el stock registrado. Se añadirá el aceite real a esta orden sin descontar inventario ni crear existencia ficticia.</div>}

      <div className="grid grid-2">
        <label><span className="label">Unidades usadas *</span><input className="input" type="number" min="0.01" step="0.01" value={oilUnits} onChange={e => setOilUnits(e.target.value)} /></label>
        <label><span className="label">Precio a cobrar REF *</span><input className="input" type="number" min="0.01" step="0.01" value={oilPriceRef} onChange={e => setOilPriceRef(e.target.value)} placeholder={pricingFresh ? "Precio sugerido de Notion" : "Ingresa precio manual"} /></label>
        <label><span className="label">Litros reales en el motor</span><input className="input" type="number" min="0" step="0.1" value={liters} onChange={e => setLiters(e.target.value)} placeholder="Ej. 4.5" /></label>
        <label><span className="label">Viscosidad</span><input className="input" value={viscosity} onChange={e => setViscosity(e.target.value)} placeholder="Ej. 15W-40" /></label>
      </div>
    </section>

    <section className="card stack">
      <div><h2 className="section-title">2. Filtro de aceite</h2><div className="muted small">Opcional · {filters.length} opciones de inventario y catálogo.</div></div>
      <input className="input" value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder="Buscar código, marca o nombre del filtro…" />
      <button className="btn btn-ghost" onClick={() => chooseFilter("")}>Sin filtro / cliente trae filtro</button>
      <div className="stack directory-list">{visibleFilters.slice(0, 8).map(i => <button className={`directory-option ${filterId === i.id ? "selected" : ""}`} key={i.id} onClick={() => chooseFilter(i.id)}><strong>{i.brand} · {i.sku}</strong><span>{i.description} · {i.source === "INVENTORY" ? `stock registrado ${i.quantity_on_hand}` : "Catálogo · no descuenta stock"}</span></button>)}</div>
      <button type="button" className="btn btn-ghost" onClick={() => { setManualFilterName(filterSearch.trim()); setFilterId("manual:filter"); setFilterPriceRef(""); }}>+ Filtro nuevo o no sincronizado</button>
      {filterId === "manual:filter" && <label><span className="label">Nombre o código exacto del filtro *</span><input className="input" value={manualFilterName} onChange={e => setManualFilterName(e.target.value)} placeholder="Ej. Filtro W 712/52" autoFocus /></label>}

      {filter && <div className="success stack">
        <div className="row-between"><div><strong>{filter.sku} · {filter.brand}</strong><div className="small">{filter.description} · {filter.source === "INVENTORY" ? `disponible ${filter.quantity_on_hand}` : "se venderá sin descontar inventario"}</div></div><div style={{ textAlign: "right" }}>{filter.current_ref_bcv != null ? <><strong>{fmtRef(filter.current_ref_bcv)}</strong><div className="small">{fmtVes(filter.current_price_ves ?? 0)} sugerido</div></> : <strong>Sin precio sugerido</strong>}</div></div>
      </div>}
      {filter?.source === "INVENTORY" && filterSaleSource !== "INVENTORY" && <div className="card brand-card">La cantidad supera el stock registrado. El filtro quedará en la orden sin descontar inventario.</div>}

      {filter && <div className="grid grid-2">
        <label><span className="label">Cantidad</span><input className="input" type="number" min="0.01" step="0.01" value={filterUnits} onChange={e => setFilterUnits(e.target.value)} /></label>
        <label><span className="label">Precio a cobrar REF *</span><input className="input" type="number" min="0.01" step="0.01" value={filterPriceRef} onChange={e => setFilterPriceRef(e.target.value)} placeholder={pricingFresh ? "Precio sugerido de Notion" : "Ingresa precio manual"} /></label>
      </div>}
    </section>

    <section className="card stack">
      <h2 className="section-title">3. Servicio y próximo mantenimiento</h2>
      <label><span className="label">Descripción</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="grid grid-2">
        <label><span className="label">Mano de obra base REF</span><input className="input" type="number" min="0" step="0.01" value={serviceBaseRef} onChange={e => setServiceBaseRef(e.target.value)} /></label>
        <label><span className="label">Mano de obra cobrada REF</span><input className="input" type="number" min="0" step="0.01" value={serviceCustomerRef} onChange={e => setServiceCustomerRef(e.target.value)} /></label>
        <label><span className="label">Próximo cambio · km</span><input className="input" type="number" min="0" step="500" value={nextKm} onChange={e => setNextKm(e.target.value)} /></label>
        <label><span className="label">Próximo cambio · meses</span><input className="input" type="number" min="0" step="1" value={nextMonths} onChange={e => setNextMonths(e.target.value)} /></label>
      </div>
      {nextOdometer != null && <div className="muted small">Próximo kilometraje estimado: {nextOdometer.toLocaleString("es-VE")} km</div>}
    </section>

    <section className="card stack">
      <div className="row-between"><div><div className="muted small">TOTAL PREVIO</div><div className="money-lg">{fmtRef(totalPreviewRef)}</div></div><div style={{ textAlign: "right" }}><div className="muted small">Aprox. Bs</div><strong>{fmtVes(totalPreviewRef * rates.bcv)}</strong></div></div>
      <div className="muted small">Aceite {fmtRef(oilUnitRef * Number(oilUnits || 0))}{filter ? ` · Filtro ${fmtRef(filterUnitRef * Number(filterUnits || 0))}` : ""} · Servicio {fmtRef(Number(serviceCustomerRef || 0))}</div>
      {error && <div className="error" role="alert">{error}</div>}
      {oil && !oilPriceRef && <div className="error">Confirma el precio REF del aceite arriba. El precio no está actualizado o requiere ingreso manual.</div>}
      <button className="btn btn-primary btn-block" disabled={busy || loading || !oil} onClick={save}>{busy ? "Agregando…" : "Agregar cambio de aceite a la orden"}</button>
    </section>
  </main>;
}


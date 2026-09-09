"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { electroautoAllocation, workshopAllocation } from "@/lib/domain/allocations";

type Product = {
  id: string;
  name: string;
  category: string | null;
  filter_code: string | null;
  available: boolean;
  cash_usd_base_price: number;
  current_price_ves: number;
  current_ref_bcv: number;
};

type Customer = {
  id: string;
  name: string | null;
  phone: string | null;
  document_id: string | null;
};

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

type Item = {
  id: string;
  item_type: string;
  business_area: string;
  description: string;
  quantity: number;
  charged_ves_amount: number;
  charged_ref_amount: number;
  cash_usd_special_total: number | null;
  cash_price_revealed: boolean;
  worker_share_ref_snapshot: number | null;
  assistant_bonus_ref_snapshot: number | null;
};

type Payment = {
  id: string;
  method: string;
  currency: string;
  amount_original: number;
  value_ves: number;
};

type Rates = { bcv: number; operative: number };
type Modal = "PARTY" | "PRODUCT" | "SERVICE" | "PAYMENT" | null;

export function OrderBuilderV2() {
  const router = useRouter();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState("Nueva orden");
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const totalVes = useMemo(() => items.reduce((a, i) => a + Number(i.charged_ves_amount || 0), 0), [items]);
  const totalRef = useMemo(() => items.reduce((a, i) => a + Number(i.charged_ref_amount || 0), 0), [items]);
  const paidVes = useMemo(() => payments.reduce((a, p) => a + Number(p.value_ves || 0), 0), [payments]);
  const remainingVes = Math.max(totalVes - paidVes, 0);
  const remainingRef = rates.bcv > 0 ? remainingVes / rates.bcv : 0;
  const remainingCashUsd = rates.operative > 0 ? remainingVes / rates.operative : 0;

  async function loadDirectory() {
    const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      supabase.from("customers").select("id,name,phone,document_id").order("updated_at", { ascending: false }).limit(300),
      supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").order("updated_at", { ascending: false }).limit(500),
    ]);
    if (ce) throw ce;
    if (ve) throw ve;
    setCustomers((c ?? []) as Customer[]);
    setVehicles((v ?? []) as Vehicle[]);
    return { customers: (c ?? []) as Customer[], vehicles: (v ?? []) as Vehicle[] };
  }

  async function bootstrap() {
    setError("");
    try {
      const [{ data: p, error: pe }, { data: r, error: re }] = await Promise.all([
        supabase.from("product_catalog_current").select("*").order("name"),
        supabase.rpc("get_current_rates"),
      ]);
      if (pe) throw pe;
      if (re) throw re;
      setProducts((p ?? []) as Product[]);
      const row = Array.isArray(r) ? r[0] : r;
      setRates({ bcv: Number(row?.bcv_rate ?? 0), operative: Number(row?.operative_rate ?? 0) });
      await loadDirectory();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }

  async function ensureOrder() {
    if (orderId) return orderId;
    const { data, error } = await supabase.rpc("create_order");
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    setOrderId(row.id);
    setOrderNumber(row.order_number);
    return row.id as string;
  }

  async function refresh(id = orderId) {
    if (!id) return;
    const [{ data: its, error: ie }, { data: pays, error: pe }] = await Promise.all([
      supabase.from("order_items").select("id,item_type,business_area,description,quantity,charged_ves_amount,charged_ref_amount,cash_usd_special_total,cash_price_revealed,worker_share_ref_snapshot,assistant_bonus_ref_snapshot").eq("order_id", id).order("created_at"),
      supabase.from("payments").select("id,method,currency,amount_original,value_ves").eq("order_id", id).order("paid_at"),
    ]);
    if (ie) setError(ie.message); else setItems((its ?? []) as Item[]);
    if (pe) setError(pe.message); else setPayments((pays ?? []) as Payment[]);
  }

  useEffect(() => { bootstrap(); }, []);

  async function removeItem(id: string) {
    if (!orderId) return;
    const { error } = await supabase.rpc("delete_order_item", { p_item_id: id });
    if (error) setError(error.message); else refresh(orderId);
  }

  async function removePayment(id: string) {
    if (!orderId) return;
    const { error } = await supabase.rpc("delete_payment", { p_payment_id: id });
    if (error) setError(error.message); else refresh(orderId);
  }

  async function closeOrder() {
    if (!orderId || !items.length) return setError("Agrega al menos un item antes de cerrar la orden.");
    setBusy(true); setError("");
    const { error } = await supabase.rpc("close_order", { p_order_id: orderId });
    setBusy(false);
    if (error) return setError(error.message);
    router.push("/orders");
  }

  return (
    <div className="stack">
      <section className="card brand-card">
        <div className="row-between">
          <div><div className="muted small">ORDEN</div><div className="money-lg">{orderNumber}</div></div>
          <span className="pill warn">ABIERTA</span>
        </div>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="card stack">
        <div className="row-between">
          <div>
            <div className="label">Cliente y vehículo</div>
            {customer || vehicle ? (
              <div>
                <strong>{customer?.name || customer?.phone || "Cliente sin nombre"}</strong>
                <div className="muted small">
                  {vehicle ? [vehicle.plate, vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · ") : "Sin vehículo asociado"}
                  {vehicle?.current_odometer != null ? ` · ${vehicle.current_odometer.toLocaleString("es-VE")} km` : ""}
                </div>
              </div>
            ) : <div className="muted">Opcional, pero recomendado para crear historial del vehículo.</div>}
          </div>
          <button className="btn btn-ghost" onClick={() => setModal("PARTY")}>{customer || vehicle ? "Cambiar" : "Asignar"}</button>
        </div>
      </section>

      <section className="grid grid-2">
        <button className="btn btn-primary" onClick={() => setModal("PRODUCT")}>+ Producto</button>
        <button className="btn" onClick={() => setModal("SERVICE")}>+ Trabajo / servicio</button>
      </section>

      <section className="card">
        <div className="row-between"><h2 className="section-title">Items</h2><span className="muted small">{items.length} líneas</span></div>
        {items.map(item => (
          <div className="order-item" key={item.id}>
            <div className="row-between">
              <div><strong>{item.description}</strong><div className="muted small">{item.business_area} · {item.quantity}x</div></div>
              <button className="btn btn-ghost" onClick={() => removeItem(item.id)}>Quitar</button>
            </div>
            <div className="row-between">
              <div><strong>{fmtRef(item.charged_ref_amount)}</strong><div className="muted small">{fmtVes(item.charged_ves_amount)}</div></div>
              {item.cash_price_revealed && item.cash_usd_special_total != null && <span className="pill">USD físico {fmtRef(item.cash_usd_special_total)}</span>}
            </div>
            {(Number(item.worker_share_ref_snapshot || 0) > 0 || Number(item.assistant_bonus_ref_snapshot || 0) > 0) && (
              <div className="muted small">
                {item.business_area === "WORKSHOP" && <>Cheo: {fmtRef(item.worker_share_ref_snapshot)} · Bono Alexis: {fmtRef(item.assistant_bonus_ref_snapshot)}</>}
                {item.business_area === "ELECTROAUTO" && <>Alexis: {fmtRef(item.worker_share_ref_snapshot)}</>}
              </div>
            )}
          </div>
        ))}
        {!items.length && <div className="muted">Agrega productos o trabajos para comenzar la orden.</div>}
      </section>

      <section className="card stack">
        <div className="row-between"><strong>Total orden</strong><div style={{ textAlign: "right" }}><div className="money-lg">{fmtRef(totalRef)}</div><div className="muted">{fmtVes(totalVes)}</div></div></div>
        <div className="divider" />
        <div className="row-between"><strong>Pagado</strong><span>{fmtVes(paidVes)}</span></div>
        <div className="row-between"><strong>Pendiente</strong><div style={{ textAlign: "right" }}><div>{fmtVes(remainingVes)}</div><div className="muted small">{fmtRef(remainingRef)} REF · ${remainingCashUsd.toFixed(2)} USD físico</div></div></div>
        <button className="btn" disabled={!items.length} onClick={() => setModal("PAYMENT")}>+ Agregar pago</button>
        {payments.map(p => <div className="row-between" key={p.id}><span className="muted small">{p.method}</span><div className="row"><strong>{p.currency === "USD" ? fmtRef(p.amount_original) : fmtVes(p.amount_original)}</strong><button className="btn btn-ghost" onClick={() => removePayment(p.id)}>×</button></div></div>)}
      </section>

      <button className="btn btn-primary btn-block" disabled={busy || !items.length} onClick={closeOrder}>{busy ? "Cerrando…" : "Cobrar y cerrar"}</button>
      <p className="muted small" style={{ textAlign: "center" }}>Cliente y vehículo quedan vinculados a la orden y al historial. Las integraciones se ejecutan después del cierre.</p>

      {modal === "PARTY" && <PartySheet customers={customers} vehicles={vehicles} currentCustomer={customer} currentVehicle={vehicle} ensureOrder={ensureOrder} reloadDirectory={loadDirectory} onDone={(c, v) => { setCustomer(c); setVehicle(v); setModal(null); }} onCancel={() => setModal(null)} />}
      {modal === "PRODUCT" && <ProductSheet products={products} ensureOrder={ensureOrder} onDone={async id => { setModal(null); await refresh(id); }} onCancel={() => setModal(null)} />}
      {modal === "SERVICE" && <ServiceSheet ensureOrder={ensureOrder} onDone={async id => { setModal(null); await refresh(id); }} onCancel={() => setModal(null)} />}
      {modal === "PAYMENT" && <PaymentSheet ensureOrder={ensureOrder} remainingVes={remainingVes} rates={rates} onDone={async id => { setModal(null); await refresh(id); }} onCancel={() => setModal(null)} />}
    </div>
  );
}

function PartySheet({ customers, vehicles, currentCustomer, currentVehicle, ensureOrder, reloadDirectory, onDone, onCancel }: {
  customers: Customer[];
  vehicles: Vehicle[];
  currentCustomer: Customer | null;
  currentVehicle: Vehicle | null;
  ensureOrder: () => Promise<string>;
  reloadDirectory: () => Promise<{ customers: Customer[]; vehicles: Vehicle[] }>;
  onDone: (customer: Customer | null, vehicle: Vehicle | null) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"EXISTING" | "NEW">("EXISTING");
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState(currentCustomer?.id ?? "");
  const [vehicleId, setVehicleId] = useState(currentVehicle?.id ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [plate, setPlate] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [engine, setEngine] = useState("");
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filteredCustomers = customers.filter(c => `${c.name ?? ""} ${c.phone ?? ""} ${c.document_id ?? ""}`.toLowerCase().includes(search.toLowerCase())).slice(0, 30);
  const customerVehicles = vehicles.filter(v => !customerId || v.customer_id === customerId);
  const selectedCustomer = customers.find(c => c.id === customerId) ?? null;
  const selectedVehicle = vehicles.find(v => v.id === vehicleId) ?? null;

  function chooseCustomer(id: string) {
    setCustomerId(id);
    if (!vehicles.some(v => v.id === vehicleId && v.customer_id === id)) setVehicleId("");
  }

  function chooseVehicle(id: string) {
    const v = vehicles.find(x => x.id === id);
    setVehicleId(id);
    if (v?.customer_id) setCustomerId(v.customer_id);
  }

  async function saveExisting() {
    if (!customerId && !vehicleId) return setError("Selecciona al menos un cliente o un vehículo.");
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const c = customers.find(x => x.id === customerId) ?? (selectedVehicle?.customer_id ? customers.find(x => x.id === selectedVehicle.customer_id) ?? null : null);
      const v = vehicles.find(x => x.id === vehicleId) ?? null;
      const { error } = await supabase.rpc("set_order_party", { p_order_id: id, p_customer_id: c?.id ?? null, p_vehicle_id: v?.id ?? null });
      if (error) throw error;
      onDone(c, v);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function saveNew() {
    setBusy(true); setError("");
    try {
      let newCustomerId: string | null = null;
      let newVehicleId: string | null = null;
      if (name.trim() || phone.trim() || documentId.trim()) {
        const { data, error } = await supabase.rpc("upsert_customer", { p_name: name || null, p_phone: phone || null, p_document_id: documentId || null });
        if (error) throw error;
        newCustomerId = data as string;
      }
      if (plate.trim() || make.trim() || model.trim()) {
        const { data, error } = await supabase.rpc("upsert_vehicle", {
          p_customer_id: newCustomerId,
          p_plate: plate || null,
          p_make: make || null,
          p_model: model || null,
          p_year: year ? Number(year) : null,
          p_engine: engine || null,
          p_current_odometer: odometer ? Number(odometer) : null,
        });
        if (error) throw error;
        newVehicleId = data as string;
      }
      if (!newCustomerId && !newVehicleId) throw new Error("Ingresa datos del cliente o del vehículo.");
      const id = await ensureOrder();
      const { error } = await supabase.rpc("set_order_party", { p_order_id: id, p_customer_id: newCustomerId, p_vehicle_id: newVehicleId });
      if (error) throw error;
      const fresh = await reloadDirectory();
      const c = fresh.customers.find(x => x.id === newCustomerId) ?? null;
      const v = fresh.vehicles.find(x => x.id === newVehicleId) ?? null;
      onDone(c, v);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Cliente y vehículo</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <div className="segmented"><button className={`btn ${mode === "EXISTING" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("EXISTING")}>Buscar existente</button><button className={`btn ${mode === "NEW" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("NEW")}>Crear nuevo</button></div>

    {mode === "EXISTING" ? <>
      <label><span className="label">Buscar cliente</span><input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre, teléfono o cédula" autoFocus /></label>
      <div className="stack directory-list">
        {filteredCustomers.map(c => <button key={c.id} className={`directory-option ${customerId === c.id ? "selected" : ""}`} onClick={() => chooseCustomer(c.id)}><strong>{c.name || "Cliente sin nombre"}</strong><span>{[c.phone, c.document_id].filter(Boolean).join(" · ") || "Sin datos adicionales"}</span></button>)}
        {!filteredCustomers.length && <div className="muted small">No encontré clientes con esa búsqueda.</div>}
      </div>
      {customerId && <div className="stack"><div className="label">Vehículos del cliente</div>{customerVehicles.map(v => <button key={v.id} className={`directory-option ${vehicleId === v.id ? "selected" : ""}`} onClick={() => chooseVehicle(v.id)}><strong>{v.plate || `${v.make ?? ""} ${v.model ?? ""}`.trim() || "Vehículo"}</strong><span>{[v.make, v.model, v.year, v.current_odometer != null ? `${v.current_odometer.toLocaleString("es-VE")} km` : null].filter(Boolean).join(" · ")}</span></button>)}{!customerVehicles.length && <div className="muted small">Este cliente todavía no tiene vehículos registrados.</div>}</div>}
      <button className="btn btn-primary btn-block" disabled={busy || (!customerId && !vehicleId)} onClick={saveExisting}>{busy ? "Guardando…" : "Usar en esta orden"}</button>
    </> : <>
      <div className="card stack"><div className="row-between"><strong>Cliente</strong><span className="muted small">Puedes dejarlo vacío si solo registrarás vehículo</span></div><div className="grid grid-2"><label><span className="label">Nombre</span><input className="input" value={name} onChange={e => setName(e.target.value)} /></label><label><span className="label">Teléfono</span><input className="input" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" /></label></div><label><span className="label">Cédula / documento</span><input className="input" value={documentId} onChange={e => setDocumentId(e.target.value)} /></label></div>
      <div className="card stack"><strong>Vehículo</strong><div className="grid grid-2"><label><span className="label">Placa</span><input className="input" value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} /></label><label><span className="label">Kilometraje</span><input className="input" type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)} /></label><label><span className="label">Marca</span><input className="input" value={make} onChange={e => setMake(e.target.value)} /></label><label><span className="label">Modelo</span><input className="input" value={model} onChange={e => setModel(e.target.value)} /></label><label><span className="label">Año</span><input className="input" type="number" min="1900" max="2100" value={year} onChange={e => setYear(e.target.value)} /></label><label><span className="label">Motor</span><input className="input" value={engine} onChange={e => setEngine(e.target.value)} /></label></div></div>
      <button className="btn btn-primary btn-block" disabled={busy} onClick={saveNew}>{busy ? "Guardando…" : "Crear y usar en esta orden"}</button>
    </>}
    {error && <div className="error">{error}</div>}
  </div></div>;
}

function ProductSheet({ products, ensureOrder, onDone, onCancel }: {
  products: Product[];
  ensureOrder: () => Promise<string>;
  onDone: (id: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const filtered = products.filter(p => `${p.filter_code ?? ""} ${p.name} ${p.category ?? ""}`.toLowerCase().includes(search.toLowerCase())).slice(0, 30);
  const selected = products.find(p => p.id === productId);

  async function add() {
    if (!productId || qty <= 0) return;
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const { error } = await supabase.rpc("add_product_item", { p_order_id: id, p_product_id: productId, p_quantity: qty, p_reveal_cash_price: reveal });
      if (error) throw error;
      await onDone(id);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Agregar producto</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <label><span className="label">Buscar por código de filtro, nombre o categoría</span><input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="AL-3387, Brava 15W40…" autoFocus /></label>
    <div className="stack" style={{ maxHeight: 280, overflow: "auto" }}>
      {filtered.map(p => <button key={p.id} className="btn btn-ghost" style={{ textAlign: "left", borderColor: p.id === productId ? "#ff5d15" : undefined }} onClick={() => setProductId(p.id)}><strong>{p.filter_code ? `${p.filter_code} · ` : ""}{p.name}</strong><div className="muted small">{fmtRef(p.current_ref_bcv)} · {fmtVes(p.current_price_ves)}</div></button>)}
    </div>
    {selected && <div className="card stack"><div className="row-between"><strong>{selected.name}</strong><span className="pill">{selected.category ?? "Producto"}</span></div><div className="grid grid-2"><label><span className="label">Cantidad</span><input className="input" type="number" min={0.01} step={0.01} value={qty} onChange={e => setQty(Number(e.target.value))} /></label><div><span className="label">Cotización normal</span><strong>{fmtRef(selected.current_ref_bcv * qty)}</strong><div className="muted">{fmtVes(selected.current_price_ves * qty)}</div></div></div><label className="row"><input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} /> <span>Aplicar / revelar precio especial en divisas</span></label>{reveal && <div className="success">Precio interno en divisas: <strong>{fmtRef(selected.cash_usd_base_price * qty)}</strong>.</div>}</div>}
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !productId} onClick={add}>{busy ? "Agregando…" : "Agregar a la orden"}</button>
  </div></div>;
}

function ServiceSheet({ ensureOrder, onDone, onCancel }: {
  ensureOrder: () => Promise<string>;
  onDone: (id: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [area, setArea] = useState<"WORKSHOP" | "ELECTROAUTO" | "OIL_CHANGE">("WORKSHOP");
  const [description, setDescription] = useState("");
  const [baseRef, setBaseRef] = useState(0);
  const [customerRef, setCustomerRef] = useState(0);
  const [bonus, setBonus] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [workerOverride, setWorkerOverride] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (customerRef === 0 && baseRef > 0) setCustomerRef(baseRef); }, [baseRef]);
  const preview = useMemo(() => {
    try {
      if (area === "WORKSHOP") return workshopAllocation({ baseRef, customerRef, alexisBonusEnabled: bonus, cheoOverrideRef: workerOverride === "" ? null : Number(workerOverride) });
      if (area === "ELECTROAUTO") return electroautoAllocation({ baseRef, customerRef, alexisOverrideRef: workerOverride === "" ? null : Number(workerOverride) });
      return { customerRef, lubricenterRef: customerRef };
    } catch (e: any) { return { error: e.message } as any; }
  }, [area, baseRef, customerRef, bonus, workerOverride]);

  async function add() {
    if (!description.trim() || baseRef <= 0 || customerRef < 0) return;
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const { error } = await supabase.rpc("add_service_item", { p_order_id: id, p_business_area: area, p_description: description.trim(), p_base_ref: baseRef, p_customer_ref: customerRef, p_worker_share_override_ref: workerOverride === "" ? null : Number(workerOverride), p_alexis_bonus_enabled: area === "WORKSHOP" ? bonus : false });
      if (error) throw error;
      await onDone(id);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Trabajo / servicio</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <label><span className="label">Área</span><select className="select" value={area} onChange={e => setArea(e.target.value as any)}><option value="WORKSHOP">Taller · Cheo</option><option value="ELECTROAUTO">Electroauto · Alexis</option><option value="OIL_CHANGE">Otro servicio sin comisión</option></select></label>
    <label><span className="label">Descripción libre</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Ej. Limpieza de tanque de gasolina" /></label>
    <div className="grid grid-2"><label><span className="label">Base del trabajo REF</span><input className="input" type="number" min="0" step="0.01" value={baseRef || ""} onChange={e => setBaseRef(Number(e.target.value))} /></label><label><span className="label">Monto al cliente REF</span><input className="input" type="number" min="0" step="0.01" value={customerRef || ""} onChange={e => setCustomerRef(Number(e.target.value))} /></label></div>
    {area === "WORKSHOP" && <label className="row"><input type="checkbox" checked={bonus} onChange={e => setBonus(e.target.checked)} /> <span>Bono meritorio Alexis 5% (sale de Lubricenter)</span></label>}
    {area !== "OIL_CHANGE" && <button className="btn btn-ghost" onClick={() => setAdvanced(v => !v)}>{advanced ? "Ocultar ajuste de reparto" : "Ajustar reparto excepcional"}</button>}
    {advanced && area !== "OIL_CHANGE" && <label><span className="label">Parte acordada {area === "WORKSHOP" ? "Cheo" : "Alexis"} en REF</span><input className="input" type="number" min="0" step="0.01" value={workerOverride} onChange={e => setWorkerOverride(e.target.value)} placeholder="Vacío = regla automática 40%" /></label>}
    <div className="card">{preview.error ? <div className="error">{preview.error}</div> : area === "WORKSHOP" ? <div className="stack"><div className="row-between"><span>Cliente</span><strong>{fmtRef(preview.customerRef)}</strong></div><div className="row-between"><span>Cheo</span><strong>{fmtRef(preview.cheoRef)}</strong></div><div className="row-between"><span>Bono Alexis</span><strong>{fmtRef(preview.alexisBonusRef)}</strong></div><div className="row-between"><span>Lubricenter</span><strong>{fmtRef(preview.lubricenterRef)}</strong></div></div> : area === "ELECTROAUTO" ? <div className="stack"><div className="row-between"><span>Cliente</span><strong>{fmtRef(preview.customerRef)}</strong></div><div className="row-between"><span>Alexis</span><strong>{fmtRef(preview.alexisRef)}</strong></div><div className="row-between"><span>Lubricenter</span><strong>{fmtRef(preview.lubricenterRef)}</strong></div></div> : <div className="row-between"><span>Total servicio</span><strong>{fmtRef(customerRef)}</strong></div>}</div>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !!preview.error || !description || baseRef <= 0} onClick={add}>{busy ? "Agregando…" : "Agregar trabajo"}</button>
  </div></div>;
}

function PaymentSheet({ ensureOrder, remainingVes, rates, onDone, onCancel }: {
  ensureOrder: () => Promise<string>;
  remainingVes: number;
  rates: Rates;
  onDone: (id: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState("MOBILE_PAYMENT");
  const currency = method === "CASH_USD" ? "USD" : "VES";
  const suggested = currency === "USD" ? (rates.operative ? remainingVes / rates.operative : 0) : remainingVes;
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAmount(Number(suggested.toFixed(currency === "USD" ? 2 : 0))); }, [method, remainingVes, rates.operative]);

  async function add() {
    if (amount <= 0) return;
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const { error } = await supabase.rpc("add_payment", { p_order_id: id, p_method: method, p_amount_original: amount, p_reference: reference || null });
      if (error) throw error;
      await onDone(id);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Agregar pago</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <label><span className="label">Método</span><select className="select" value={method} onChange={e => setMethod(e.target.value)}><option value="MOBILE_PAYMENT">Pago móvil</option><option value="TRANSFER_BDV">Transferencia BDV</option><option value="TRANSFER_BNC">Transferencia BNC</option><option value="CASH_VES">Efectivo Bs</option><option value="CASH_USD">Efectivo USD físico</option></select></label>
    <label><span className="label">Monto {currency}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} /></label>
    {method !== "CASH_USD" && method !== "CASH_VES" && <label><span className="label">Referencia opcional</span><input className="input" value={reference} onChange={e => setReference(e.target.value)} /></label>}
    <div className="card"><div className="muted small">VALOR OPERATIVO DEL PAGO</div><div className="money-lg">{fmtVes(currency === "USD" ? amount * rates.operative : amount)}</div><div className="muted small">USD físico se valora a tasa operativa. Bs conserva su monto original.</div></div>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || amount <= 0} onClick={add}>{busy ? "Agregando…" : "Agregar pago"}</button>
  </div></div>;
}

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null };
const customerFields = "id,name,phone,document_id";
const vehicleFields = "id,customer_id,plate,make,model,year,engine,current_odometer";

export function OrderPartySheet({ currentCustomer, currentVehicle, ensureOrder, onDone, onWalkIn, onCancel }: {
  currentCustomer: Customer | null; currentVehicle: Vehicle | null;
  ensureOrder: () => Promise<string>;
  onDone: (customer: Customer | null, vehicle: Vehicle | null, id: string) => Promise<void>;
  onWalkIn: (id: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [customer, setCustomer] = useState(currentCustomer);
  const [vehicle, setVehicle] = useState(currentVehicle);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [owned, setOwned] = useState<Vehicle[]>([]);
  const [newCustomer, setNewCustomer] = useState(false);
  const [newVehicle, setNewVehicle] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [plate, setPlate] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const text = query.trim().replace(/[,().%_*\\]/g, " ").trim();
    setCustomers([]); setVehicles([]);
    if (text.length < 2) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const [c, v] = await Promise.all([
          supabase.from("customers").select(customerFields).or(`name.ilike.%${text}%,phone.ilike.%${text}%,document_id.ilike.%${text}%`).order("name").limit(8),
          supabase.from("vehicles").select(vehicleFields).or(`plate.ilike.%${text}%,make.ilike.%${text}%,model.ilike.%${text}%`).order("plate").limit(8),
        ]);
        if (c.error || v.error) throw c.error || v.error;
        if (active) { setCustomers(c.data ?? []); setVehicles(v.data ?? []); }
      } catch (e: any) { if (active) setError(e.message); }
      finally { if (active) setSearching(false); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    let active = true;
    setOwned([]);
    if (customer) supabase.from("vehicles").select(vehicleFields).eq("customer_id", customer.id).order("plate").then(({ data, error }) => {
      if (active) { if (error) setError(error.message); else setOwned(data ?? []); }
    });
    return () => { active = false; };
  }, [customer?.id]);

  function chooseCustomer(c: Customer) {
    setCustomer(c); setVehicle(null); setNewCustomer(false); setNewVehicle(false); setQuery(""); setError("");
  }
  async function chooseVehicle(v: Vehicle) {
    setBusy(true); setError("");
    try {
      let c: Customer | null = null;
      if (v.customer_id) {
        const result = await supabase.from("customers").select(customerFields).eq("id", v.customer_id).single();
        if (result.error) throw result.error;
        c = result.data;
      }
      setCustomer(c); setVehicle(v); setNewVehicle(false); setNewCustomer(false); setQuery("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy) return;
    if (newCustomer && !name.trim()) return setError("Escribe el nombre del cliente.");
    if (newVehicle && !plate.trim()) return setError("Escribe la placa para identificar el vehículo y evitar duplicados.");
    if (newVehicle && odometer && (!Number.isInteger(Number(odometer)) || Number(odometer) < 0)) return setError("El kilometraje debe ser un número entero igual o mayor que cero.");
    setBusy(true); setError("");
    try {
      let c = customer, v = vehicle;
      // Check the plate before invoking the existing upsert, which can transfer ownership.
      if (newVehicle) {
        const existing = await supabase.from("vehicles").select("id").ilike("plate", plate.trim().toUpperCase()).limit(1);
        if (existing.error) throw existing.error;
        if (existing.data?.length) throw new Error("Esta placa ya está registrada. Búscala arriba y selecciona el vehículo existente.");
      }
      if (newCustomer) {
        const result = await supabase.rpc("upsert_customer", { p_name: name.trim(), p_phone: phone.trim() || null, p_document_id: documentId.trim() || null });
        if (result.error) throw result.error;
        const saved = await supabase.from("customers").select(customerFields).eq("id", result.data).single();
        if (saved.error) throw saved.error;
        c = saved.data; setCustomer(c); setNewCustomer(false);
      }
      if (newVehicle) {
        const result = await supabase.rpc("upsert_vehicle", { p_customer_id: c?.id ?? null, p_plate: plate.trim().toUpperCase(), p_make: make.trim() || null, p_model: model.trim() || null, p_current_odometer: odometer ? Number(odometer) : null });
        if (result.error) throw result.error;
        const saved = await supabase.from("vehicles").select(vehicleFields).eq("id", result.data).single();
        if (saved.error) throw saved.error;
        v = saved.data; setVehicle(v); setNewVehicle(false);
      }
      if (!c && !v) throw new Error("Busca o crea un cliente o vehículo para continuar.");
      const id = await ensureOrder();
      const result = await supabase.rpc("set_order_party", { p_order_id: id, p_customer_id: c?.id ?? null, p_vehicle_id: v?.id ?? null });
      if (result.error) throw result.error;
      await onDone(c, v, id);
    } catch (e: any) { setError(e.message ?? "No se pudo guardar. Revisa la conexión e inténtalo de nuevo."); }
    finally { setBusy(false); }
  }

  async function continueWithoutCustomer() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const id = await ensureOrder();
      const result = await supabase.rpc("set_order_walk_in", { p_order_id: id, p_is_walk_in: true });
      if (result.error) throw result.error;
      await onWalkIn(id);
    } catch (e: any) {
      setError(e.message ?? "No se pudo activar el servicio rápido. Inténtalo de nuevo.");
    } finally { setBusy(false); }
  }

  return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-labelledby="party-title">
    <div className="row-between"><h2 id="party-title">Cliente y vehículo</h2><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Volver</button></div>
    <fieldset disabled={busy} className="stack form-fields">
      <label><span className="label">Buscar cliente o placa</span><input autoFocus className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Placa, nombre, teléfono o cédula · mínimo 2 caracteres" /></label>
      <div className="muted small" role="status">{searching ? "Buscando…" : query.trim().length < 2 ? "Busca en todos los registros o crea uno aquí mismo." : !customers.length && !vehicles.length ? "Sin coincidencias. Puedes crear el cliente y su vehículo abajo." : "Selecciona una coincidencia. Si necesitas afinar, escribe más datos."}</div>
      {customers.map(c => <button key={c.id} className="directory-option" onClick={() => chooseCustomer(c)}><strong>{c.name || c.phone}</strong><span>{[c.phone, c.document_id].filter(Boolean).join(" · ")}</span></button>)}
      {vehicles.map(v => <button key={v.id} className="directory-option" onClick={() => chooseVehicle(v)}><strong>{v.plate}</strong><span>{[v.make, v.model].filter(Boolean).join(" · ")}</span></button>)}
      <div className="grid grid-2"><button className="btn" onClick={() => { setNewCustomer(true); setCustomer(null); setVehicle(null); setNewVehicle(true); }}>+ Cliente nuevo</button><button className="btn" disabled={!customer && !newCustomer} onClick={() => { setNewVehicle(true); setVehicle(null); }}>+ Vehículo para este cliente</button></div>
      {customer && <div className="success"><strong>{customer.name || customer.phone}</strong><div className="small">Cliente seleccionado</div></div>}
      {newCustomer && <div className="card stack"><strong>Nuevo cliente</strong><label>Nombre *<input className="input" value={name} onChange={e => setName(e.target.value)} /></label><div className="grid grid-2"><label>Teléfono<input className="input" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label><label>Cédula<input className="input" value={documentId} onChange={e => setDocumentId(e.target.value)} /></label></div></div>}
      {customer && !newVehicle && <div className="stack directory-list">{owned.map(v => <button key={v.id} className={`directory-option ${vehicle?.id === v.id ? "selected" : ""}`} onClick={() => chooseVehicle(v)}><strong>{v.plate || "Sin placa"}</strong><span>{[v.make, v.model].filter(Boolean).join(" · ")}</span></button>)}</div>}
      {vehicle && <div className="success">Vehículo seleccionado: <strong>{vehicle.plate || vehicle.model}</strong></div>}
      {newVehicle && <div className="card stack"><div className="row-between"><strong>Nuevo vehículo</strong><button className="btn btn-ghost" onClick={() => setNewVehicle(false)}>Sin vehículo</button></div><div className="grid grid-2"><label>Placa *<input className="input" value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} /></label><label>Kilometraje<input className="input" type="number" min="0" step="1" value={odometer} onChange={e => setOdometer(e.target.value)} /></label><label>Marca<input className="input" value={make} onChange={e => setMake(e.target.value)} /></label><label>Modelo<input className="input" value={model} onChange={e => setModel(e.target.value)} /></label></div></div>}
    </fieldset>
    {error && <div className="error" role="alert">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar y continuar en la orden"}</button>
    {!customer && !vehicle && !newCustomer && !newVehicle && <div className="card stack">
      <div><strong>¿Es un trabajo rápido de taller?</strong><div className="muted small">Continúa sin registrar cliente ni vehículo. No generará historial, recordatorios ni seguimiento CRM.</div></div>
      <button className="btn btn-block" disabled={busy} onClick={continueWithoutCustomer}>{busy ? "Guardando…" : "Continuar sin cliente"}</button>
    </div>}
  </div></div>;
}


"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InventoryHistory } from "@/components/inventory-history";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { inventorySearchText, matchesSearch } from "@/lib/domain/search";
import {
  inventoryState, INVENTORY_FILTERS, matchesInventoryFilter, type InventoryFilter, type InventoryFullRow
} from "@/lib/inventory-full";

type Rates = { bcv: number; operative: number };
type ItemForm = {
  id: string | null; sku: string; name: string; description: string; brand: string; category: string; unit: string;
  price: string; cost: string; image: string; codes: string; active: boolean; needsReview: boolean; inCatalog: boolean;
  quantity: string; originalQuantity: number; countNote: string; updatedAt: string | null;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const usd = (v: number) => "$" + v.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (v: number) => v.toLocaleString("es-VE", { maximumFractionDigits: 2 });
const parseDecimal = (v: string) => (v.trim() === "" ? null : Number(v.trim().replace(",", ".")));
const nameOf = (r: InventoryFullRow) => r.display_name || r.description;

function toRow(r: any): InventoryFullRow {
  return {
    ...r,
    quantity_on_hand: Number(r.quantity_on_hand ?? 0),
    movement_count: Number(r.movement_count ?? 0),
    price_usd: num(r.price_usd),
    current_price_ves: num(r.current_price_ves),
    current_ref_bcv: num(r.current_ref_bcv),
    average_cost_ref: num(r.average_cost_ref),
    last_purchase_cost_ref: num(r.last_purchase_cost_ref),
    source_cost_ref: num(r.source_cost_ref),
    alt_codes: Array.isArray(r.alt_codes) ? r.alt_codes : [],
  };
}

export default function InventoryPage() {
  const [location, setLocation] = useState<{ id: string; code: string; name: string } | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [rows, setRows] = useState<InventoryFullRow[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("TODOS");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<ItemForm | null>(null);
  const [historyItem, setHistoryItem] = useState<InventoryFullRow | null>(null);
  const [bulkPrice, setBulkPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    const [invRes, rateRes, locationRes, permissionRes] = await Promise.all([
      supabase.rpc("get_inventory_full", { p_location_code: "CABUDARE" }),
      supabase.rpc("get_current_rates"),
      supabase.from("locations").select("id,code,name").eq("code", "CABUDARE").maybeSingle(),
      supabase.rpc("can_administer_orders"),
    ]);
    setCanManage(permissionRes.data === true);
    if (invRes.error || locationRes.error) {
      setError((invRes.error || locationRes.error)?.message ?? "No pude cargar el inventario.");
      setLoading(false);
      return;
    }
    setLocation(locationRes.data ?? null);
    setRows((invRes.data ?? []).map(toRow));
    const rate = Array.isArray(rateRes.data) ? rateRes.data[0] : rateRes.data;
    setRates({ bcv: Number(rate?.bcv_rate ?? 0), operative: Number(rate?.operative_rate ?? 0) });
    setLoading(false);
  }

  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener("lubricenter:pricing-updated", refresh);
    return () => window.removeEventListener("lubricenter:pricing-updated", refresh);
  }, []);

  const categories = useMemo(() => Array.from(new Set(rows.map(r => r.category).filter(Boolean) as string[])).sort(), [rows]);
  const counts = useMemo(() => Object.fromEntries(INVENTORY_FILTERS.map(f => [f.id, rows.filter(r => matchesInventoryFilter(r, f.id)).length])), [rows]);

  const visible = useMemo(() => {
    const q = search.trim();
    return rows.filter(r => matchesInventoryFilter(r, filter)
      && (category === "TODOS" || r.category === category)
      && (!q || matchesSearch(inventorySearchText({ ...r, catalog_product_name: r.display_name }), q)));
  }, [rows, search, category, filter]);

  const selectedRows = rows.filter(r => selected.has(r.id));
  const allVisibleSelected = visible.length > 0 && visible.every(r => selected.has(r.id));

  function toggle(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  function toggleAllVisible() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach(r => next.delete(r.id)); else visible.forEach(r => r.merged_into ? null : next.add(r.id));
      return next;
    });
  }

  function beginEdit(r: InventoryFullRow | null) {
    setNotice(""); setError("");
    setForm(r ? {
      id: r.id, sku: r.sku, name: nameOf(r), description: r.description ?? "", brand: r.brand ?? "", category: r.category ?? "",
      unit: r.unit || "UND", price: r.price_usd != null ? String(r.price_usd) : "",
      cost: r.average_cost_ref != null ? String(Number(r.average_cost_ref.toFixed(4))) : "", image: r.image_url ?? "",
      codes: r.alt_codes.join(", "), active: r.active, needsReview: r.needs_review, inCatalog: r.in_catalog,
      quantity: String(r.quantity_on_hand), originalQuantity: r.quantity_on_hand, countNote: "", updatedAt: r.updated_at,
    } : {
      id: null, sku: "", name: "", description: "", brand: "", category: category !== "TODOS" ? category : "", unit: "UND",
      price: "", cost: "", image: "", codes: "", active: true, needsReview: false, inCatalog: false,
      quantity: "0", originalQuantity: 0, countNote: "", updatedAt: null,
    });
  }

  async function setCount(itemId: string, expected: number, count: number, note: string) {
    if (!location) throw new Error("No encontré la sede Cabudare.");
    const { error } = await supabase.rpc("inventory_set_count_at_location", {
      p_inventory_item_id: itemId, p_location_id: location.id, p_expected_quantity: expected, p_new_count: count, p_note: note,
    });
    if (error) throw error;
  }

  async function saveItem() {
    if (!form || !canManage || busy) return;
    const price = parseDecimal(form.price);
    const cost = parseDecimal(form.cost);
    const quantity = parseDecimal(form.quantity);
    if (price != null && (!Number.isFinite(price) || price < 0)) return setError("El precio de venta debe ser un número válido.");
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return setError("El costo debe ser un número válido.");
    if (quantity == null || !Number.isFinite(quantity) || quantity < 0) return setError("La existencia debe ser cero o mayor.");
    const quantityChanged = quantity !== form.originalQuantity;
    if (quantityChanged && !form.active) return setError("Para cambiar la existencia, el artículo debe estar activo.");
    if (quantityChanged && !form.countNote.trim()) return setError("Escribe el motivo del cambio de existencia (por ejemplo, «recuento del estante»).");
    if (form.inCatalog && !(price && price > 0)) return setError("Para mostrarlo en el catálogo ponle un precio de venta.");

    setBusy(true); setError(""); setNotice("");
    try {
      const { data, error } = await supabase.rpc("inventory_save_item_full", {
        p_id: form.id, p_sku: form.sku, p_display_name: form.name, p_description: form.description, p_brand: form.brand,
        p_category: form.category, p_unit: form.unit, p_price_usd: price, p_cost_ref: cost, p_image_url: form.image,
        p_alt_codes: form.codes.split(",").map(x => x.trim()).filter(Boolean),
        p_active: form.active, p_needs_review: form.needsReview, p_in_catalog: form.inCatalog && form.active,
        p_expected_updated_at: form.updatedAt,
      });
      if (error) throw error;
      const id = (data as { id?: string } | null)?.id ?? form.id;
      if (quantityChanged && id) await setCount(id, form.originalQuantity, quantity, form.countNote.trim());
      setNotice(`${form.sku.toUpperCase()}: ${form.id ? "guardado" : "creado"}${quantityChanged ? `, existencia ${qtyText(quantity)}` : ""}.`);
      setForm(null);
      await load();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setCatalog(ids: string[], inCatalog: boolean) {
    if (!canManage || busy || !ids.length) return;
    setBusy(true); setError(""); setNotice("");
    const { data, error } = await supabase.rpc("inventory_set_catalog_bulk", { p_item_ids: ids, p_in_catalog: inCatalog });
    setBusy(false);
    if (error) return setError(error.message);
    const changed = Number(data ?? 0);
    const skipped = inCatalog ? ids.filter(id => { const r = rows.find(x => x.id === id); return r && !r.in_catalog && !((r.price_usd ?? 0) > 0 && r.active); }).length : 0;
    setNotice(inCatalog
      ? `${changed} artículo${changed === 1 ? "" : "s"} al catálogo.${skipped ? ` ${skipped} no entraron porque no tienen precio o están archivados.` : ""}`
      : `${changed} artículo${changed === 1 ? "" : "s"} fuera del catálogo.`);
    setSelected(new Set());
    await load();
  }

  async function saveBulkPrice() {
    const price = parseDecimal(bulkPrice ?? "");
    if (price == null || !Number.isFinite(price) || price <= 0) return setError("Escribe un precio de venta mayor que cero.");
    const ids = selectedRows.filter(r => r.active && !r.merged_into).map(r => r.id);
    if (!ids.length) return setError("Ningún artículo seleccionado está activo.");
    setBusy(true); setError(""); setNotice("");
    const { data, error } = await supabase.rpc("inventory_set_price_bulk", { p_item_ids: ids, p_price_usd: price });
    setBusy(false);
    if (error) return setError(error.message);
    setBulkPrice(null);
    setSelected(new Set());
    setNotice(`Precio ${usd(price)} aplicado a ${Number(data ?? 0)} artículos.`);
    await load();
  }

  const formPrice = form ? parseDecimal(form.price) : null;

  return <main className="container stack inv-page">
    <header className="inv-head">
      <div>
        <div className="muted small">Inventario · {location?.name ?? "Cabudare"}</div>
        <h1>Inventario</h1>
        <p className="muted">Todos los artículos. Aquí cambias existencia, precio, costo y si aparecen en el catálogo.</p>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {canManage && <button className="btn btn-primary" onClick={() => beginEdit(null)}>Nuevo artículo</button>}
        <Link href="/catalog" className="btn btn-ghost">Ver catálogo</Link>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>{loading ? "Cargando…" : "Recargar"}</button>
      </div>
    </header>

    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}

    <nav className="inv-filters" aria-label="Filtrar por estado">
      {INVENTORY_FILTERS.map(f => <button key={f.id} type="button" className={"inv-chip" + (filter === f.id ? " is-on" : "")}
        aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} title={f.hint}>
        <span>{f.label}</span><b>{counts[f.id] ?? 0}</b>
      </button>)}
    </nav>

    <section className="inv-tools">
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nombre, código, marca o código del conteo" aria-label="Buscar" />
      <select className="input" value={category} onChange={e => setCategory(e.target.value)} aria-label="Rubro">
        <option value="TODOS">Todos los rubros</option>
        {categories.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </section>

    {canManage && selected.size > 0 && <section className="inv-bulk" role="region" aria-label="Acciones con la selección">
      <strong>{selected.size} seleccionado{selected.size === 1 ? "" : "s"}</strong>
      <button className="btn btn-primary" disabled={busy} onClick={() => setCatalog([...selected], true)}>Poner en el catálogo</button>
      <button className="btn" disabled={busy} onClick={() => setCatalog([...selected], false)}>Sacar del catálogo</button>
      <button className="btn" disabled={busy} onClick={() => setBulkPrice("")}>Poner precio</button>
      <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>Quitar selección</button>
    </section>}

    <div className="muted small">{visible.length} de {rows.length} artículos</div>

    {loading ? <div className="card muted">Cargando inventario…</div> : <div className="inv-table-wrap">
      <table className="inv-table">
        <thead><tr>
          {canManage && <th className="inv-check"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Seleccionar los visibles" /></th>}
          <th>Artículo</th>
          <th>Rubro</th>
          <th className="num">Existencia</th>
          <th className="num">Precio de venta</th>
          <th className="num">Costo</th>
          <th>Catálogo</th>
          <th aria-label="Acciones" />
        </tr></thead>
        <tbody>
          {visible.map(r => {
            const state = inventoryState(r);
            return <tr key={r.id} className={!r.active ? "is-archived" : undefined}>
              {canManage && <td className="inv-check"><input type="checkbox" checked={selected.has(r.id)} disabled={!!r.merged_into} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.sku}`} /></td>}
              <td>
                <div className="inv-name">{nameOf(r)}</div>
                <div className="muted small">{r.sku}{r.brand ? ` · ${r.brand}` : ""}{r.alt_codes.length ? ` · también ${r.alt_codes.join(", ")}` : ""}</div>
                {r.needs_review && <span className="inv-tag is-warn">Revisar</span>}
              </td>
              <td className="small">{r.category || <span className="muted">Sin rubro</span>}</td>
              <td className="num">
                <div className={"inv-qty" + (r.quantity_on_hand < 0 ? " is-neg" : "")}>{qtyText(r.quantity_on_hand)} <span className="muted small">{r.unit}</span></div>
                <span className={"inv-tag " + state.tone}>{state.label}</span>
              </td>
              <td className="num">{r.price_usd ? <><div>{usd(r.price_usd)}</div><div className="muted small">{r.current_ref_bcv != null ? fmtRef(r.current_ref_bcv) : ""}</div></> : <span className="muted small">Sin precio</span>}</td>
              <td className="num small">{r.average_cost_ref != null ? fmtRef(r.average_cost_ref) : <span className="muted">Sin costo</span>}</td>
              <td>{r.merged_into ? <span className="muted small">—</span> : <label className="inv-switch">
                <input type="checkbox" checked={r.in_catalog} disabled={!canManage || busy || (!r.in_catalog && !((r.price_usd ?? 0) > 0 && r.active))}
                  onChange={() => setCatalog([r.id], !r.in_catalog)}
                  title={!r.in_catalog && !((r.price_usd ?? 0) > 0) ? "Ponle precio para mostrarlo en el catálogo" : undefined} />
                <span>{r.in_catalog ? "Sí" : "No"}</span>
              </label>}</td>
              <td className="inv-actions">
                {r.merged_into ? <span className="muted small">Fusionado en {r.merged_into_sku}</span> : <>
                  {canManage && <button className="btn btn-ghost" onClick={() => beginEdit(r)}>Editar</button>}
                  {location && <button className="btn btn-ghost" onClick={() => setHistoryItem(r)}>Movimientos</button>}
                </>}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
      {!visible.length && <div className="card muted">No hay artículos con este filtro. Cambia el estado, el rubro o la búsqueda.</div>}
    </div>}

    {historyItem && location && <InventoryHistory item={historyItem} location={location} onClose={() => setHistoryItem(null)} />}

    {bulkPrice != null && <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-label="Poner precio">
      <div className="row-between"><h2 style={{ margin: 0 }}>Precio para {selectedRows.length} artículos</h2><button className="btn btn-ghost" onClick={() => setBulkPrice(null)}>Cerrar</button></div>
      <div className="stack inv-bulk-list">{selectedRows.map(r => <div className="small" key={r.id}>{r.sku} · {nameOf(r)}{r.price_usd ? ` · hoy ${usd(r.price_usd)}` : ""}</div>)}</div>
      <label><span className="label">Precio de venta en divisas (USD)</span><input className="input" inputMode="decimal" value={bulkPrice} onChange={e => setBulkPrice(e.target.value)} autoFocus /></label>
      <button className="btn btn-primary btn-block" disabled={busy || !bulkPrice.trim()} onClick={saveBulkPrice}>{busy ? "Guardando…" : "Aplicar precio"}</button>
    </div></div>}

    {form && <div className="overlay"><div className="sheet stack inv-sheet" role="dialog" aria-modal="true" aria-label={form.id ? "Editar artículo" : "Nuevo artículo"}>
      <div className="row-between"><h2 style={{ margin: 0 }}>{form.id ? "Editar artículo" : "Nuevo artículo"}</h2><button className="btn btn-ghost" onClick={() => setForm(null)}>Cerrar</button></div>

      <fieldset className="inv-group"><legend>Identificación</legend>
        <label><span className="label">Nombre de venta</span><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ej. Filtro de aceite Wix 51061" autoFocus /></label>
        <div className="grid grid-2">
          <label><span className="label">Código (SKU)</span><input className="input" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} /></label>
          <label><span className="label">Marca</span><input className="input" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} /></label>
          <label><span className="label">Rubro</span><input className="input" list="inventory-categories" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
          <label><span className="label">Unidad</span><input className="input" list="inventory-units" value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} /></label>
        </div>
        <label><span className="label">Descripción interna</span><input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Como aparece en el conteo o la factura" /></label>
        <label><span className="label">Otros códigos (separados por coma)</span><input className="input" value={form.codes} onChange={e => setForm({ ...form, codes: e.target.value })} placeholder="Ej. CC006, Rav4" /></label>
        <datalist id="inventory-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
        <datalist id="inventory-units"><option value="UND" /><option value="LT" /><option value="GAL" /><option value="KIT" /></datalist>
      </fieldset>

      <fieldset className="inv-group"><legend>Existencia</legend>
        <div className="grid grid-2">
          <label><span className="label">Cantidad en {location?.name ?? "Cabudare"}</span><input className="input" type="number" min="0" step="0.01" value={form.quantity} disabled={!form.active} onChange={e => setForm({ ...form, quantity: e.target.value })} /></label>
          <div className="muted small inv-hint">Hoy el sistema tiene {qtyText(form.originalQuantity)}. Al cambiarla se guarda un ajuste con tu motivo en los movimientos.</div>
        </div>
        {parseDecimal(form.quantity) !== form.originalQuantity && <label><span className="label">Motivo del cambio</span><input className="input" value={form.countNote} onChange={e => setForm({ ...form, countNote: e.target.value })} placeholder="Ej. Recuento del estante" /></label>}
      </fieldset>

      <fieldset className="inv-group"><legend>Precio y costo</legend>
        <div className="grid grid-2">
          <label><span className="label">Precio de venta en divisas (USD)</span><input className="input" inputMode="decimal" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder="Ej. 6.50" /></label>
          <label><span className="label">Costo unitario (REF)</span><input className="input" inputMode="decimal" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} placeholder="Sin costo: se estima precio ÷ 1,35" /></label>
        </div>
        {formPrice != null && formPrice > 0 && rates.operative > 0 && rates.bcv > 0 && <div className="muted small">Se venderá aprox. a {fmtVes(formPrice * rates.operative)}, {fmtRef(formPrice * rates.operative / rates.bcv)}.</div>}
      </fieldset>

      <fieldset className="inv-group"><legend>Estado</legend>
        <label className="row"><input type="checkbox" checked={form.inCatalog} disabled={!form.active} onChange={e => setForm({ ...form, inCatalog: e.target.checked })} /> <span>Mostrar en el catálogo (necesita precio de venta)</span></label>
        <label className="row"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked, inCatalog: e.target.checked && form.inCatalog })} /> <span>Activo (desmárcalo para archivar un artículo que ya no se maneja)</span></label>
        <label className="row"><input type="checkbox" checked={form.needsReview} onChange={e => setForm({ ...form, needsReview: e.target.checked })} /> <span>Por revisar (no se puede vender hasta quitar la marca)</span></label>
        <label><span className="label">Foto (enlace https)</span><input className="input" value={form.image} onChange={e => setForm({ ...form, image: e.target.value })} /></label>
      </fieldset>

      <button className="btn btn-primary btn-block" disabled={busy || form.name.trim().length < 2 || form.sku.trim().length < 2} onClick={saveItem}>{busy ? "Guardando…" : "Guardar"}</button>
    </div></div>}
  </main>;
}

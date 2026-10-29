"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InventoryHistory } from "@/components/inventory-history";
import { catalogIsFresh } from "@/lib/catalog";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { inventorySearchText, matchesSearch } from "@/lib/domain/search";

type InventoryRow = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  unit: string;
  needs_review: boolean;
  location_code: string;
  quantity_on_hand: number;
  catalog_product_name: string | null;
  display_name: string | null;
  price_usd: number | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  alt_codes: string[];
  image_url: string | null;
  updated_at: string | null;
};

type PricingSync = {
  catalogSyncedAt: string | null;
  catalogProducts: number;
  bcv: number;
  bcvEffectiveAt: string | null;
  operative: number;
  operativeEffectiveAt: string | null;
};

type ItemForm = {
  id: string | null;
  sku: string;
  name: string;
  brand: string;
  category: string;
  unit: string;
  price: string;
  image: string;
  codes: string;
  active: boolean;
  updated_at: string | null;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const usd = (v: number) => "$" + v.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nameOf = (r: InventoryRow) => r.display_name || r.description;

function formatSyncDate(value: string | null) {
  if (!value) return "sin sincronizar";
  return new Date(value).toLocaleString("es-VE", { timeZone: "America/Caracas", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function InventoryPage() {
  const [locations, setLocations] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [locationCode, setLocationCode] = useState("CABUDARE");
  const [canManage, setCanManage] = useState(false);
  const [historyItem, setHistoryItem] = useState<InventoryRow | null>(null);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [sync, setSync] = useState<PricingSync | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("TODOS");
  const [stockOnly, setStockOnly] = useState(true);
  const [missingPriceOnly, setMissingPriceOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);
  const [newCount, setNewCount] = useState("");
  const [note, setNote] = useState("");
  const [form, setForm] = useState<ItemForm | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    const [invRes, syncRes, locationRes, permissionRes] = await Promise.all([
      supabase.rpc("get_inventory_snapshot_v2", { p_location_code: locationCode }),
      supabase.rpc("get_pricing_sync_status"),
      supabase.from("locations").select("id,code,name").eq("active", true).order("name"),
      supabase.rpc("can_administer_orders"),
    ]);
    setLocations(locationRes.data ?? []);
    setCanManage(permissionRes.data === true);
    if (invRes.error || syncRes.error || locationRes.error) {
      setError((invRes.error || syncRes.error || locationRes.error)?.message ?? "No pude cargar el inventario.");
      setLoading(false);
      return;
    }
    setRows((invRes.data ?? []).map((r: any) => ({
      ...r,
      quantity_on_hand: Number(r.quantity_on_hand ?? 0),
      price_usd: num(r.price_usd),
      current_price_ves: num(r.current_price_ves),
      current_ref_bcv: num(r.current_ref_bcv),
      alt_codes: Array.isArray(r.alt_codes) ? r.alt_codes : [],
    })) as InventoryRow[]);
    const s = Array.isArray(syncRes.data) ? syncRes.data[0] : syncRes.data;
    if (s) setSync({
      catalogSyncedAt: s.catalog_synced_at ?? null,
      catalogProducts: Number(s.catalog_products ?? 0),
      bcv: Number(s.bcv_rate ?? 0),
      bcvEffectiveAt: s.bcv_effective_at ?? null,
      operative: Number(s.operative_rate ?? 0),
      operativeEffectiveAt: s.operative_effective_at ?? null,
    });
    setLoading(false);
  }

  useEffect(() => {
    load();
    const refreshPricing = () => load();
    window.addEventListener("lubricenter:pricing-updated", refreshPricing);
    return () => window.removeEventListener("lubricenter:pricing-updated", refreshPricing);
  }, [locationCode]);

  const categories = useMemo(() => Array.from(new Set(rows.map(r => r.category).filter(Boolean) as string[])).sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim();
    return rows.filter(r => {
      if (category !== "TODOS" && r.category !== category) return false;
      // Al buscar se muestran también los artículos en cero, para que no parezca que no existen.
      if (stockOnly && !q && r.quantity_on_hand <= 0) return false;
      if (missingPriceOnly && (r.price_usd ?? 0) > 0) return false;
      if (!q) return true;
      return matchesSearch(inventorySearchText(r), q);
    });
  }, [rows, search, category, stockOnly, missingPriceOnly]);

  const withStock = rows.filter(r => r.quantity_on_hand > 0);
  const units = withStock.reduce((sum, r) => sum + r.quantity_on_hand, 0);
  const withoutPrice = withStock.filter(r => !((r.price_usd ?? 0) > 0)).length;
  const review = rows.filter(r => r.needs_review || r.quantity_on_hand < 0).length;
  const pricingFresh = catalogIsFresh(sync);
  const selectedLocation = locations.find(x => x.code === locationCode);

  function beginAdjust(r: InventoryRow) {
    setAdjusting(r);
    setNewCount(String(Math.max(r.quantity_on_hand, 0)));
    setNote("");
    setNotice("");
  }

  function beginEdit(r: InventoryRow | null) {
    setNotice(""); setError("");
    setForm(r ? {
      id: r.id, sku: r.sku, name: nameOf(r), brand: r.brand ?? "", category: r.category ?? "", unit: r.unit || "UND",
      price: r.price_usd != null ? String(r.price_usd) : "", image: r.image_url ?? "", codes: r.alt_codes.join(", "),
      active: true, updated_at: r.updated_at,
    } : { id: null, sku: "", name: "", brand: "", category: category !== "TODOS" ? category : "", unit: "UND", price: "", image: "", codes: "", active: true, updated_at: null });
  }

  async function saveCount() {
    if (!adjusting || newCount === "" || !canManage || !selectedLocation || !note.trim()) return;
    const count = Number(newCount);
    if (!Number.isFinite(count) || count < 0) return setError("El conteo debe ser cero o mayor.");
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("inventory_set_count_at_location", {
      p_inventory_item_id: adjusting.id,
      p_location_id: selectedLocation.id,
      p_expected_quantity: adjusting.quantity_on_hand,
      p_new_count: count,
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) return setError(error.message);
    setAdjusting(null);
    setNotice(`${adjusting.sku}: existencia actualizada a ${count}.`);
    await load();
  }

  async function saveItem() {
    if (!form || !canManage || busy) return;
    const price = form.price.trim() === "" ? null : Number(form.price.replace(",", "."));
    if (price != null && (!Number.isFinite(price) || price < 0)) return setError("El precio en divisas debe ser un número válido.");
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("inventory_save_item", {
      p_id: form.id, p_sku: form.sku, p_display_name: form.name, p_brand: form.brand, p_category: form.category,
      p_unit: form.unit, p_price_usd: price, p_image_url: form.image,
      p_alt_codes: form.codes.split(",").map(x => x.trim()).filter(Boolean), p_active: form.active,
      p_expected_updated_at: form.updated_at,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setNotice(form.id ? `${form.sku}: artículo actualizado.` : `${form.sku}: artículo creado. Registra su existencia con «Ajustar conteo» o una compra.`);
    setForm(null);
    await load();
  }

  async function saveBulkPrice() {
    const price = Number(bulkPrice.replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) return setError("Escribe un precio en divisas mayor que cero.");
    const ids = filtered.map(r => r.id).slice(0, 500);
    if (!ids.length) return;
    setBusy(true); setError(""); setNotice("");
    const { data, error } = await supabase.rpc("inventory_set_price_bulk", { p_item_ids: ids, p_price_usd: price });
    setBusy(false);
    if (error) return setError(error.message);
    setBulkOpen(false); setBulkPrice("");
    setNotice(`Precio ${usd(price)} aplicado a ${Number(data ?? 0)} artículos.`);
    await load();
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">INVENTARIO · CATÁLOGO ÚNICO · {selectedLocation?.name ?? locationCode}</div><h1>Inventario</h1><p>Cada artículo tiene su existencia y su precio. Todo lo que se vende sale de aquí.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className={`card stack ${pricingFresh ? "" : "brand-card"}`}>
      <div className="row-between">
        <div><div className="muted small">PRECIOS</div><strong>Precio base en divisas por artículo</strong></div>
        <span className={`pill ${pricingFresh ? "ok" : "warn"}`}>{pricingFresh ? "TASAS AL DÍA" : "REVISAR TASAS"}</span>
      </div>
      <div className="grid grid-2">
        <div><div className="muted small">SIN PRECIO</div><div>{withoutPrice} artículos con existencia aún no tienen precio</div></div>
        <div><div className="muted small">TASAS</div><div>BCV {sync?.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 }) ?? "—"} · Operativa {sync?.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 }) ?? "—"} · {formatSyncDate(sync?.bcvEffectiveAt ?? null)}</div></div>
      </div>
    </section>

    <label><span className="label">Sede</span><select className="select" value={locationCode} disabled={loading} onChange={e => { setLocationCode(e.target.value); setRows([]); setAdjusting(null); setHistoryItem(null); }}>{locations.map(l => <option key={l.id} value={l.code}>{l.name}</option>)}</select></label>
    <section className="row" style={{ gap: 10, flexWrap: "wrap" }}>
      {canManage && <button className="btn btn-primary" onClick={() => beginEdit(null)}>Nuevo artículo</button>}
      <Link href="/catalog" className="btn btn-ghost">Catálogo visual con fotos ↗</Link>
      <Link href="/catalog/technical" className="btn">Clasificar aceites y filtros</Link>
      <button className="btn btn-ghost" onClick={load} disabled={loading}>{loading ? "Cargando…" : "Recargar"}</button>
    </section>

    <section className="grid grid-3">
      <div className="card"><div className="muted small">CON EXISTENCIA</div><div className="kpi">{withStock.length}</div><div className="muted">de {rows.length} artículos registrados</div></div>
      <div className="card"><div className="muted small">UNIDADES</div><div className="kpi">{units.toLocaleString("es-VE")}</div><div className="muted">Stock actual</div></div>
      <div className="card"><div className="muted small">POR REVISAR</div><div className="kpi">{review}</div><div className="muted">Saldos negativos o en revisión</div></div>
    </section>

    <section className="card stack">
      <div className="grid grid-2">
        <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nombre, código, marca o código del conteo…" />
        <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="TODOS">Todos los rubros</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <label className="row"><input type="checkbox" checked={stockOnly} onChange={e => setStockOnly(e.target.checked)} /> <span>Mostrar solo artículos con existencia</span></label>
      <label className="row"><input type="checkbox" checked={missingPriceOnly} onChange={e => setMissingPriceOnly(e.target.checked)} /> <span>Mostrar solo artículos sin precio</span></label>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="muted small">{filtered.length} artículos visibles</div>
        {canManage && filtered.length > 0 && <button className="btn btn-ghost" onClick={() => { setBulkOpen(true); setBulkPrice(""); }}>Poner un precio a los {Math.min(filtered.length, 500)} visibles</button>}
      </div>
    </section>

    {loading && <div className="card muted">Cargando inventario…</div>}

    {!loading && <section className="stack">
      {filtered.map(r => <article className="card stack" key={r.id}>
        <div className="row-between">
          <div>
            <div className="row"><strong>{nameOf(r)}</strong>{r.needs_review && <span className="pill warn">REVISAR</span>}</div>
            <div className="muted small">{r.sku}{r.brand ? ` · ${r.brand}` : ""} · {r.category || "Sin rubro"}</div>
            {r.alt_codes.length > 0 && <div className="muted small">También: {r.alt_codes.join(" · ")}</div>}
          </div>
          <div style={{ textAlign: "right" }}><div className="money-lg">{r.quantity_on_hand.toLocaleString("es-VE")}</div><div className="muted small">{r.unit}</div></div>
        </div>
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>{r.current_ref_bcv != null && r.price_usd != null
            ? <><strong>{fmtRef(r.current_ref_bcv)}</strong><div className="muted small">{fmtVes(r.current_price_ves ?? 0)} · {usd(r.price_usd)} divisas</div></>
            : <div className="muted small">Sin precio · {canManage ? "edítalo para poder venderlo al precio de lista" : "pide a un administrador que lo cargue"}</div>}</div>
          {canManage && <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn btn-ghost" onClick={() => beginEdit(r)}>Editar / precio</button>
            <button className="btn btn-ghost" onClick={() => setHistoryItem(r)}>Movimientos</button>
            <button className="btn btn-ghost" onClick={() => beginAdjust(r)}>Ajustar conteo</button>
          </div>}
        </div>
      </article>)}
      {!filtered.length && <div className="card error">No hay artículos con este filtro. Desactiva «solo con existencia» o cambia la búsqueda.</div>}
    </section>}

    {historyItem && selectedLocation && <InventoryHistory item={historyItem} location={selectedLocation} onClose={() => setHistoryItem(null)} />}

    {adjusting && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><div><h2 style={{ margin: 0 }}>Conteo físico</h2><div className="muted small">{adjusting.sku} · {nameOf(adjusting)}</div></div><button className="btn btn-ghost" onClick={() => setAdjusting(null)}>Cerrar</button></div>
      <div className="muted">Sistema: {adjusting.quantity_on_hand.toLocaleString("es-VE")} {adjusting.unit}</div>
      <label><span className="label">Cantidad realmente contada</span><input className="input" type="number" min="0" step="0.01" value={newCount} onChange={e => setNewCount(e.target.value)} autoFocus /></label>
      <label><span className="label">Nota</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. Recuento de estante" /></label>
      <button className="btn btn-primary btn-block" disabled={busy || newCount === "" || !note.trim()} onClick={saveCount}>{busy ? "Guardando…" : "Guardar conteo"}</button>
    </div></div>}

    {form && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><h2 style={{ margin: 0 }}>{form.id ? "Editar artículo" : "Nuevo artículo"}</h2><button className="btn btn-ghost" onClick={() => setForm(null)}>Cerrar</button></div>
      <label><span className="label">Nombre de venta</span><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ej. Filtro de aceite Wix 51061" autoFocus /></label>
      <div className="grid grid-2">
        <label><span className="label">Código (SKU)</span><input className="input" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} /></label>
        <label><span className="label">Precio base en divisas (USD)</span><input className="input" inputMode="decimal" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder="Ej. 6.50" /></label>
        <label><span className="label">Marca</span><input className="input" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} /></label>
        <label><span className="label">Rubro</span><input className="input" list="inventory-categories" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
      </div>
      <datalist id="inventory-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
      <label><span className="label">Otros códigos (separados por coma)</span><input className="input" value={form.codes} onChange={e => setForm({ ...form, codes: e.target.value })} placeholder="Ej. CC006, Rav4" /></label>
      <label><span className="label">Foto (enlace https)</span><input className="input" value={form.image} onChange={e => setForm({ ...form, image: e.target.value })} /></label>
      {form.id && <label className="row"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> <span>Activo (desmárcalo para archivar un artículo que ya no se maneja)</span></label>}
      {sync && Number(form.price.replace(",", ".")) > 0 && sync.operative > 0 && sync.bcv > 0 && <div className="muted small">Se venderá aprox. a {fmtVes(Number(form.price.replace(",", ".")) * sync.operative)} · {fmtRef(Number(form.price.replace(",", ".")) * sync.operative / sync.bcv)}</div>}
      <div className="muted small">La existencia no cambia aquí: usa «Ajustar conteo» o registra una compra.</div>
      <button className="btn btn-primary btn-block" disabled={busy || form.name.trim().length < 2 || form.sku.trim().length < 2} onClick={saveItem}>{busy ? "Guardando…" : "Guardar artículo"}</button>
    </div></div>}

    {bulkOpen && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><h2 style={{ margin: 0 }}>Precio para {Math.min(filtered.length, 500)} artículos</h2><button className="btn btn-ghost" onClick={() => setBulkOpen(false)}>Cerrar</button></div>
      <div className="muted small">Se aplica a los artículos visibles con el filtro actual{search.trim() ? ` («${search.trim()}»)` : ""}{category !== "TODOS" ? ` en ${category}` : ""}. Revisa la lista antes de confirmar.</div>
      <div className="stack" style={{ maxHeight: 180, overflow: "auto" }}>{filtered.slice(0, 500).map(r => <div className="small" key={r.id}>{r.sku} · {nameOf(r)}{r.price_usd ? ` · hoy ${usd(r.price_usd)}` : ""}</div>)}</div>
      <label><span className="label">Precio base en divisas (USD)</span><input className="input" inputMode="decimal" value={bulkPrice} onChange={e => setBulkPrice(e.target.value)} autoFocus /></label>
      <button className="btn btn-primary btn-block" disabled={busy || !bulkPrice.trim()} onClick={saveBulkPrice}>{busy ? "Guardando…" : "Aplicar precio"}</button>
    </div></div>}
  </main>;
}

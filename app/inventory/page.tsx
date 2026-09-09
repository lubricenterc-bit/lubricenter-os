"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type InventoryRow = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  unit: string;
  source_cost_ref: number;
  source_alert: string | null;
  needs_review: boolean;
  cost_missing: boolean;
  location_code: string;
  quantity_on_hand: number;
  sellable_quantity: number;
  product_id: string | null;
  catalog_product_name: string | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
};

type CatalogRow = {
  id: string;
  name: string;
  category: string | null;
  available: boolean;
  active: boolean;
  cash_usd_base_price: number;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  image_url: string | null;
  catalog_source: string | null;
  catalog_synced_at: string | null;
};

type PricingSync = {
  catalogSyncedAt: string | null;
  catalogProducts: number;
  bcv: number;
  bcvEffectiveAt: string | null;
  operative: number;
  operativeEffectiveAt: string | null;
};

function formatSyncDate(value: string | null) {
  if (!value) return "sin sincronizar";
  return new Date(value).toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [sync, setSync] = useState<PricingSync | null>(null);
  const [mode, setMode] = useState<"inventory" | "catalog">("inventory");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("TODOS");
  const [stockOnly, setStockOnly] = useState(true);
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);
  const [newCount, setNewCount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    const [invRes, catRes, syncRes] = await Promise.all([
      supabase.rpc("get_inventory_snapshot", { p_location_code: "CABUDARE" }),
      supabase.rpc("get_catalog_snapshot"),
      supabase.rpc("get_pricing_sync_status"),
    ]);

    if (invRes.error || catRes.error || syncRes.error) {
      setError((invRes.error || catRes.error || syncRes.error)?.message ?? "No pude cargar inventario y catálogo.");
      setLoading(false);
      return;
    }

    setRows((invRes.data ?? []).map((r: any) => ({
      ...r,
      source_cost_ref: Number(r.source_cost_ref ?? 0),
      quantity_on_hand: Number(r.quantity_on_hand ?? 0),
      sellable_quantity: Number(r.sellable_quantity ?? 0),
      current_price_ves: r.current_price_ves == null ? null : Number(r.current_price_ves),
      current_ref_bcv: r.current_ref_bcv == null ? null : Number(r.current_ref_bcv),
    })) as InventoryRow[]);

    setCatalog((catRes.data ?? []).map((r: any) => ({
      ...r,
      cash_usd_base_price: Number(r.cash_usd_base_price ?? 0),
      current_price_ves: r.current_price_ves == null ? null : Number(r.current_price_ves),
      current_ref_bcv: r.current_ref_bcv == null ? null : Number(r.current_ref_bcv),
    })) as CatalogRow[]);

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

  useEffect(() => { load(); }, []);

  const inventoryCategories = useMemo(() => Array.from(new Set(rows.map(r => r.category).filter(Boolean) as string[])).sort(), [rows]);
  const catalogCategories = useMemo(() => Array.from(new Set(catalog.map(r => r.category).filter(Boolean) as string[])).sort(), [catalog]);
  const categories = mode === "inventory" ? inventoryCategories : catalogCategories;

  const filteredInventory = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (category !== "TODOS" && r.category !== category) return false;
      if (stockOnly && r.quantity_on_hand <= 0) return false;
      if (!q) return true;
      return `${r.sku} ${r.brand ?? ""} ${r.description} ${r.category ?? ""} ${r.catalog_product_name ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, search, category, stockOnly]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter(r => {
      if (category !== "TODOS" && r.category !== category) return false;
      if (!q) return true;
      return `${r.name} ${r.category ?? ""}`.toLowerCase().includes(q);
    });
  }, [catalog, search, category]);

  const positiveRefs = rows.filter(r => r.quantity_on_hand > 0).length;
  const units = rows.reduce((sum, r) => sum + Math.max(r.quantity_on_hand, 0), 0);
  const review = rows.filter(r => r.needs_review || r.quantity_on_hand < 0).length;
  const catalogAge = sync?.catalogSyncedAt ? (Date.now() - new Date(sync.catalogSyncedAt).getTime()) / 3600000 : Infinity;
  const rateTimes = [sync?.bcvEffectiveAt, sync?.operativeEffectiveAt].filter(Boolean) as string[];
  const rateAge = rateTimes.length ? Math.max(...rateTimes.map(v => (Date.now() - new Date(v).getTime()) / 3600000)) : Infinity;
  const pricingFresh = catalogAge <= 24 && rateAge <= 3;

  function switchMode(next: "inventory" | "catalog") {
    setMode(next);
    setCategory("TODOS");
    setSearch("");
  }

  function beginAdjust(r: InventoryRow) {
    setAdjusting(r);
    setNewCount(String(Math.max(r.quantity_on_hand, 0)));
    setNote("");
    setNotice("");
  }

  async function saveCount() {
    if (!adjusting || newCount === "") return;
    const count = Number(newCount);
    if (!Number.isFinite(count) || count < 0) return setError("El conteo debe ser cero o mayor.");
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("set_inventory_count", {
      p_inventory_item_id: adjusting.id,
      p_new_count: count,
      p_note: note.trim() || "Conteo físico desde Lubricenter OS",
    });
    setBusy(false);
    if (error) return setError(error.message);
    setAdjusting(null);
    setNotice(`${adjusting.sku}: existencia actualizada a ${count}.`);
    await load();
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">INVENTARIO + CATÁLOGO · CABUDARE</div><h1>Productos</h1><p>Existencia física desde el OS y precios comerciales vigentes desde Notion.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className={`card stack ${pricingFresh ? "" : "brand-card"}`}>
      <div className="row-between">
        <div><div className="muted small">FUENTE DE PRECIOS</div><strong>Notion · Nuestros Productos</strong></div>
        <span className={`pill ${pricingFresh ? "ok" : "warn"}`}>{pricingFresh ? "ACTUALIZADO" : "REVISAR"}</span>
      </div>
      <div className="grid grid-2">
        <div><div className="muted small">CATÁLOGO</div><div>{catalog.length} disponibles · {formatSyncDate(sync?.catalogSyncedAt ?? null)}</div></div>
        <div><div className="muted small">TASAS</div><div>BCV {sync?.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 }) ?? "—"} · P2P {sync?.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 }) ?? "—"}</div></div>
      </div>
    </section>

    <section className="row" style={{ gap: 10, flexWrap: "wrap" }}>
      <button className={`btn ${mode === "inventory" ? "btn-primary" : "btn-ghost"}`} onClick={() => switchMode("inventory")}>Inventario físico</button>
      <button className={`btn ${mode === "catalog" ? "btn-primary" : "btn-ghost"}`} onClick={() => switchMode("catalog")}>Catálogo Notion</button>
      <button className="btn btn-ghost" onClick={load} disabled={loading}>{loading ? "Cargando…" : "Recargar"}</button>
    </section>

    {mode === "inventory" && <section className="grid grid-3">
      <div className="card"><div className="muted small">REFERENCIAS</div><div className="kpi">{rows.length}</div><div className="muted">{positiveRefs} con existencia</div></div>
      <div className="card"><div className="muted small">UNIDADES POSITIVAS</div><div className="kpi">{units.toLocaleString("es-VE")}</div><div className="muted">Stock actual</div></div>
      <div className="card"><div className="muted small">POR REVISAR</div><div className="kpi">{review}</div><div className="muted">Conteos o saldos dudosos</div></div>
    </section>}

    {mode === "catalog" && <section className="grid grid-3">
      <div className="card"><div className="muted small">PRODUCTOS DISPONIBLES</div><div className="kpi">{catalog.length}</div><div className="muted">Fuente: Notion</div></div>
      <div className="card"><div className="muted small">PRECIO BASE</div><div className="kpi">USD</div><div className="muted">Precio maestro de Notion</div></div>
      <div className="card"><div className="muted small">PRECIO CLIENTE</div><div className="kpi">REF + Bs</div><div className="muted">Calculado con P2P + BCV</div></div>
    </section>}

    <section className="card stack">
      <div className="grid grid-2">
        <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder={mode === "inventory" ? "Buscar SKU, marca o producto…" : "Buscar producto del catálogo…"} />
        <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="TODOS">Todos los rubros</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {mode === "inventory" && <label className="row"><input type="checkbox" checked={stockOnly} onChange={e => setStockOnly(e.target.checked)} /> <span>Mostrar solo productos con existencia</span></label>}
      <div className="muted small">{mode === "inventory" ? filteredInventory.length : filteredCatalog.length} referencias visibles</div>
    </section>

    {loading && <div className="card muted">Cargando inventario y catálogo…</div>}

    {!loading && mode === "inventory" && <section className="stack">
      {filteredInventory.map(r => <article className="card stack" key={r.id}>
        <div className="row-between">
          <div>
            <div className="row"><strong>{r.sku}</strong>{r.needs_review && <span className="pill warn">REVISAR</span>}</div>
            <div>{r.brand ? `${r.brand} · ` : ""}{r.description}</div>
            <div className="muted small">{r.category || "Sin rubro"}{r.catalog_product_name ? ` · ${r.catalog_product_name}` : ""}</div>
          </div>
          <div style={{ textAlign: "right" }}><div className="money-lg">{r.quantity_on_hand.toLocaleString("es-VE")}</div><div className="muted small">{r.unit}</div></div>
        </div>
        <div className="row-between">
          <div>{r.current_ref_bcv != null ? <><strong>{fmtRef(r.current_ref_bcv)}</strong><div className="muted small">{fmtVes(r.current_price_ves ?? 0)} · precio sugerido</div></> : <div className="muted small">Sin vínculo de precio · podrás escribir el precio al vender</div>}</div>
          <button className="btn btn-ghost" onClick={() => beginAdjust(r)}>Ajustar conteo</button>
        </div>
      </article>)}
      {!filteredInventory.length && <div className="card error">No hay productos visibles con este filtro. Pulsa “Recargar” o desactiva “solo con existencia”.</div>}
    </section>}

    {!loading && mode === "catalog" && <section className="stack">
      {filteredCatalog.map(r => <article className="card stack" key={r.id}>
        <div className="row-between">
          <div><strong>{r.name}</strong><div className="muted small">{r.category || "Sin categoría"} · Notion</div></div>
          <div style={{ textAlign: "right" }}><strong>{fmtRef(r.current_ref_bcv ?? 0)}</strong><div className="muted small">{fmtVes(r.current_price_ves ?? 0)}</div></div>
        </div>
        <div className="row-between"><div className="muted small">Precio base Notion: ${r.cash_usd_base_price.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><span className="pill ok">DISPONIBLE</span></div>
      </article>)}
      {!filteredCatalog.length && <div className="card error">El catálogo no devolvió productos. Pulsa “Recargar” y revisa el indicador de Notion.</div>}
    </section>}

    <section className="card"><strong>Precio editable al vender</strong><div className="muted small">Notion mantiene el precio maestro. En el cambio de aceite podrás modificar el “Precio a cobrar REF” para esa orden sin alterar el catálogo global.</div></section>

    {adjusting && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><div><h2 style={{ margin: 0 }}>Conteo físico</h2><div className="muted small">{adjusting.sku} · {adjusting.brand}</div></div><button className="btn btn-ghost" onClick={() => setAdjusting(null)}>Cerrar</button></div>
      <div className="muted">Sistema: {adjusting.quantity_on_hand.toLocaleString("es-VE")} {adjusting.unit}</div>
      <label><span className="label">Cantidad realmente contada</span><input className="input" type="number" min="0" step="0.01" value={newCount} onChange={e => setNewCount(e.target.value)} autoFocus /></label>
      <label><span className="label">Nota</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. Conteo de apertura" /></label>
      <button className="btn btn-primary btn-block" disabled={busy || newCount === ""} onClick={saveCount}>{busy ? "Guardando…" : "Guardar conteo"}</button>
    </div></div>}
  </main>;
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { NumberField } from "@/components/number-field";
import { ItemPicker } from "@/components/purchasing/item-picker";
import { QuickItemForm } from "@/components/purchasing/quick-item-form";
import {
  DRAFT_KEY, entryTotals, invoiceItems, lineIssue, lineTotal, newAverageCost, unitCostRef,
  type BrandOption, type EntryLine, type PurchasingItem,
} from "@/lib/purchasing";

type Supplier = { id: string; name: string; default_currency: "USD" | "VES"; active: boolean };
type Draft = {
  requestId: string; supplierId: string; number: string; date: string; due: string; currency: "USD" | "VES";
  lines: EntryLine[]; tax: number | null; freight: number | null; discount: number | null; notes: string; receiveAll: boolean;
};
type Done = { invoiceId: string; number: string; received: number };

function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date()); }
function fmt(n: number, currency: "USD" | "VES") {
  const v = Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${v}` : `Bs ${v}`;
}
function qty(n: number) { return Number(n || 0).toLocaleString("es-VE", { maximumFractionDigits: 3 }); }
function newDraft(): Draft {
  return { requestId: crypto.randomUUID(), supplierId: "", number: "", date: today(), due: "", currency: "USD", lines: [],
    tax: null, freight: null, discount: null, notes: "", receiveAll: true };
}
function readDraft(): Draft | null {
  try { const raw = sessionStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) as Draft : null; } catch { return null; }
}
function saveDraft(d: Draft | null) {
  try { if (d) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else sessionStorage.removeItem(DRAFT_KEY); } catch { /* sin almacenamiento */ }
}

/** Ingresar mercancía: factura del proveedor + entrada al inventario en un solo paso. */
export function GoodsEntrySheet({ onClose, initialSupplierId }: { onClose: (changed: boolean) => void; initialSupplierId?: string }) {
  const [draft, setDraft] = useState<Draft>(() => readDraft() ?? { ...newDraft(), supplierId: initialSupplierId ?? "" });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [newSupplier, setNewSupplier] = useState<string | null>(null);
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [supplierBrands, setSupplierBrands] = useState<string[]>([]);
  const [bcv, setBcv] = useState(0);
  const [creating, setCreating] = useState<{ name: string; brand: string } | null>(null);
  const [bulkBrand, setBulkBrand] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  const supplier = suppliers.find(s => s.id === draft.supplierId) ?? null;
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));

  useEffect(() => { if (!done) saveDraft(draft); }, [draft, done]);
  useEffect(() => {
    void Promise.all([
      supabase.from("suppliers").select("id,name,default_currency,active").eq("active", true).order("name"),
      supabase.rpc("purchasing_brands"),
      supabase.rpc("get_current_rates"),
    ]).then(([s, b, r]) => {
      setSuppliers((s.data ?? []) as Supplier[]);
      setBrands((b.data ?? []) as BrandOption[]);
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      setBcv(Number(row?.bcv_rate ?? 0));
    });
  }, []);
  useEffect(() => {
    if (!draft.supplierId) { setSupplierBrands([]); return; }
    void supabase.from("supplier_brands").select("brand_key").eq("supplier_id", draft.supplierId)
      .then(({ data }) => setSupplierBrands((data ?? []).map(x => x.brand_key as string)));
  }, [draft.supplierId]);

  const totals = useMemo(() => entryTotals(draft.lines, draft.tax, draft.freight, draft.discount), [draft]);
  const issues = draft.lines.map(lineIssue);
  const inventoryLines = draft.lines.filter((l): l is Extract<EntryLine, { type: "INVENTORY" }> => l.type === "INVENTORY");
  const ready = !!draft.supplierId && !!draft.number.trim() && !!draft.date && draft.lines.length > 0 && issues.every(x => !x) && totals.total >= 0;

  function addItem(item: PurchasingItem) {
    setDraft(d => {
      const existing = d.lines.find(l => l.type === "INVENTORY" && l.item.id === item.id);
      if (existing) return d;
      const cost = item.last_purchase_cost_ref ?? null;
      return { ...d, lines: [...d.lines, { key: crypto.randomUUID(), type: "INVENTORY", item, quantity: null,
        unit_cost: d.currency === "USD" && cost ? Number(cost) : null }] };
    });
  }
  function updateLine(key: string, patch: Partial<EntryLine>) {
    setDraft(d => ({ ...d, lines: d.lines.map(l => l.key === key ? { ...l, ...patch } as EntryLine : l) }));
  }
  function removeLine(key: string) { setDraft(d => ({ ...d, lines: d.lines.filter(l => l.key !== key) })); }

  async function createSupplier() {
    if (!newSupplier?.trim()) return;
    setBusy(true); setError("");
    const { data, error: e } = await supabase.rpc("upsert_supplier", { p_id: null, p_name: newSupplier.trim(), p_legal_name: null, p_rif: null,
      p_phone: null, p_email: null, p_address: null, p_contact_name: null, p_bank_details: null, p_default_currency: draft.currency,
      p_payment_terms_days: 0, p_notes: null, p_active: true });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const id = typeof data === "string" ? data : (data as { id?: string } | null)?.id;
    const { data: list } = await supabase.from("suppliers").select("id,name,default_currency,active").eq("active", true).order("name");
    setSuppliers((list ?? []) as Supplier[]);
    const created = (list ?? []).find(s => s.id === id) ?? (list ?? []).find(s => s.name === newSupplier.trim());
    if (created) set({ supplierId: created.id });
    setNewSupplier(null);
  }

  async function submit() {
    setBusy(true); setError("");
    const { data, error: e } = await supabase.rpc("purchase_invoice_and_receive", {
      p_request_id: draft.requestId, p_supplier_id: draft.supplierId, p_invoice_number: draft.number.trim(),
      p_invoice_date: draft.date, p_due_date: draft.due || null, p_currency: draft.currency, p_items: invoiceItems(draft.lines),
      p_tax: draft.tax ?? 0, p_discount: draft.discount ?? 0, p_freight: draft.freight ?? 0, p_notes: draft.notes.trim() || null,
      p_location_id: null, p_receive_all: draft.receiveAll,
    });
    setBusy(false);
    if (e) { setError(e.message); setConfirming(false); return; }
    const r = data as { invoice_id: string; stock_after: unknown[] };
    saveDraft(null);
    setDone({ invoiceId: r.invoice_id, number: draft.number.trim(), received: draft.receiveAll ? inventoryLines.length : 0 });
  }

  if (done) return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-label="Mercancía ingresada">
    <div className="success" role="status">Listo: factura {done.number} registrada{done.received ? ` y ${done.received} ${done.received === 1 ? "artículo ingresado" : "artículos ingresados"} al inventario` : ""}.</div>
    <div className="row">
      <Link className="btn" href={`/purchases/${done.invoiceId}`}>Ver factura</Link>
      <button className="btn btn-primary" onClick={() => { setDone(null); setDraft({ ...newDraft(), supplierId: draft.supplierId, currency: draft.currency }); }}>Ingresar otra</button>
      <button className="btn btn-ghost" onClick={() => onClose(true)}>Cerrar</button>
    </div>
  </div></div>;

  const supplierMatches = suppliers.filter(s => !supplierQuery.trim() || s.name.toLowerCase().includes(supplierQuery.trim().toLowerCase())).slice(0, 8);

  return <div className="overlay"><div className="sheet stack pp-sheet" role="dialog" aria-modal="true" aria-labelledby="pp-title">
    <div className="row-between">
      <div><h2 id="pp-title" style={{ margin: 0 }}>Ingresar mercancía</h2><div className="muted small">Registra la factura del proveedor y suma la mercancía al inventario en un paso.</div></div>
      <button className="btn btn-ghost" onClick={() => onClose(false)}>Cerrar</button>
    </div>

    <section className="stack" aria-labelledby="pp-step1">
      <h3 id="pp-step1" className="pp-step">1. Proveedor</h3>
      {supplier ? <div className="row-between pp-chosen">
        <div><strong>{supplier.name}</strong><div className="muted small">{supplierBrands.length ? `${supplierBrands.length} marcas asociadas` : "Sin marcas asociadas: puedes cargarlas en la ficha del proveedor"}</div></div>
        <button className="btn btn-ghost" onClick={() => set({ supplierId: "" })}>Cambiar</button>
      </div> : <div className="stack">
        <input className="input" type="search" placeholder="Buscar proveedor" aria-label="Buscar proveedor" value={supplierQuery} onChange={e => setSupplierQuery(e.target.value)} />
        <div className="pp-chips">{supplierMatches.map(s => <button key={s.id} type="button" className="pp-chip" onClick={() => set({ supplierId: s.id, currency: s.default_currency })}>{s.name}</button>)}
          <button type="button" className="pp-chip is-add" onClick={() => setNewSupplier(supplierQuery)}>+ Nuevo proveedor</button></div>
        {newSupplier !== null && <div className="row"><input className="input" autoFocus value={newSupplier} onChange={e => setNewSupplier(e.target.value)} placeholder="Nombre comercial" aria-label="Nombre del proveedor nuevo" />
          <button className="btn btn-primary" disabled={busy || !newSupplier.trim()} onClick={() => void createSupplier()}>Crear</button>
          <button className="btn btn-ghost" onClick={() => setNewSupplier(null)}>Cancelar</button></div>}
      </div>}
    </section>

    <section className="stack" aria-labelledby="pp-step2">
      <h3 id="pp-step2" className="pp-step">2. Factura</h3>
      <div className="grid grid-2">
        <label><span className="label">Número de factura</span><input className="input" value={draft.number} onChange={e => set({ number: e.target.value })} placeholder="00012345" /></label>
        <label><span className="label">Moneda</span><select className="select" value={draft.currency} onChange={e => set({ currency: e.target.value as "USD" | "VES" })}><option value="USD">USD / REF</option><option value="VES">Bolívares</option></select></label>
        <label><span className="label">Fecha</span><input className="input" type="date" max={today()} value={draft.date} onChange={e => set({ date: e.target.value })} /></label>
        <label><span className="label">Vence (opcional)</span><input className="input" type="date" min={draft.date} value={draft.due} onChange={e => set({ due: e.target.value })} /></label>
      </div>
    </section>

    <section className="stack" aria-labelledby="pp-step3">
      <div className="row-between"><h3 id="pp-step3" className="pp-step">3. Lo que llegó</h3>
        <div className="row"><button type="button" className="btn btn-ghost" onClick={() => setDraft(d => ({ ...d, lines: [...d.lines, { key: crypto.randomUUID(), type: "EXPENSE", description: "", category: "", quantity: 1, unit_cost: null }] }))}>+ Gasto o servicio</button></div></div>
      {creating ? <QuickItemForm initialName={creating.name} initialBrand={creating.brand} brands={brands}
          onCancel={() => setCreating(null)} onCreated={item => { addItem(item); setCreating(null); }} />
        : <ItemPicker supplierId={draft.supplierId || null} supplierBrands={supplierBrands} brands={brands} onPick={addItem}
          onCreate={(text, brandKey) => setCreating({ name: text, brand: brands.find(b => b.brand_key === brandKey)?.name ?? "" })} />}
      {supplierBrands.length > 0 && !creating && <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="muted small">Agregar varios de una marca:</span>
        {brands.filter(b => supplierBrands.includes(b.brand_key)).map(b => <button key={b.brand_key} type="button" className="btn btn-ghost" onClick={() => setBulkBrand(b.brand_key)}>{b.name}</button>)}
      </div>}

      {draft.lines.length === 0 && <p className="muted">Busca el primer artículo de la factura. Si no existe, créalo desde el buscador.</p>}
      <ul className="pp-lines">
        {draft.lines.map((l, i) => <li key={l.key} className="pp-line">
          {l.type === "INVENTORY" ? <div className="pp-line-name"><strong>{l.item.display_name}</strong><small>{l.item.sku} · existencia {qty(l.item.stock)}</small></div>
            : <div className="pp-line-name grid grid-2">
              <label><span className="label">Gasto o servicio</span><input className="input" value={l.description} onChange={e => updateLine(l.key, { description: e.target.value })} placeholder="Flete" /></label>
              <label><span className="label">Categoría</span><input className="input" value={l.category} onChange={e => updateLine(l.key, { category: e.target.value })} placeholder="Transporte" /></label></div>}
          <label className="pp-num"><span className="label">Cantidad</span><NumberField className="input" kind="qty" min={0} value={l.quantity} onChange={v => updateLine(l.key, { quantity: v })} aria-label={`Cantidad ${i + 1}`} /></label>
          <label className="pp-num"><span className="label">Costo c/u {draft.currency === "USD" ? "$" : "Bs"}</span><NumberField className="input" kind="money" min={0} value={l.unit_cost} onChange={v => updateLine(l.key, { unit_cost: v })} aria-label={`Costo ${i + 1}`} /></label>
          <div className="pp-line-total"><span className="label">Subtotal</span><strong>{fmt(lineTotal(l), draft.currency)}</strong>{issues[i] && <small className="pp-issue">{issues[i]}</small>}</div>
          <button type="button" className="btn btn-ghost pp-remove" aria-label="Quitar línea" onClick={() => removeLine(l.key)}>×</button>
        </li>)}
      </ul>
    </section>

    <section className="stack" aria-labelledby="pp-step4">
      <h3 id="pp-step4" className="pp-step">4. Totales</h3>
      <div className="grid grid-3">
        <label><span className="label">Impuesto</span><NumberField className="input" kind="money" min={0} value={draft.tax} onChange={v => set({ tax: v })} /></label>
        <label><span className="label">Flete</span><NumberField className="input" kind="money" min={0} value={draft.freight} onChange={v => set({ freight: v })} /></label>
        <label><span className="label">Descuento</span><NumberField className="input" kind="money" min={0} value={draft.discount} onChange={v => set({ discount: v })} /></label>
      </div>
      <div className="row-between pp-total"><span>Total de la factura</span><strong>{fmt(totals.total, draft.currency)}</strong></div>
      <label className="row"><input type="checkbox" checked={draft.receiveAll} onChange={e => set({ receiveAll: e.target.checked })} /> <span>La mercancía ya llegó completa a Cabudare (se suma al inventario ahora)</span></label>
      <label><span className="label">Notas (opcional)</span><input className="input" value={draft.notes} onChange={e => set({ notes: e.target.value })} /></label>
    </section>

    {error && <div className="error" role="alert">{error}</div>}

    {confirming ? <section className="card stack" aria-labelledby="pp-confirm">
      <h3 id="pp-confirm" className="pp-step">Confirma antes de guardar</h3>
      <ul className="pp-summary">
        {inventoryLines.map(l => {
          const add = l.quantity ?? 0;
          const avg = newAverageCost(l.item.stock, l.item.average_cost_ref, add, unitCostRef(l.unit_cost ?? 0, draft.currency, bcv));
          return <li key={l.key}><strong>+{qty(add)}</strong> {l.item.display_name} {draft.receiveAll ? <span className="muted">(de {qty(l.item.stock)} a {qty(l.item.stock + add)})</span> : null}
            <small className="muted"> · costo promedio nuevo ≈ ${avg.toLocaleString("es-VE", { maximumFractionDigits: 2 })}</small></li>;
        })}
        {draft.lines.filter(l => l.type === "EXPENSE").map(l => <li key={l.key}>{l.type === "EXPENSE" ? l.description : ""} · {fmt(lineTotal(l), draft.currency)}</li>)}
      </ul>
      <div className="row-between pp-total"><span>{supplier?.name} · factura {draft.number}</span><strong>{fmt(totals.total, draft.currency)}</strong></div>
      <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Guardando…" : draft.receiveAll ? "Registrar e ingresar al inventario" : "Registrar factura"}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Volver a editar</button></div>
    </section> : <button className="btn btn-primary btn-block" disabled={!ready} onClick={() => setConfirming(true)}>Revisar y confirmar</button>}

    {bulkBrand && <BulkBrandSheet brandKey={bulkBrand} brandName={brands.find(b => b.brand_key === bulkBrand)?.name ?? bulkBrand}
      supplierId={draft.supplierId} currency={draft.currency} onCancel={() => setBulkBrand(null)}
      onAdd={rows => { setDraft(d => ({ ...d, lines: [...d.lines, ...rows.filter(r => !d.lines.some(l => l.type === "INVENTORY" && l.item.id === r.item.id))] })); setBulkBrand(null); }} />}
  </div></div>;
}

/** Lista completa de una marca con cantidad y costo por fila; agrega las que tengan cantidad. */
function BulkBrandSheet({ brandKey, brandName, supplierId, currency, onCancel, onAdd }: {
  brandKey: string; brandName: string; supplierId: string; currency: "USD" | "VES";
  onCancel: () => void; onAdd: (rows: Extract<EntryLine, { type: "INVENTORY" }>[]) => void;
}) {
  const [items, setItems] = useState<PurchasingItem[] | null>(null);
  const [values, setValues] = useState<Record<string, { q: number | null; c: number | null }>>({});
  useEffect(() => {
    void supabase.rpc("purchasing_item_search", { p_query: "", p_supplier_id: supplierId || null, p_brand_keys: [brandKey], p_categories: null, p_limit: 200 })
      .then(({ data }) => setItems((data ?? []) as PurchasingItem[]));
  }, [brandKey, supplierId]);
  const chosen = (items ?? []).filter(i => (values[i.id]?.q ?? 0) > 0);
  return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-label={`Agregar varios de ${brandName}`}>
    <div className="row-between"><h2 style={{ margin: 0 }}>{brandName}</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <p className="muted small">Escribe la cantidad de lo que llegó. Las filas en blanco no se agregan.</p>
    {!items ? <p className="muted">Cargando…</p> : <ul className="pp-lines">
      {items.map(i => <li key={i.id} className="pp-line is-bulk">
        <div className="pp-line-name"><strong>{i.display_name}</strong><small>{i.sku} · {i.category} · existencia {qty(i.stock)}</small></div>
        <label className="pp-num"><span className="label">Cantidad</span><NumberField className="input" kind="qty" min={0} value={values[i.id]?.q ?? null} onChange={v => setValues(x => ({ ...x, [i.id]: { q: v, c: x[i.id]?.c ?? (currency === "USD" ? i.last_purchase_cost_ref : null) } }))} /></label>
        <label className="pp-num"><span className="label">Costo c/u</span><NumberField className="input" kind="money" min={0} value={values[i.id]?.c ?? (currency === "USD" ? i.last_purchase_cost_ref : null)} onChange={v => setValues(x => ({ ...x, [i.id]: { q: x[i.id]?.q ?? null, c: v } }))} /></label>
      </li>)}
    </ul>}
    <button className="btn btn-primary btn-block" disabled={!chosen.length} onClick={() => onAdd(chosen.map(i => ({ key: crypto.randomUUID(), type: "INVENTORY", item: i, quantity: values[i.id].q, unit_cost: values[i.id].c ?? (currency === "USD" ? i.last_purchase_cost_ref : null) })))}>
      Agregar {chosen.length || ""} {chosen.length === 1 ? "artículo" : "artículos"}</button>
  </div></div>;
}

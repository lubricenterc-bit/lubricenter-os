"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { NumberField } from "@/components/number-field";
import { ItemPicker } from "@/components/purchasing/item-picker";
import { QuickItemForm } from "@/components/purchasing/quick-item-form";
import {
  editItems, editLineIssue, entryTotals, lineTotal, receivedAfterEdit, stockChanges,
  type BrandOption, type EditLine, type PurchasingItem,
} from "@/lib/purchasing";

type Currency = "USD" | "VES";
type Supplier = { id: string; name: string };
export type EditableInvoice = {
  id: string; supplier_id: string; invoice_number: string; invoice_date: string; due_date: string | null; currency: Currency;
  tax_original: number; discount_original: number; freight_original: number; paid_original: number; notes: string | null; updated_at: string;
};
export type EditableItem = {
  id: string; line_type: "INVENTORY" | "EXPENSE"; inventory_item_id: string | null; description: string; expense_category: string | null;
  quantity: number; received_quantity: number; unit_cost_original: number;
};

function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date()); }
function fmt(n: number, c: Currency) {
  const v = Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c === "USD" ? `$${v}` : `Bs ${v}`;
}
function qty(n: number) { return Number(n || 0).toLocaleString("es-VE", { maximumFractionDigits: 3 }); }

/** Editar una factura de proveedor ya registrada. Solo la cuenta del dueño
 *  (la base lo exige en supplier_invoice_update). */
export function InvoiceEditSheet({ invoice, items, hasPayments, onCancel, onDone }: {
  invoice: EditableInvoice; items: EditableItem[]; hasPayments: boolean;
  onCancel: () => void; onDone: () => void | Promise<void>;
}) {
  const original = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const [supplierId, setSupplierId] = useState(invoice.supplier_id);
  const [number, setNumber] = useState(invoice.invoice_number);
  const [date, setDate] = useState(invoice.invoice_date);
  const [due, setDue] = useState(invoice.due_date ?? "");
  const [currency, setCurrency] = useState<Currency>(invoice.currency);
  const [tax, setTax] = useState<number | null>(Number(invoice.tax_original) || null);
  const [freight, setFreight] = useState<number | null>(Number(invoice.freight_original) || null);
  const [discount, setDiscount] = useState<number | null>(Number(invoice.discount_original) || null);
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<EditLine[]>(() => items.map(i => ({
    key: i.id, lineId: i.id, type: i.line_type, itemId: i.inventory_item_id, name: i.description, sku: null,
    description: i.line_type === "EXPENSE" ? i.description : "", category: i.expense_category ?? "",
    quantity: Number(i.quantity), unit_cost: Number(i.unit_cost_original),
    received: Number(i.received_quantity), ordered: Number(i.quantity),
  })));
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [supplierBrands, setSupplierBrands] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | "NEW" | null>(null);
  const [creating, setCreating] = useState<{ name: string; brand: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      supabase.from("suppliers").select("id,name").or(`active.eq.true,id.eq.${invoice.supplier_id}`).order("name"),
      supabase.rpc("purchasing_brands"),
    ]).then(([s, b]) => { setSuppliers((s.data ?? []) as Supplier[]); setBrands((b.data ?? []) as BrandOption[]); });
  }, [invoice.supplier_id]);
  useEffect(() => {
    void supabase.from("supplier_brands").select("brand_key").eq("supplier_id", supplierId)
      .then(({ data }) => setSupplierBrands((data ?? []).map(x => x.brand_key as string)));
  }, [supplierId]);
  // Nombres de los artículos que aparecen en los ajustes de existencia (el original de una línea cuyo producto cambió).
  useEffect(() => {
    const ids = items.map(i => i.inventory_item_id).filter((x): x is string => !!x);
    if (!ids.length) return;
    void supabase.from("inventory_items").select("id,display_name,description").in("id", ids)
      .then(({ data }) => setNames(Object.fromEntries((data ?? []).map(x => [x.id as string, (x.display_name as string) || (x.description as string)]))));
  }, [items]);

  const totals = useMemo(() => entryTotals(lines, tax, freight, discount), [lines, tax, freight, discount]);
  const issues = lines.map(editLineIssue);
  const removedReceived = items.filter(i => i.received_quantity > 0 && !lines.some(l => l.lineId === i.id));
  const paid = Number(invoice.paid_original);
  const belowPaid = hasPayments && totals.total < paid - (currency === "USD" ? 0.05 : 1);
  const ready = !!number.trim() && !!date && lines.length > 0 && issues.every(x => !x) && totals.total >= 0 && !belowPaid && !removedReceived.length;

  const changes = lines.flatMap(l => stockChanges(l, l.lineId ? original.get(l.lineId)?.inventory_item_id ?? null : null))
    .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.itemId]: (acc[c.itemId] ?? 0) + c.delta }), {});
  const changeList = Object.entries(changes).filter(([, d]) => d !== 0);
  const itemName = (id: string) => lines.find(l => l.itemId === id)?.name ?? names[id] ?? "Artículo";

  function update(key: string, patch: Partial<EditLine>) { setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l)); }
  function pick(item: PurchasingItem) {
    const patch = { itemId: item.id, name: item.display_name, sku: item.sku };
    if (picking === "NEW") {
      if (!lines.some(l => l.itemId === item.id)) setLines(ls => [...ls, { key: crypto.randomUUID(), lineId: null, type: "INVENTORY", ...patch,
        description: "", category: "", quantity: null, unit_cost: currency === "USD" && item.last_purchase_cost_ref ? Number(item.last_purchase_cost_ref) : null, received: 0, ordered: 0 }]);
    } else if (picking) update(picking, patch);
    setPicking(null); setCreating(null);
  }

  async function save() {
    setBusy(true); setError("");
    const { error: e } = await supabase.rpc("supplier_invoice_update", {
      p_invoice_id: invoice.id, p_expected_updated_at: invoice.updated_at, p_supplier_id: supplierId,
      p_invoice_number: number.trim(), p_invoice_date: date, p_due_date: due || null, p_currency: currency,
      p_items: editItems(lines), p_tax: tax ?? 0, p_discount: discount ?? 0, p_freight: freight ?? 0,
      p_notes: notes.trim() || null, p_reason: reason.trim() || null,
    });
    setBusy(false);
    if (e) { setError(e.message); setConfirming(false); return; }
    await onDone();
  }

  return <div className="overlay"><div className="sheet stack pp-sheet" role="dialog" aria-modal="true" aria-labelledby="ie-title">
    <div className="row-between">
      <div><h2 id="ie-title" style={{ margin: 0 }}>Editar factura</h2><div className="muted small">Los cambios en lo que ya entró al inventario se registran como ajuste y recalculan el costo promedio.</div></div>
      <button className="btn btn-ghost" onClick={onCancel}>Cerrar</button>
    </div>

    <section className="stack" aria-label="Datos de la factura">
      <div className="grid grid-2">
        <label><span className="label">Proveedor</span>
          <select className="select" value={supplierId} disabled={hasPayments} onChange={e => setSupplierId(e.target.value)}>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {hasPayments && <small className="muted">Tiene pagos: el proveedor y la moneda no se cambian.</small>}
        </label>
        <label><span className="label">Número de factura</span><input className="input" value={number} onChange={e => setNumber(e.target.value)} /></label>
        <label><span className="label">Fecha</span><input className="input" type="date" max={today()} value={date} onChange={e => setDate(e.target.value)} /></label>
        <label><span className="label">Vence (opcional)</span><input className="input" type="date" min={date} value={due} onChange={e => setDue(e.target.value)} /></label>
        <label><span className="label">Moneda</span><select className="select" value={currency} disabled={hasPayments} onChange={e => setCurrency(e.target.value as Currency)}><option value="USD">USD / REF</option><option value="VES">Bolívares</option></select></label>
      </div>
    </section>

    <section className="stack" aria-labelledby="ie-lines">
      <div className="row-between"><h3 id="ie-lines" className="pp-step">Productos y conceptos</h3>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={() => { setPicking("NEW"); setCreating(null); }}>+ Producto</button>
          <button type="button" className="btn btn-ghost" onClick={() => setLines(ls => [...ls, { key: crypto.randomUUID(), lineId: null, type: "EXPENSE", itemId: null, name: "", sku: null, description: "", category: "", quantity: 1, unit_cost: null, received: 0, ordered: 0 }])}>+ Gasto o servicio</button>
        </div></div>
      {picking && (creating
        ? <QuickItemForm initialName={creating.name} initialBrand={creating.brand} brands={brands} onCancel={() => setCreating(null)} onCreated={pick} />
        : <div className="stack"><ItemPicker autoFocus supplierId={supplierId} supplierBrands={supplierBrands} brands={brands} onPick={pick}
            onCreate={(text, brandKey) => setCreating({ name: text, brand: brands.find(b => b.brand_key === brandKey)?.name ?? "" })} />
          <button type="button" className="btn btn-ghost" onClick={() => setPicking(null)}>Cancelar búsqueda</button></div>)}
      <ul className="pp-lines">
        {lines.map((l, i) => {
          const after = receivedAfterEdit(l.received, l.ordered, l.quantity ?? 0);
          return <li key={l.key} className="pp-line">
            {l.type === "INVENTORY" ? <div className="pp-line-name">
              <strong>{l.name || "Elige el producto"}</strong>
              <small>{l.received > 0 ? `Ya ingresó ${qty(l.received)}${after !== l.received ? ` → quedará ${qty(after)}` : ""}` : l.lineId ? "Pendiente de recibir" : "Nueva línea (se recibe después)"}</small>
              <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => { setPicking(l.key); setCreating(null); }}>Cambiar producto</button>
            </div> : <div className="pp-line-name grid grid-2">
              <label><span className="label">Gasto o servicio</span><input className="input" value={l.description} onChange={e => update(l.key, { description: e.target.value })} /></label>
              <label><span className="label">Categoría</span><input className="input" value={l.category} onChange={e => update(l.key, { category: e.target.value })} /></label></div>}
            <label className="pp-num"><span className="label">Cantidad</span><NumberField className="input" kind="qty" min={0} value={l.quantity} onChange={v => update(l.key, { quantity: v })} aria-label={`Cantidad ${i + 1}`} /></label>
            <label className="pp-num"><span className="label">Costo c/u {currency === "USD" ? "$" : "Bs"}</span><NumberField className="input" kind="money" min={0} value={l.unit_cost} onChange={v => update(l.key, { unit_cost: v })} aria-label={`Costo ${i + 1}`} /></label>
            <div className="pp-line-total"><span className="label">Subtotal</span><strong>{fmt(lineTotal(l), currency)}</strong>{issues[i] && <small className="pp-issue">{issues[i]}</small>}</div>
            {l.received > 0
              ? <span className="pp-remove muted small" title="Ya ingresó al inventario: corrige su cantidad o su producto">—</span>
              : <button type="button" className="btn btn-ghost pp-remove" aria-label="Quitar línea" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>×</button>}
          </li>;
        })}
      </ul>
    </section>

    <section className="stack" aria-label="Totales">
      <div className="grid grid-3">
        <label><span className="label">Impuesto</span><NumberField className="input" kind="money" min={0} value={tax} onChange={setTax} /></label>
        <label><span className="label">Flete</span><NumberField className="input" kind="money" min={0} value={freight} onChange={setFreight} /></label>
        <label><span className="label">Descuento</span><NumberField className="input" kind="money" min={0} value={discount} onChange={setDiscount} /></label>
      </div>
      <div className="row-between pp-total"><span>Total de la factura</span><strong>{fmt(totals.total, currency)}</strong></div>
      {belowPaid && <div className="error" role="alert">Ya se pagaron {fmt(paid, currency)}: el total no puede quedar por debajo.</div>}
      <label><span className="label">Notas</span><input className="input" value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <label><span className="label">Motivo del cambio (opcional)</span><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej.: el proveedor corrigió el precio" /></label>
    </section>

    {error && <div className="error" role="alert">{error}</div>}

    {confirming ? <section className="card stack" aria-labelledby="ie-confirm">
      <h3 id="ie-confirm" className="pp-step">Confirma los cambios</h3>
      {changeList.length ? <ul className="pp-summary">{changeList.map(([id, d]) => <li key={id}><strong>{d > 0 ? "+" : ""}{qty(d)}</strong> {itemName(id)} <span className="muted">(ajuste de existencia)</span></li>)}</ul>
        : <p className="muted small">No cambia la existencia de ningún artículo.</p>}
      <div className="row-between pp-total"><span>Factura {number.trim()}</span><strong>{fmt(totals.total, currency)}</strong></div>
      <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar cambios"}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Volver a editar</button></div>
    </section> : <button className="btn btn-primary btn-block" disabled={!ready || busy} onClick={() => setConfirming(true)}>Revisar y guardar</button>}
  </div></div>;
}

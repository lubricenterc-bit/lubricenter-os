"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { NumberField } from "@/components/number-field";
import { CATEGORIES, suggestCode, type BrandOption, type PurchasingItem } from "@/lib/purchasing";

/** Crear un artículo nuevo desde la factura. Queda fuera del catálogo y «por revisar». */
export function QuickItemForm({ initialName, initialBrand, brands, onCancel, onCreated }: {
  initialName: string; initialBrand: string; brands: BrandOption[];
  onCancel: () => void; onCreated: (item: PurchasingItem) => void;
}) {
  const [name, setName] = useState(initialName);
  const [brand, setBrand] = useState(initialBrand);
  const [code, setCode] = useState(suggestCode(initialBrand, initialName));
  const [codeTouched, setCodeTouched] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [unit, setUnit] = useState<"UND" | "L" | "GAL">("UND");
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listId = "pp-brand-options";

  function update(nextName: string, nextBrand: string) {
    if (!codeTouched) setCode(suggestCode(nextBrand, nextName));
  }

  async function save() {
    if (!name.trim() || !code.trim() || !brand.trim() || !category) { setError("Completa nombre, código, marca y rubro."); return; }
    setBusy(true); setError("");
    const { data, error: e } = await supabase.rpc("inventory_save_item_full", {
      p_id: null, p_sku: code.trim().toUpperCase(), p_display_name: name.trim(), p_description: name.trim(), p_brand: brand.trim(),
      p_category: category, p_unit: unit, p_price_usd: null, p_cost_ref: cost, p_image_url: null, p_alt_codes: [],
      p_active: true, p_needs_review: true, p_in_catalog: false, p_expected_updated_at: null,
    });
    if (e) { setBusy(false); setError(e.message); return; }
    const id = (data as { id?: string } | null)?.id;
    const { data: found } = await supabase.rpc("purchasing_item_search", { p_query: code.trim(), p_supplier_id: null, p_brand_keys: null, p_categories: null, p_limit: 5 });
    setBusy(false);
    const item = (found as PurchasingItem[] | null)?.find(x => x.id === id) ?? (found as PurchasingItem[] | null)?.[0];
    if (!item) { setError("Se creó el artículo, pero no pude cargarlo. Búscalo por su código."); return; }
    onCreated(item);
  }

  return <div className="card stack pp-quick" role="group" aria-label="Crear artículo">
    <div className="row-between"><strong>Artículo nuevo</strong><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancelar</button></div>
    <div className="grid grid-2">
      <label><span className="label">Nombre</span><input className="input" autoFocus value={name} onChange={e => { setName(e.target.value); update(e.target.value, brand); }} placeholder="Valvoline 15W-40 mineral" /></label>
      <label><span className="label">Marca</span><input className="input" list={listId} value={brand} onChange={e => { setBrand(e.target.value); update(name, e.target.value); }} placeholder="Valvoline" />
        <datalist id={listId}>{brands.map(b => <option key={b.brand_key} value={b.name} />)}</datalist></label>
      <label><span className="label">Código</span><input className="input" value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setCodeTouched(true); }} placeholder="VAL-15W40-MIN" /></label>
      <label><span className="label">Rubro</span><select className="select" value={category} onChange={e => setCategory(e.target.value)}>
        <option value="">Elige el rubro…</option>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      <label><span className="label">Unidad</span><select className="select" value={unit} onChange={e => setUnit(e.target.value as "UND" | "L" | "GAL")}>
        <option value="UND">Unidad</option><option value="L">Litro</option><option value="GAL">Galón</option></select></label>
      <label><span className="label">Costo REF (opcional)</span><NumberField className="input" kind="money" min={0} value={cost} onChange={setCost} /></label>
    </div>
    <p className="muted small">Queda fuera del catálogo y «por revisar» hasta que le pongas precio de venta en Inventario.</p>
    {error && <div className="error" role="alert">{error}</div>}
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Creando…" : "Crear y agregar a la factura"}</button>
  </div>;
}

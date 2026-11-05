"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { supabase } from "@/lib/supabase";
import { CATEGORIES, type BrandOption, type PurchasingItem } from "@/lib/purchasing";

function qty(n: number) { return Number(n || 0).toLocaleString("es-VE", { maximumFractionDigits: 2 }); }
function ref(n: number | null) { return n === null || n === undefined ? "—" : "$" + Number(n).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** Buscador escribible de artículos para compras (combobox, nunca <select>).
 *  Chips de las marcas del proveedor (activas por defecto) y de rubro. */
export function ItemPicker({ supplierId, supplierBrands, brands, onPick, onCreate, autoFocus }: {
  supplierId: string | null; supplierBrands: string[]; brands: BrandOption[];
  onPick: (item: PurchasingItem) => void; onCreate: (text: string, brandKey: string | null) => void; autoFocus?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [onlySupplier, setOnlySupplier] = useState(true);
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [results, setResults] = useState<PurchasingItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const brandFilter = activeBrand ? [activeBrand] : onlySupplier && supplierBrands.length ? supplierBrands : null;
  const filterKey = JSON.stringify([brandFilter, categories, supplierId]);

  useEffect(() => {
    const text = query.trim();
    if (!text && !activeBrand && !categories.length) { setResults([]); return; }
    const n = ++req.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("purchasing_item_search", {
        p_query: text, p_supplier_id: supplierId, p_brand_keys: brandFilter, p_categories: categories.length ? categories : null, p_limit: 40,
      });
      if (n !== req.current) return;
      setLoading(false);
      setResults(error ? [] : (data as PurchasingItem[]));
      setActive(0);
    }, 200);
    return () => clearTimeout(t);
    // brandFilter se resume en filterKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filterKey]);

  function pick(item: PurchasingItem) {
    onPick(item);
    setQuery(""); setResults([]); setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, Math.max(results.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) pick(results[active]); else if (query.trim()) onCreate(query.trim(), activeBrand); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  const supplierBrandOptions = brands.filter(b => supplierBrands.includes(b.brand_key));
  const otherBrands = brands.filter(b => !supplierBrands.includes(b.brand_key));
  const listId = `${id}-list`;
  const showList = open && (results.length > 0 || (!loading && query.trim().length > 0));

  return <div className="pp-picker">
    <div className="pp-chips" aria-label="Marcas">
      {supplierBrandOptions.length > 0 && <button type="button" className={"pp-chip" + (onlySupplier && !activeBrand ? " is-on" : "")} aria-pressed={onlySupplier && !activeBrand}
        onClick={() => { setOnlySupplier(true); setActiveBrand(null); }}>Marcas del proveedor</button>}
      {supplierBrandOptions.map(b => <button type="button" key={b.brand_key} className={"pp-chip" + (activeBrand === b.brand_key ? " is-on" : "")}
        aria-pressed={activeBrand === b.brand_key} onClick={() => setActiveBrand(activeBrand === b.brand_key ? null : b.brand_key)}>{b.name}</button>)}
      <button type="button" className={"pp-chip" + (!onlySupplier && !activeBrand ? " is-on" : "")} aria-pressed={!onlySupplier && !activeBrand}
        onClick={() => { setOnlySupplier(false); setActiveBrand(null); }}>Todas las marcas</button>
      {!onlySupplier && <select className="select pp-brand-select" aria-label="Otra marca" value={activeBrand ?? ""} onChange={e => setActiveBrand(e.target.value || null)}>
        <option value="">Elegir marca…</option>
        {otherBrands.map(b => <option key={b.brand_key} value={b.brand_key}>{b.name} ({b.items})</option>)}
      </select>}
    </div>
    <div className="pp-chips pp-cats" aria-label="Rubros">
      {CATEGORIES.map(c => <button type="button" key={c} className={"pp-chip is-small" + (categories.includes(c) ? " is-on" : "")} aria-pressed={categories.includes(c)}
        onClick={() => setCategories(cs => cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c])}>{c}</button>)}
    </div>
    <div className="pp-combo">
      <input ref={inputRef} className="input" type="search" role="combobox" aria-expanded={showList} aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={showList && results[active] ? `${id}-opt-${active}` : undefined}
        aria-label="Buscar artículo" placeholder="Escribe el nombre, código o marca (3 letras bastan)" autoComplete="off" autoFocus={autoFocus}
        value={query} onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown} />
      {loading && <span className="pp-loading" aria-hidden="true">Buscando…</span>}
      {showList && <ul id={listId} role="listbox" className="pp-list">
        {results.map((r, i) => <li key={r.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
          className={"pp-option" + (i === active ? " is-active" : "")}
          onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(r)}>
          <div className="pp-option-top"><strong>{r.display_name}</strong><code>{r.sku}</code></div>
          <div className="pp-option-meta">
            {[r.brand, r.category, `existencia ${qty(r.stock)}`, `último costo ${ref(r.last_purchase_cost_ref ?? r.average_cost_ref)}`].filter(Boolean).join(" · ")}
            {r.bought_from_supplier && <span className="pp-badge">Ya se lo compraste</span>}
          </div>
        </li>)}
        {!results.length && query.trim() && <li className="pp-empty">
          No encontré «{query.trim()}». <button type="button" className="btn btn-ghost" onMouseDown={e => e.preventDefault()} onClick={() => onCreate(query.trim(), activeBrand)}>+ Crear artículo «{query.trim()}»</button>
        </li>}
      </ul>}
    </div>
  </div>;
}

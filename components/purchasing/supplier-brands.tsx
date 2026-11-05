"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { BrandOption } from "@/lib/purchasing";

/** Ficha del proveedor: marcas que trae. Se usan como filtro al ingresar mercancía. */
export function SupplierBrands({ supplierId, canManage }: { supplierId: string; canManage: boolean }) {
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      supabase.rpc("purchasing_brands"),
      supabase.from("supplier_brands").select("brand_key").eq("supplier_id", supplierId),
    ]).then(([b, s]) => {
      setBrands((b.data ?? []) as BrandOption[]);
      const keys = (s.data ?? []).map(x => x.brand_key as string);
      setSelected(keys); setSaved(keys);
    });
  }, [supplierId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return brands.filter(b => selected.includes(b.brand_key) || !q || b.name.toLowerCase().includes(q));
  }, [brands, selected, query]);
  const dirty = selected.slice().sort().join("|") !== saved.slice().sort().join("|");

  async function save() {
    setBusy(true); setError(""); setMessage("");
    const { error: e } = await supabase.rpc("supplier_brands_set", { p_supplier_id: supplierId, p_brand_keys: selected });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setSaved(selected);
    setMessage("Marcas guardadas. Aparecen primero al ingresar mercancía de este proveedor.");
  }

  return <section className="card stack" aria-labelledby="supplier-brands-title">
    <div className="row-between"><h2 id="supplier-brands-title" className="section-title">Marcas que trae</h2><span className="muted small">{selected.length} seleccionadas</span></div>
    <input className="input" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar marca" aria-label="Buscar marca" />
    <div className="pp-chips">
      {visible.map(b => {
        const on = selected.includes(b.brand_key);
        return <button key={b.brand_key} type="button" className={"pp-chip" + (on ? " is-on" : "")} aria-pressed={on} disabled={!canManage}
          onClick={() => setSelected(s => on ? s.filter(x => x !== b.brand_key) : [...s, b.brand_key])}>{b.name} <small>{b.items}</small></button>;
      })}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="success" role="status">{message}</div>}
    {canManage && <div className="row"><button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar marcas"}</button></div>}
  </section>;
}

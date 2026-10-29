"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { inventorySearchText, matchesSearch } from "@/lib/domain/search";

/**
 * Lubricenter Norte: cada artículo tiene tres precios en dólares.
 * Contado, divisas y Cashea. Cualquiera se cobra en Bs o en $ a tasa BCV.
 */
type Row = {
  id: string; sku: string; brand: string | null; description: string; category: string | null;
  display_name: string | null; quantity_on_hand: number; alt_codes: string[] | null;
  price_usd: number | null; price_cashea_usd: number | null; price_divisas_usd: number | null;
};
type Draft = { contado: string; divisas: string; cashea: string };

const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
const show = (v: number | null) => (v == null ? "" : String(Number(v)));

export default function TierPricesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [search, setSearch] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [newItem, setNewItem] = useState({ sku: "", name: "", brand: "", category: "" });

  async function load() {
    setLoading(true); setError("");
    const r = await supabase.from("inventory_current")
      .select("id,sku,brand,description,category,display_name,quantity_on_hand,alt_codes,price_usd,price_cashea_usd,price_divisas_usd")
      .eq("location_code", "NORTE").order("brand").order("category").order("sku").limit(2000);
    if (r.error) setError(r.error.message);
    else {
      const data = (r.data ?? []).map((x: any) => ({ ...x, quantity_on_hand: Number(x.quantity_on_hand ?? 0) })) as Row[];
      setRows(data);
      setDrafts(Object.fromEntries(data.map(x => [x.id, { contado: show(x.price_usd), divisas: show(x.price_divisas_usd), cashea: show(x.price_cashea_usd) }])));
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => (!onlyMissing || !r.price_usd || !r.price_divisas_usd || !r.price_cashea_usd)
      && (!q || matchesSearch(inventorySearchText(r as any), q)));
  }, [rows, search, onlyMissing]);
  const priced = rows.filter(r => r.price_usd && r.price_divisas_usd && r.price_cashea_usd).length;

  function dirty(r: Row) {
    const d = drafts[r.id]; if (!d) return false;
    return num(d.contado) !== (r.price_usd == null ? null : Number(r.price_usd))
      || num(d.divisas) !== (r.price_divisas_usd == null ? null : Number(r.price_divisas_usd))
      || num(d.cashea) !== (r.price_cashea_usd == null ? null : Number(r.price_cashea_usd));
  }

  async function save(r: Row) {
    const d = drafts[r.id]; const c = num(d.contado), v = num(d.divisas), k = num(d.cashea);
    for (const x of [c, v, k]) if (x != null && (!Number.isFinite(x) || x < 0)) return setError(`Revisa los precios de ${r.sku}.`);
    setSaving(r.id); setError(""); setNotice("");
    const res = await supabase.rpc("inventory_set_tier_prices", { p_id: r.id, p_contado: c, p_cashea: k, p_divisas: v });
    setSaving(null);
    if (res.error) return setError(res.error.message);
    const out = res.data as any;
    setRows(list => list.map(x => x.id === r.id ? { ...x, price_usd: out.price_usd, price_cashea_usd: out.price_cashea_usd, price_divisas_usd: out.price_divisas_usd } : x));
    setNotice(`Precios de ${r.sku} guardados.`);
  }

  async function create() {
    if (newItem.sku.trim().length < 2 || newItem.name.trim().length < 2) return setError("Escribe el código y el nombre del artículo.");
    setCreating(true); setError(""); setNotice("");
    const res = await supabase.rpc("inventory_save_item", {
      p_id: null, p_sku: newItem.sku, p_display_name: newItem.name, p_brand: newItem.brand, p_category: newItem.category,
      p_unit: "UND", p_price_usd: null, p_image_url: null, p_alt_codes: [], p_active: true,
    });
    setCreating(false);
    if (res.error) return setError(res.error.message);
    setNewItem({ sku: "", name: "", brand: "", category: "" });
    setNotice("Artículo creado. Ahora escribe sus tres precios.");
    await load();
  }

  return <main className="container stack">
    <header className="stack">
      <h1 style={{ margin: 0 }}>Precios de Norte</h1>
      <p className="muted">Cada artículo tiene tres precios en dólares. Al cobrar, el precio elegido se puede pagar en Bs o en $ a tasa BCV. Cashea usa su precio automáticamente.</p>
      <div className="muted small">{priced} de {rows.length} artículos tienen los tres precios.</div>
    </header>

    <section className="card stack">
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <input className="input" style={{ flex: "1 1 260px" }} placeholder="Buscar por código, marca o nombre" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} /> <span>Solo los que faltan</span></label>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="muted" role="status">{notice}</div>}
    </section>

    <section className="card" style={{ overflowX: "auto" }}>
      {loading ? <p className="muted">Cargando artículos…</p> : !visible.length ? <p className="muted">No hay artículos con ese filtro.</p> :
        <table className="table" style={{ width: "100%", minWidth: 720 }}>
          <thead><tr><th>Artículo</th><th style={{ textAlign: "right" }}>Existencia</th><th>Contado $</th><th>Divisas $</th><th>Cashea $</th><th /></tr></thead>
          <tbody>{visible.map(r => {
            const d = drafts[r.id] ?? { contado: "", divisas: "", cashea: "" };
            const set = (patch: Partial<Draft>) => setDrafts(all => ({ ...all, [r.id]: { ...d, ...patch } }));
            return <tr key={r.id}>
              <td><strong>{r.display_name || r.description}</strong><div className="muted small">{[r.brand, r.sku, r.category].filter(Boolean).join(" · ")}</div></td>
              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.quantity_on_hand}</td>
              <td><input className="input" inputMode="decimal" style={{ width: 96 }} aria-label={`Contado ${r.sku}`} value={d.contado} onChange={e => set({ contado: e.target.value })} /></td>
              <td><input className="input" inputMode="decimal" style={{ width: 96 }} aria-label={`Divisas ${r.sku}`} value={d.divisas} onChange={e => set({ divisas: e.target.value })} /></td>
              <td><input className="input" inputMode="decimal" style={{ width: 96 }} aria-label={`Cashea ${r.sku}`} value={d.cashea} onChange={e => set({ cashea: e.target.value })} /></td>
              <td><button className="btn btn-primary" disabled={!dirty(r) || saving === r.id} onClick={() => void save(r)}>{saving === r.id ? "Guardando…" : "Guardar"}</button>
                {!dirty(r) && r.price_usd ? <div className="muted small">{fmtRef(Number(r.price_usd))}</div> : null}</td>
            </tr>;
          })}</tbody>
        </table>}
    </section>

    <section className="card stack">
      <h2 className="section-title">Nuevo artículo</h2>
      <p className="muted small">Para mercancía que no está en la lista. Solo el dueño puede crear artículos.</p>
      <div className="grid grid-2">
        <label><span className="label">Código</span><input className="input" value={newItem.sku} onChange={e => setNewItem({ ...newItem, sku: e.target.value })} /></label>
        <label><span className="label">Nombre de venta</span><input className="input" value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })} /></label>
        <label><span className="label">Marca</span><input className="input" value={newItem.brand} onChange={e => setNewItem({ ...newItem, brand: e.target.value })} /></label>
        <label><span className="label">Categoría</span><input className="input" placeholder="Aceite Motor, Filtro Aceite…" value={newItem.category} onChange={e => setNewItem({ ...newItem, category: e.target.value })} /></label>
      </div>
      <button className="btn" disabled={creating} onClick={() => void create()}>{creating ? "Creando…" : "Crear artículo"}</button>
    </section>
  </main>;
}

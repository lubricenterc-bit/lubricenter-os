"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type InventoryProduct = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  quantity_on_hand: number;
  product_id: string | null;
  catalog_product_name: string | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
};

type CatalogProduct = {
  id: string;
  name: string;
  category: string | null;
  filter_code: string | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
};

type SearchResult = {
  key: string;
  kind: "STOCK" | "CATALOG";
  inventory_item_id?: string;
  product_id?: string;
  title: string;
  subtitle: string;
  stock?: number;
  unit_ref: number;
  unit_ves: number;
};

type CartLine = {
  key: string;
  kind: "STOCK" | "CATALOG" | "MANUAL";
  inventory_item_id?: string;
  product_id?: string;
  description: string;
  quantity: number;
  unit_ref: number;
  source_label: string;
  stock?: number;
};

type Rates = { bcv: number; operative: number };
type CompletedSale = { order_id: string; order_number: string; total_ves: number; total_ref: number };

const PAYMENT_METHODS = [
  ["MOBILE_PAYMENT", "Pago móvil"],
  ["TRANSFER_BDV", "Transferencia BDV"],
  ["TRANSFER_BNC", "Transferencia BNC"],
  ["CASH_VES", "Efectivo Bs"],
  ["CASH_USD", "Efectivo USD"],
] as const;

function normalize(value: string | null | undefined) {
  return (value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function roundToStep(value: number, step = 10) {
  if (!Number.isFinite(value) || step <= 0) return value;
  return Math.round(value / step) * step;
}

export default function QuickSalePage() {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [inventory, setInventory] = useState<InventoryProduct[]>([]);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [manualDescription, setManualDescription] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [completed, setCompleted] = useState<CompletedSale | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    setWarning("");
    const [invRes, catRes, rateRes] = await Promise.all([
      supabase.from("inventory_current")
        .select("id,sku,brand,description,category,quantity_on_hand,product_id,catalog_product_name,current_price_ves,current_ref_bcv")
        .eq("location_code", "CABUDARE")
        .gt("quantity_on_hand", 0)
        .eq("needs_review", false)
        .order("brand")
        .order("sku")
        .limit(1000),
      supabase.from("product_catalog_current")
        .select("id,name,category,filter_code,current_price_ves,current_ref_bcv")
        .eq("available", true)
        .order("name")
        .limit(1000),
      supabase.rpc("get_current_rates"),
    ]);

    const warnings: string[] = [];
    if (invRes.error) warnings.push(`Inventario: ${invRes.error.message}`);
    else setInventory((invRes.data ?? []).map((x: any) => ({
      ...x,
      quantity_on_hand: Number(x.quantity_on_hand ?? 0),
      current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves),
      current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv),
    })) as InventoryProduct[]);

    if (catRes.error) warnings.push(`Catálogo: ${catRes.error.message}`);
    else setCatalog((catRes.data ?? []).map((x: any) => ({
      ...x,
      current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves),
      current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv),
    })) as CatalogProduct[]);

    if (rateRes.error) warnings.push(`Tasas: ${rateRes.error.message}`);
    else {
      const row = Array.isArray(rateRes.data) ? rateRes.data[0] : rateRes.data;
      setRates({ bcv: Number(row?.bcv_rate ?? 0), operative: Number(row?.operative_rate ?? 0) });
    }

    setWarning(warnings.join(" · "));
    setLoading(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  }

  useEffect(() => { load(); }, []);

  const positiveCatalogIds = useMemo(() => new Set(inventory.map(i => i.product_id).filter(Boolean) as string[]), [inventory]);

  const results = useMemo<SearchResult[]>(() => {
    const q = normalize(search.trim());
    const stockResults = inventory
      .filter(i => {
        if (!q) return true;
        return normalize(`${i.sku} ${i.brand ?? ""} ${i.description} ${i.catalog_product_name ?? ""} ${i.category ?? ""}`).includes(q);
      })
      .map(i => ({
        key: `STOCK:${i.id}`,
        kind: "STOCK" as const,
        inventory_item_id: i.id,
        product_id: i.product_id ?? undefined,
        title: [i.brand, i.sku].filter(Boolean).join(" · ") || i.sku,
        subtitle: i.description,
        stock: i.quantity_on_hand,
        unit_ref: Number(i.current_ref_bcv ?? 0),
        unit_ves: Number(i.current_price_ves ?? 0),
      }));

    const catalogResults = catalog
      .filter(p => !positiveCatalogIds.has(p.id))
      .filter(p => {
        if (!q) return true;
        return normalize(`${p.name} ${p.category ?? ""} ${p.filter_code ?? ""}`).includes(q);
      })
      .map(p => ({
        key: `CATALOG:${p.id}`,
        kind: "CATALOG" as const,
        product_id: p.id,
        title: p.name,
        subtitle: [p.category, p.filter_code ? `Código ${p.filter_code}` : null].filter(Boolean).join(" · ") || "Catálogo",
        unit_ref: Number(p.current_ref_bcv ?? 0),
        unit_ves: Number(p.current_price_ves ?? 0),
      }));

    return [...stockResults, ...catalogResults].slice(0, q ? 40 : 24);
  }, [inventory, catalog, positiveCatalogIds, search]);

  function addResult(r: SearchResult) {
    setCompleted(null);
    setCart(lines => {
      const existing = lines.find(x => x.key === r.key);
      if (existing) {
        return lines.map(x => x.key === r.key ? { ...x, quantity: x.quantity + 1 } : x);
      }
      return [...lines, {
        key: r.key,
        kind: r.kind,
        inventory_item_id: r.inventory_item_id,
        product_id: r.product_id,
        description: r.kind === "STOCK" ? `${r.title} · ${r.subtitle}` : r.title,
        quantity: 1,
        unit_ref: r.unit_ref,
        source_label: r.kind === "STOCK" ? `Con stock · ${r.stock ?? 0} disp.` : "Catálogo · sin descontar stock",
        stock: r.stock,
      }];
    });
    setSearch("");
    setTimeout(() => searchRef.current?.focus(), 20);
  }

  function addManual() {
    const description = manualDescription.trim();
    const unitRef = Number(manualPrice);
    const quantity = Number(manualQty || 1);
    if (!description) return setError("Escribe el producto manual.");
    if (!Number.isFinite(unitRef) || unitRef <= 0) return setError("Escribe un precio REF válido.");
    if (!Number.isFinite(quantity) || quantity <= 0) return setError("Escribe una cantidad válida.");
    setError("");
    setCompleted(null);
    setCart(lines => [...lines, {
      key: `MANUAL:${Date.now()}:${Math.random()}`,
      kind: "MANUAL",
      description,
      quantity,
      unit_ref: unitRef,
      source_label: "Venta manual · no altera inventario",
    }]);
    setManualDescription(""); setManualPrice(""); setManualQty("1");
    setTimeout(() => searchRef.current?.focus(), 20);
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart(lines => lines.map(line => line.key === key ? { ...line, ...patch } : line));
  }

  const totalRef = useMemo(() => cart.reduce((sum, line) => sum + line.quantity * Math.max(0, Number(line.unit_ref || 0)), 0), [cart]);
  const totalVes = useMemo(() => cart.reduce((sum, line) => {
    const unitVes = rates.bcv > 0 ? roundToStep(Number(line.unit_ref || 0) * rates.bcv, 10) : 0;
    return sum + unitVes * line.quantity;
  }, 0), [cart, rates.bcv]);
  const cashUsd = rates.operative > 0 ? totalVes / rates.operative : 0;
  const cartValid = cart.length > 0 && cart.every(x => x.quantity > 0 && Number(x.unit_ref) > 0 && (x.kind !== "STOCK" || x.stock == null || x.quantity <= x.stock));

  function payload() {
    return cart.map(line => ({
      kind: line.kind,
      inventory_item_id: line.inventory_item_id ?? null,
      product_id: line.product_id ?? null,
      description: line.description,
      quantity: line.quantity,
      unit_ref: Number(line.unit_ref),
    }));
  }

  async function complete(method: string) {
    if (!cartValid || busy) return;
    setBusy(true); setError(""); setCompleted(null);
    const { data, error } = await supabase.rpc("complete_quick_sale", {
      p_items: payload(),
      p_payment_method: method,
      p_payment_reference: reference.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    setCompleted({
      order_id: row.order_id,
      order_number: row.order_number,
      total_ves: Number(row.total_ves ?? 0),
      total_ref: Number(row.total_ref ?? 0),
    });
    setCart([]); setReference(""); setSearch("");
    await load();
  }

  async function continueAsOrder() {
    if (!cartValid || busy) return;
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("build_quick_sale_order", { p_items: payload() });
    setBusy(false);
    if (error) return setError(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    router.push(`/orders/${row.order_id}`);
  }

  return <main className="container stack">
    <section className="brand-hero">
      <div>
        <div className="eyebrow">MOSTRADOR · PRECIO → VENTA → COBRO</div>
        <h1>Venta rápida</h1>
        <p>Busca precio sin crear una orden. La OS nace solo cuando cobras o decides continuar como orden completa.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}
    {warning && <div className="card" style={{ borderColor: "rgba(255,93,21,.45)" }}><strong>Modo degradado disponible</strong><div className="muted small">{warning}. La venta manual sigue disponible si el catálogo o inventario no cargan.</div></div>}

    {completed && <section className="card stack" style={{ borderColor: "rgba(63,190,115,.55)" }}>
      <div className="row-between"><div><div className="eyebrow">VENTA CERRADA</div><div className="money-lg">{completed.order_number}</div></div><span className="pill ok">COBRADA</span></div>
      <div className="row-between"><strong>{fmtRef(completed.total_ref)}</strong><strong>{fmtVes(completed.total_ves)}</strong></div>
      <div className="grid grid-2"><Link className="btn" href={`/orders/${completed.order_id}/receipt`}>Ver recibo</Link><button className="btn btn-primary" onClick={() => { setCompleted(null); searchRef.current?.focus(); }}>Nueva venta</button></div>
    </section>}

    <section className="card stack">
      <div className="row-between"><div><strong>1. Buscar / cotizar</strong><div className="muted small">SKU, marca, descripción, filtro o nombre. Enter agrega el primer resultado.</div></div><span className="pill">{inventory.length} stock · {catalog.length} catálogo</span></div>
      <input ref={searchRef} className="input" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && results[0]) { e.preventDefault(); addResult(results[0]); } }} placeholder="Ej: Valvoline, 3387, 20W50, refrigerante…" autoFocus />
      {loading ? <div className="muted">Cargando precios…</div> : <div className="stack" style={{ maxHeight: 430, overflow: "auto" }}>
        {results.map(r => <button key={r.key} className="card directory-option" style={{ padding: 14, textAlign: "left" }} onClick={() => addResult(r)}>
          <div className="row-between" style={{ gap: 12 }}>
            <div style={{ minWidth: 0 }}><strong>{r.title}</strong><div className="muted small">{r.subtitle}</div><div className="muted small">{r.kind === "STOCK" ? `Stock físico: ${r.stock}` : "Sin stock confirmado · venta permitida"}</div></div>
            <div style={{ textAlign: "right", flexShrink: 0 }}><div className="money-lg">{r.unit_ref > 0 ? fmtRef(r.unit_ref) : "Sin precio"}</div><div className="muted small">{r.unit_ves > 0 ? fmtVes(r.unit_ves) : "editable al agregar"}</div></div>
          </div>
        </button>)}
        {!results.length && <div className="muted">No aparece en stock ni catálogo. Regístralo abajo como venta manual.</div>}
      </div>}
    </section>

    <section className="card stack">
      <div><strong>Venta manual inmediata</strong><div className="muted small">Para productos que todavía no existen en catálogo. No descuenta inventario.</div></div>
      <input className="input" value={manualDescription} onChange={e => setManualDescription(e.target.value)} placeholder="Descripción del producto" />
      <div className="grid grid-2"><input className="input" type="number" min="0" step="0.01" value={manualPrice} onChange={e => setManualPrice(e.target.value)} placeholder="Precio unitario REF" /><input className="input" type="number" min="0.01" step="0.01" value={manualQty} onChange={e => setManualQty(e.target.value)} placeholder="Cantidad" /></div>
      <button className="btn" onClick={addManual}>+ Agregar manual</button>
    </section>

    <section className="card stack">
      <div className="row-between"><div><strong>2. Venta</strong><div className="muted small">Precio editable por esta venta; nunca cambia el precio maestro de Notion.</div></div><span className="pill">{cart.length} líneas</span></div>
      {cart.map(line => {
        const exceeds = line.kind === "STOCK" && line.stock != null && line.quantity > line.stock;
        return <div className="order-item" key={line.key}>
          <div className="row-between"><div><strong>{line.description}</strong><div className="muted small">{line.source_label}</div></div><button className="btn btn-ghost" onClick={() => setCart(lines => lines.filter(x => x.key !== line.key))}>Quitar</button></div>
          <div className="grid grid-2" style={{ marginTop: 10 }}>
            <label><span className="label">Cantidad</span><input className="input" type="number" min="0.01" step="0.01" value={line.quantity} onChange={e => updateLine(line.key, { quantity: Number(e.target.value) })} /></label>
            <label><span className="label">Precio unitario REF</span><input className="input" type="number" min="0.01" step="0.01" value={line.unit_ref || ""} onChange={e => updateLine(line.key, { unit_ref: Number(e.target.value) })} /></label>
          </div>
          <div className="row-between"><span className="muted small">Subtotal</span><strong>{fmtRef(line.quantity * Number(line.unit_ref || 0))}</strong></div>
          {exceeds && <div className="error">Solo hay {line.stock} en stock físico. Reduce la cantidad o vende la diferencia desde catálogo/manual para no descontar inventario inexistente.</div>}
        </div>;
      })}
      {!cart.length && <div className="muted">Agrega productos para armar la cotización. Todavía no se crea ninguna OS.</div>}
    </section>

    <section className="card stack" style={{ position: "sticky", bottom: 78, zIndex: 3 }}>
      <div className="row-between"><div><div className="muted small">TOTAL A COBRAR</div><div className="money-lg">{fmtRef(totalRef)}</div></div><div style={{ textAlign: "right" }}><strong>{fmtVes(totalVes)}</strong><div className="muted small">USD físico aprox. {cashUsd.toFixed(2)}</div></div></div>
      <input className="input" value={reference} onChange={e => setReference(e.target.value)} placeholder="Referencia de pago (opcional)" />
      <div className="grid grid-2">
        {PAYMENT_METHODS.map(([method, label]) => <button key={method} className={method === "MOBILE_PAYMENT" ? "btn btn-primary" : "btn"} disabled={!cartValid || busy} onClick={() => complete(method)}>{busy ? "Procesando…" : label}</button>)}
      </div>
      <button className="btn btn-ghost btn-block" disabled={!cartValid || busy} onClick={continueAsOrder}>Pago mixto / Crédito LC / asociar cliente → continuar como orden</button>
      {!cartValid && cart.length > 0 && <div className="muted small">Corrige cantidades o precios antes de cobrar.</div>}
    </section>
  </main>;
}

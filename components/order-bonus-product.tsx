"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type InventoryRow = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  quantity_on_hand: number;
};

export function OrderBonusProduct({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const { data, error } = await supabase
      .from("inventory_current")
      .select("id,sku,brand,description,category,quantity_on_hand")
      .eq("location_code", "CABUDARE")
      .gt("quantity_on_hand", 0)
      .eq("needs_review", false)
      .order("category")
      .order("brand")
      .order("sku")
      .limit(1000);
    if (error) return setError(error.message);
    setRows((data ?? []).map((r: any) => ({ ...r, quantity_on_hand: Number(r.quantity_on_hand ?? 0) })) as InventoryRow[]);
  }

  useEffect(() => { if (open && rows.length === 0) load(); }, [open]);

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => rows.filter(r => `${r.sku} ${r.brand ?? ""} ${r.description} ${r.category ?? ""}`.toLowerCase().includes(q)).slice(0, 80), [rows, q]);
  const selected = rows.find(r => r.id === selectedId) ?? null;

  async function addBonus() {
    if (!selected) return setError("Selecciona un producto del inventario.");
    if (!Number.isFinite(qty) || qty <= 0) return setError("La cantidad debe ser mayor que cero.");
    if (qty > selected.quantity_on_hand) return setError(`Solo hay ${selected.quantity_on_hand} disponibles.`);
    setBusy(true); setError("");
    const { error } = await supabase.rpc("add_inventory_bonus_item", {
      p_order_id: orderId,
      p_inventory_item_id: selected.id,
      p_quantity: qty,
      p_reason: reason.trim() || null,
      p_business_area: "STORE",
    });
    setBusy(false);
    if (error) return setError(error.message);
    window.location.reload();
  }

  return <>
    <button className="btn" onClick={() => setOpen(true)}>🎁 Producto bonificado</button>
    {open && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><div><h2 style={{ margin: 0 }}>Producto bonificado</h2><div className="muted small">Cortesía física: cobra $0, pero sí descuenta inventario al cerrar la orden.</div></div><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cerrar</button></div>
      <div className="success small">Para servicios gratis que no consumen inventario usa “Servicios adicionales / Bonificaciones” en Salida CRM. Usa esta opción solo cuando entregas un producto físico.</div>
      <label><span className="label">Buscar inventario</span><input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="SKU, marca o descripción" autoFocus /></label>
      <div className="stack" style={{ maxHeight: 300, overflow: "auto" }}>
        {visible.map(r => <button key={r.id} className="btn btn-ghost" style={{ textAlign: "left", borderColor: selectedId === r.id ? "#ff5d15" : undefined }} onClick={() => setSelectedId(r.id)}>
          <div className="row-between"><strong>{r.sku} · {r.brand ?? "Producto"}</strong><span className="pill">Stock {r.quantity_on_hand}</span></div>
          <div className="small">{r.description}</div><div className="muted small">{r.category ?? "Sin rubro"}</div>
        </button>)}
        {!visible.length && <div className="card muted">No hay coincidencias con existencia positiva.</div>}
      </div>
      {selected && <div className="card stack">
        <strong>{selected.sku} · {selected.description}</strong>
        <div className="grid grid-2">
          <label><span className="label">Cantidad</span><input className="input" type="number" min="0.01" step="0.01" value={qty} onChange={e => setQty(Number(e.target.value))} /></label>
          <label><span className="label">Motivo / cortesía</span><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej. Cortesía post-servicio" /></label>
        </div>
        <div className="row-between"><span>Cliente paga</span><strong>REF $0.00</strong></div>
        <div className="muted small">Al cerrar la orden se descontarán {qty} unidad(es) del inventario físico.</div>
      </div>}
      {error && <div className="error">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy || !selected || qty <= 0} onClick={addBonus}>{busy ? "Agregando…" : "Agregar cortesía física"}</button>
    </div></div>}
  </>;
}

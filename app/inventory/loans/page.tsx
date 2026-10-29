"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { inventorySearchText, matchesSearch } from "@/lib/domain/search";

/** Préstamos de mercancía con otras sucursales. Solo se registran aquí; no se cruzan con otros sistemas. */
type Loan = {
  id: string; direction: "LENT" | "BORROWED"; counterparty: string; description: string;
  quantity: number; settled_quantity: number; status: "OPEN" | "SETTLED"; note: string | null; occurred_on: string;
};
type Item = { id: string; sku: string; brand: string | null; description: string; display_name: string | null; category: string | null; alt_codes: string[] | null; quantity_on_hand: number };

const BRANCHES = ["Cabudare", "El Cují", "La Morán"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [showSettled, setShowSettled] = useState(false);
  const [direction, setDirection] = useState<"LENT" | "BORROWED">("BORROWED");
  const [counterparty, setCounterparty] = useState(BRANCHES[0]);
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [l, i] = await Promise.all([
      supabase.from("merchandise_loans").select("id,direction,counterparty,description,quantity,settled_quantity,status,note,occurred_on").order("occurred_on", { ascending: false }).limit(500),
      supabase.from("inventory_current").select("id,sku,brand,description,display_name,category,alt_codes,quantity_on_hand").eq("location_code", "NORTE").order("brand").limit(2000),
    ]);
    if (l.error) setError(l.error.message); else setLoans((l.data ?? []).map((x: any) => ({ ...x, quantity: Number(x.quantity), settled_quantity: Number(x.settled_quantity) })));
    if (i.error) setError(i.error.message); else setItems((i.data ?? []) as Item[]);
  }
  useEffect(() => { void load(); }, []);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase(); if (q.length < 2) return [];
    return items.filter(x => matchesSearch(inventorySearchText(x as any), q)).slice(0, 6);
  }, [items, search]);
  const selected = items.find(x => x.id === itemId);
  const visible = loans.filter(l => showSettled || l.status === "OPEN");
  const owedToUs = loans.filter(l => l.status === "OPEN" && l.direction === "LENT").length;
  const weOwe = loans.filter(l => l.status === "OPEN" && l.direction === "BORROWED").length;

  async function register() {
    const q = Number(quantity);
    if (!itemId && description.trim().length < 2) return setError("Elige el artículo o describe la mercancía.");
    if (!Number.isFinite(q) || q <= 0) return setError("Escribe una cantidad válida.");
    setBusy(true); setError(""); setNotice("");
    const r = await supabase.rpc("loan_register", { p_direction: direction, p_counterparty: counterparty, p_inventory_item_id: itemId, p_description: itemId ? "" : description, p_quantity: q, p_note: note, p_occurred_on: date });
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setItemId(null); setSearch(""); setDescription(""); setQuantity("1"); setNote("");
    setNotice(direction === "LENT" ? "Préstamo registrado. La mercancía salió del inventario." : "Registrado. La mercancía prestada entró al inventario.");
    await load();
  }

  async function settle(l: Loan, mode: "GOODS" | "PAID") {
    const left = l.quantity - l.settled_quantity;
    const text = window.prompt(mode === "GOODS" ? `¿Cuántas unidades se devolvieron? (quedan ${left})` : `¿Cuántas unidades se pagaron en dinero? (quedan ${left})`, String(left));
    if (text == null) return;
    const q = Number(text.replace(",", "."));
    if (!Number.isFinite(q) || q <= 0 || q > left) return setError(`Cantidad inválida: quedan ${left}.`);
    setBusy(true); setError(""); setNotice("");
    const r = await supabase.rpc("loan_settle", { p_loan: l.id, p_quantity: q, p_mode: mode, p_amount_usd: null, p_note: null });
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setNotice("Devolución registrada."); await load();
  }

  return <main className="container stack">
    <header className="stack">
      <h1 style={{ margin: 0 }}>Préstamos de mercancía</h1>
      <p className="muted">Lo que Norte presta o recibe prestado de otras sucursales. Prestar saca la mercancía del inventario; recibir prestado la agrega. Al devolver, se revierte.</p>
      <div className="muted small">{weOwe} préstamos por devolver · {owedToUs} por cobrar</div>
    </header>

    <section className="card stack">
      <h2 className="section-title">Registrar préstamo</h2>
      <div className="segmented" role="group" aria-label="Tipo de préstamo">
        <button type="button" className={`btn ${direction === "BORROWED" ? "btn-primary" : "btn-ghost"}`} onClick={() => setDirection("BORROWED")}>Nos prestaron</button>
        <button type="button" className={`btn ${direction === "LENT" ? "btn-primary" : "btn-ghost"}`} onClick={() => setDirection("LENT")}>Prestamos</button>
      </div>
      <div className="grid grid-2">
        <label><span className="label">{direction === "LENT" ? "A qué sucursal" : "De qué sucursal"}</span>
          <input className="input" list="loan-branches" value={counterparty} onChange={e => setCounterparty(e.target.value)} />
          <datalist id="loan-branches">{BRANCHES.map(b => <option key={b} value={b} />)}</datalist></label>
        <label><span className="label">Fecha</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      </div>
      {selected ? <div className="row-between card"><span><strong>{selected.display_name || selected.description}</strong> <span className="muted small">{selected.sku} · existencia {Number(selected.quantity_on_hand)}</span></span><button className="btn btn-ghost" onClick={() => setItemId(null)}>Cambiar</button></div>
        : <label><span className="label">Artículo del inventario</span><input className="input" placeholder="Buscar por código, marca o nombre" value={search} onChange={e => setSearch(e.target.value)} />
          {matches.length > 0 && <div className="stack" style={{ gap: 4, marginTop: 6 }}>{matches.map(m => <button key={m.id} type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start" }} onClick={() => { setItemId(m.id); setSearch(""); }}>{m.brand} · {m.sku} · {m.display_name || m.description}</button>)}</div>}
          <span className="muted small">Si no está en el inventario, descríbelo abajo (no moverá existencias).</span></label>}
      {!selected && <label><span className="label">Descripción (si no está en el inventario)</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label>}
      <div className="grid grid-2">
        <label><span className="label">Cantidad</span><input className="input" inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        <label><span className="label">Nota (opcional)</span><input className="input" value={note} onChange={e => setNote(e.target.value)} /></label>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="muted" role="status">{notice}</div>}
      <button className="btn btn-primary" disabled={busy} onClick={() => void register()}>{busy ? "Registrando…" : direction === "LENT" ? "Registrar lo que prestamos" : "Registrar lo que nos prestaron"}</button>
    </section>

    <section className="card stack">
      <div className="row-between"><h2 className="section-title">Préstamos</h2>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={showSettled} onChange={e => setShowSettled(e.target.checked)} /> <span>Ver también los saldados</span></label></div>
      {!visible.length ? <p className="muted">No hay préstamos pendientes.</p> :
        <table className="table" style={{ width: "100%" }}>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Sucursal</th><th>Mercancía</th><th style={{ textAlign: "right" }}>Pendiente</th><th /></tr></thead>
          <tbody>{visible.map(l => <tr key={l.id}>
            <td>{l.occurred_on}</td>
            <td>{l.direction === "LENT" ? "Prestamos" : "Nos prestaron"}</td>
            <td>{l.counterparty}</td>
            <td>{l.description}{l.note ? <div className="muted small">{l.note}</div> : null}</td>
            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.status === "SETTLED" ? "Saldado" : `${l.quantity - l.settled_quantity} de ${l.quantity}`}</td>
            <td>{l.status === "OPEN" && <div className="row" style={{ gap: 6 }}>
              <button className="btn" disabled={busy} onClick={() => void settle(l, "GOODS")}>{l.direction === "LENT" ? "Nos devolvieron" : "Devolvimos"}</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void settle(l, "PAID")}>Se pagó</button>
            </div>}</td>
          </tr>)}</tbody>
        </table>}
    </section>
  </main>;
}

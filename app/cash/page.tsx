"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtVes } from "@/lib/format";

type Account = {
  id: string;
  code: string;
  name: string;
  currency: "VES" | "USD";
  account_type: string;
  active: boolean;
  balance_native: number;
  balance_ves: number;
};
type Movement = {
  id: string;
  account_id: string;
  direction: "IN" | "OUT";
  movement_type: string;
  currency: "VES" | "USD";
  amount_original: number;
  value_ves: number;
  category: string | null;
  note: string | null;
  reference: string | null;
  occurred_at: string;
};
type Modal = "EXPENSE" | "TRANSFER" | null;

export default function CashPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    const [{ data: a, error: ae }, { data: m, error: me }] = await Promise.all([
      supabase.from("account_balances_current").select("id,code,name,currency,account_type,active,balance_native,balance_ves").eq("active", true).order("account_type").order("name"),
      supabase.from("account_movements").select("id,account_id,direction,movement_type,currency,amount_original,value_ves,category,note,reference,occurred_at").order("occurred_at", { ascending: false }).limit(150),
    ]);
    if (ae || me) setError((ae || me)?.message ?? "No pude cargar caja.");
    else { setAccounts((a ?? []) as Account[]); setMovements((m ?? []) as Movement[]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const totalVes = accounts.filter(a => a.account_type !== "RELATED").reduce((sum, a) => sum + Number(a.balance_ves || 0), 0);
  const cashUsd = accounts.find(a => a.code === "CASH_USD");
  const banksVes = accounts.filter(a => a.account_type === "BANK" || a.account_type === "CLEARING").reduce((sum, a) => sum + Number(a.balance_native || 0), 0);

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">CAJA · BANCOS</div><h1>Dinero operativo</h1><p>Los pagos de las órdenes entran aquí automáticamente. Gastos y transferencias quedan separados para no falsear ventas.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {error && <div className="error">{error}</div>}

    <section className="grid grid-3">
      <div className="card"><div className="muted small">VALOR REGISTRADO</div><div className="kpi">{fmtVes(totalVes)}</div><div className="muted small">Equivalente operativo de cuentas propias.</div></div>
      <div className="card"><div className="muted small">BANCOS / PAGO MÓVIL</div><div className="kpi">{fmtVes(banksVes)}</div></div>
      <div className="card"><div className="muted small">CAJA USD</div><div className="kpi">${Number(cashUsd?.balance_native ?? 0).toFixed(2)}</div></div>
    </section>

    <section className="row" style={{ flexWrap: "wrap" }}>
      <button className="btn btn-primary" onClick={() => setModal("EXPENSE")}>+ Registrar gasto</button>
      <button className="btn" onClick={() => setModal("TRANSFER")}>↔ Transferencia interna</button>
    </section>

    <section className="grid grid-2">
      {accounts.map(a => <div className="card stack" key={a.id}>
        <div className="row-between"><div><div className="muted small">{accountTypeLabel(a.account_type)}</div><strong>{a.name}</strong></div><span className="pill">{a.currency}</span></div>
        <div className="kpi">{a.currency === "USD" ? `$${Number(a.balance_native).toFixed(2)}` : fmtVes(a.balance_native)}</div>
        {a.currency === "USD" && <div className="muted small">Equivalente actual registrado: {fmtVes(a.balance_ves)}</div>}
        {a.code === "MOBILE" && <div className="muted small">Pago móvil queda separado hasta que definamos a qué banco llega por defecto.</div>}
        {a.code === "CUJI" && <div className="muted small">Cuenta relacionada: mover dinero aquí no se registra como gasto operativo.</div>}
      </div>)}
      {!accounts.length && !loading && <div className="card muted">No hay cuentas configuradas.</div>}
    </section>

    <section className="card stack">
      <div className="row-between"><div><h2 className="section-title">Movimientos recientes</h2><div className="muted small">Pagos, gastos y transferencias.</div></div><span className="pill">{movements.length}</span></div>
      {movements.map(m => {
        const a = accountMap.get(m.account_id);
        return <div className="order-item" key={m.id}>
          <div className="row-between"><div><strong>{movementLabel(m)}</strong><div className="muted small">{a?.name ?? "Cuenta"} · {fmtDate(m.occurred_at)}{m.reference ? ` · Ref. ${m.reference}` : ""}</div>{m.note && <div className="muted small">{m.note}</div>}</div><div style={{ textAlign: "right" }}><strong style={{ color: m.direction === "IN" ? "var(--ok)" : "var(--danger)" }}>{m.direction === "IN" ? "+" : "−"}{m.currency === "USD" ? `$${Number(m.amount_original).toFixed(2)}` : fmtVes(m.amount_original)}</strong><div className="muted small">{fmtVes(m.value_ves)}</div></div></div>
        </div>;
      })}
      {!movements.length && <div className="muted">Los movimientos aparecerán cuando registres pagos, gastos o transferencias.</div>}
    </section>

    {modal === "EXPENSE" && <ExpenseSheet accounts={accounts.filter(a => a.account_type !== "RELATED")} onCancel={() => setModal(null)} onDone={async () => { setModal(null); await load(); }} />}
    {modal === "TRANSFER" && <TransferSheet accounts={accounts} onCancel={() => setModal(null)} onDone={async () => { setModal(null); await load(); }} />}
  </main>;
}

function accountTypeLabel(type: string) {
  return ({ CASH: "EFECTIVO", BANK: "BANCO", CLEARING: "POR CLASIFICAR", RELATED: "RELACIONADA" } as Record<string,string>)[type] ?? type;
}
function movementLabel(m: Movement) {
  if (m.movement_type === "PAYMENT") return "Pago de cliente";
  if (m.movement_type === "EXPENSE") return m.category ? `Gasto · ${m.category}` : "Gasto";
  if (m.movement_type === "TRANSFER") return m.direction === "IN" ? "Transferencia recibida" : "Transferencia enviada";
  return "Ajuste";
}

function ExpenseSheet({ accounts, onCancel, onDone }: { accounts: Account[]; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState(0);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = accounts.find(a => a.id === accountId);

  async function save() {
    if (!accountId || amount <= 0 || !category.trim()) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_account_expense", { p_account_id: accountId, p_amount: amount, p_category: category.trim(), p_note: note.trim() || null, p_reference: reference.trim() || null });
    setBusy(false);
    if (error) return setError(error.message);
    await onDone();
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Registrar gasto</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <label><span className="label">Cuenta que paga</span><select className="select" value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
    <label><span className="label">Monto {account?.currency ?? ""}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} /></label>
    <label><span className="label">Categoría</span><input className="input" value={category} onChange={e => setCategory(e.target.value)} placeholder="Ej. insumos, comida, repuesto, servicio" /></label>
    <label><span className="label">Nota</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Qué se pagó" /></label>
    <label><span className="label">Referencia opcional</span><input className="input" value={reference} onChange={e => setReference(e.target.value)} /></label>
    <div className="muted small">Esto reduce la cuenta seleccionada y queda como gasto. Para dinero enviado a El Cuji usa Transferencia interna.</div>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !accountId || amount <= 0 || !category.trim()} onClick={save}>{busy ? "Guardando…" : "Registrar gasto"}</button>
  </div></div>;
}

function TransferSheet({ accounts, onCancel, onDone }: { accounts: Account[]; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [fromId, setFromId] = useState(accounts[0]?.id ?? "");
  const [toId, setToId] = useState(accounts[1]?.id ?? "");
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = accounts.find(a => a.id === fromId);
  const compatible = accounts.filter(a => a.id !== fromId && a.currency === from?.currency);

  useEffect(() => { if (toId === fromId || !compatible.some(a => a.id === toId)) setToId(compatible[0]?.id ?? ""); }, [fromId]);

  async function save() {
    if (!fromId || !toId || amount <= 0) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_internal_transfer", { p_from_account_id: fromId, p_to_account_id: toId, p_amount: amount, p_note: note.trim() || null, p_reference: reference.trim() || null });
    setBusy(false);
    if (error) return setError(error.message);
    await onDone();
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Transferencia interna</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <label><span className="label">Desde</span><select className="select" value={fromId} onChange={e => setFromId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
    <label><span className="label">Hacia</span><select className="select" value={toId} onChange={e => setToId(e.target.value)}>{compatible.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
    <label><span className="label">Monto {from?.currency ?? ""}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} /></label>
    <label><span className="label">Nota</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Ej. transferencia a El Cuji" /></label>
    <label><span className="label">Referencia opcional</span><input className="input" value={reference} onChange={e => setReference(e.target.value)} /></label>
    <div className="muted small">Una transferencia mueve el saldo entre cuentas; no aumenta ventas ni gastos.</div>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !fromId || !toId || amount <= 0} onClick={save}>{busy ? "Moviendo…" : "Registrar transferencia"}</button>
  </div></div>;
}

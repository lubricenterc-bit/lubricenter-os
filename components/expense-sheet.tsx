"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export type ExpenseAccount = { id: string; name: string; currency: "VES" | "USD"; account_type: string };

const categories = ["Insumos", "Repuestos", "Servicios", "Alquiler", "Nómina", "Comida", "Transporte", "Mantenimiento", "Impuestos", "Publicidad", "Otros"];

export function ExpenseSheet({ accounts, onCancel, onDone }: { accounts: ExpenseAccount[]; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState(0);
  const [category, setCategory] = useState("");
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [occurredOn, setOccurredOn] = useState(localDate());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = accounts.find(a => a.id === accountId);

  async function save() {
    if (!accountId || amount <= 0 || !category.trim() || !occurredOn) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_account_expense_v2", {
      p_account_id: accountId, p_amount: amount, p_category: category.trim(),
      p_payee: payee.trim() || null, p_note: note.trim() || null,
      p_reference: reference.trim() || null, p_occurred_on: occurredOn,
    });
    setBusy(false);
    if (error) return setError(error.message);
    await onDone();
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><div><h2 style={{ margin: 0 }}>Registrar gasto</h2><div className="muted small">Quedará descontado de la cuenta y visible en Finanzas.</div></div><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <div className="grid grid-2">
      <label><span className="label">Cuenta que paga</span><select className="select" value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
      <label><span className="label">Fecha del gasto</span><input className="input" type="date" max={localDate()} value={occurredOn} onChange={e => setOccurredOn(e.target.value)} /></label>
      <label><span className="label">Monto {account?.currency ?? ""}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} autoFocus /></label>
      <label><span className="label">Categoría</span><input className="input" list="expense-categories" value={category} onChange={e => setCategory(e.target.value)} placeholder="Selecciona o escribe otra" /><datalist id="expense-categories">{categories.map(c => <option key={c} value={c} />)}</datalist></label>
      <label><span className="label">Proveedor / beneficiario</span><input className="input" value={payee} onChange={e => setPayee(e.target.value)} placeholder="A quién se pagó" /></label>
      <label><span className="label">Referencia</span><input className="input" value={reference} onChange={e => setReference(e.target.value)} placeholder="Factura, pago móvil…" /></label>
    </div>
    <label><span className="label">Descripción</span><textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="Qué se compró o por qué se pagó" /></label>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !accountId || amount <= 0 || !category.trim() || !occurredOn} onClick={save}>{busy ? "Guardando…" : "Registrar gasto"}</button>
  </div></div>;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}


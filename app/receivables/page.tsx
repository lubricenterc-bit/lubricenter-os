"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Receivable = {
  id: string;
  order_id: string;
  customer_id: string | null;
  principal_ves: number;
  principal_ref: number;
  outstanding_ves: number;
  status: string;
  due_date: string | null;
  created_at: string;
  closed_at: string | null;
};
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Order = { id: string; order_number: string; vehicle_id: string | null; closed_at: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null };
type CreditPayment = { id: string; receivable_id: string | null; method: string; currency: string; amount_original: number; value_ves: number; reference: string | null; paid_at: string };
type Rates = { bcv: number; operative: number };

type Filter = "OPEN" | "PAID" | "ALL";

export default function ReceivablesPage() {
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [payments, setPayments] = useState<CreditPayment[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [selected, setSelected] = useState<Receivable | null>(null);
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    const [{ data: r, error: re }, { data: c, error: ce }, { data: o, error: oe }, { data: v, error: ve }, { data: p, error: pe }, { data: xr, error: xre }] = await Promise.all([
      supabase.from("receivables").select("id,order_id,customer_id,principal_ves,principal_ref,outstanding_ves,status,due_date,created_at,closed_at").order("created_at", { ascending: false }).limit(1000),
      supabase.from("customers").select("id,name,phone,document_id").limit(1500),
      supabase.from("orders").select("id,order_number,vehicle_id,closed_at").limit(1500),
      supabase.from("vehicles").select("id,plate,make,model").limit(2000),
      supabase.from("payments").select("id,receivable_id,method,currency,amount_original,value_ves,reference,paid_at").not("receivable_id", "is", null).order("paid_at", { ascending: false }).limit(2000),
      supabase.rpc("get_current_rates"),
    ]);
    const anyError = re || ce || oe || ve || pe || xre;
    if (anyError) setError(anyError.message);
    else {
      setReceivables((r ?? []) as Receivable[]);
      setCustomers((c ?? []) as Customer[]);
      setOrders((o ?? []) as Order[]);
      setVehicles((v ?? []) as Vehicle[]);
      setPayments((p ?? []) as CreditPayment[]);
      const row = Array.isArray(xr) ? xr[0] : xr;
      setRates({ bcv: Number(row?.bcv_rate ?? 0), operative: Number(row?.operative_rate ?? 0) });
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const orderMap = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders]);
  const vehicleMap = useMemo(() => new Map(vehicles.map(v => [v.id, v])), [vehicles]);
  const paymentsByReceivable = useMemo(() => {
    const m = new Map<string, CreditPayment[]>();
    for (const p of payments) if (p.receivable_id) m.set(p.receivable_id, [...(m.get(p.receivable_id) ?? []), p]);
    return m;
  }, [payments]);

  const visible = useMemo(() => receivables.filter(r => {
    if (filter !== "ALL" && r.status !== filter) return false;
    const c = r.customer_id ? customerMap.get(r.customer_id) : undefined;
    const o = orderMap.get(r.order_id);
    const v = o?.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
    const haystack = `${c?.name ?? ""} ${c?.phone ?? ""} ${c?.document_id ?? ""} ${o?.order_number ?? ""} ${v?.plate ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), [receivables, filter, search, customerMap, orderMap, vehicleMap]);

  const open = receivables.filter(r => r.status === "OPEN");
  const openTotal = open.reduce((a, r) => a + Number(r.outstanding_ves || 0), 0);
  const overdue = open.filter(r => r.due_date && new Date(`${r.due_date}T23:59:59`) < new Date()).length;

  return <main className="container stack">
    <div className="row-between"><div><h1 style={{ marginBottom: 4 }}>Crédito LC</h1><div className="muted">Cuentas por cobrar y abonos reales de clientes.</div></div><Link href="/orders/new" className="btn btn-primary">+ Nueva orden</Link></div>

    <section className="grid grid-3">
      <div className="card"><div className="muted small">SALDO PENDIENTE</div><div className="kpi">{fmtVes(openTotal)}</div></div>
      <div className="card"><div className="muted small">CUENTAS ABIERTAS</div><div className="kpi">{open.length}</div></div>
      <div className="card"><div className="muted small">VENCIDAS</div><div className="kpi">{overdue}</div></div>
    </section>

    {error && <div className="error">{error}</div>}
    <section className="card stack">
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente, teléfono, cédula, orden o placa" />
      <div className="segmented">{(["OPEN","PAID","ALL"] as Filter[]).map(f => <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f === "OPEN" ? "Pendientes" : f === "PAID" ? "Pagadas" : "Todas"}</button>)}</div>
    </section>

    {loading ? <div className="card muted">Cargando cuentas por cobrar…</div> : <section className="stack">
      {visible.map(r => {
        const c = r.customer_id ? customerMap.get(r.customer_id) : undefined;
        const o = orderMap.get(r.order_id);
        const v = o?.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
        const history = paymentsByReceivable.get(r.id) ?? [];
        const paid = Math.max(Number(r.principal_ves) - Number(r.outstanding_ves), 0);
        const isOverdue = r.status === "OPEN" && r.due_date && new Date(`${r.due_date}T23:59:59`) < new Date();
        return <article className="card stack" key={r.id}>
          <div className="row-between">
            <div><div className="muted small">{o?.order_number ?? "Orden"} · {fmtDate(r.created_at)}</div><div className="money-lg">{c?.name || c?.phone || "Cliente"}</div><div className="muted small">{[c?.phone, v?.plate, v?.make, v?.model].filter(Boolean).join(" · ")}</div></div>
            <span className={`pill ${r.status === "PAID" ? "ok" : "warn"}`}>{r.status === "PAID" ? "PAGADO" : isOverdue ? "VENCIDO" : "PENDIENTE"}</span>
          </div>

          <div className="grid grid-3">
            <div><div className="muted small">ORIGINAL</div><strong>{fmtVes(r.principal_ves)}</strong><div className="muted small">{fmtRef(r.principal_ref)}</div></div>
            <div><div className="muted small">ABONADO</div><strong>{fmtVes(paid)}</strong></div>
            <div><div className="muted small">PENDIENTE</div><strong>{fmtVes(r.outstanding_ves)}</strong>{r.due_date && <div className="muted small">Esperado: {r.due_date}</div>}</div>
          </div>

          {history.length > 0 && <div className="stack"><div className="label">Abonos registrados</div>{history.slice(0,5).map(p => <div className="row-between" key={p.id}><div><span>{paymentLabel(p.method)}</span><div className="muted small">{fmtDate(p.paid_at)}{p.reference ? ` · Ref. ${p.reference}` : ""}</div></div><strong>{p.currency === "USD" ? `$${Number(p.amount_original).toFixed(2)}` : fmtVes(p.amount_original)}</strong></div>)}</div>}

          <div className="row-between"><Link className="btn btn-ghost" href={`/orders/${r.order_id}`}>Ver orden</Link>{r.status === "OPEN" && <button className="btn btn-primary" onClick={() => setSelected(r)}>Registrar abono</button>}</div>
        </article>;
      })}
      {!visible.length && <div className="card muted">No hay cuentas que coincidan con este filtro.</div>}
    </section>}

    {selected && <CreditPaymentSheet receivable={selected} customer={selected.customer_id ? customerMap.get(selected.customer_id) ?? null : null} rates={rates} onCancel={() => setSelected(null)} onDone={async () => { setSelected(null); await load(); }} />}
  </main>;
}

function paymentLabel(method: string) {
  return ({ MOBILE_PAYMENT: "Pago móvil", TRANSFER_BDV: "Transferencia BDV", TRANSFER_BNC: "Transferencia BNC", CASH_VES: "Efectivo Bs", CASH_USD: "Efectivo USD" } as Record<string,string>)[method] ?? method;
}

function CreditPaymentSheet({ receivable, customer, rates, onCancel, onDone }: { receivable: Receivable; customer: Customer | null; rates: Rates; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [method, setMethod] = useState("MOBILE_PAYMENT");
  const currency = method === "CASH_USD" ? "USD" : "VES";
  const suggested = currency === "USD" ? (rates.operative > 0 ? Number(receivable.outstanding_ves) / rates.operative : 0) : Number(receivable.outstanding_ves);
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setAmount(Number(suggested.toFixed(currency === "USD" ? 2 : 0))); }, [method, receivable.id, rates.operative]);

  const valueVes = currency === "USD" ? amount * rates.operative : amount;

  async function save() {
    if (amount <= 0) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_credit_payment", { p_receivable_id: receivable.id, p_method: method, p_amount_original: amount, p_reference: reference || null });
    setBusy(false);
    if (error) return setError(error.message);
    await onDone();
  }

  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Registrar abono</h2><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <div className="card stack" style={{ borderColor: "rgba(255,93,21,.45)" }}><div className="muted small">CLIENTE</div><strong>{customer?.name || customer?.phone || "Cliente"}</strong><div className="row-between"><span>Saldo actual</span><strong>{fmtVes(receivable.outstanding_ves)}</strong></div></div>
    <label><span className="label">Método</span><select className="select" value={method} onChange={e => setMethod(e.target.value)}><option value="MOBILE_PAYMENT">Pago móvil</option><option value="TRANSFER_BDV">Transferencia BDV</option><option value="TRANSFER_BNC">Transferencia BNC</option><option value="CASH_VES">Efectivo Bs</option><option value="CASH_USD">Efectivo USD físico</option></select></label>
    <label><span className="label">Monto {currency}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} /></label>
    {method !== "CASH_USD" && method !== "CASH_VES" && <label><span className="label">Referencia opcional</span><input className="input" value={reference} onChange={e => setReference(e.target.value)} /></label>}
    <div className="card"><div className="muted small">VALOR DEL ABONO</div><div className="money-lg">{fmtVes(valueVes)}</div><div className="muted small">Nuevo saldo aproximado: {fmtVes(Math.max(Number(receivable.outstanding_ves) - valueVes, 0))}</div></div>
    {error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || amount <= 0 || valueVes > Number(receivable.outstanding_ves) + 1} onClick={save}>{busy ? "Registrando…" : "Registrar abono"}</button>
  </div></div>;
}

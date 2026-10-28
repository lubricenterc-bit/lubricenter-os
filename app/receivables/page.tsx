"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { referenceError } from "@/lib/finance/money";
import {
  currencyOf, debtMessage, payAllAmount, previewPayment, remaining, type PayCurrency,
} from "@/lib/finance/receivables";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtVes } from "@/lib/format";

type Receivable = {
  id: string; order_id: string; customer_id: string | null;
  principal_ves: number; principal_ref: number; principal_usd: number | null;
  outstanding_ves: number; outstanding_fraction: number;
  status: string; due_date: string | null; created_at: string; closed_at: string | null;
};
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Order = { id: string; order_number: string; vehicle_id: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null };
type CreditPayment = {
  id: string; receivable_id: string | null; method: string; currency: string; amount_original: number;
  applied_ref: number | null; applied_usd: number | null; reference: string | null; paid_at: string;
};
type Filter = "OPEN" | "PAID" | "ALL";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ref = (n: number | null | undefined) =>
  `${Number(n ?? 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} REF`;

const METHODS: { id: string; label: string; group: PayCurrency }[] = [
  { id: "TRANSFER_BDV", label: "Pago móvil BDV", group: "VES" },
  { id: "TRANSFER_BNC", label: "Pago móvil BNC", group: "VES" },
  { id: "CASH_VES", label: "Efectivo Bs", group: "VES" },
  { id: "ZELLE", label: "Zelle", group: "USD" },
  { id: "BINANCE", label: "Binance", group: "USD" },
  { id: "CASH_USD", label: "Efectivo $", group: "USD" },
];
const methodLabel = (m: string) => METHODS.find(x => x.id === m)?.label ?? (m === "MOBILE_PAYMENT" ? "Pago móvil" : m);

function isOverdue(r: Receivable) {
  return r.status === "OPEN" && !!r.due_date && new Date(`${r.due_date}T23:59:59`) < new Date();
}

export default function ReceivablesPage() {
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [payments, setPayments] = useState<CreditPayment[]>([]);
  const [bcv, setBcv] = useState(0);
  const [selected, setSelected] = useState<Receivable | null>(null);
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    const [r, c, o, v, p, xr] = await Promise.all([
      supabase.from("receivables").select("id,order_id,customer_id,principal_ves,principal_ref,principal_usd,outstanding_ves,outstanding_fraction,status,due_date,created_at,closed_at").order("created_at", { ascending: false }).limit(1000),
      supabase.from("customers").select("id,name,phone,document_id").limit(2000),
      supabase.from("orders").select("id,order_number,vehicle_id").limit(2000),
      supabase.from("vehicles").select("id,plate,make,model").limit(2000),
      supabase.from("payments").select("id,receivable_id,method,currency,amount_original,applied_ref,applied_usd,reference,paid_at").not("receivable_id", "is", null).order("paid_at", { ascending: false }).limit(2000),
      supabase.rpc("get_current_rates"),
    ]);
    const anyError = r.error || c.error || o.error || v.error || p.error || xr.error;
    if (anyError) setError(anyError.message);
    else {
      setReceivables((r.data ?? []) as Receivable[]);
      setCustomers((c.data ?? []) as Customer[]);
      setOrders((o.data ?? []) as Order[]);
      setVehicles((v.data ?? []) as Vehicle[]);
      setPayments((p.data ?? []) as CreditPayment[]);
      const row = Array.isArray(xr.data) ? xr.data[0] : xr.data;
      setBcv(Number(row?.bcv_rate ?? 0));
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

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
  const totals = open.reduce((acc, r) => {
    const left = remaining(r, bcv);
    return { ref: acc.ref + left.ref, usd: acc.usd + (left.usd ?? 0), ves: acc.ves + (left.vesToday ?? 0) };
  }, { ref: 0, usd: 0, ves: 0 });
  const overdue = open.filter(isOverdue).length;

  async function copyMessage(r: Receivable) {
    const c = r.customer_id ? customerMap.get(r.customer_id) : undefined;
    const text = debtMessage(c?.name ?? null, orderMap.get(r.order_id)?.order_number ?? "", r, bcv);
    try { await navigator.clipboard.writeText(text); setNotice("Mensaje copiado. Pégalo en WhatsApp."); }
    catch { setError("No se pudo copiar el mensaje."); }
  }
  function whatsappLink(r: Receivable) {
    const c = r.customer_id ? customerMap.get(r.customer_id) : undefined;
    const digits = (c?.phone ?? "").replace(/\D/g, "");
    if (digits.length < 10) return null;
    const phone = digits.startsWith("58") ? digits : "58" + digits.replace(/^0/, "");
    const text = debtMessage(c?.name ?? null, orderMap.get(r.order_id)?.order_number ?? "", r, bcv);
    return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  }

  return <main className="container stack">
    <div className="row-between">
      <div>
        <h1 style={{ marginBottom: 4 }}>Crédito LC</h1>
        <div className="muted">Lo que nos deben los clientes. Cada deuda se guarda en REF BCV y en $ divisas: el cliente paga en la moneda que quiera y la deuda cierra exacta.</div>
      </div>
      <Link href="/orders/new" className="btn btn-primary">+ Nueva orden</Link>
    </div>

    <section className="grid grid-3">
      <div className="card"><div className="muted small">NOS DEBEN · EN DIVISAS</div><div className="kpi">{usd(totals.usd)}</div><div className="muted small">o {ref(totals.ref)}</div></div>
      <div className="card"><div className="muted small">EN BOLÍVARES HOY</div><div className="kpi">{fmtVes(totals.ves)}</div><div className="muted small">BCV {bcv ? bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 }) : "—"}</div></div>
      <div className="card"><div className="muted small">CUENTAS ABIERTAS</div><div className="kpi">{open.length}</div><div className="muted small">{overdue} vencida(s)</div></div>
    </section>

    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="card" role="status" style={{ borderColor: "rgba(80,200,120,.5)" }}>{notice}</div>}

    <section className="card stack">
      <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente, teléfono, cédula, orden o placa" aria-label="Buscar deuda" />
      <div className="segmented">{(["OPEN", "PAID", "ALL"] as Filter[]).map(f =>
        <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>
          {f === "OPEN" ? "Pendientes" : f === "PAID" ? "Pagadas" : "Todas"}
        </button>)}
      </div>
    </section>

    {loading ? <div className="card muted">Cargando cuentas por cobrar…</div> : <section className="stack">
      {visible.map(r => {
        const c = r.customer_id ? customerMap.get(r.customer_id) : undefined;
        const o = orderMap.get(r.order_id);
        const v = o?.vehicle_id ? vehicleMap.get(o.vehicle_id) : undefined;
        const history = paymentsByReceivable.get(r.id) ?? [];
        const left = remaining(r, bcv);
        const paidPercent = Math.max(0, Math.min(100, 100 - left.percent));
        const wa = r.status === "OPEN" ? whatsappLink(r) : null;
        return <article className="card stack" key={r.id}>
          <div className="row-between">
            <div>
              <div className="muted small">{o?.order_number ?? "Orden"} · {fmtDate(r.created_at)}</div>
              <div className="money-lg">{c?.name || c?.phone || "Cliente"}</div>
              <div className="muted small">{[c?.phone, v?.plate, v?.make, v?.model].filter(Boolean).join(" · ")}</div>
            </div>
            <span className={`pill ${r.status === "PAID" ? "ok" : "warn"}`}>{r.status === "PAID" ? "PAGADA" : isOverdue(r) ? "VENCIDA" : "PENDIENTE"}</span>
          </div>

          {r.status === "OPEN" ? <div className="stack" style={{ gap: 6 }}>
            <div className="muted small">FALTA POR COBRAR</div>
            <div className="money-lg">{usd(left.usd)} <span className="muted small">en divisas</span></div>
            <div className="muted">o {fmtVes(left.vesToday)} en bolívares hoy · {ref(left.ref)}</div>
          </div> : <div className="muted">Pagada el {r.closed_at ? fmtDate(r.closed_at) : "—"}.</div>}

          <div aria-label={`Pagado ${paidPercent.toFixed(0)}%`} style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
            <div style={{ width: `${paidPercent}%`, height: "100%", background: "var(--accent, #ff5d15)" }} />
          </div>
          <div className="row-between muted small">
            <span>Original: {usd(r.principal_usd)} · {ref(r.principal_ref)}</span>
            <span>{paidPercent.toFixed(0)}% pagado{r.due_date ? ` · vence ${r.due_date}` : ""}</span>
          </div>

          {history.length > 0 && <div className="stack">
            <div className="label">Abonos</div>
            {history.slice(0, 5).map(p => <div className="row-between" key={p.id}>
              <div><span>{methodLabel(p.method)}</span><div className="muted small">{fmtDate(p.paid_at)}{p.reference ? ` · Ref. ${p.reference}` : ""}</div></div>
              <div style={{ textAlign: "right" }}>
                <strong>{p.currency === "USD" ? usd(p.amount_original) : fmtVes(p.amount_original)}</strong>
                {p.applied_ref != null && <div className="muted small">{ref(p.applied_ref)}</div>}
              </div>
            </div>)}
          </div>}

          <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
            <Link className="btn btn-ghost" href={`/orders/${r.order_id}`}>Ver orden</Link>
            {r.status === "OPEN" && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {wa ? <a className="btn btn-ghost" href={wa} target="_blank" rel="noopener noreferrer">Recordar por WhatsApp</a>
                : <button className="btn btn-ghost" onClick={() => void copyMessage(r)}>Copiar mensaje</button>}
              <button className="btn btn-primary" onClick={() => { setNotice(""); setSelected(r); }}>Registrar abono</button>
            </div>}
          </div>
        </article>;
      })}
      {!visible.length && <div className="card muted">No hay cuentas que coincidan con este filtro.</div>}
    </section>}

    {selected && <PaymentSheet
      receivable={selected}
      customer={selected.customer_id ? customerMap.get(selected.customer_id) ?? null : null}
      orderNumber={orderMap.get(selected.order_id)?.order_number ?? ""}
      bcv={bcv}
      onCancel={() => setSelected(null)}
      onDone={async (msg) => { setSelected(null); setNotice(msg); await load(); }} />}
  </main>;
}

function PaymentSheet({ receivable, customer, orderNumber, bcv, onCancel, onDone }: {
  receivable: Receivable; customer: Customer | null; orderNumber: string; bcv: number;
  onCancel: () => void; onDone: (message: string) => void | Promise<void>;
}) {
  const [method, setMethod] = useState("TRANSFER_BDV");
  const currency = currencyOf(method);
  const all = payAllAmount(receivable, currency, bcv) ?? 0;
  const [amountText, setAmountText] = useState(all.toFixed(2));
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setAmountText((payAllAmount(receivable, currency, bcv) ?? 0).toFixed(2)); }, [currency, receivable, bcv]);

  const amount = Number(amountText.replace(",", "."));
  const preview = previewPayment(receivable, currency, amount, bcv);
  const money = (n: number) => currency === "USD" ? usd(n) : fmtVes(n);
  const needsRef = !["CASH_USD", "CASH_VES"].includes(method);

  async function save() {
    const re = needsRef ? referenceError(method, reference) : null;
    if (re) return setError(re);
    if (!preview.ok) return setError(preview.error);
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_receivable_payment", {
      p_receivable_id: receivable.id, p_method: method, p_amount_original: amount, p_reference: reference.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    await onDone(preview.closes
      ? `Listo: ${orderNumber} quedó pagada.`
      : `Abono registrado. A ${orderNumber} le faltan ${usd(preview.after.usd)} en divisas.`);
  }

  return <div className="overlay" role="dialog" aria-modal="true" aria-label="Registrar abono"><div className="sheet stack">
    <div className="row-between"><h2 style={{ margin: 0 }}>Registrar abono</h2><button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cerrar</button></div>
    <div className="card stack">
      <div className="muted small">{orderNumber} · {customer?.name || customer?.phone || "Cliente"}</div>
      <div className="row-between"><span>Falta en divisas</span><strong>{usd(remaining(receivable, bcv).usd)}</strong></div>
      <div className="row-between"><span>Falta en bolívares hoy</span><strong>{fmtVes(remaining(receivable, bcv).vesToday)}</strong></div>
    </div>

    <div className="stack" style={{ gap: 8 }}>
      <span className="label">1. ¿Cómo paga?</span>
      {(["VES", "USD"] as PayCurrency[]).map(group => <div key={group} className="stack" style={{ gap: 6 }}>
        <span className="muted small">{group === "VES" ? "En bolívares (se calcula al BCV de hoy)" : "En divisas"}</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {METHODS.filter(m => m.group === group).map(m =>
            <button key={m.id} type="button" className={`btn ${method === m.id ? "btn-primary" : "btn-ghost"}`}
              style={{ minHeight: 48 }} aria-pressed={method === m.id} onClick={() => { setMethod(m.id); setError(""); }}>{m.label}</button>)}
        </div>
      </div>)}
    </div>

    <label className="stack" style={{ gap: 6 }}>
      <span className="label">2. ¿Cuánto paga? ({currency === "USD" ? "$" : "Bs"})</span>
      <input className="input" inputMode="decimal" value={amountText} onChange={e => setAmountText(e.target.value)} style={{ fontSize: 22 }} />
    </label>
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-ghost" onClick={() => setAmountText(all.toFixed(2))}>Paga todo · {money(all)}</button>
      <button type="button" className="btn btn-ghost" onClick={() => setAmountText((Math.floor(all * 50) / 100).toFixed(2))}>La mitad</button>
    </div>

    {needsRef && <label className="stack" style={{ gap: 6 }}>
      <span className="label">3. Referencia (últimos 4 números)</span>
      <input className="input" inputMode="numeric" value={reference} onChange={e => setReference(e.target.value)} />
    </label>}

    <div className="card">
      {preview.ok
        ? preview.closes
          ? <strong>Con este abono la deuda queda pagada.</strong>
          : <div><div className="muted small">DESPUÉS DEL ABONO FALTARÁ</div><strong>{usd(preview.after.usd)} en divisas</strong><div className="muted small">o {fmtVes(preview.after.vesToday)} hoy · {preview.after.percent.toFixed(1)}% de la deuda</div></div>
        : <span className="muted">{preview.error}</span>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    <button className="btn btn-primary btn-block" style={{ minHeight: 52 }} disabled={busy || !preview.ok} onClick={() => void save()}>
      {busy ? "Registrando…" : preview.ok && preview.closes ? `Cobrar ${money(amount)} y cerrar la deuda` : `Registrar abono de ${preview.ok ? money(amount) : "—"}`}
    </button>
  </div></div>;
}

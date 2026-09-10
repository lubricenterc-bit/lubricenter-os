"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type PaymentMethod = "MOBILE_PAYMENT" | "TRANSFER_BDV" | "TRANSFER_BNC" | "CASH_VES" | "CASH_USD";
type Sale = {
  id: string; order_id: string; status: "ACTIVE" | "SETTLED" | "CANCELLED"; initial_percent: number; commission_percent: number;
  gross_ref: number; gross_ves_snapshot: number; initial_ref: number; initial_ves_snapshot: number; financed_ref: number;
  commission_ref: number; commission_ves_snapshot: number; bcv_rate_snapshot: number; initial_payment_method: PaymentMethod;
  cashea_reference: string | null; created_at: string; settled_at: string | null;
};
type Installment = { id: string; cashea_sale_id: string; installment_no: number; due_date: string; amount_ref: number; amount_ves_snapshot: number; paid_ref: number; paid_ves_actual: number; status: "PENDING" | "PARTIAL" | "PAID"; paid_at: string | null };
type Order = { id: string; order_number: string; total_ref: number; total_ves: number };
type Rates = { bcv: number; operative: number };

const METHODS: readonly [PaymentMethod,string][] = [
  ["MOBILE_PAYMENT","Pago móvil"], ["TRANSFER_BDV","Transferencia BDV"], ["TRANSFER_BNC","Transferencia BNC"], ["CASH_VES","Efectivo Bs"], ["CASH_USD","Efectivo USD"],
];
function paymentLabel(method: string) { return Object.fromEntries(METHODS)[method] ?? method; }

export default function CasheaPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [selected, setSelected] = useState<Installment | null>(null);
  const [filter, setFilter] = useState<"ACTIVE" | "SETTLED" | "ALL">("ACTIVE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    const [s, i, o, r] = await Promise.all([
      supabase.from("cashea_sales").select("id,order_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference,created_at,settled_at").order("created_at", { ascending: false }).limit(1000),
      supabase.from("cashea_installments").select("id,cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot,paid_ref,paid_ves_actual,status,paid_at").order("due_date").limit(3000),
      supabase.from("orders").select("id,order_number,total_ref,total_ves").limit(2000),
      supabase.rpc("get_current_rates"),
    ]);
    const anyError = s.error || i.error || o.error || r.error;
    if (anyError) setError(anyError.message);
    else {
      setSales((s.data ?? []).map((x:any) => ({ ...x, initial_percent:Number(x.initial_percent), commission_percent:Number(x.commission_percent), gross_ref:Number(x.gross_ref), gross_ves_snapshot:Number(x.gross_ves_snapshot), initial_ref:Number(x.initial_ref), initial_ves_snapshot:Number(x.initial_ves_snapshot), financed_ref:Number(x.financed_ref), commission_ref:Number(x.commission_ref), commission_ves_snapshot:Number(x.commission_ves_snapshot), bcv_rate_snapshot:Number(x.bcv_rate_snapshot) })) as Sale[]);
      setInstallments((i.data ?? []).map((x:any) => ({ ...x, amount_ref:Number(x.amount_ref), amount_ves_snapshot:Number(x.amount_ves_snapshot), paid_ref:Number(x.paid_ref), paid_ves_actual:Number(x.paid_ves_actual) })) as Installment[]);
      setOrders((o.data ?? []).map((x:any) => ({ ...x, total_ref:Number(x.total_ref), total_ves:Number(x.total_ves) })) as Order[]);
      const row = Array.isArray(r.data) ? r.data[0] : r.data; setRates({ bcv:Number(row?.bcv_rate ?? 0), operative:Number(row?.operative_rate ?? 0) });
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const orderMap = useMemo(() => new Map(orders.map(o => [o.id,o])), [orders]);
  const bySale = useMemo(() => { const m = new Map<string,Installment[]>(); for (const x of installments) m.set(x.cashea_sale_id,[...(m.get(x.cashea_sale_id) ?? []),x]); return m; }, [installments]);
  const visible = sales.filter(s => filter === "ALL" || s.status === filter);
  const active = sales.filter(s => s.status === "ACTIVE");
  const outstandingRef = active.reduce((sum,s) => sum + (bySale.get(s.id) ?? []).reduce((a,x) => a + Math.max(x.amount_ref-x.paid_ref,0),0),0);
  const commissionRef = sales.filter(s => s.status !== "CANCELLED").reduce((sum,s) => sum + s.commission_ref,0);
  const dueCount = installments.filter(x => x.status !== "PAID" && new Date(`${x.due_date}T23:59:59`) < new Date()).length;

  return <main className="container stack">
    <div className="row-between"><div><div className="eyebrow">FINANZAS · CASHEA TRADICIONAL</div><h1 style={{ marginBottom: 4 }}>Cashea</h1><div className="muted">Inicial recibida hoy, tres cuotas por recibir y comisión contractual separada de Crédito LC.</div></div><Link href="/quick-sale" className="btn btn-primary">+ Venta Cashea</Link></div>

    <section className="grid grid-3">
      <div className="card"><div className="muted small">POR RECIBIR</div><div className="kpi">{fmtRef(outstandingRef)}</div><div className="muted small">saldo Cashea en REF / USD</div></div>
      <div className="card"><div className="muted small">VENTAS ACTIVAS</div><div className="kpi">{active.length}</div><div className="muted small">{dueCount} cuotas vencidas</div></div>
      <div className="card"><div className="muted small">COMISIÓN REGISTRADA</div><div className="kpi">{fmtRef(commissionRef)}</div><div className="muted small">costo Cashea acumulado</div></div>
    </section>

    <section className="card stack">
      <div className="success small"><strong>Separado de Crédito LC.</strong> Aquí el deudor operativo es Cashea / su flujo de cuotas; no el cliente de Lubricenter. Registra una cuota solo cuando el dinero realmente llegue.</div>
      <div className="segmented">{(["ACTIVE","SETTLED","ALL"] as const).map(f => <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f === "ACTIVE" ? "Activas" : f === "SETTLED" ? "Liquidadas" : "Todas"}</button>)}</div>
    </section>

    {error && <div className="error">{error}</div>}
    {loading ? <div className="card muted">Cargando Cashea…</div> : <section className="stack">
      {visible.map(s => {
        const order = orderMap.get(s.order_id); const parts = bySale.get(s.id) ?? [];
        const remain = parts.reduce((a,x) => a + Math.max(x.amount_ref-x.paid_ref,0),0);
        return <article className="card stack" key={s.id}>
          <div className="row-between"><div><div className="muted small">{fmtDate(s.created_at)} · {order?.order_number ?? "Orden"}</div><div className="money-lg">{fmtRef(s.gross_ref)}</div><div className="muted small">Ref. Cashea: {s.cashea_reference || "sin registrar"}</div></div><span className={`pill ${s.status === "SETTLED" ? "ok" : "warn"}`}>{s.status === "SETTLED" ? "LIQUIDADA" : "ACTIVA"}</span></div>
          <div className="grid grid-3"><div><div className="muted small">INICIAL · {s.initial_percent}%</div><strong>{fmtRef(s.initial_ref)}</strong><div className="muted small">{paymentLabel(s.initial_payment_method)}</div></div><div><div className="muted small">SALDO CASHEA</div><strong>{fmtRef(remain)}</strong></div><div><div className="muted small">COMISIÓN · {s.commission_percent}%</div><strong>{fmtRef(s.commission_ref)}</strong><div className="muted small">no aumenta precio</div></div></div>
          <div className="divider" />
          <div className="stack"><div className="label">Cuotas</div>{parts.map(x => { const remaining = Math.max(x.amount_ref-x.paid_ref,0); const overdue = x.status !== "PAID" && new Date(`${x.due_date}T23:59:59`) < new Date(); return <div className="card" key={x.id} style={{ padding: 12 }}><div className="row-between"><div><strong>Cuota {x.installment_no} · {fmtRef(x.amount_ref)}</strong><div className="muted small">Vence {x.due_date}{x.paid_ref > 0 ? ` · recibido ${fmtRef(x.paid_ref)}` : ""}</div></div><span className={`pill ${x.status === "PAID" ? "ok" : "warn"}`}>{x.status === "PAID" ? "PAGADA" : overdue ? "VENCIDA" : x.status === "PARTIAL" ? "PARCIAL" : "PENDIENTE"}</span></div>{x.status !== "PAID" && <div className="row-between" style={{ marginTop: 10 }}><span className="muted small">Por recibir {fmtRef(remaining)}</span><button className="btn btn-primary" onClick={() => setSelected(x)}>Registrar llegada</button></div>}</div>; })}</div>
          <div className="row-between"><Link className="btn btn-ghost" href={`/orders/${s.order_id}`}>Ver orden</Link><span className="muted small">Neto económico tras comisión: {fmtRef(Math.max(s.gross_ref-s.commission_ref,0))}</span></div>
        </article>;
      })}
      {!visible.length && <div className="card muted">No hay ventas Cashea en este filtro.</div>}
    </section>}

    {selected && <InstallmentPaymentSheet installment={selected} rates={rates} onCancel={() => setSelected(null)} onDone={async () => { setSelected(null); await load(); }} />}
  </main>;
}

function InstallmentPaymentSheet({ installment, rates, onCancel, onDone }: { installment: Installment; rates: Rates; onCancel:()=>void; onDone:()=>void|Promise<void> }) {
  const [method,setMethod] = useState<PaymentMethod>("TRANSFER_BDV");
  const remainingRef = Math.max(installment.amount_ref-installment.paid_ref,0);
  const currency = method === "CASH_USD" ? "USD" : "VES";
  const suggested = currency === "USD" ? remainingRef : remainingRef * rates.bcv;
  const [amount,setAmount] = useState(suggested);
  const [reference,setReference] = useState("");
  const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  useEffect(() => { setAmount(Number((currency === "USD" ? remainingRef : remainingRef*rates.bcv).toFixed(currency === "USD" ? 2 : 0))); }, [method, installment.id, rates.bcv]);
  const valueRef = currency === "USD" ? amount : (rates.bcv > 0 ? amount/rates.bcv : 0);
  async function save() {
    if (amount <= 0 || valueRef > remainingRef + 0.05) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("record_cashea_installment_payment", { p_installment_id:installment.id, p_method:method, p_amount_original:amount, p_reference:reference.trim() || null });
    setBusy(false); if (error) return setError(error.message); await onDone();
  }
  return <div className="overlay"><div className="sheet stack">
    <div className="row-between"><div><h2 style={{ margin:0 }}>Registrar cuota Cashea</h2><div className="muted small">Cuota {installment.installment_no} · saldo {fmtRef(remainingRef)}</div></div><button className="btn btn-ghost" onClick={onCancel}>Cerrar</button></div>
    <div><span className="label">Dónde llegó el dinero</span><div className="grid grid-2">{METHODS.map(([m,label]) => <button type="button" key={m} className={method === m ? "btn btn-primary" : "btn"} onClick={() => setMethod(m)}>{method === m ? `✓ ${label}` : label}</button>)}</div></div>
    <label><span className="label">Monto {currency}</span><input className="input" type="number" min="0" step="0.01" value={amount || ""} onChange={e => setAmount(Number(e.target.value))} /></label>
    <input className="input" value={reference} onChange={e => setReference(e.target.value)} placeholder="Referencia bancaria / Cashea (opcional)" />
    <div className="card"><div className="muted small">EQUIVALE A</div><div className="money-lg">{fmtRef(valueRef)}</div><div className="muted small">Las cuotas Cashea se valorizan con BCV del día en que llegan.</div></div>
    {valueRef > remainingRef + 0.05 && <div className="error">El monto supera el saldo de esta cuota.</div>}{error && <div className="error">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || amount <= 0 || valueRef > remainingRef + 0.05} onClick={save}>{busy ? "Registrando…" : "Confirmar dinero recibido"}</button>
  </div></div>;
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type PaymentMethod = "MOBILE_PAYMENT" | "TRANSFER_BDV" | "TRANSFER_BNC" | "CASH_VES" | "CASH_USD";
type CasheaSale = { id: string; status: string; initial_percent: number; gross_ref: number; initial_ref: number; financed_ref: number; commission_ref: number; cashea_reference: string | null };

const METHODS: readonly [PaymentMethod, string][] = [
  ["MOBILE_PAYMENT", "Pago móvil"],
  ["TRANSFER_BDV", "Transferencia BDV"],
  ["TRANSFER_BNC", "Transferencia BNC"],
  ["CASH_VES", "Efectivo Bs"],
  ["CASH_USD", "Efectivo USD"],
];
const COMMISSION = 4;

export function OrderCasheaCheckout({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("OPEN");
  const [orderNumber, setOrderNumber] = useState("");
  const [totalRef, setTotalRef] = useState(0);
  const [totalVes, setTotalVes] = useState(0);
  const [paymentCount, setPaymentCount] = useState(0);
  const [bcv, setBcv] = useState(0);
  const [sale, setSale] = useState<CasheaSale | null>(null);
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState("40");
  const [method, setMethod] = useState<PaymentMethod>("MOBILE_PAYMENT");
  const [paymentReference, setPaymentReference] = useState("");
  const [casheaReference, setCasheaReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const [orderRes, itemsRes, paymentsRes, ratesRes, saleRes] = await Promise.all([
      supabase.from("orders").select("status,order_number").eq("id", orderId).single(),
      supabase.from("order_items").select("charged_ref_amount,charged_ves_amount").eq("order_id", orderId),
      supabase.from("payments").select("id").eq("order_id", orderId),
      supabase.rpc("get_current_rates"),
      supabase.from("cashea_sales").select("id,status,initial_percent,gross_ref,initial_ref,financed_ref,commission_ref,cashea_reference").eq("order_id", orderId).maybeSingle(),
    ]);
    if (orderRes.error || itemsRes.error || paymentsRes.error || ratesRes.error || saleRes.error) {
      setError((orderRes.error || itemsRes.error || paymentsRes.error || ratesRes.error || saleRes.error)?.message ?? "No pude cargar Cashea.");
      return;
    }
    setStatus(orderRes.data.status);
    setOrderNumber(orderRes.data.order_number);
    setTotalRef((itemsRes.data ?? []).reduce((a: number, x: any) => a + Number(x.charged_ref_amount || 0), 0));
    setTotalVes((itemsRes.data ?? []).reduce((a: number, x: any) => a + Number(x.charged_ves_amount || 0), 0));
    setPaymentCount((paymentsRes.data ?? []).length);
    const rate = Array.isArray(ratesRes.data) ? ratesRes.data[0] : ratesRes.data;
    setBcv(Number(rate?.bcv_rate ?? 0));
    setSale(saleRes.data ? ({ ...saleRes.data, initial_percent: Number(saleRes.data.initial_percent), gross_ref: Number(saleRes.data.gross_ref), initial_ref: Number(saleRes.data.initial_ref), financed_ref: Number(saleRes.data.financed_ref), commission_ref: Number(saleRes.data.commission_ref) } as CasheaSale) : null);
  }
  useEffect(() => { load(); }, [orderId]);

  const pct = Number(percent);
  const validPct = Number.isFinite(pct) && pct > 0 && pct < 100;
  const initialRef = validPct ? totalRef * pct / 100 : 0;
  const financedRef = Math.max(totalRef - initialRef, 0);
  const installmentRef = financedRef / 3;
  const commissionRef = totalRef * COMMISSION / 100;
  const initialVes = initialRef * bcv;
  const canUse = status === "OPEN" && totalRef > 0 && paymentCount === 0;

  async function confirm() {
    if (!canUse || !validPct || busy) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("close_order_with_cashea", {
      p_order_id: orderId,
      p_initial_percent: pct,
      p_initial_payment_method: method,
      p_payment_reference: paymentReference.trim() || null,
      p_cashea_reference: casheaReference.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setOpen(false);
    router.push(`/orders/${orderId}/receipt`);
    router.refresh();
  }

  if (sale) return <section className="card stack" style={{ borderColor: "rgba(124,92,255,.5)" }}>
    <div className="row-between"><div><div className="eyebrow">CASHEA</div><strong>{sale.status === "SETTLED" ? "Liquidado" : "Financiamiento activo"}</strong></div><span className="pill ok">{sale.initial_percent}% inicial</span></div>
    <div className="grid grid-3"><div><div className="muted small">VENTA</div><strong>{fmtRef(sale.gross_ref)}</strong></div><div><div className="muted small">INICIAL</div><strong>{fmtRef(sale.initial_ref)}</strong></div><div><div className="muted small">POR RECIBIR</div><strong>{fmtRef(sale.financed_ref)}</strong></div></div>
    <Link className="btn btn-ghost btn-block" href="/cashea">Ver seguimiento Cashea</Link>
  </section>;

  if (status !== "OPEN") return null;

  return <>
    <section className="card stack" style={{ borderColor: "rgba(124,92,255,.45)" }}>
      <div className="row-between"><div><div className="eyebrow">FORMA DE COBRO</div><strong>Cashea tradicional</strong><div className="muted small">También disponible para órdenes completas: taller, aceite, electroauto y productos.</div></div><span className="pill">4% comisión</span></div>
      <button className="btn btn-block" disabled={!canUse} onClick={() => setOpen(true)}>Cerrar orden con Cashea</button>
      {totalRef <= 0 && <div className="muted small">Agrega items antes de elegir Cashea.</div>}
      {paymentCount > 0 && <div className="muted small">Esta orden ya tiene pagos cargados. Elimínalos si quieres que la inicial quede registrada automáticamente como Cashea.</div>}
    </section>

    {open && <div className="overlay"><div className="sheet stack">
      <div className="row-between"><div><h2 style={{ margin: 0 }}>Cobrar con Cashea</h2><div className="muted small">{orderNumber}</div></div><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cerrar</button></div>
      <div className="card stack"><div className="row-between"><span>Total orden</span><strong>{fmtRef(totalRef)}</strong></div><div className="muted small">{fmtVes(totalVes)}</div></div>

      <div><span className="label">Inicial autorizada por Cashea</span><div className="grid grid-3">{[40,50,60].map(v => <button key={v} type="button" className={`btn ${pct === v ? "btn-primary" : ""}`} onClick={() => setPercent(String(v))}>{v}%</button>)}</div></div>
      <label><span className="label">Porcentaje personalizado</span><input className="input" type="number" min="1" max="99" step="0.01" value={percent} onChange={e => setPercent(e.target.value)} /></label>

      <label><span className="label">Cómo recibiste la inicial</span><select className="select" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>{METHODS.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className="label">Referencia del pago · opcional</span><input className="input" value={paymentReference} onChange={e => setPaymentReference(e.target.value)} /></label>
      <label><span className="label">Referencia / operación Cashea · opcional</span><input className="input" value={casheaReference} onChange={e => setCasheaReference(e.target.value)} /></label>

      <div className="card stack" style={{ borderColor: "rgba(124,92,255,.45)" }}>
        <div className="row-between"><span>Inicial hoy</span><strong>{fmtRef(initialRef)}</strong></div>
        <div className="muted small">Aprox. {fmtVes(initialVes)}</div>
        <div className="row-between"><span>Saldo Cashea</span><strong>{fmtRef(financedRef)}</strong></div>
        <div className="row-between"><span>3 cuotas estimadas</span><strong>{fmtRef(installmentRef)} c/u</strong></div>
        <div className="divider" />
        <div className="row-between"><span>Comisión Lubricenter 4%</span><strong>{fmtRef(commissionRef)}</strong></div>
        <div className="row-between"><span>Neto económico estimado</span><strong>{fmtRef(totalRef - commissionRef)}</strong></div>
      </div>

      {error && <div className="error">{error}</div>}
      <button className="btn btn-primary btn-block" style={{ minHeight: 56 }} disabled={busy || !validPct || !canUse} onClick={confirm}>{busy ? "Registrando…" : `Registrar Cashea y cerrar · ${pct || 0}% inicial`}</button>
      <div className="muted small">Confirma primero la operación en Cashea. Lubricenter OS registra la inicial, la comisión y las cuotas; no sustituye la autorización de Cashea.</div>
    </div></div>}
  </>;
}

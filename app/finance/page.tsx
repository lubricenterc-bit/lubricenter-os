"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExpenseSheet, type ExpenseAccount } from "@/components/expense-sheet";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Summary = { orders?: number; payments?: number; expenses?: number; total_ref: number; total_ves: number };
type Split = { sale_type?: string; method?: string; category?: string; orders?: number; payments?: number; expenses?: number; total_ref: number; total_ves: number };
type Account = ExpenseAccount & { code: string; balance_native: number; balance_ves: number };
type Daily = { activity_date: string; sales_ref: number; collected_ref: number; expenses_ves: number };
type FinanceData = {
  period: { from: string; to: string; days: number };
  sales: Summary; sales_by_type: Split[];
  collections: Summary; collections_by_method: Split[];
  expenses: Summary; expenses_by_category: Split[];
  net_cash_ves: number;
  lc_open: { accounts: number; outstanding_ves: number; overdue: number };
  cashea_open: { sales: number; installments: number; outstanding_ref: number; overdue: number };
  accounts: Account[]; daily: Daily[];
};
type Preset = "WEEK" | "MONTH" | "30D" | "CUSTOM";

export default function FinancePage() {
  const today = localDate();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [preset, setPreset] = useState<Preset>("MONTH");
  const [data, setData] = useState<FinanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showExpense, setShowExpense] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    const { data: result, error } = await supabase.rpc("finance_dashboard", { p_from: from, p_to: to });
    setLoading(false);
    if (error) return setError(error.message);
    setData(result as FinanceData);
  }
  useEffect(() => { load(); }, [from, to]);

  function choose(value: Preset) {
    setPreset(value);
    if (value === "WEEK") setFrom(weekStart(today));
    if (value === "MONTH") setFrom(monthStart(today));
    if (value === "30D") setFrom(addDays(today, -29));
    if (value !== "CUSTOM") setTo(today);
  }

  const salesTypes = useMemo(() => new Map((data?.sales_by_type ?? []).map(x => [x.sale_type, x])), [data]);
  const ownAccounts = data?.accounts.filter(a => a.account_type !== "RELATED") ?? [];
  const maxDailyRef = Math.max(1, ...(data?.daily ?? []).map(d => Math.max(Number(d.sales_ref), Number(d.collected_ref))));

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">FINANZAS · CONTROL DEL NEGOCIO</div><h1>Central financiera</h1><p>Separa lo vendido, lo cobrado, lo pendiente y lo gastado para saber qué ocurrió realmente con el dinero.</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>
    <Link href="/finance/inbox" className="card brand-card"><h2 className="section-title">Revisión financiera</h2><p>Importa banco y Cashea; atiende solo las excepciones.</p></Link>
    {error && <div className="error">{error}</div>}

    <section className="card stack">
      <div className="finance-presets">{(["WEEK","MONTH","30D","CUSTOM"] as Preset[]).map(x => <button key={x} className={`btn ${preset === x ? "btn-primary" : "btn-ghost"}`} onClick={() => choose(x)}>{x === "WEEK" ? "Esta semana" : x === "MONTH" ? "Este mes" : x === "30D" ? "Últimos 30 días" : "Personalizado"}</button>)}</div>
      <div className="grid grid-2"><label><span className="label">Desde</span><input className="input" type="date" value={from} max={to} onChange={e => { setPreset("CUSTOM"); setFrom(e.target.value); }} /></label><label><span className="label">Hasta</span><input className="input" type="date" value={to} min={from} max={today} onChange={e => { setPreset("CUSTOM"); setTo(e.target.value); }} /></label></div>
    </section>

    {loading && <div className="card muted">Calculando finanzas…</div>}
    {data && !loading && <>
      <section className="grid grid-4">
        <div className="card brand-card"><div className="muted small">VENDIDO</div><div className="kpi">{fmtRef(data.sales.total_ref)}</div><div className="muted small">{data.sales.orders ?? 0} ventas · {fmtVes(data.sales.total_ves)}</div></div>
        <div className="card"><div className="muted small">DINERO COBRADO</div><div className="kpi">{fmtVes(data.collections.total_ves)}</div><div className="muted small">{fmtRef(data.collections.total_ref)} · {data.collections.payments ?? 0} pagos</div></div>
        <div className="card"><div className="muted small">GASTOS</div><div className="kpi" style={{ color: "var(--danger)" }}>{fmtVes(data.expenses.total_ves)}</div><div className="muted small">{data.expenses.expenses ?? 0} movimientos</div></div>
        <div className="card"><div className="muted small">FLUJO NETO</div><div className="kpi" style={{ color: data.net_cash_ves >= 0 ? "var(--ok)" : "var(--danger)" }}>{fmtVes(data.net_cash_ves)}</div><div className="muted small">Cobros menos gastos del período</div></div>
      </section>

      <section className="grid grid-3">
        <SaleTypeCard title="Contado" row={salesTypes.get("CASH")} />
        <SaleTypeCard title="Cashea" row={salesTypes.get("CASHEA")} />
        <SaleTypeCard title="Crédito LC" row={salesTypes.get("CREDIT_LC")} />
      </section>

      <section className="grid grid-2">
        <div className="card stack"><div className="row-between"><div><h2 className="section-title">Cobrado por método</h2><div className="muted small">Pagos recibidos dentro del período.</div></div><span className="pill">{data.collections_by_method.length}</span></div>{data.collections_by_method.map(x => <div className="row-between order-item" key={x.method}><div><strong>{paymentLabel(x.method ?? "")}</strong><div className="muted small">{x.payments ?? 0} pagos</div></div><div style={{ textAlign: "right" }}><strong>{fmtVes(x.total_ves)}</strong><div className="muted small">{fmtRef(x.total_ref)}</div></div></div>)}{!data.collections_by_method.length && <div className="muted">No hubo cobros en este período.</div>}</div>
        <div className="card stack"><div className="row-between"><div><h2 className="section-title">Gastos por categoría</h2><div className="muted small">Salidas operativas; las transferencias internas no cuentan.</div></div><button className="btn btn-primary" onClick={() => setShowExpense(true)}>+ Gasto</button></div>{data.expenses_by_category.map(x => <div className="row-between order-item" key={x.category}><div><strong>{x.category}</strong><div className="muted small">{x.expenses ?? 0} registros</div></div><strong>{fmtVes(x.total_ves)}</strong></div>)}{!data.expenses_by_category.length && <div className="muted">No hay gastos registrados en este período.</div>}<Link href="/cash" className="btn btn-ghost">Ver todos los movimientos</Link></div>
      </section>

      <section className="grid grid-2">
        <Link href="/receivables" className="card stack"><div className="row-between"><h2 className="section-title">Crédito LC por cobrar</h2><span className={`pill ${data.lc_open.overdue ? "warn" : "ok"}`}>{data.lc_open.overdue} vencidas</span></div><div className="kpi">{fmtVes(data.lc_open.outstanding_ves)}</div><div className="muted small">{data.lc_open.accounts} cuentas abiertas</div></Link>
        <Link href="/cashea" className="card stack"><div className="row-between"><h2 className="section-title">Cashea por recibir</h2><span className={`pill ${data.cashea_open.overdue ? "warn" : "ok"}`}>{data.cashea_open.overdue} vencidas</span></div><div className="kpi">{fmtRef(data.cashea_open.outstanding_ref)}</div><div className="muted small">{data.cashea_open.installments} cuotas · {data.cashea_open.sales} ventas activas</div></Link>
      </section>
      <section className="grid grid-2">
        <Link href="/expenses" className="card brand-card"><div className="eyebrow">COMPRAS Y PROVEEDORES</div><h2 className="section-title">Central de egresos</h2><div className="muted small">Facturas, mercancía recibida, pagos y cuentas por pagar.</div></Link>
        <Link href="/cash-close" className="card brand-card"><div className="eyebrow">CONTROL DIARIO</div><h2 className="section-title">Cuadre de caja</h2><div className="muted small">Compara saldos esperados y reales de cada cuenta.</div></Link>
      </section>

      <section className="card stack"><div><h2 className="section-title">Saldos registrados</h2><div className="muted small">Son saldos construidos por pagos, gastos y transferencias ingresados en Lubricenter OS.</div></div><div className="grid grid-3">{data.accounts.map(a => <div className="finance-account" key={a.id}><div className="row-between"><strong>{a.name}</strong><span className="pill">{a.currency}</span></div><div className="money-lg">{a.currency === "USD" ? `$${Number(a.balance_native).toFixed(2)}` : fmtVes(a.balance_native)}</div><div className="muted small">{accountTypeLabel(a.account_type)}</div></div>)}</div></section>

      <section className="card stack"><div><h2 className="section-title">Actividad diaria</h2><div className="muted small">Compara el día de la venta con el día en que entró el dinero.</div></div><div className="finance-days">{data.daily.filter(d => Number(d.sales_ref) || Number(d.collected_ref) || Number(d.expenses_ves)).map(d => <div className="finance-day" key={d.activity_date}><div className="small"><strong>{formatShortDate(d.activity_date)}</strong></div><div className="finance-bars"><div className="finance-bar sales" style={{ width: `${Math.max(2, Number(d.sales_ref) / maxDailyRef * 100)}%` }} /><div className="finance-bar collected" style={{ width: `${Math.max(2, Number(d.collected_ref) / maxDailyRef * 100)}%` }} /></div><div className="finance-day-values"><span>Vendido {fmtRef(d.sales_ref)}</span><span>Cobrado {fmtRef(d.collected_ref)}</span>{Number(d.expenses_ves) > 0 && <span>Gastos {fmtVes(d.expenses_ves)}</span>}</div></div>)}{!data.daily.some(d => Number(d.sales_ref) || Number(d.collected_ref) || Number(d.expenses_ves)) && <div className="muted">No hay actividad en este período.</div>}</div></section>

      <div className="row crm-action-bar"><Link href="/more" className="btn btn-ghost">Más herramientas</Link><Link href="/orders" className="btn btn-ghost">Administrar ventas</Link><button className="btn btn-primary" onClick={() => setShowExpense(true)}>+ Registrar gasto</button></div>
      {showExpense && <ExpenseSheet accounts={ownAccounts} onCancel={() => setShowExpense(false)} onDone={async () => { setShowExpense(false); await load(); }} />}
    </>}
  </main>;
}

function SaleTypeCard({ title, row }: { title: string; row?: Split }) { return <div className="card"><div className="muted small">{title.toUpperCase()}</div><div className="money-lg">{fmtRef(row?.total_ref ?? 0)}</div><div className="muted small">{row?.orders ?? 0} ventas · {fmtVes(row?.total_ves ?? 0)}</div></div>; }
function paymentLabel(method: string) { return ({ MOBILE_PAYMENT: "Pago móvil · Banco de Venezuela", TRANSFER_BDV: "Pago móvil · Banco de Venezuela", TRANSFER_BNC: "Pago móvil · BNC", CASH_VES: "Efectivo Bs", CASH_USD: "Efectivo USD", ZELLE: "Zelle", CASHEA: "Cashea" } as Record<string,string>)[method] ?? method; }
function accountTypeLabel(type: string) { return ({ BANK: "Banco", CASH: "Efectivo", CLEARING: "Por clasificar", RELATED: "Cuenta relacionada" } as Record<string,string>)[type] ?? type; }
function localDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function monthStart(value: string) { return `${value.slice(0,7)}-01`; }
function weekStart(value: string) { const d = new Date(`${value}T12:00:00-04:00`); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function addDays(value: string, amount: number) { const d = new Date(`${value}T12:00:00-04:00`); d.setDate(d.getDate()+amount); return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function formatShortDate(value: string) { return new Date(`${value}T12:00:00-04:00`).toLocaleDateString("es-VE", { day: "2-digit", month: "short" }); }

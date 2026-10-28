"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FinanceCashAlerts } from "@/components/finance-cash-alerts";
import { ExpenseSheet, type ExpenseAccount } from "@/components/expense-sheet";
import { fmtRef, fmtVes } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { FinanceManagementReportView } from "@/components/finance-management-report";
import { financeToday, financeDateStep, validFinancePeriod, type FinanceManagementReport } from "@/lib/finance/management-report";
import "./report.css";

type CurrencyView = "VES" | "BCV" | "USD";
type Preset = "DAY" | "WEEK" | "MONTH" | "30D" | "CUSTOM";
type Values = Record<string, number | string | null>;
type FinanceAccount = ExpenseAccount & {
  code: string; name: string; currency: "VES" | "USD"; account_type: string;
  opening: number; incoming: number; outgoing: number; closing: number; counted: number | null;
};
type InvoiceSales = { orders: number; sales_ves: number; sales_bcv: number | null; sales_divisas_usd: number; warnings: { missing_order_bcv: number; usd_overpayment: number; excluded_cashea_other_or_unresolved: number } };
type CurrencySummary = {
  period: { from: string; to: string };
  bs: Values; bcv: Values; usd: Values; operative: Values;
  accounts: FinanceAccount[];
  cashea: {
    sales: number; gross_ref: number; initial_ref: number;
    financed_ref: number; commission_ref: number;
    payouts_linked_ref: number; payouts_unlinked: number;
  };
  warnings: {
    bcv_missing: number; operative_missing: number;
    unclassified_adjustments: number; unmatched_transfers: number;
  };
};
type Metric = { title: string; key: string; help: string; formula: string };

const VIEWS: { code: CurrencyView; label: string }[] = [
  { code: "VES", label: "Bs" }, { code: "BCV", label: "$ BCV" }, { code: "USD", label: "Divisas" },
];
const METRICS: Record<CurrencyView, Metric[]> = {
  VES: [
    { title: "Facturación Cashea, Bs y crédito", key: "sales_assigned", help: "Cashea completo, contado en Bs y crédito LC del reporte. Las ventas directas en divisas se muestran aparte.", formula: "Suma de esas tres categorías, por fecha de factura. La inicial Cashea pertenece a Cashea aunque se haya pagado en divisas." },
    { title: "Cobros de ventas", key: "collections", help: "Dinero recibido por ventas en Bs en el período, aunque la factura sea anterior.", formula: "Entradas de movimientos PAYMENT en cuentas VES; no incluye transferencias internas." },
    { title: "Entradas a cuentas", key: "entries", help: "Todos los créditos en Bs de bancos y caja, incluso transferencias entre cuentas propias.", formula: "Suma de movimientos IN en cuentas VES, por fecha real del movimiento." },
    { title: "Salidas de cuentas", key: "outflows", help: "Todos los débitos en Bs. Las transferencias no son gastos del negocio.", formula: "Suma de movimientos OUT en cuentas VES; los egresos externos se presentan por separado." },
  ],
  BCV: [
    { title: "Facturación Cashea, Bs y crédito · $ BCV", key: "sales_bcv", help: "Equivalente de Cashea completo, contado en Bs y crédito LC del reporte.", formula: "Bs de cada categoría / BCV histórico de factura. Las ventas directas en divisas se muestran aparte; los abonos de crédito no reclasifican la venta." },
    { title: "Cobros de ventas $ BCV", key: "collections", help: "Pagos recibidos en Bs, incluso si la factura es anterior.", formula: "Cobros Bs / tasa BCV de cada cobro; no es facturación." },
    { title: "Entradas equivalentes", key: "entries", help: "Todas las entradas en Bs convertidas a tasa histórica BCV; no son dólares disponibles.", formula: "Suma por movimiento IN de Bs / BCV efectivo del movimiento." },
    { title: "Salidas equivalentes", key: "outflows", help: "Salidas en bolívares convertidas a tasa BCV histórica.", formula: "Suma por movimiento OUT de Bs / BCV efectivo del movimiento." },
    { title: "Entradas externas", key: "external_entries", help: "Entradas no procedentes de una transferencia entre cuentas propias.", formula: "Movimientos IN de Bs sin TRANSFER, convertidos individualmente; no equivale solo a ventas." },
  ],
  USD: [
    { title: "Ventas directas en divisas", key: "sales_assigned", help: "Porciones de ventas directas pagadas en USD, Zelle, Binance o saldo a favor USD, por fecha de factura.", formula: "USD nominales de la venta, sin iniciales Cashea ni abonos de crédito posteriores. No convierte pagos Bs." },
    { title: "Cobros de ventas", key: "collections", help: "USD reales o USDT cobrados por ventas durante el período.", formula: "Suma de movimientos PAYMENT en cuentas USD; Binance USDT se presenta nominalmente 1:1." },
    { title: "Entradas en divisas", key: "entries", help: "Dinero recibido en cuentas USD, incluyendo transferencias propias identificadas.", formula: "Suma de movimientos IN en cuentas USD, sin bolívares convertidos." },
    { title: "Salidas en divisas", key: "outflows", help: "Salidas reales de cuentas de divisas, separando traspasos de gastos.", formula: "Suma de movimientos OUT en cuentas USD." },
  ],
};
const INFO_STYLE = { display: "inline-block", position: "relative" as const };
const INFO_PANEL = {
  position: "absolute" as const, zIndex: 5, right: 0, top: 24, width: "min(280px, 74vw)",
  padding: 12, borderRadius: 9, border: "1px solid var(--border)",
  background: "var(--surface, #fff)", boxShadow: "0 10px 30px #0002", textAlign: "left" as const,
};

function dateToday() {
  return financeToday();
}
function dateStep(v: string, days: number) {
  return financeDateStep(v, days);
}
function weekStart(v: string) {
  const d = new Date(v + "T12:00:00Z");
  return dateStep(v, -((d.getUTCDay() + 6) % 7));
}
function valueFor(row: Values, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}
function Info({ title, help, formula }: { title: string; help: string; formula: string }) {
  return <details style={INFO_STYLE}>
    <summary aria-label={"Explicar " + title} title={"Explicar " + title}
      style={{ cursor: "pointer", listStyle: "none", fontSize: 14, color: "var(--muted)", padding: "0 3px" }}>ⓘ</summary>
    <div style={INFO_PANEL}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <p className="small" style={{ margin: "6px 0" }}>{help}</p>
      <div className="muted small">{formula}</div>
    </div>
  </details>;
}
function Money({ value, currency }: { value: number | null; currency: "VES" | "USD" }) {
  return <>{value === null ? <span title="Hay tasas históricas sin registrar">Pendiente</span> : currency === "VES" ? fmtVes(value) : fmtRef(value)}</>;
}
function MetricCard({ metric, row, currency }: { metric: Metric; row: Values; currency: "VES" | "USD" }) {
  return <div className="card" style={{ minWidth: 0 }}>
    <div className="row-between" style={{ alignItems: "start", gap: 8 }}>
      <span className="muted small">{metric.title}</span>
      <Info title={metric.title} help={metric.help} formula={metric.formula} />
    </div>
    <div className="kpi" style={{ wordBreak: "break-word" }}><Money value={valueFor(row, metric.key)} currency={currency} /></div>
  </div>;
}

export default function FinancePage() {
  const today = dateToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [preset, setPreset] = useState<Preset>("DAY");
  const [datesReady, setDatesReady] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<FinanceManagementReport | null>(null);
  const [view, setView] = useState<CurrencyView>("USD");
  const [includeVes, setIncludeVes] = useState(false);
  const [data, setData] = useState<CurrencySummary | null>(null);
  const [invoiceSales, setInvoiceSales] = useState<InvoiceSales | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [role, setRole] = useState("");
  const [expenseOpen, setExpenseOpen] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const start = query.get("from") ?? today, end = query.get("to") ?? start;
    if (validFinancePeriod(start, end, today)) {
      setFrom(start); setTo(end); setPreset(start === end ? "DAY" : "CUSTOM");
    }
    setDatesReady(true);
  }, []); // Initial shared report dates; subsequent edits stay in this page.

  useEffect(() => {
    if (!datesReady) return;
    let live = true;
    (async () => {
      setData(null); setInvoiceSales(null); setReport(null); setError("");
      if (!validFinancePeriod(from, to, today)) {
        setLoading(false); setError("Selecciona fechas válidas, hasta hoy y de máximo 367 días"); return;
      }
      const url = new URL(window.location.href); url.searchParams.set("from", from); url.searchParams.set("to", to);
      window.history.replaceState(null, "", url);
      setLoading(true);
      const [summary, financeRole, management] = await Promise.all([
        supabase.rpc("finance_currency_summary", { p_from: from, p_to: to }),
        supabase.rpc("finance_role"),
        supabase.rpc("finance_management_report", { p_from: from, p_to: to }),
      ]);
      if (!live) return;
      setLoading(false);
      setRole(String(financeRole.data ?? ""));
      if (summary.error || management.error || !management.data || !summary.data) { setError(summary.error?.message ?? management.error?.message ?? "Error de facturación"); return; }
      setData(summary.data as CurrencySummary);
      const m = management.data as FinanceManagementReport;
      setInvoiceSales({ orders: m.totals.orders,
        sales_ves: Number(m.channels.cashea.ves ?? 0) + Number(m.channels.contado.ves ?? 0) + Number(m.channels.credito.ves ?? 0),
        sales_bcv: m.totals.sales_equivalent === null ? null : m.totals.sales_equivalent - Number(m.channels.divisas.usd ?? 0),
        sales_divisas_usd: Number(m.channels.divisas.usd ?? 0),
        warnings: { missing_order_bcv: m.warnings.missing_invoice_rates, usd_overpayment: m.warnings.overpaid_orders, excluded_cashea_other_or_unresolved: m.warnings.excluded_cashea } });
      setReport(m);
    })().catch(() => { if (live) { setLoading(false); setError("No se pudo conectar. Reintenta cargar el reporte"); } });
    return () => { live = false; };
  }, [from, to, refresh, datesReady]);

  const ownAccounts = useMemo(() => (data?.accounts ?? []).filter(a => a.account_type !== "RELATED"), [data]);
  const selectedAccounts = ownAccounts.filter(a => (view === "USD" ? "USD" : "VES") === a.currency);
  const selected: Values = data && invoiceSales ? { ...(view === "VES" ? data.bs : view === "BCV" ? data.bcv : data.usd), ...(view === "VES" ? { sales_assigned: invoiceSales.sales_ves } : view === "BCV" ? { sales_bcv: invoiceSales.sales_bcv } : { sales_assigned: invoiceSales.sales_divisas_usd }) } : {};
  const missingRates = view === "BCV" ? (data?.warnings.bcv_missing ?? 0) : view === "USD" && includeVes ? (data?.warnings.operative_missing ?? 0) : 0;
  const metricCurrency = view === "VES" ? "VES" : "USD";

  function choose(v: Preset) {
    setPreset(v);
    if (v === "DAY") setFrom(today);
    if (v === "WEEK") setFrom(weekStart(today));
    if (v === "MONTH") setFrom(today.slice(0,7) + "-01");
    if (v === "30D") setFrom(dateStep(today,-29));
    if (v !== "CUSTOM") setTo(today);
  }

  function onExpenseDone() {
    setExpenseOpen(false);
    setRefresh(v => v + 1);
  }
  function selectDay(day: string) { setPreset("DAY"); setFrom(day); setTo(day); }

  const opIn = data ? valueFor(data.operative,"external_entries") : null;
  const opOut = data ? valueFor(data.operative,"external_outflows") : null;
  const dollarsIn = data ? valueFor(data.usd,"external_entries") : null;
  const dollarsOut = data ? valueFor(data.usd,"external_outflows") : null;

  return <main className="container stack finance-page">
    <section className="brand-hero">
      <div><div className="eyebrow">FINANZAS · CONTROL DEL NEGOCIO</div>
        <h1>Resumen financiero</h1>
        <p>Lo vendido, cómo se vendió y lo que queda por cobrar. Consulta un día o un período y lleva el reporte a administración.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>
    {role === "OWNER" && <div className="finance-cash-alerts"><FinanceCashAlerts /></div>}
    <section className="card stack finance-controls" aria-label="Fechas del reporte">
      <div className="finance-presets">
        {(["DAY","WEEK","MONTH","30D","CUSTOM"] as Preset[]).map(p =>
          <button key={p} className={"btn " + (preset === p ? "btn-primary" : "btn-ghost")} onClick={() => choose(p)}>
            {p === "DAY" ? "Un día" : p === "WEEK" ? "Esta semana" : p === "MONTH" ? "Este mes" : p === "30D" ? "Últimos 30 días" : "Rango de fechas"}
          </button>)}
        <button className="btn btn-ghost finance-refresh" onClick={() => setRefresh(v => v + 1)} disabled={loading}>Actualizar</button>
      </div>
      {preset === "DAY" ? <div className="finance-daily-input">
        <button className="btn btn-ghost" onClick={() => selectDay(dateStep(from, -1))} disabled={!from} aria-label="Día anterior">←</button>
        <label><span className="label">Día del reporte</span><input className="input" type="date" value={from} max={today} onChange={e => selectDay(e.target.value)} /></label>
        <button className="btn btn-ghost" onClick={() => selectDay(dateStep(from, 1))} disabled={!from || from >= today} aria-label="Día siguiente">→</button>
        <button className="btn btn-ghost" onClick={() => selectDay(today)}>Hoy</button>
        <button className="btn btn-ghost" onClick={() => selectDay(dateStep(today, -1))}>Ayer</button>
      </div> : <div className="grid grid-2">
        <label><span className="label">Desde</span><input type="date" className="input" value={from} max={to} onChange={e => { setPreset("CUSTOM"); setFrom(e.target.value); }} /></label>
        <label><span className="label">Hasta</span><input type="date" className="input" value={to} min={from} max={today} onChange={e => { setPreset("CUSTOM"); setTo(e.target.value); }} /></label>
      </div>}
    </section>
    {loading && <div className="card muted finance-report-loading" role="status">Preparando el reporte financiero…</div>}
    {error && <div className="error finance-error-row" role="alert"><span>No se pudo cargar el reporte: {error}.</span><button className="btn btn-ghost" onClick={() => setRefresh(v => v + 1)}>Reintentar</button></div>}
    {data && invoiceSales && report && !loading && <>
      <FinanceManagementReportView report={report} />
      <details className="finance-extra"><summary>Movimientos, cobros, bancos y detalle por moneda</summary><div className="stack">
      <div className="row" role="tablist" aria-label="Moneda del resumen financiero" style={{ flexWrap: "wrap", gap: 8 }}>
        {VIEWS.map(v => <button key={v.code} type="button" role="tab" aria-selected={view === v.code}
          onClick={() => setView(v.code)} className={"btn " + (view === v.code ? "btn-primary" : "btn-ghost")}>{v.label}</button>)}
      </div>
      {view === "USD" && <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={includeVes} onChange={e => setIncludeVes(e.target.checked)} />
        <span className="small">Incluir equivalente de Bs a tasa operativa (solo consulta)</span>
      </label>}
      <section className="stack">
        <div className="row-between">
          <h2 className="section-title" style={{ margin: 0 }}>{view === "VES" ? "Movimientos en bolívares" : view === "BCV" ? "Equivalentes a tasa BCV" : "Dinero real en divisas"}</h2>
          <span className="pill">{view === "VES" ? "Bs reales" : view === "BCV" ? "Solo referencial" : "USD / USDT 1:1"}</span>
        </div>
        {missingRates > 0 && <div className="error">{missingRates} movimiento(s) en Bs sin tasa histórica {view === "BCV" ? "BCV" : "operativa"}. La conversión global queda pendiente; no se usa la tasa actual.</div>}
        <section className="grid grid-2">
          {METRICS[view].map(m => <MetricCard key={m.key} metric={m} row={selected} currency={metricCurrency} />)}
        </section>
        {(view === "BCV" || view === "VES") && <div className="card stack" style={{ gap: 6 }}>
          <div className="row-between"><strong className="small">Facturación del período</strong>
            <Info title="Facturación, no cobros" help="El mismo reparto del reporte superior: Cashea completo, contado Bs y crédito LC; divisas directas aparte." formula="Conversión BCV histórica por factura. La inicial Cashea no se duplica y los cobros se calculan por separado a la tasa de cobro." /></div>
          <div className="row-between small"><span>Órdenes cerradas</span><strong>{invoiceSales.orders}</strong></div>
          <div className="row-between small"><span>Cashea, contado Bs y crédito LC</span><strong>{fmtVes(invoiceSales.sales_ves)}</strong></div>
          <div className="row-between small"><span>Equivalente a tasa BCV de venta</span><strong><Money value={invoiceSales.sales_bcv} currency="USD" /></strong></div>
          <div className="row-between small"><span>Ventas en divisas excluidas</span><strong>{fmtRef(invoiceSales.sales_divisas_usd)}</strong></div>
          <div className="muted small">Ventas por fecha de factura; cobros por fecha de pago. El equivalente no representa dinero recibido en dólares.</div>
        </div>}
        {(invoiceSales.warnings.missing_order_bcv > 0 || invoiceSales.warnings.usd_overpayment > 0 || invoiceSales.warnings.excluded_cashea_other_or_unresolved > 0) && <div className="error">Hay ventas con datos pendientes de revisión: BCV faltante ({invoiceSales.warnings.missing_order_bcv}), pagos en divisas superiores a factura ({invoiceSales.warnings.usd_overpayment}), Cashea sin atribución confirmada ({invoiceSales.warnings.excluded_cashea_other_or_unresolved}).</div>}
        <div className="card row-between">
          <div><strong>Flujo externo del período</strong><div className="muted small">Entradas externas menos salidas externas. No es utilidad ni saldo bancario.</div></div>
          <strong><Money currency={metricCurrency} value={valueFor(selected, "external_entries") === null || valueFor(selected, "external_outflows") === null
            ? null : Number(selected.external_entries) - Number(selected.external_outflows)} /></strong>
        </div>
      </section>

      {view === "USD" && includeVes && <section className="card stack">
        <div className="row-between"><h2 className="section-title" style={{ margin: 0 }}>Consolidado operativo · solo consulta</h2>
          <Info title="Total combinado de consulta" help="Las entradas y salidas reales en USD se acompañan del equivalente histórico de entradas y salidas externas en Bs."
            formula="USD real + suma(Bs / tasa operativa al momento de cada movimiento). Nunca modifica caja USD y nunca vuelve a contar los traspasos propios." /></div>
        <div className="row-between"><span>Entradas externas de divisas reales</span><strong><Money value={dollarsIn} currency="USD" /></strong></div>
        <div className="row-between"><span>Entradas Bs equivalentes a $ operativo</span><strong><Money value={opIn} currency="USD" /></strong></div>
        <div className="row-between"><strong>Entradas combinadas de consulta</strong><strong><Money value={opIn === null || dollarsIn === null ? null : opIn + dollarsIn} currency="USD" /></strong></div>
        <hr />
        <div className="row-between"><span>Salidas externas de divisas reales</span><strong><Money value={dollarsOut} currency="USD" /></strong></div>
        <div className="row-between"><span>Salidas Bs equivalentes a $ operativo</span><strong><Money value={opOut} currency="USD" /></strong></div>
        <div className="row-between"><strong>Salidas combinadas de consulta</strong><strong><Money value={opOut === null || dollarsOut === null ? null : opOut + dollarsOut} currency="USD" /></strong></div>
        <div className="muted small">No se suma al saldo real ni a las ventas. USDT mostrado nominalmente 1:1.</div>
      </section>}

      <section className="card stack">
        <div className="row-between"><h2 className="section-title" style={{ margin: 0 }}>Bancos y cajas</h2>
          <Info title="Movimientos por cuenta" help="Importes en moneda nativa, agrupados por el período y la cuenta correspondiente."
            formula="Entradas y salidas son todos los movimientos registrados. Saldo contable al cierre = movimientos acumulados hasta la fecha; no sustituye la conciliación bancaria." /></div>
        {view === "BCV" && <div className="muted small">Los movimientos de las cuentas permanecen en Bs originales. Solo los indicadores superiores están expresados en $ BCV.</div>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "right" }}>
            <thead><tr><th style={{ textAlign: "left", padding: 8 }}>Cuenta</th><th>Entró</th><th>Salió</th><th>Saldo contable</th><th>Diferencia</th></tr></thead>
            <tbody>{selectedAccounts.map(a => <tr key={a.id} className="order-item">
              <td style={{ textAlign: "left", padding: 8 }}><strong>{a.code === "BINANCE" ? "Binance USDT" : a.name}</strong></td>
              <td><Money value={Number(a.incoming)} currency={a.currency} /></td>
              <td><Money value={Number(a.outgoing)} currency={a.currency} /></td>
              <td><Money value={Number(a.closing)} currency={a.currency} /></td>
              <td>{a.counted === null ? <span className="muted small">Sin conteo</span>
                : <Money currency={a.currency} value={Number(a.closing) - Number(a.counted)} />}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="muted small">El saldo es contable, no verificado por extracto. Las diferencias se conservan para revisión. No se incluyen cuentas de otro local.</div>
      </section>

      <section className="card stack">
        <div className="row-between"><h2 className="section-title" style={{ margin: 0 }}>Cashea · control independiente</h2>
          <Info title="Cashea" help="Ventas de órdenes propias de Lubricenter y liquidaciones respaldadas por el reporte externo."
            formula="Las ventas se fechan por factura; los pagos bancarios por acreditación. La liquidación de Cashea no se suma por segunda vez al banco." /></div>
        <div className="muted small">Valores contractuales de referencia en USD, separados de la caja de divisas. No son dólares recibidos.</div>
        {([
          ["Ventas brutas",data.cashea.gross_ref],
          ["Iniciales",data.cashea.initial_ref],
          ["Financiado",data.cashea.financed_ref],
          ["Comisiones estimadas de órdenes",data.cashea.commission_ref],
          ["Payouts con respaldo bancario",data.cashea.payouts_linked_ref],
        ] as [string,number][]).map(([label,value]) =>
          <div key={label} className="row-between"><span>{label}</span><strong>{fmtRef(value)}</strong></div>)}
        <div className="muted small">{data.cashea.sales} venta(s) propias en este período · {data.cashea.payouts_unlinked} payout(s) sin vínculo bancario. Los importes pendientes definitivos requieren conciliar el reporte y las retenciones.</div>
        <Link href="/cashea/balance" className="btn btn-ghost">Revisar facturas y balance Cashea</Link>
      </section>

      {(data.warnings.unclassified_adjustments > 0 || data.warnings.unmatched_transfers > 0) && <div className="card">
        <strong>Revisión pendiente</strong><div className="muted small">
          {data.warnings.unclassified_adjustments} ajustes sin clasificar · {data.warnings.unmatched_transfers} transferencias sin grupo asociado. No se ajustaron automáticamente.
        </div>
      </div>}
      <section className="grid grid-2">
        <Link href="/finance/reconcile" className="card brand-card"><strong>Conciliación semanal</strong><div className="muted small">Ver diferencias de bancos y Cashea.</div></Link>
        <Link href="/finance/export" className="card brand-card"><strong>Exportar conciliación</strong><div className="muted small">Anexos individuales y pendientes de revisión.</div></Link>
        <Link href="/finance/bank-outflows" className="card brand-card"><strong>Egresos bancarios</strong><div className="muted small">Clasificar los débitos sin alterar ventas.</div></Link>
        <Link href="/cash" className="card brand-card"><strong>Caja y transferencias</strong><div className="muted small">Ver movimientos o traspasar entre Bs y divisas.</div></Link>
        <Link href="/finance/profit" className="card"><strong>Ganancias</strong><div className="muted small">Tienda y taller por separado, ítem por ítem.</div></Link>
        <Link href="/receivables" className="card"><strong>Crédito LC</strong><div className="muted small">Consultar cobros pendientes por cliente.</div></Link>
        <Link href="/expenses" className="card"><strong>Proveedores y egresos</strong><div className="muted small">Compras, pagos y gastos.</div></Link>
      </section>
      <div className="row"><button className="btn btn-primary" onClick={() => setExpenseOpen(true)}>+ Registrar gasto</button></div>
      {expenseOpen && <ExpenseSheet accounts={ownAccounts} onCancel={() => setExpenseOpen(false)} onDone={onExpenseDone} />}
      </div></details>
    </>}
  </main>;
}

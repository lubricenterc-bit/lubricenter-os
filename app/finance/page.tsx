"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FinanceCashAlerts } from "@/components/finance-cash-alerts";
import { ExpenseSheet, type ExpenseAccount } from "@/components/expense-sheet";
import { fmtRef, fmtVes } from "@/lib/format";
import { supabase } from "@/lib/supabase";

type CurrencyView = "VES" | "BCV" | "USD";
type Preset = "WEEK" | "MONTH" | "30D" | "CUSTOM";
type Values = Record<string, number | string | null>;
type FinanceAccount = ExpenseAccount & {
  code: string; name: string; currency: "VES" | "USD"; account_type: string;
  opening: number; incoming: number; outgoing: number; closing: number; counted: number | null;
};
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
    { title: "Ventas asignadas a Bs", key: "sales_assigned", help: "Porciones de órdenes cerradas asignadas a cobros en bolívares. La fecha es la de facturación.", formula: "Suma del importe nativo de pagos Bs de órdenes facturadas en el período. Excluye partes financiadas aún sin moneda de cobro." },
    { title: "Cobros de ventas", key: "collections", help: "Dinero recibido por ventas en Bs en el período, aunque la factura sea anterior.", formula: "Entradas de movimientos PAYMENT en cuentas VES; no incluye transferencias internas." },
    { title: "Entradas a cuentas", key: "entries", help: "Todos los créditos en Bs de bancos y caja, incluso transferencias entre cuentas propias.", formula: "Suma de movimientos IN en cuentas VES, por fecha real del movimiento." },
    { title: "Salidas de cuentas", key: "outflows", help: "Todos los débitos en Bs. Las transferencias no son gastos del negocio.", formula: "Suma de movimientos OUT en cuentas VES; los egresos externos se presentan por separado." },
  ],
  BCV: [
    { title: "Cobros de ventas $ BCV", key: "collections", help: "Equivalente de los pagos de clientes realmente recibidos en Bs.", formula: "Cada cobro en Bs / tasa BCV del momento de cobro, sumado individualmente." },
    { title: "Entradas equivalentes", key: "entries", help: "Todas las entradas en Bs convertidas a tasa histórica BCV; no son dólares disponibles.", formula: "Suma por movimiento IN de Bs / BCV efectivo del movimiento." },
    { title: "Salidas equivalentes", key: "outflows", help: "Salidas en bolívares convertidas a tasa BCV histórica.", formula: "Suma por movimiento OUT de Bs / BCV efectivo del movimiento." },
    { title: "Entradas externas", key: "external_entries", help: "Entradas no procedentes de una transferencia entre cuentas propias.", formula: "Movimientos IN de Bs sin TRANSFER, convertidos individualmente; no equivale solo a ventas." },
  ],
  USD: [
    { title: "Ventas asignadas a divisas", key: "sales_assigned", help: "Porciones de órdenes cerradas asignadas a pagos reales en USD/USDT, por fecha de factura.", formula: "Suma de pagos originales USD vinculados a órdenes facturadas en el período; no convierte pagos Bs." },
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
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function dateStep(v: string, days: number) {
  const d = new Date(v + "T12:00:00-04:00");
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function weekStart(v: string) {
  const d = new Date(v + "T12:00:00-04:00");
  return dateStep(v, -((d.getDay() + 6) % 7));
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
  const [from, setFrom] = useState(today.slice(0, 7) + "-01");
  const [to, setTo] = useState(today);
  const [preset, setPreset] = useState<Preset>("MONTH");
  const [view, setView] = useState<CurrencyView>("USD");
  const [includeVes, setIncludeVes] = useState(false);
  const [data, setData] = useState<CurrencySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [role, setRole] = useState("");
  const [expenseOpen, setExpenseOpen] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true); setError("");
      const [summary, financeRole] = await Promise.all([
        supabase.rpc("finance_currency_summary", { p_from: from, p_to: to }),
        supabase.rpc("finance_role"),
      ]);
      if (!live) return;
      setLoading(false);
      setRole(String(financeRole.data ?? ""));
      if (summary.error) { setData(null); setError(summary.error.message); return; }
      setData(summary.data as CurrencySummary);
    })();
    return () => { live = false; };
  }, [from, to]);

  const ownAccounts = useMemo(() => (data?.accounts ?? []).filter(a => a.account_type !== "RELATED"), [data]);
  const selectedAccounts = ownAccounts.filter(a => (view === "USD" ? "USD" : "VES") === a.currency);
  const selected = data ? (view === "VES" ? data.bs : view === "BCV" ? data.bcv : data.usd) : {};
  const missingRates = view === "BCV" ? (data?.warnings.bcv_missing ?? 0) : view === "USD" && includeVes ? (data?.warnings.operative_missing ?? 0) : 0;
  const metricCurrency = view === "VES" ? "VES" : "USD";

  function choose(v: Preset) {
    setPreset(v);
    if (v === "WEEK") setFrom(weekStart(today));
    if (v === "MONTH") setFrom(today.slice(0,7) + "-01");
    if (v === "30D") setFrom(dateStep(today,-29));
    if (v !== "CUSTOM") setTo(today);
  }

  function onExpenseDone() {
    setExpenseOpen(false);
    // Re-fetch the selected dates without mutating existing transactions.
    setFrom(v => v);
    window.location.reload();
  }

  const opIn = data ? valueFor(data.operative,"external_entries") : null;
  const opOut = data ? valueFor(data.operative,"external_outflows") : null;
  const dollarsIn = data ? valueFor(data.usd,"external_entries") : null;
  const dollarsOut = data ? valueFor(data.usd,"external_outflows") : null;

  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">FINANZAS · CONTROL DEL NEGOCIO</div>
        <h1>Resumen financiero</h1>
        <p>Tres vistas independientes. Ventas, cobros, movimientos y saldos no se duplican ni convierten silenciosamente.</p>
      </div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>
    {role === "OWNER" && <FinanceCashAlerts />}
    <section className="card stack">
      <div className="finance-presets">
        {(["WEEK","MONTH","30D","CUSTOM"] as Preset[]).map(p =>
          <button key={p} className={"btn " + (preset === p ? "btn-primary" : "btn-ghost")} onClick={() => choose(p)}>
            {p === "WEEK" ? "Esta semana" : p === "MONTH" ? "Este mes" : p === "30D" ? "Últimos 30 días" : "Personalizado"}
          </button>)}
      </div>
      <div className="grid grid-2">
        <label><span className="label">Desde</span><input type="date" className="input" value={from} max={to} onChange={e => { setPreset("CUSTOM"); setFrom(e.target.value); }} /></label>
        <label><span className="label">Hasta</span><input type="date" className="input" value={to} min={from} max={today} onChange={e => { setPreset("CUSTOM"); setTo(e.target.value); }} /></label>
      </div>
      <div className="row" role="tablist" aria-label="Moneda del resumen financiero" style={{ flexWrap: "wrap", gap: 8 }}>
        {VIEWS.map(v => <button key={v.code} type="button" role="tab" aria-selected={view === v.code}
          onClick={() => setView(v.code)} className={"btn " + (view === v.code ? "btn-primary" : "btn-ghost")}>{v.label}</button>)}
      </div>
      {view === "USD" && <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={includeVes} onChange={e => setIncludeVes(e.target.checked)} />
        <span className="small">Incluir equivalente de Bs a tasa operativa (solo consulta)</span>
      </label>}
    </section>
    {loading && <div className="card muted">Calculando el período…</div>}
    {error && <div className="error">No se pudo cargar el nuevo resumen: {error}. Ningún saldo fue modificado.</div>}
    {data && !loading && <>
      <section className="stack">
        <div className="row-between">
          <h2 className="section-title" style={{ margin: 0 }}>{view === "VES" ? "Movimientos en bolívares" : view === "BCV" ? "Equivalentes a tasa BCV" : "Dinero real en divisas"}</h2>
          <span className="pill">{view === "VES" ? "Bs reales" : view === "BCV" ? "Solo referencial" : "USD / USDT 1:1"}</span>
        </div>
        {missingRates > 0 && <div className="error">{missingRates} movimiento(s) en Bs sin tasa histórica {view === "BCV" ? "BCV" : "operativa"}. La conversión global queda pendiente; no se usa la tasa actual.</div>}
        <section className="grid grid-2">
          {METRICS[view].map(m => <MetricCard key={m.key} metric={m} row={selected} currency={metricCurrency} />)}
        </section>
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
        <Link href="/receivables" className="card"><strong>Crédito LC</strong><div className="muted small">Consultar cobros pendientes por cliente.</div></Link>
        <Link href="/expenses" className="card"><strong>Proveedores y egresos</strong><div className="muted small">Compras, pagos y gastos.</div></Link>
      </section>
      <div className="row"><button className="btn btn-primary" onClick={() => setExpenseOpen(true)}>+ Registrar gasto</button></div>
      {expenseOpen && <ExpenseSheet accounts={ownAccounts} onCancel={() => setExpenseOpen(false)} onDone={onExpenseDone} />}
    </>}
  </main>;
}

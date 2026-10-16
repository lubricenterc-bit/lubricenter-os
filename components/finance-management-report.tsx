"use client";

import Link from "next/link";
import { fmtRef, fmtVes } from "@/lib/format";
import { FINANCE_CHANNEL_LABELS, financePeriodLabel, managementReportCsv, type FinanceManagementReport } from "@/lib/finance/management-report";

const CHANNELS = [
  { key: "cashea", label: "Cashea", note: "Venta completa · inicial incluida", color: "#8276ce" },
  { key: "contado", label: "Contado en Bs", note: "Pagos directos en bolívares", color: "#e96b28" },
  { key: "divisas", label: "Divisas", note: "USD, Zelle y Binance · USDT 1:1", color: "#398363" },
  { key: "credito", label: "Crédito LC", note: "Parte de la venta dejada a crédito", color: "#477ba6" },
] as const;

function Amount({ value }: { value: number | null }) {
  return <>{value === null ? "Por revisar" : fmtRef(value)}</>;
}
export function FinanceManagementReportView({ report }: { report: FinanceManagementReport }) {
  const { totals, channels, receivables, warnings } = report;
  const day = report.period.from === report.period.to;
  const period = financePeriodLabel(report.period.from, report.period.to);
  const time = (date: string) => new Intl.DateTimeFormat("es-VE", { ...(day ? {} : { day: "2-digit", month: "2-digit" }), hour: "2-digit", minute: "2-digit", timeZone: "America/Caracas" }).format(new Date(date));
  function download() {
    const url = URL.createObjectURL(new Blob([managementReportCsv(report)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `Lubricenter_reporte_${report.period.from}_${report.period.to}.csv`;
    a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="finance-management-report stack" aria-label="Reporte de ventas y cuentas por cobrar">
    <div className="finance-report-heading">
      <div><div className="eyebrow">REPORTE DE ADMINISTRACIÓN</div><h2>{period}</h2><p className="muted small">Ventas por fecha de factura · hora de Venezuela</p></div>
      <div className="row finance-tools"><button className="btn btn-ghost" onClick={download}>Descargar Excel / CSV</button><button className="btn btn-ghost" onClick={() => window.print()}>Imprimir / PDF</button></div>
    </div>
    <section className="finance-sales-hero" aria-label="Total vendido">
      <div className="finance-total-label">TOTAL VENDIDO · EQUIVALENTE</div>
      <div className="finance-sales-total" data-testid="finance-total"><Amount value={totals.sales_equivalent} /></div>
      <div className="finance-total-meta"><span>{totals.orders} {totals.orders === 1 ? "orden facturada" : "órdenes facturadas"}</span><span>{day ? "Reporte diario" : "Reporte del período"}</span></div>
      <p>Bs convertidos al BCV histórico de cada factura + ventas en divisas nominales. Es el valor vendido, no el dinero disponible en caja.</p>
      {totals.sales_equivalent !== null && totals.sales_equivalent > 0 && <div className="finance-channel-bar" aria-hidden="true">{CHANNELS.map(c => <span key={c.key} style={{ width: `${100 * Number(channels[c.key].equivalent ?? 0) / totals.sales_equivalent!}%`, background: c.color }} />)}</div>}
    </section>
    <section className="finance-channel-grid" aria-label="Ventas por forma de pago">
      {CHANNELS.map(c => { const row = channels[c.key]; const share = totals.sales_equivalent && row.equivalent !== null ? 100 * row.equivalent / totals.sales_equivalent : null;
        return <article className="finance-channel-card" key={c.key} style={{ borderTopColor: c.color }}>
          <div className="row-between"><h3>{c.label}</h3>{share !== null && <span className="small muted">{share.toFixed(1)}%</span>}</div>
          <strong className="finance-channel-amount"><Amount value={row.equivalent} /></strong>
          <div className="small">{c.key === "divisas" ? "USD nominales de la venta" : `${fmtVes(row.ves ?? 0)} · equivalente BCV`}</div>
          <p className="muted small">{c.note}</p><span className="finance-channel-count">{row.orders} orden(es) con participación</span>
        </article>;
      })}
    </section>
    <p className="muted small finance-report-note">Una venta mixta reparte su importe entre canales. Las iniciales Cashea están dentro de Cashea; los abonos posteriores de crédito no vuelven a contarse como venta. Contado puede incluir saldo a favor usado por el cliente.</p>
    {(warnings.missing_invoice_rates > 0 || warnings.overpaid_orders > 0 || warnings.excluded_cashea > 0) && <div className="error" role="alert">Revisión del reporte: {warnings.missing_invoice_rates} factura(s) sin BCV histórico, {warnings.overpaid_orders} con pagos superiores al total y {warnings.excluded_cashea} Cashea excluida(s) por atribución o anulación. Los importes incompletos se muestran como “Por revisar”.</div>}
    <section className="finance-debts-grid" aria-label="Cuentas por cobrar al cierre">
      <article className="card stack">
        <div className="row-between"><div className="eyebrow">CUENTAS POR COBRAR · CLIENTES</div><span className="pill">Al {receivables.as_of}</span></div>
        <div className="finance-debt-amount">{fmtVes(receivables.outstanding_ves)}</div>
        <div><Amount value={receivables.outstanding_bcv} /> <span className="muted small">equivalente al BCV de las facturas</span></div>
        <div className="muted small">{receivables.accounts} cuenta(s) · {receivables.overdue} vencida(s). Incluye deudas de días anteriores y descuenta solo abonos hasta la fecha consultada.</div>
        <Link href="/receivables" className="finance-report-link">Gestionar cobros →</Link>
      </article>
      <article className="card stack">
        <div className="eyebrow">CASHEA · SALDO REGISTRADO AL CORTE</div>
        <div className="finance-debt-amount">{receivables.cashea_recorded_ref === null ? "Sin apertura" : fmtRef(receivables.cashea_recorded_ref)}</div>
        <p className="muted small">{receivables.cashea_recorded_ref === null ? "Falta registrar una apertura para calcular el saldo acumulado de Cashea." : "Saldo del balance Cashea hasta la fecha consultada. Su confirmación depende de la conciliación de liquidaciones y retenciones."}</p>
        <div className="small">Financiado en las ventas seleccionadas: <strong>{fmtRef(channels.cashea.financed_ref ?? 0)}</strong></div>
        <Link href="/cashea/balance" className="finance-report-link">Ver balance Cashea →</Link>
      </article>
    </section>
    <section className="card stack finance-orders-card">
      <div className="row-between"><div><div className="eyebrow">DETALLE DE FACTURACIÓN</div><h2 className="section-title">{day ? "Órdenes de este día" : "Órdenes del período"}</h2></div><span className="pill">{totals.orders} órdenes</span></div>
      {report.orders.length === 0 ? <div className="finance-empty">No hay órdenes facturadas en la fecha seleccionada.</div> : <div className="finance-table-wrap"><table className="finance-report-table">
        <thead><tr><th>Orden / hora</th><th>Cliente / vehículo</th><th>Modalidad</th><th className="finance-number">Venta equivalente</th></tr></thead>
        <tbody>{report.orders.map(o => <tr key={o.id}>
          <td><Link href={`/orders/${o.id}`} className="finance-report-link">{o.order_number}</Link><div className="muted small">{time(o.business_at)}</div></td>
          <td><strong>{o.customer}</strong><div className="muted small">{[o.plate, o.location].filter(Boolean).join(" · ")}</div></td>
          <td><span className="pill">{FINANCE_CHANNEL_LABELS[o.channel] ?? o.channel}</span>{o.channel === "MIXTA" && <div className="muted small">Importe repartido entre canales</div>}</td>
          <td className="finance-number"><strong><Amount value={o.sales_equivalent} /></strong><div className="muted small">Factura: {fmtVes(o.total_ves)}</div></td>
        </tr>)}</tbody>
        <tfoot><tr><td colSpan={3}>Total de las órdenes seleccionadas</td><td className="finance-number"><Amount value={totals.sales_equivalent} /></td></tr></tfoot>
      </table></div>}
    </section>
    {receivables.items.length > 0 && <details className="card finance-debt-detail"><summary>Ver {receivables.accounts} cuenta(s) por cobrar al corte</summary><div className="finance-table-wrap"><table className="finance-report-table"><thead><tr><th>Cliente / orden</th><th>Vencimiento</th><th className="finance-number">Pendiente Bs</th></tr></thead><tbody>{receivables.items.map(r => <tr key={r.id}><td><strong>{r.customer}</strong><div><Link className="finance-report-link" href={`/orders/${r.order_id}`}>{r.order_number}</Link></div></td><td>{r.due_date ?? "Sin fecha"}</td><td className="finance-number">{fmtVes(r.outstanding_ves)}</td></tr>)}</tbody></table></div></details>}
    <div className="muted small finance-report-stamp">LUBRICENTER OS · Generado {new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Caracas" }).format(new Date(report.generated_at))} · Las órdenes anuladas y abiertas no forman parte de la facturación.</div>
  </div>;
}

import Link from "next/link";
import { fmtRef } from "@/lib/format";
import { REASON_LABEL, dayMonth, type UnverifiedInstallment } from "@/lib/cashea-sync";

/** Cuotas que no se pudieron verificar al 100 %: no se marcan pagadas solas. */
export function PendingConfirmation({ items, title = "Cuotas por confirmar" }: { items: UnverifiedInstallment[]; title?: string }) {
  if (!items.length) return null;
  return <section className="card stack" aria-labelledby="cashea-pending-title">
    <div className="row-between"><h2 id="cashea-pending-title" className="section-title">{title} ({items.length})</h2><span className="pill warn">REVISAR</span></div>
    <p className="muted small">Solo se marcan pagadas solas las cuotas que Cashea da por pagadas o cuyo pago aparece en el BNC con la misma referencia y el mismo monto. Estas necesitan un dato más.</p>
    <div className="stack">
      {items.map(x => <div className="order-item row-between" key={`${x.cashea_reference ?? x.order_number}-${x.installment_no}`}>
        <div>
          <strong>{x.order_number ?? "Venta"} · cuota {x.installment_no} · {fmtRef(x.amount_ref)}</strong>
          <div className="muted small">Vence {dayMonth(x.due_date)}{x.cashea_reference ? ` · Cashea ${x.cashea_reference}` : " · sin número de Cashea"}{x.verified_ref > 0 ? ` · verificado ${fmtRef(x.verified_ref)}` : ""}</div>
          <div className="small">{x.hint}</div>
        </div>
        <span className="pill warn">{REASON_LABEL[x.reason] ?? x.reason}</span>
      </div>)}
    </div>
    <div className="row"><Link className="btn" href="/cashea/conciliacion">Subir reportes</Link></div>
  </section>;
}

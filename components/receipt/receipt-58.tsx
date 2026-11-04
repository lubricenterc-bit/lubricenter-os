import {
  amountIn, footerPhrase, installmentStatus, km, lineDetail, qtyText, ref, shortDate, shortTime, statusBand, ves,
  type ReceiptData,
} from "@/lib/receipt";

/** Recibo de 58 mm (48 mm de contenido): solo negro sobre blanco. */
export function Receipt58({ data }: { data: ReceiptData }) {
  const h = data.header;
  const band = statusBand(data.order.status);
  const contact = [h.address, h.whatsapp ? `WhatsApp ${h.whatsapp}` : null, h.instagram ? `@${h.instagram.replace(/^@/, "")}` : null, h.rif ? `RIF ${h.rif}` : null].filter(Boolean);
  const vehicle = data.vehicle ? [data.vehicle.label, data.vehicle.plate].filter(Boolean).join(" · ") : "";
  const next = data.next_service;

  return <article className="lc-receipt" data-total-style={h.total_style === "BORDER" ? "BORDER" : "BLOCK"} aria-label={`Recibo ${data.order.number}`}>
    {band && <div className="lc-r-band">{band}</div>}

    <header className="lc-r-head">
      <img className="lc-r-logo" src="/brand/lubricenter-mono.svg" alt="" width={64} height={64} />
      <div className="lc-r-brand">LUBRICENTER</div>
      {h.branch && <div className="lc-r-branch">{h.branch}</div>}
      {contact.map(c => <div className="lc-r-contact" key={c}>{c}</div>)}
    </header>

    <hr className="lc-r-rule lc-r-rule-thick" />

    <section className="lc-r-doc">
      <div className="lc-r-doc-title">Nota de entrega</div>
      <div className="lc-r-row lc-r-doc-row"><strong>{data.order.number}</strong><span>{shortDate(data.order.at)} · {shortTime(data.order.at)}</span></div>
    </section>

    {(data.customer?.name || vehicle || data.vehicle?.odometer) && <section className="lc-r-party">
      {data.customer?.name && <div className="lc-r-strong">{data.customer.name}</div>}
      {vehicle && <div>{vehicle}</div>}
      {data.vehicle?.odometer ? <div>{km(data.vehicle.odometer)}</div> : null}
    </section>}

    <hr className="lc-r-rule" />

    <section className="lc-r-lines">
      {data.lines.map((line, i) => {
        const detail = lineDetail(line);
        return <div className="lc-r-line" key={i}>
          <div className="lc-r-line-name">{line.name}</div>
          <div className="lc-r-row lc-r-line-detail">
            <span>{detail}</span>
            <strong>{line.courtesy ? "Cortesía" : ref(line.total_ref)}</strong>
          </div>
        </div>;
      })}
      {data.adjustments.discount_ref ? <div className="lc-r-row lc-r-adj"><span>Descuento</span><strong>-{ref(data.adjustments.discount_ref)}</strong></div> : null}
      {data.adjustments.rounding_ref ? <div className="lc-r-row lc-r-adj"><span>Redondeo</span><strong>{ref(data.adjustments.rounding_ref)}</strong></div> : null}
    </section>

    <section className="lc-r-total">
      <div className="lc-r-row lc-r-total-main"><span>Total</span><strong>{ref(data.totals.ref)}</strong></div>
      <div className="lc-r-row lc-r-total-ves"><span>{data.totals.bcv_rate ? `Tasa BCV ${qtyText(data.totals.bcv_rate)}` : ""}</span><span>{ves(data.totals.ves)}</span></div>
    </section>

    {(data.payments.length > 0 || data.change.length > 0) && <section className="lc-r-block">
      <div className="lc-r-label">Pago</div>
      {data.payments.map((p, i) => <div className="lc-r-row" key={i}>
        <span>{p.label}{p.ref_tail && <span className="lc-r-sub">Ref. {p.ref_tail}</span>}</span><strong>{amountIn(p.amount, p.currency)}</strong>
      </div>)}
      {data.change.map((c, i) => <div key={`c${i}`}>
        <div className="lc-r-row"><span>Recibido</span><span>{amountIn(c.received, c.currency)}</span></div>
        {c.returned_usd > 0 && <div className="lc-r-row"><span>Vuelto entregado</span><span>{ref(c.returned_usd)}</span></div>}
        {c.pending_usd > 0 && <div className="lc-r-row"><strong>Vuelto pendiente</strong><strong>{ref(c.pending_usd)}</strong></div>}
      </div>)}
    </section>}

    {data.cashea && <section className="lc-r-block">
      <div className="lc-r-label">Cashea</div>
      <div className="lc-r-row"><span>Inicial {qtyText(data.cashea.initial_percent)}%</span><strong>{ref(data.cashea.initial_ref)}</strong></div>
      {data.cashea.installments.map(i => <div className="lc-r-row lc-r-inst" key={i.no}>
        <span>Cuota {i.no} · {shortDate(i.due).slice(0, 5)}</span><span>{ref(i.amount_ref)} · {installmentStatus(i.status)}</span>
      </div>)}
    </section>}

    {data.credit && <section className="lc-r-block">
      <div className="lc-r-row"><strong>Saldo pendiente</strong><strong>{ves(data.credit.outstanding_ves)}</strong></div>
    </section>}

    {next && <section className="lc-r-next">
      <div className="lc-r-label">Tu próximo cambio</div>
      <div className="lc-r-next-main">{[km(next.odometer), shortDate(next.date)].filter(Boolean).join(" · ")}</div>
      {next.oil && <div>Aceite {next.oil}</div>}
      {next.filter && <div>Filtro <span className="lc-r-keep">{next.filter}</span></div>}
    </section>}

    <footer className="lc-r-foot">
      <div className="lc-r-strong">Cuidamos lo que te mueve.</div>
      <div>{footerPhrase(data)}</div>
      {data.order.attendant && <div>Atendió: {data.order.attendant}</div>}
      {h.legend && <div className="lc-r-legend">{h.legend}</div>}
    </footer>
  </article>;
}

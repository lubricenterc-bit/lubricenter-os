import Link from "next/link";
import { OrderWorkspace } from "@/components/order-workspace";
import { OrderBonusProduct } from "@/components/order-bonus-product";
import { OrderCrmExtras } from "@/components/order-crm-extras";
import { OrderFinalizePanel } from "@/components/order-finalize-panel";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container stack">
    <style>{`.order-core-only > .stack > section.stack:not(.card):last-of-type{display:none}`}</style>
    <section className="card brand-card stack">
      <div className="row-between">
        <div><div className="eyebrow">ACCIONES DE ESTA ORDEN</div><strong>Todo lo cobrado en esta visita queda en una sola OS</strong></div>
        <span className="pill ok">1 ORDEN</span>
      </div>
      <div className="grid grid-2">
        <Link className="btn btn-primary" href={`/orders/${id}/oil-change`}>＋ Cambio de aceite</Link>
        <OrderBonusProduct orderId={id} />
        <Link className="btn" href={`/orders/${id}/delivery`}>Salida / observación CRM</Link>
        <Link className="btn btn-ghost" href="/orders/new">＋ Otra orden</Link>
      </div>
      <div className="muted small">Productos y trabajos se agregan justo debajo. El cobro final y CRM están separados para que la atención sea más clara.</div>
    </section>

    <div className="order-core-only"><OrderWorkspace initialOrderId={id} /></div>

    <OrderFinalizePanel orderId={id} />

    <section className="card stack">
      <div><div className="eyebrow">CLIENTE · CRM</div><strong>Información de salida y seguimiento</strong><div className="muted small">Completa esto cuando aplique; no está mezclado con el cobro ni con los items de la orden.</div></div>
      <OrderCrmExtras orderId={id} />
    </section>
  </main>;
}

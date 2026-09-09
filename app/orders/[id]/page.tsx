import Link from "next/link";
import { OrderWorkspace } from "@/components/order-workspace";
import { OrderBonusProduct } from "@/components/order-bonus-product";
import { OrderCrmExtras } from "@/components/order-crm-extras";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container stack">
    <section className="card brand-card stack">
      <div className="row-between">
        <div><div className="eyebrow">MÓDULOS DE ESTA ORDEN</div><strong>Agrega todo lo realizado en la misma visita</strong></div>
        <span className="pill ok">1 ORDEN</span>
      </div>
      <div className="muted small">Productos, cortesías físicas, taller, electroauto y cambio de aceite conviven dentro del mismo número OS.</div>
      <div className="grid grid-2">
        <Link className="btn btn-primary" href={`/orders/${id}/oil-change`}>+ Cambio de aceite</Link>
        <OrderBonusProduct orderId={id} />
        <Link className="btn" href={`/orders/${id}/delivery`}>Salida CRM · pantalla completa</Link>
      </div>
    </section>

    <OrderCrmExtras orderId={id} />
    <OrderWorkspace initialOrderId={id} />
  </main>;
}

import Link from "next/link";
import { OrderWorkspace } from "@/components/order-workspace";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container stack">
    <section className="card brand-card stack">
      <div className="row-between">
        <div><div className="eyebrow">MÓDULOS DE ESTA ORDEN</div><strong>Agrega todo lo realizado en la misma visita</strong></div>
        <span className="pill ok">1 ORDEN</span>
      </div>
      <div className="muted small">Productos, taller, electroauto y cambio de aceite conviven dentro del mismo número OS.</div>
      <div className="grid grid-2">
        <Link className="btn btn-primary" href={`/orders/${id}/oil-change`}>+ Cambio de aceite</Link>
        <Link className="btn" href={`/orders/${id}/delivery`}>Salida / mensaje CRM</Link>
      </div>
    </section>
    <OrderWorkspace initialOrderId={id} />
  </main>;
}

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
      <div className="muted small">Productos, taller, electroauto y cambio de aceite pueden convivir dentro del mismo número OS.</div>
      <Link className="btn btn-primary btn-block" href={`/orders/${id}/oil-change`}>+ Agregar cambio de aceite</Link>
    </section>
    <OrderWorkspace initialOrderId={id} />
  </main>;
}

import { OrderWorkspace } from "@/components/order-workspace";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><OrderWorkspace initialOrderId={id} /></main>;
}

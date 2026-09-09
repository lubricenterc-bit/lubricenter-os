"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { OrderCrmExtras } from "@/components/order-crm-extras";

type Order = { id: string; order_number: string; customer_id: string | null; vehicle_id: string | null };
type Customer = { name: string | null; phone: string | null };
type Vehicle = { plate: string | null; make: string | null; model: string | null; year: number | null };

export default function DeliveryPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = params.id;
  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data: o, error: oe } = await supabase.from("orders").select("id,order_number,customer_id,vehicle_id").eq("id", orderId).single();
      if (oe) return setError(oe.message);
      const ord = o as Order;
      setOrder(ord);
      const [{ data: c }, { data: v }] = await Promise.all([
        ord.customer_id ? supabase.from("customers").select("name,phone").eq("id", ord.customer_id).maybeSingle() : Promise.resolve({ data: null } as any),
        ord.vehicle_id ? supabase.from("vehicles").select("plate,make,model,year").eq("id", ord.vehicle_id).maybeSingle() : Promise.resolve({ data: null } as any),
      ]);
      setCustomer((c ?? null) as Customer | null);
      setVehicle((v ?? null) as Vehicle | null);
    })();
  }, [orderId]);

  const vehicleLabel = [vehicle?.plate, vehicle?.make, vehicle?.model, vehicle?.year].filter(Boolean).join(" · ") || "Vehículo";

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">SALIDA · CRM</div><h1>Post-servicio</h1><p>{order?.order_number || "Orden"} · {customer?.name || customer?.phone || "Cliente"} · {vehicleLabel}</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>
    {error && <div className="error">{error}</div>}
    <OrderCrmExtras orderId={orderId} />
    <section className="card stack">
      <strong>Qué pasa al cerrar</strong>
      <div className="muted small">El OS combinará automáticamente lo cobrado en la orden con el cambio de aceite, los servicios adicionales, las bonificaciones, las observaciones y el estado de salida para preparar el WhatsApp post-servicio.</div>
      <button className="btn btn-ghost btn-block" onClick={() => router.push(`/orders/${orderId}`)}>Volver a la orden</button>
    </section>
  </main>;
}

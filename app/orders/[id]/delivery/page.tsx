"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Order = { id: string; order_number: string; status: string; customer_id: string | null; vehicle_id: string | null; health_status: "GREEN" | "YELLOW" | "RED"; health_notes: string | null };
type Customer = { name: string | null; phone: string | null };
type Vehicle = { plate: string | null; make: string | null; model: string | null; year: number | null };

export default function DeliveryPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = params.id;
  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [health, setHealth] = useState<"GREEN" | "YELLOW" | "RED">("GREEN");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const { data: o, error: oe } = await supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,health_status,health_notes").eq("id", orderId).single();
      if (oe) return setError(oe.message);
      const ord = o as Order;
      setOrder(ord); setHealth(ord.health_status || "GREEN"); setNotes(ord.health_notes || "");
      const [{ data: c }, { data: v }] = await Promise.all([
        ord.customer_id ? supabase.from("customers").select("name,phone").eq("id", ord.customer_id).maybeSingle() : Promise.resolve({ data: null } as any),
        ord.vehicle_id ? supabase.from("vehicles").select("plate,make,model,year").eq("id", ord.vehicle_id).maybeSingle() : Promise.resolve({ data: null } as any),
      ]);
      setCustomer((c ?? null) as Customer | null); setVehicle((v ?? null) as Vehicle | null);
    })();
  }, [orderId]);

  async function save() {
    if (!order || order.status !== "OPEN") return;
    if (health !== "GREEN" && !notes.trim()) return setError("Describe la observación para que el mensaje al cliente tenga contexto.");
    setBusy(true); setError("");
    const { error } = await supabase.rpc("set_order_health", { p_order_id: order.id, p_health_status: health, p_health_notes: notes.trim() || null });
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/orders/${order.id}`); router.refresh();
  }

  const vehicleLabel = [vehicle?.plate, vehicle?.make, vehicle?.model, vehicle?.year].filter(Boolean).join(" · ") || "Vehículo";
  const preview = health === "RED"
    ? `🚨 Alerta de seguridad: ${notes.trim() || "Describe la condición pendiente."}`
    : health === "YELLOW"
      ? `⚠️ Observación preventiva: ${notes.trim() || "Describe el detalle para su próximo servicio."}`
      : "✅ Estado general: Servicio finalizado. ¡Listo para la vía!";

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">SALIDA · CRM</div><h1>Estado de entrega</h1><p>{order?.order_number || "Orden"} · {customer?.name || customer?.phone || "Cliente"} · {vehicleLabel}</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>
    {error && <div className="error">{error}</div>}
    <section className="card stack">
      <div><strong>¿Cómo se entrega el vehículo?</strong><div className="muted small">Esto se incorpora al mensaje post-servicio que aparece en CRM cuando cierres la orden.</div></div>
      <div className="segmented">
        <button className={`btn ${health === "GREEN" ? "btn-primary" : "btn-ghost"}`} onClick={() => setHealth("GREEN")}>✅ Todo OK</button>
        <button className={`btn ${health === "YELLOW" ? "btn-primary" : "btn-ghost"}`} onClick={() => setHealth("YELLOW")}>⚠️ Preventivo</button>
        <button className={`btn ${health === "RED" ? "btn-primary" : "btn-ghost"}`} onClick={() => setHealth("RED")}>🛑 Seguridad</button>
      </div>
      {health !== "GREEN" && <label><span className="label">Detalle para el cliente *</span><textarea className="input" style={{ minHeight: 100 }} value={notes} onChange={e => setNotes(e.target.value)} placeholder={health === "RED" ? "Ej. Se detectó juego excesivo en terminal de dirección..." : "Ej. Pastillas delanteras próximas a reemplazo..."} /></label>}
      <div className={health === "RED" ? "error" : health === "YELLOW" ? "card brand-card" : "success"}><strong>Vista previa</strong><div style={{ marginTop: 6 }}>{preview}</div></div>
      {order?.status === "OPEN" ? <button className="btn btn-primary btn-block" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar estado y volver a la orden"}</button> : <div className="error">Esta orden ya está cerrada y su estado de salida no se puede modificar desde aquí.</div>}
      <button className="btn btn-ghost btn-block" onClick={() => router.push(`/orders/${orderId}`)}>Volver sin cambios</button>
    </section>
  </main>;
}

"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";

type Order = {
  id: string;
  order_number: string;
  status: string;
  customer_id: string | null;
  vehicle_id: string | null;
  total_ves: number;
  total_ref: number;
  opened_at: string;
  closed_at: string | null;
};
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null };
type Item = { id: string; item_type: string; business_area: string; description: string; quantity: number; charged_ref_amount: number; charged_ves_amount: number; cash_price_revealed: boolean; cash_usd_special_total: number | null };
type Payment = { id: string; method: string; currency: string; amount_original: number; value_ves: number; reference: string | null; paid_at: string };
type Receivable = { id: string; principal_ves: number; principal_ref: number; outstanding_ves: number; status: string; due_date: string | null };
type ServiceRecord = { id: string; service_type: string; description: string; odometer: number | null; next_service_odometer: number | null; next_service_date: string | null; oil_brand: string | null; oil_viscosity: string | null; oil_quantity_liters: number | null; oil_filter_code: string | null };

export default function ReceiptPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = params.id;
  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [receivable, setReceivable] = useState<Receivable | null>(null);
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: its, error: ie }, { data: pays, error: pe }, { data: rec, error: re }, { data: sr, error: se }] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,total_ves,total_ref,opened_at,closed_at").eq("id", orderId).single(),
      supabase.from("order_items").select("id,item_type,business_area,description,quantity,charged_ref_amount,charged_ves_amount,cash_price_revealed,cash_usd_special_total").eq("order_id", orderId).order("created_at"),
      supabase.from("payments").select("id,method,currency,amount_original,value_ves,reference,paid_at").eq("order_id", orderId).order("paid_at"),
      supabase.from("receivables").select("id,principal_ves,principal_ref,outstanding_ves,status,due_date").eq("order_id", orderId).maybeSingle(),
      supabase.from("service_records").select("id,service_type,description,odometer,next_service_odometer,next_service_date,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code").eq("order_id", orderId).order("performed_at"),
    ]);
    const anyError = oe || ie || pe || re || se;
    if (anyError) return setError(anyError.message);
    const ord = o as Order;
    setOrder(ord);
    setItems((its ?? []) as Item[]);
    setPayments((pays ?? []) as Payment[]);
    setReceivable((rec ?? null) as Receivable | null);
    setServices((sr ?? []) as ServiceRecord[]);

    const [{ data: c, error: ce }, { data: v, error: ve }] = await Promise.all([
      ord.customer_id ? supabase.from("customers").select("id,name,phone,document_id").eq("id", ord.customer_id).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
      ord.vehicle_id ? supabase.from("vehicles").select("id,plate,make,model,year,engine,current_odometer").eq("id", ord.vehicle_id).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
    ]);
    if (ce || ve) return setError((ce || ve)?.message ?? "No pude cargar cliente/vehículo.");
    setCustomer((c ?? null) as Customer | null);
    setVehicle((v ?? null) as Vehicle | null);
  }

  useEffect(() => { if (orderId) load(); }, [orderId]);

  const paidVes = useMemo(() => payments.reduce((a, p) => a + Number(p.value_ves || 0), 0), [payments]);
  const oilService = services.find(s => s.service_type === "OIL_CHANGE") ?? null;

  const shareText = useMemo(() => {
    if (!order) return "";
    const lines = [
      `LUBRICENTER · ${order.order_number}`,
      customer?.name ? `Cliente: ${customer.name}` : null,
      vehicle ? `Vehículo: ${[vehicle.plate,vehicle.make,vehicle.model,vehicle.year].filter(Boolean).join(" · ")}` : null,
      "",
      ...items.map(i => `${Number(i.quantity)}x ${i.description} — ${fmtRef(i.charged_ref_amount)} / ${fmtVes(i.charged_ves_amount)}`),
      "",
      `Total: ${fmtRef(order.total_ref)} / ${fmtVes(order.total_ves)}`,
      `Pagado: ${fmtVes(paidVes)}`,
      receivable?.status === "OPEN" ? `Crédito LC pendiente: ${fmtVes(receivable.outstanding_ves)}` : null,
      oilService?.next_service_odometer ? `Próximo cambio de aceite: ${oilService.next_service_odometer.toLocaleString("es-VE")} km${oilService.next_service_date ? ` o ${oilService.next_service_date}` : ""}` : null,
      "",
      "Cuidamos lo que te mueve.",
    ].filter((x): x is string => Boolean(x));
    return lines.join("\n");
  }, [order, customer, vehicle, items, paidVes, receivable, oilService]);

  async function share() {
    if (!shareText) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: order?.order_number ?? "Lubricenter", text: shareText });
      } else {
        await navigator.clipboard.writeText(shareText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError("No pude compartir. Intenta usar Imprimir o copia el resumen manualmente.");
    }
  }

  if (!order && !error) return <main className="container"><div className="card muted">Preparando comprobante…</div></main>;

  return <main className="receipt-screen">
    <div className="receipt-actions no-print">
      <button className="btn btn-ghost" onClick={() => router.push(`/orders/${orderId}`)}>← Volver</button>
      <div className="row">
        <button className="btn" onClick={share}>{copied ? "Copiado ✓" : "Compartir"}</button>
        <button className="btn btn-primary" onClick={() => window.print()}>Imprimir / PDF</button>
      </div>
    </div>

    {error && <div className="error no-print">{error}</div>}

    {order && <article className="receipt-paper">
      <header className="receipt-header">
        <img src="/lubricenter-logo.png" alt="Lubricenter" />
        <div><div className="receipt-brand">LUBRICENTER</div><div className="receipt-tagline">Cuidamos lo que te mueve.</div></div>
      </header>

      <div className="receipt-title-row">
        <div><div className="receipt-label">COMPROBANTE INTERNO</div><h1>{order.order_number}</h1></div>
        <div className="receipt-right"><strong>{order.status === "CLOSED" ? "CERRADA" : "ABIERTA"}</strong><div>{fmtDate(order.closed_at ?? order.opened_at)}</div></div>
      </div>
      <div className="receipt-note">Documento operativo de Lubricenter. No sustituye factura fiscal cuando corresponda.</div>

      <section className="receipt-party">
        <div><div className="receipt-label">CLIENTE</div><strong>{customer?.name || customer?.phone || "No indicado"}</strong><div>{[customer?.phone,customer?.document_id].filter(Boolean).join(" · ")}</div></div>
        <div><div className="receipt-label">VEHÍCULO</div><strong>{vehicle?.plate || "No indicado"}</strong><div>{vehicle ? [vehicle.make,vehicle.model,vehicle.year,vehicle.engine ? `Motor ${vehicle.engine}` : null].filter(Boolean).join(" · ") : ""}</div>{vehicle?.current_odometer != null && <div>{vehicle.current_odometer.toLocaleString("es-VE")} km</div>}</div>
      </section>

      <section className="receipt-lines">
        <div className="receipt-line receipt-line-head"><span>Detalle</span><span>REF</span><span>Bs</span></div>
        {items.map(i => <div className="receipt-line" key={i.id}>
          <div><strong>{i.description}</strong><div className="receipt-small">{i.quantity} × {areaLabel(i.business_area)}</div></div>
          <div>{fmtRef(i.charged_ref_amount)}</div>
          <div>{fmtVes(i.charged_ves_amount)}</div>
        </div>)}
      </section>

      <section className="receipt-totals">
        <div><span>Total</span><strong>{fmtRef(order.total_ref)}</strong><strong>{fmtVes(order.total_ves)}</strong></div>
        <div><span>Pagado</span><span></span><strong>{fmtVes(paidVes)}</strong></div>
        {receivable?.status === "OPEN" && <div className="receipt-credit"><span>Crédito LC pendiente</span><span>{fmtRef(receivable.principal_ref)}</span><strong>{fmtVes(receivable.outstanding_ves)}</strong></div>}
      </section>

      <section className="receipt-payments">
        <div className="receipt-label">PAGOS</div>
        {payments.map(p => <div className="receipt-payment" key={p.id}><span>{paymentLabel(p.method)}{p.reference ? ` · Ref. ${p.reference}` : ""}</span><strong>{p.currency === "USD" ? `$${Number(p.amount_original).toFixed(2)}` : fmtVes(p.amount_original)}</strong></div>)}
        {!payments.length && <div>Sin pagos registrados.</div>}
      </section>

      {oilService && <section className="receipt-maintenance">
        <div className="receipt-label">MANTENIMIENTO</div>
        <strong>Cambio de aceite registrado</strong>
        <div>{[oilService.oil_brand,oilService.oil_viscosity,oilService.oil_quantity_liters ? `${oilService.oil_quantity_liters} L` : null,oilService.oil_filter_code ? `Filtro ${oilService.oil_filter_code}` : null].filter(Boolean).join(" · ")}</div>
        {oilService.odometer != null && <div>Km del servicio: {oilService.odometer.toLocaleString("es-VE")} km</div>}
        {(oilService.next_service_odometer || oilService.next_service_date) && <div className="receipt-next">Próximo servicio: {oilService.next_service_odometer ? `${oilService.next_service_odometer.toLocaleString("es-VE")} km` : ""}{oilService.next_service_odometer && oilService.next_service_date ? " · " : ""}{oilService.next_service_date ?? ""}</div>}
      </section>}

      <footer className="receipt-footer">Gracias por confiar en Lubricenter.</footer>
    </article>}
  </main>;
}

function paymentLabel(method: string) {
  return ({ MOBILE_PAYMENT: "Pago móvil", TRANSFER_BDV: "Transferencia BDV", TRANSFER_BNC: "Transferencia BNC", CASH_VES: "Efectivo Bs", CASH_USD: "Efectivo USD" } as Record<string,string>)[method] ?? method;
}
function areaLabel(area: string) {
  return ({ STORE: "Producto", WORKSHOP: "Taller", ELECTROAUTO: "Electroauto", OIL_CHANGE: "Cambio de aceite" } as Record<string,string>)[area] ?? area;
}

"use client";

import { ReceiptPrintButton } from "@/components/receipt-print-button";
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
  const [cashea, setCashea] = useState<{ initial_ref: number; financed_ref: number; initial_percent: number } | null>(null);
  const [receivable, setReceivable] = useState<Receivable | null>(null);
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    setError("");
    const [{ data: o, error: oe }, { data: its, error: ie }, { data: pays, error: pe }, { data: rec, error: re }, { data: sr, error: se }, {data: cs, error: cse}] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,total_ves,total_ref,opened_at,closed_at").eq("id", orderId).single(),
      supabase.from("order_items").select("id,item_type,business_area,description,quantity,charged_ref_amount,charged_ves_amount,cash_price_revealed,cash_usd_special_total").eq("order_id", orderId).order("created_at"),
      supabase.from("payments").select("id,method,currency,amount_original,value_ves,reference,paid_at").eq("order_id", orderId).order("paid_at"),
      supabase.from("receivables").select("id,principal_ves,principal_ref,outstanding_ves,status,due_date").eq("order_id", orderId).maybeSingle(),
      supabase.from("service_records").select("id,service_type,description,odometer,next_service_odometer,next_service_date,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code").eq("order_id", orderId).order("performed_at"),
      supabase.from("cashea_sales").select("initial_ref,financed_ref,initial_percent").eq("order_id",orderId).maybeSingle(),
    ]);
    const anyError = oe || ie || pe || re || se || cse;
    if (anyError) return setError(anyError.message);
    const ord = o as Order;
    if (ord.status === "OPEN") { ord.total_ref = (its??[]).reduce((sum,x)=>sum+Number(x.charged_ref_amount),0); ord.total_ves = (its??[]).reduce((sum,x)=>sum+Number(x.charged_ves_amount),0); }
    setOrder(ord);
    setCashea(cs);
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

  const oilService = services.find(s => s.service_type === "OIL_CHANGE") ?? null;

  const shareText = useMemo(() => {
    if (!order) return "";
    const lines = [
      `LUBRICENTER · ${order.order_number} · ${order.status === "CANCELLED" ? "ANULADA" : order.status === "OPEN" ? "COTIZACIÓN" : "RECIBO"}`,
      customer?.name ? `Cliente: ${customer.name}` : null,
      vehicle ? `Vehículo: ${[vehicle.plate,vehicle.make,vehicle.model,vehicle.year].filter(Boolean).join(" · ")}` : null,
      "",
      ...items.map(i => `${Number(i.quantity)}x ${i.description} — ${fmtRef(i.charged_ref_amount)}`),
      "",
      `Total: ${fmtRef(order.total_ref)} / ${fmtVes(order.total_ves)}`,
      cashea ? `Cashea: inicial ${cashea.initial_percent}% · ${fmtRef(cashea.initial_ref)}. Financiado: ${fmtRef(cashea.financed_ref)} en 3 cuotas.` : null,
      receivable?.status === "OPEN" ? `Crédito LC pendiente: ${fmtVes(receivable.outstanding_ves)}` : null,
      oilService && (oilService.next_service_odometer || oilService.next_service_date) ? `Próximo servicio: ${oilService.next_service_odometer ? `${oilService.next_service_odometer.toLocaleString("es-VE")} km` : ""}${oilService.next_service_odometer && oilService.next_service_date ? " · " : ""}${oilService.next_service_date ?? ""}` : null,
      "",
      "Cuidamos lo que te mueve.",
    ].filter((x): x is string => Boolean(x));
    return lines.join("\n");
  }, [order, customer, vehicle, items, receivable, oilService, cashea]);

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
        <ReceiptPrintButton />
      </div>
    </div>

    {error && <div className="error no-print">{error}</div>}

    {order && <article className="receipt-paper">
      <header className="receipt-header">
        <img src="/lubricenter-logo.png" alt="Lubricenter" />
        <div><div className="receipt-brand">LUBRICENTER</div><div className="receipt-tagline">Cuidamos lo que te mueve.</div></div>
      </header>

      {order.status !== "CLOSED" && <div style={{border:"2px solid #000",padding:"2mm",fontWeight:900,textAlign:"center"}}>{order.status === "CANCELLED" ? "ANULADA · SIN VALIDEZ" : "COTIZACIÓN · VENTA ABIERTA"}</div>}
      <div className="receipt-title-row">
        <div><div className="receipt-label">RECIBO</div><h1>{order.order_number}</h1></div>
        <div className="receipt-right">{fmtDate(order.closed_at ?? order.opened_at)}</div>
      </div>

      {(customer || vehicle) && <section className="receipt-party">
        {customer && <div><span className="receipt-label">CLIENTE </span><strong>{customer.name || customer.phone}</strong></div>}
        {vehicle && <div><span className="receipt-label">VEHÍCULO </span><strong>{[vehicle.plate,vehicle.make,vehicle.model].filter(Boolean).join(" · ")}</strong></div>}
      </section>}

      <section className="receipt-lines">
        <div className="receipt-line receipt-line-head"><span>Detalle</span><span>REF</span></div>
        {items.map(i => <div className="receipt-line" key={i.id}>
          <div><strong>{Number(i.quantity)} × {i.description}</strong></div>
          <strong>{fmtRef(i.charged_ref_amount)}</strong>
        </div>)}
      </section>

      <section className="receipt-totals">
        <div><span>Total</span><strong>{fmtRef(order.total_ref)}</strong><strong>{fmtVes(order.total_ves)}</strong></div>
        {receivable?.status === "OPEN" && <div className="receipt-credit"><span>Crédito LC pendiente</span><span>{fmtRef(receivable.principal_ref)}</span><strong>{fmtVes(receivable.outstanding_ves)}</strong></div>}
      </section>

      {cashea && <section className="receipt-payments"><div className="receipt-payment"><span>Cashea · inicial {cashea.initial_percent}%</span><strong>{fmtRef(cashea.initial_ref)}</strong></div><div className="receipt-payment"><span>Saldo Cashea · 3 cuotas</span><strong>{fmtRef(cashea.financed_ref)}</strong></div></section>}
      {!!payments.length && <section className="receipt-payments">
        {payments.map(p => <div className="receipt-payment" key={p.id}><span>{paymentLabel(p.method)}</span><strong>{p.currency === "USD" ? `$${Number(p.amount_original).toFixed(2)}` : fmtVes(p.amount_original)}</strong></div>)}
      </section>}

      {oilService && (oilService.next_service_odometer || oilService.next_service_date) && <section className="receipt-maintenance"><div className="receipt-next">Próximo servicio: {oilService.next_service_odometer ? `${oilService.next_service_odometer.toLocaleString("es-VE")} km` : ""}{oilService.next_service_odometer && oilService.next_service_date ? " · " : ""}{oilService.next_service_date ?? ""}</div></section>}

      <footer className="receipt-footer">Gracias por confiar en Lubricenter.</footer>
    </article>}
  </main>;
}

function paymentLabel(method: string) {
  return ({ MOBILE_PAYMENT: "Pago móvil", TRANSFER_BDV: "Transferencia BDV", TRANSFER_BNC: "Transferencia BNC", CASH_VES: "Efectivo Bs", CASH_USD: "Efectivo USD" } as Record<string,string>)[method] ?? method;
}


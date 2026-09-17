"use client";
import { OrderDateEditor } from "@/components/order-date-editor";
import { matchesSearch } from "@/lib/domain/search";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { OrderCasheaSheet } from "@/components/order-cashea-sheet";
import { OrderPartySheet } from "@/components/order-party-sheet";
import { OrderBonusProduct } from "@/components/order-bonus-product";
import { OrderCrmExtras } from "@/components/order-crm-extras";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { electroautoAllocation, workshopAllocation } from "@/lib/domain/allocations";

type InventoryProduct = {
  id: string;
  sku: string;
  brand: string | null;
  description: string;
  category: string | null;
  quantity_on_hand: number;
  product_id: string | null;
  catalog_product_name: string | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  needs_review: boolean;
};

type CatalogProduct = {
  id: string;
  name: string;
  category: string | null;
  filter_code: string | null;
  available: boolean;
  cash_usd_base_price: number;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
};

type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Vehicle = { id: string; customer_id: string | null; plate: string | null; make: string | null; model: string | null; year: number | null; engine: string | null; current_odometer: number | null };
type OrderRecord = { id: string; order_number: string; status: "OPEN" | "CLOSED" | "CANCELLED"; customer_id: string | null; vehicle_id: string | null; is_walk_in: boolean; opened_at: string; closed_at: string | null; total_ves: number; total_ref: number };
type Item = { id: string; item_type: string; business_area: string; description: string; quantity: number; charged_ves_amount: number; charged_ref_amount: number; cash_usd_special_total: number | null; cash_price_revealed: boolean; worker_share_ref_snapshot: number | null; assistant_bonus_ref_snapshot: number | null };
type Payment = { id: string; method: string; currency: string; amount_original: number; value_ves: number; value_ref: number; reference: string | null };
type Receivable = { id: string; status: string; outstanding_ves: number; principal_ref: number; due_date: string | null };
type Rates = { bcv: number; operative: number };
type Modal = "PARTY" | "PRODUCT" | "SERVICE" | "PAYMENT" | "CREDIT" | "CASHEA" | null;


export function OrderWorkspace({ initialOrderId }: { initialOrderId?: string }) {
  const router = useRouter();
  const creatingOrder = useRef<Promise<string> | null>(null);
  const [admin, setAdmin] = useState(false);
  const [notice, setNotice] = useState("");
  const [readinessError, setReadinessError] = useState("");
  const [orderId, setOrderId] = useState<string | null>(initialOrderId ?? null);
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [inventoryProducts, setInventoryProducts] = useState<InventoryProduct[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  
  
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [cashea, setCashea] = useState<{ financed_ref: number; initial_ref: number; status: string } | null>(null);
  const [receivable, setReceivable] = useState<Receivable | null>(null);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const totalVes = useMemo(() => items.reduce((a, i) => a + Number(i.charged_ves_amount || 0), 0), [items]);
  const totalRef = useMemo(() => items.reduce((a, i) => a + Number(i.charged_ref_amount || 0), 0), [items]);
  const paidVes = useMemo(() => payments.reduce((a, p) => a + Number(p.value_ves || 0), 0), [payments]);
  const paidRef = useMemo(() => payments.reduce((a, p) => a + Number(p.value_ref || 0), 0), [payments]);
  const remainingVes = Math.max(totalVes - paidVes, 0);
  const remainingRef = Math.max(totalRef - paidRef, 0);
  const remainingCashUsd = rates.operative > 0 ? remainingVes / rates.operative : 0;
  const status = order?.status ?? "OPEN";
  const locked = status !== "OPEN";

  async function loadOrder(id: string) {
    const [{ data: o, error: oe }, { data: its, error: ie }, { data: pays, error: pe }, { data: rec, error: re }, { data: cs, error: cse }] = await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,is_walk_in,opened_at,closed_at,total_ves,total_ref").eq("id", id).single(),
      supabase.from("order_items").select("id,item_type,business_area,description,quantity,charged_ves_amount,charged_ref_amount,cash_usd_special_total,cash_price_revealed,worker_share_ref_snapshot,assistant_bonus_ref_snapshot").eq("order_id", id).order("created_at"),
      supabase.from("payments").select("id,method,currency,amount_original,value_ves,value_ref,reference").eq("order_id", id).order("paid_at"),
      supabase.from("receivables").select("id,status,outstanding_ves,principal_ref,due_date").eq("order_id", id).maybeSingle(),
      supabase.from("cashea_sales").select("financed_ref,initial_ref,status").eq("order_id", id).maybeSingle(),
    ]);
    if (oe) throw oe;
    if (ie) throw ie;
    if (pe) throw pe;
    if (re) throw re;
    if (cse) throw cse;
    setCashea(cs);
    const row = o as OrderRecord;
    setOrder(row);
    setOrderId(row.id);
    setItems((its ?? []) as Item[]);
    setPayments((pays ?? []) as Payment[]);
    setReceivable((rec ?? null) as Receivable | null);
    const [c, v] = await Promise.all([
      row.customer_id ? supabase.from("customers").select("id,name,phone,document_id").eq("id", row.customer_id).single() : Promise.resolve({ data: null, error: null }),
      row.vehicle_id ? supabase.from("vehicles").select("id,customer_id,plate,make,model,year,engine,current_odometer").eq("id", row.vehicle_id).single() : Promise.resolve({ data: null, error: null }),
    ]);
    if (c.error || v.error) throw c.error || v.error;
    setCustomer(c.data); setVehicle(v.data);
    if (row.status === "OPEN") { const readiness = await supabase.rpc("validate_order_ready_to_close", { p_order_id: id }); setReadinessError(readiness.error?.message ?? ""); } else setReadinessError("");
  }

  async function bootstrap() {
    setLoading(true);
    setError("");
    try {
      const [{ data: inv, error: invError }, { data: cat, error: catError }, { data: r, error: re }] = await Promise.all([
        supabase.from("inventory_current").select("id,sku,brand,description,category,quantity_on_hand,product_id,catalog_product_name,current_price_ves,current_ref_bcv,needs_review").eq("location_code", "CABUDARE").gt("quantity_on_hand", 0).eq("needs_review", false).order("category").order("brand").order("sku").limit(1000),
        supabase.from("product_catalog_current").select("id,name,category,filter_code,available,cash_usd_base_price,current_price_ves,current_ref_bcv").eq("available", true).order("name").limit(1000),
        supabase.rpc("get_current_rates"),
      ]);
      if (invError) throw invError;
      if (catError) throw catError;
      if (re) throw re;
      setInventoryProducts((inv ?? []).map((x: any) => ({ ...x, quantity_on_hand: Number(x.quantity_on_hand ?? 0), current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves), current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv) })) as InventoryProduct[]);
      setCatalogProducts((cat ?? []).map((x: any) => ({ ...x, cash_usd_base_price: Number(x.cash_usd_base_price ?? 0), current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves), current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv) })) as CatalogProduct[]);
      const rateRow = Array.isArray(r) ? r[0] : r;
      setRates({ bcv: Number(rateRow?.bcv_rate ?? 0), operative: Number(rateRow?.operative_rate ?? 0) });
      if (initialOrderId) await loadOrder(initialOrderId);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    supabase.rpc("can_administer_orders").then(({data}) => setAdmin(data === true));
    bootstrap();
    const refreshPricing = () => bootstrap();
    window.addEventListener("lubricenter:pricing-updated", refreshPricing);
    return () => window.removeEventListener("lubricenter:pricing-updated", refreshPricing);
  }, [initialOrderId]);

  async function ensureOrder() {
    if (orderId) return orderId;
    if (creatingOrder.current) return creatingOrder.current;
    creatingOrder.current = createNewOrder();
    try { return await creatingOrder.current; } finally { creatingOrder.current = null; }
  }

  async function createNewOrder() {
    const { data, error } = await supabase.rpc("create_order");
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const newOrder: OrderRecord = { id: row.id, order_number: row.order_number, status: "OPEN", customer_id: null, vehicle_id: null, is_walk_in: false, opened_at: new Date().toISOString(), closed_at: null, total_ves: 0, total_ref: 0 };
    setOrderId(row.id);
    setOrder(newOrder);
    return row.id as string;
  }

  async function refresh(id = orderId) {
    if (!id) return;
    await loadOrder(id);
    if (!initialOrderId) router.replace(`/orders/${id}`);
  }

  async function removeItem(id: string) {
    if (!orderId || locked) return;
    const { error } = await supabase.rpc("delete_order_item", { p_item_id: id });
    if (error) setError(error.message); else await refresh(orderId);
  }

  async function removePayment(id: string) {
    if (!orderId || locked) return;
    const { error } = await supabase.rpc("delete_payment", { p_payment_id: id });
    if (error) setError(error.message); else await refresh(orderId);
  }

  async function deleteOrder() {
    if (!orderId || locked) return;
    if (!window.confirm(`¿Eliminar ${order?.order_number ?? "esta orden"}?\n\nÚsalo solo para órdenes duplicadas o creadas por error. Esta acción no se puede deshacer.`)) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("delete_open_order", { p_order_id: orderId, p_reason: "Orden duplicada o creada por error desde Lubricenter OS" });
    setBusy(false);
    if (error) return setError(error.message);
    router.push("/orders"); router.refresh();
  }

  async function closePaid() {
    if (!orderId || !items.length || locked || busy) return;
    if (readinessError) { setError(readinessError); if (/cliente|vehículo/i.test(readinessError)) setModal("PARTY"); return; }
    if (remainingVes > 1) { setModal("PAYMENT"); return; }
    if (paidVes - totalVes > 1) return setError(`Hay ${fmtVes(paidVes - totalVes)} de más. Quita el pago incorrecto y registra el monto correspondiente.`);
    setBusy(true); setError("");
    try {
      const result = await supabase.rpc("close_order", { p_order_id: orderId });
      if (result.error) throw result.error;
      await refresh(orderId);
      setNotice("Orden cerrada correctamente. Ya puedes imprimir el recibo o iniciar otra atención.");
    } catch (e: any) { setError(`${e.message}. Revisa los pagos y las existencias. Actualiza la orden antes de reintentar.`); }
    finally { setBusy(false); }
  }
  async function openOilChange() {
    if (!vehicle) { setNotice("Primero selecciona o crea el vehículo para guardar su cambio de aceite."); setModal("PARTY"); return; }
    setBusy(true);
    try { const id = await ensureOrder(); router.push(`/orders/${id}/oil-change`); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const sheet = document.querySelector<HTMLElement>(".sheet");
    sheet?.setAttribute("role", "dialog"); sheet?.setAttribute("aria-modal", "true");
    sheet?.querySelector<HTMLElement>("input, button")?.focus();
    function trap(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const nodes = Array.from(sheet?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []).filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", trap);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", trap); previous?.focus(); };
  }, [modal]);

  if (loading) return <div className="card"><div className="muted">Cargando orden…</div></div>;

  return <div className="stack">
    <section className="card brand-card"><div className="row-between"><div><div className="muted small">ORDEN</div><div className="money-lg">{order?.order_number ?? "Nueva orden"}</div>{order && <div className="muted small">Se guarda automáticamente en la nube.</div>}</div><span className={`pill ${status === "CLOSED" ? "ok" : status === "OPEN" ? "warn" : ""}`}>{status === "OPEN" ? "ABIERTA" : status === "CLOSED" ? "CERRADA" : "CANCELADA"}</span></div></section>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    {!locked && <OrderDateEditor date={order?.opened_at} ensureOrder={ensureOrder} onSaved={async id => { await refresh(id); setNotice("Fecha de atención guardada."); }} />}
    {orderId && <div className="row"><Link className="btn" href={`/orders/${orderId}/history`}>Historial de movimientos</Link>{admin && status === "CLOSED" && <Link className="btn" href={`/orders/${orderId}/correct`}>Corregir venta cerrada</Link>}</div>}
    {!locked && <div className="order-steps"><span>1 · Cliente / vehículo</span><span>2 · Productos / trabajos</span><span>3 · Cobro / cierre</span></div>}
    {cashea && status !== "CANCELLED" && <section className="card success"><strong>Orden cerrada con Cashea</strong><div>Inicial {fmtRef(cashea.initial_ref)} · financiado originalmente {fmtRef(cashea.financed_ref)}</div><Link className="btn" href="/cashea">Ver cuotas y saldo actual</Link></section>}
    {receivable && status !== "CANCELLED" && <section className="card stack" style={{ borderColor: "rgba(255,93,21,.45)" }}><div className="row-between"><strong>Crédito LC</strong><span className={`pill ${receivable.status === "PAID" ? "ok" : "warn"}`}>{receivable.status === "PAID" ? "PAGADO" : "PENDIENTE"}</span></div><div className="money-lg">{fmtVes(receivable.outstanding_ves)}</div><div className="muted small">Saldo original aprox. {fmtRef(receivable.principal_ref)}{receivable.due_date ? ` · vence ${receivable.due_date}` : ""}</div></section>}
    <section className="card stack"><div className="row-between"><div><div className="label">Cliente y vehículo</div>{customer || vehicle ? <div><strong>{customer?.name || customer?.phone || "Cliente sin nombre"}</strong><div className="muted small">{[customer?.phone, vehicle?.plate, vehicle?.make, vehicle?.model, vehicle?.year].filter(Boolean).join(" · ")}</div>{vehicle?.current_odometer != null && <div className="muted small">Kilometraje: {vehicle.current_odometer.toLocaleString("es-VE")} km</div>}</div> : order?.is_walk_in ? <div><strong>Servicio rápido · sin cliente</strong><div className="muted small">Se puede cobrar y cerrar sin crear un cliente ficticio. No genera historial ni seguimiento CRM.</div></div> : <div className="muted">Asócialo para conservar historial o elige servicio rápido sin cliente.</div>}</div>{!locked && <button className="btn btn-ghost" onClick={() => setModal("PARTY")}>{customer || vehicle ? "Cambiar / nuevo vehículo" : order?.is_walk_in ? "Asociar cliente" : "Elegir atención"}</button>}</div></section>
    {!locked && <section className="grid grid-3"><button className="btn btn-primary" onClick={() => setModal("PRODUCT")}>+ Aceite / producto</button><button className="btn" disabled={busy} onClick={openOilChange}>+ Cambio de aceite completo</button><button className="btn" onClick={() => setModal("SERVICE")}>+ Taller / electroauto</button></section>}
    <section className="card"><div className="row-between"><h2 className="section-title">Productos y trabajos</h2><span className="muted small">{items.length} líneas</span></div>{items.map(item => <div className="order-item" key={item.id}><div className="row-between"><div><strong>{item.description}</strong><div className="muted small">{item.business_area} · {item.quantity}x</div></div>{!locked && <button className="btn btn-ghost" onClick={() => removeItem(item.id)}>Quitar</button>}</div><div className="row-between"><div><strong>{fmtRef(item.charged_ref_amount)}</strong><div className="muted small">{fmtVes(item.charged_ves_amount)}</div></div>{item.cash_price_revealed && item.cash_usd_special_total != null && <span className="pill">USD físico {fmtRef(item.cash_usd_special_total)}</span>}</div>{(Number(item.worker_share_ref_snapshot || 0) > 0 || Number(item.assistant_bonus_ref_snapshot || 0) > 0) && <div className="muted small">{item.business_area === "WORKSHOP" && <>Cheo: {fmtRef(item.worker_share_ref_snapshot)} · Bono Alexis: {fmtRef(item.assistant_bonus_ref_snapshot)}</>}{item.business_area === "ELECTROAUTO" && <>Alexis: {fmtRef(item.worker_share_ref_snapshot)}</>}</div>}</div>)}{!items.length && <div className="muted">Todavía no hay productos ni trabajos en esta orden.</div>}</section>
    <section className="card stack"><div className="row-between"><strong>Total orden</strong><div style={{ textAlign: "right" }}><div className="money-lg">{fmtRef(totalRef)}</div><div className="muted">{fmtVes(totalVes)}</div></div></div><div className="divider" /><div className="row-between"><strong>Pagado</strong><span>{fmtVes(paidVes)}</span></div><div className="row-between"><strong>{cashea ? "Diferencia cubierta por Cashea" : "Pendiente"}</strong><div style={{ textAlign: "right" }}><div>{fmtVes(remainingVes)}</div><div className="muted small">{fmtRef(remainingRef)} REF · ${remainingCashUsd.toFixed(2)} USD físico</div></div></div>{!locked && <button className="btn" disabled={!items.length} onClick={() => setModal("PAYMENT")}>+ Agregar pago</button>}{payments.map(p => <div className="row-between" key={p.id}><div><span className="muted small">{paymentLabel(p.method)}</span>{p.reference && <div className="muted small">Ref. {p.reference}</div>}</div><div className="row"><strong>{p.currency === "USD" ? `$${Number(p.amount_original).toFixed(2)}` : fmtVes(p.amount_original)}</strong>{!locked && <button className="btn btn-ghost" onClick={() => removePayment(p.id)}>×</button>}</div></div>)}</section>
    {!locked ? <section className="card stack">{readinessError && <div className="error" role="alert"><strong>Para cerrar:</strong> {readinessError}{/cliente|vehículo/i.test(readinessError) ? <button className="btn btn-block" onClick={() => setModal("PARTY")}>Completar cliente y vehículo</button> : /aceite/i.test(readinessError) ? <div>Quita la línea de servicio incompleta y usa “Cambio de aceite completo”.</div> : <div>Completa las observaciones en “Salida, seguimiento CRM y cortesías”.</div>}</div>}<button className="btn btn-ghost btn-block" onClick={() => router.push("/orders")}>Volver a órdenes · cambios guardados</button><button className="btn btn-block" disabled={busy || !items.length} onClick={() => setModal("CASHEA")}>Cobrar con Cashea</button><button className="btn btn-primary btn-block" disabled={busy || !items.length} onClick={closePaid}>{busy ? "Cerrando…" : remainingVes > 1 ? `Ir a cobrar · ${fmtVes(remainingVes)}` : "Cerrar orden pagada"}</button>{paidVes - totalVes > 1 && <div className="error" role="alert">Pago excedido por {fmtVes(paidVes - totalVes)}. Quita el pago incorrecto antes de cerrar.</div>}{!items.length && <div className="muted">Agrega productos o trabajos antes de cobrar.</div>}{remainingVes > 1 && <button className="btn btn-block" disabled={busy || !items.length || !customer} onClick={() => setModal("CREDIT")}>Cerrar con Crédito LC · {fmtVes(remainingVes)}</button>}{remainingVes > 1 && !customer && <div className="muted small" style={{ textAlign: "center" }}>Para Crédito LC primero asigna un cliente.</div>}{orderId && <button className="btn btn-ghost btn-block" disabled={busy} style={{ borderColor: "rgba(255,80,80,.45)", color: "#ff8b8b" }} onClick={deleteOrder}>Eliminar orden duplicada</button>}</section> : <button className="btn btn-ghost btn-block" onClick={() => router.push("/orders")}>Volver a órdenes</button>}
    {orderId && <div className="grid grid-2"><Link className="btn" href={`/orders/${orderId}/receipt`}>Ver / imprimir recibo</Link><Link className="btn" href="/orders/new">+ Nueva atención</Link></div>}
    {orderId && <details className="card"><summary>Salida, seguimiento CRM y cortesías</summary><div className="stack"><Link className="btn" href={`/orders/${orderId}/delivery`}>Salida / CRM</Link>{!locked && <OrderBonusProduct orderId={orderId} />}<OrderCrmExtras orderId={orderId} /></div></details>}
    {modal === "PARTY" && <OrderPartySheet currentCustomer={customer} currentVehicle={vehicle} ensureOrder={ensureOrder} onDone={async (c, v, id) => { setCustomer(c); setVehicle(v); setModal(null); setNotice("Cliente y vehículo guardados en esta orden."); try { await refresh(id); } catch (e: any) { setError(`Datos guardados. Recarga la orden para actualizar: ${e.message}`); } }} onWalkIn={async id => { setCustomer(null); setVehicle(null); setModal(null); setNotice("Servicio rápido activado. Puedes cobrar y cerrar sin registrar cliente ni vehículo."); try { await refresh(id); } catch (e: any) { setError(`Modo rápido guardado. Recarga la orden para actualizar: ${e.message}`); } }} onCancel={() => setModal(null)} />}
    {modal === "PRODUCT" && <ProductSheet inventoryProducts={inventoryProducts} catalogProducts={catalogProducts} rates={rates} ensureOrder={ensureOrder} onDone={async id => { setModal(null); try { await refresh(id); setNotice("Guardado en la orden."); } catch (e: any) { setError(`La operación se guardó, pero no se pudo actualizar: ${e.message}. Recarga la orden; no la registres de nuevo.`); } }} onCancel={() => setModal(null)} />}
    {modal === "SERVICE" && <ServiceSheet ensureOrder={ensureOrder} onDone={async id => { setModal(null); try { await refresh(id); setNotice("Guardado en la orden."); } catch (e: any) { setError(`La operación se guardó, pero no se pudo actualizar: ${e.message}. Recarga la orden; no la registres de nuevo.`); } }} onCancel={() => setModal(null)} />}
    {modal === "CASHEA" && orderId && <OrderCasheaSheet orderId={orderId} totalRef={totalRef} totalVes={totalVes} paidVes={paidVes} onCancel={() => setModal(null)} onDone={async () => { setModal(null); setNotice("Orden cerrada con Cashea. La inicial y las cuotas quedaron registradas."); try { await refresh(orderId); } catch (e: any) { setError(`Cierre registrado. Recarga la orden: ${e.message}`); } }} />}
    {modal === "PAYMENT" && <PaymentSheet onCashea={() => setModal("CASHEA")} ensureOrder={ensureOrder} remainingVes={remainingVes} rates={rates} onDone={async id => { setModal(null); try { await refresh(id); setNotice("Guardado en la orden."); } catch (e: any) { setError(`La operación se guardó, pero no se pudo actualizar: ${e.message}. Recarga la orden; no la registres de nuevo.`); } }} onCancel={() => setModal(null)} />}
    {modal === "CREDIT" && orderId && <CreditSheet orderId={orderId} customer={customer} remainingVes={remainingVes} remainingRef={remainingRef} onDone={() => { setModal(null); router.push("/orders"); router.refresh(); }} onCancel={() => setModal(null)} />}
  </div>;
}

function paymentLabel(method: string) { return ({ MOBILE_PAYMENT: "Pago móvil · Banco de Venezuela", TRANSFER_BDV: "Pago móvil · Banco de Venezuela", TRANSFER_BNC: "Pago móvil · BNC", CASH_VES: "Efectivo Bs", CASH_USD: "Efectivo USD" } as Record<string,string>)[method] ?? method; }

function ProductSheet({ inventoryProducts, catalogProducts, rates, ensureOrder, onDone, onCancel }: { inventoryProducts: InventoryProduct[]; catalogProducts: CatalogProduct[]; rates: Rates; ensureOrder: () => Promise<string>; onDone: (id:string)=>void|Promise<void>; onCancel:()=>void; }) {
  const [mode,setMode]=useState<"STOCK"|"CATALOG"|"MANUAL">("STOCK"); const [search,setSearch]=useState(""); const [selectedId,setSelectedId]=useState(""); const [qty,setQty]=useState(1); const [unitRef,setUnitRef]=useState(""); const [manualDescription,setManualDescription]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  const q=search.trim().toLowerCase(); const filteredInventory=inventoryProducts.filter(p=>matchesSearch(`${p.sku} ${p.brand??""} ${p.description} ${p.catalog_product_name??""} ${p.category??""}`, q)).slice(0,q ? 12 : 6); const filteredCatalog=catalogProducts.filter(p=>matchesSearch(`${p.filter_code??""} ${p.name} ${p.category??""}`, q)).slice(0,q ? 12 : 6);
  const selectedInventory=mode==="STOCK"?inventoryProducts.find(p=>p.id===selectedId)??null:null; const selectedCatalog=mode==="CATALOG"?catalogProducts.find(p=>p.id===selectedId)??null:null; const suggestedRef=selectedInventory?.current_ref_bcv??selectedCatalog?.current_ref_bcv??null; const effectiveUnitRef=unitRef===""?(suggestedRef??0):Number(unitRef);
  function switchMode(next:"STOCK"|"CATALOG"|"MANUAL"){setMode(next);setSelectedId("");setUnitRef("");setError("");if(next==="MANUAL"&&search.trim())setManualDescription(search.trim());}
  function chooseInventory(id:string){const p=inventoryProducts.find(x=>x.id===id);setSelectedId(id);setUnitRef(p?.current_ref_bcv!=null?Number(p.current_ref_bcv).toFixed(2):"");setError("");requestAnimationFrame(()=>document.getElementById("product-price")?.focus());}
  function chooseCatalog(id:string){const p=catalogProducts.find(x=>x.id===id);setSelectedId(id);setUnitRef(p?.current_ref_bcv!=null?Number(p.current_ref_bcv).toFixed(2):"");setError("");requestAnimationFrame(()=>document.getElementById("product-price")?.focus());}
  async function add(){if(busy)return;if(!Number.isFinite(qty)||qty<=0)return setError("La cantidad debe ser mayor que cero.");if(!Number.isFinite(effectiveUnitRef)||effectiveUnitRef<=0)return setError("Indica el precio unitario REF que vas a cobrar.");setBusy(true);setError("");try{const id=await ensureOrder();if(mode==="STOCK"){if(!selectedInventory)throw new Error("Selecciona un producto del inventario.");if(qty>selectedInventory.quantity_on_hand)throw new Error(`Stock insuficiente. Disponible: ${selectedInventory.quantity_on_hand}. Usa “Catálogo sin stock” si igual necesitas venderlo.`);const{error}=await supabase.rpc("add_inventory_product_item",{p_order_id:id,p_inventory_item_id:selectedInventory.id,p_quantity:qty,p_manual_unit_ref:effectiveUnitRef,p_business_area:"STORE"});if(error)throw error;}else if(mode==="CATALOG"){if(!selectedCatalog)throw new Error("Selecciona un producto del catálogo.");const{error}=await supabase.rpc("add_catalog_product_item_override",{p_order_id:id,p_product_id:selectedCatalog.id,p_quantity:qty,p_manual_unit_ref:effectiveUnitRef});if(error)throw error;}else{if(!manualDescription.trim())throw new Error("Escribe el nombre o descripción del producto.");const{error}=await supabase.rpc("add_manual_product_item",{p_order_id:id,p_description:manualDescription.trim(),p_quantity:qty,p_unit_ref:effectiveUnitRef});if(error)throw error;}await onDone(id);}catch(e:any){setError(e.message??String(e));}finally{setBusy(false);}}
  const canAdd=mode==="STOCK"?!!selectedInventory:mode==="CATALOG"?!!selectedCatalog:!!manualDescription.trim(); const displayName=selectedInventory?`${selectedInventory.sku} · ${selectedInventory.brand??"Producto"}`:(selectedCatalog?.name??manualDescription)||"Producto manual";
  return <div className="overlay"><div className="sheet stack"><div className="row-between"><div><h2 style={{margin:0}}>Agregar producto</h2><div className="muted small">Puedes vender con stock, sin stock o manualmente.</div></div><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cerrar</button></div><div className="segmented"><button className={`btn ${mode==="STOCK"?"btn-primary":"btn-ghost"}`} onClick={()=>switchMode("STOCK")}>Con stock</button><button className={`btn ${mode==="CATALOG"?"btn-primary":"btn-ghost"}`} onClick={()=>switchMode("CATALOG")}>Catálogo sin stock</button><button className={`btn ${mode==="MANUAL"?"btn-primary":"btn-ghost"}`} onClick={()=>switchMode("MANUAL")}>Venta manual</button></div>{mode!=="MANUAL"&&<label><span className="label">Buscar producto</span><input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="SKU, marca, filtro, aceite o descripción" autoFocus/></label>}{mode==="STOCK"&&<><div className="muted small">{inventoryProducts.length} referencias con existencia física disponibles.</div><div className="stack" style={{maxHeight:300,overflow:"auto"}}>{filteredInventory.map(p=><button key={p.id} className="btn btn-ghost" style={{textAlign:"left",borderColor:p.id===selectedId?"#ff5d15":undefined}} onClick={()=>chooseInventory(p.id)}><div className="row-between"><strong>{p.sku} · {p.brand??p.catalog_product_name??"Producto"}</strong><span className="pill">Stock {p.quantity_on_hand}</span></div><div className="small">{p.description}</div><div className="muted small">{p.category??"Sin rubro"} · {p.current_ref_bcv!=null?`${fmtRef(p.current_ref_bcv)} sugerido`:"precio manual"}</div></button>)}{!filteredInventory.length&&<div className="card stack"><strong>No aparece con stock.</strong><div className="muted small">Puedes venderlo igualmente desde “Catálogo sin stock” o “Venta manual”.</div><button className="btn" onClick={()=>switchMode("CATALOG")}>Buscar en catálogo</button></div>}</div></>}{mode==="CATALOG"&&<><div className="success small">Esta venta no descuenta inventario físico. Úsala cuando el conteo todavía no esté actualizado o la existencia real aún no esté cargada.</div><div className="muted small">{catalogProducts.length} productos disponibles en el catálogo.</div><div className="stack" style={{maxHeight:300,overflow:"auto"}}>{filteredCatalog.map(p=><button key={p.id} className="btn btn-ghost" style={{textAlign:"left",borderColor:p.id===selectedId?"#ff5d15":undefined}} onClick={()=>chooseCatalog(p.id)}><div className="row-between"><strong>{p.filter_code?`${p.filter_code} · `:""}{p.name}</strong><span className="pill">SIN CONTROL STOCK</span></div><div className="muted small">{p.category??"Producto"} · {p.current_ref_bcv!=null?`${fmtRef(p.current_ref_bcv)} sugerido`:"confirma precio"}</div></button>)}{!filteredCatalog.length&&<div className="card stack"><strong>No aparece en el catálogo.</strong><div className="muted small">Regístralo como venta manual para no frenar la atención.</div><button className="btn" onClick={()=>switchMode("MANUAL")}>Vender manualmente</button></div>}</div></>}{mode==="MANUAL"&&<div className="card stack"><div className="success small">Para productos que todavía no están bien cargados en catálogo/inventario. Queda en la orden, pero no altera stock.</div><label><span className="label">Producto / descripción</span><input className="input" value={manualDescription} onChange={e=>setManualDescription(e.target.value)} placeholder="Ej. Valvoline 10W30 Mineral" autoFocus/></label></div>}{(selectedInventory||selectedCatalog||mode==="MANUAL")&&<div className="card stack"><div className="row-between"><div><strong>{displayName}</strong>{selectedInventory&&<div className="muted small">{selectedInventory.description}</div>}</div>{selectedInventory?<span className="pill">Disponible {selectedInventory.quantity_on_hand}</span>:<span className="pill warn">SIN DESCUENTO STOCK</span>}</div><div className="grid grid-2"><label><span className="label">Cantidad</span><input className="input" type="number" min={0.01} step={0.01} value={qty} onChange={e=>setQty(Number(e.target.value))}/></label><label><span className="label">Precio a cobrar REF · unitario</span><input id="product-price" className="input" type="number" min="0.01" step="0.01" value={unitRef} onChange={e=>setUnitRef(e.target.value)} placeholder={suggestedRef!=null?suggestedRef.toFixed(2):"Precio manual"}/></label></div>{suggestedRef!=null&&<div className="muted small">Precio sugerido actual: {fmtRef(suggestedRef)} por unidad. Puedes modificarlo solo para esta orden.</div>}<div className="row-between"><span>Total a cobrar</span><div style={{textAlign:"right"}}><strong>{fmtRef(effectiveUnitRef*qty)}</strong><div className="muted small">{fmtVes(effectiveUnitRef*qty*rates.bcv)}</div></div></div></div>}{canAdd && (!Number.isFinite(effectiveUnitRef) || effectiveUnitRef <= 0) && <div className="error" role="alert">Este producto necesita un precio. Escribe el precio unitario REF para poder agregarlo.</div>}{error&&<div className="error" role="alert">{error}</div>}<button className="btn btn-primary btn-block" disabled={busy||!canAdd||!Number.isFinite(effectiveUnitRef)||effectiveUnitRef<=0||!Number.isFinite(qty)||qty<=0} onClick={add}>{busy?"Agregando…":mode==="STOCK"?"Agregar a la orden · stock al cerrar":"Agregar a la orden"}</button></div></div>;
}

function ServiceSheet({ ensureOrder, onDone, onCancel }: { ensureOrder:()=>Promise<string>; onDone:(id:string)=>void|Promise<void>; onCancel:()=>void; }) {
  const [area,setArea]=useState<"WORKSHOP"|"ELECTROAUTO"|"OIL_CHANGE">("WORKSHOP"); const [description,setDescription]=useState(""); const [baseRef,setBaseRef]=useState(0); const [customerRef,setCustomerRef]=useState(0); const [bonus,setBonus]=useState(true); const [advanced,setAdvanced]=useState(false); const [workerOverride,setWorkerOverride]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  useEffect(()=>{if(customerRef===0&&baseRef>0)setCustomerRef(baseRef);},[baseRef]); const preview=useMemo(()=>{try{if(area==="WORKSHOP")return workshopAllocation({baseRef,customerRef,alexisBonusEnabled:bonus,cheoOverrideRef:workerOverride===""?null:Number(workerOverride)});if(area==="ELECTROAUTO")return electroautoAllocation({baseRef,customerRef,alexisOverrideRef:workerOverride===""?null:Number(workerOverride)});return{customerRef,lubricenterRef:customerRef};}catch(e:any){return{error:e.message}as any;}},[area,baseRef,customerRef,bonus,workerOverride]);
  async function add(){if(busy||!Number.isFinite(baseRef)||!Number.isFinite(customerRef)||!description.trim()||baseRef<=0||customerRef<0||preview.error)return;setBusy(true);setError("");try{const id=await ensureOrder();const{error}=await supabase.rpc("add_service_item",{p_order_id:id,p_business_area:area,p_description:description.trim(),p_base_ref:baseRef,p_customer_ref:customerRef,p_worker_share_override_ref:workerOverride===""?null:Number(workerOverride),p_alexis_bonus_enabled:area==="WORKSHOP"?bonus:false});if(error)throw error;await onDone(id);}catch(e:any){setError(e.message??String(e));}finally{setBusy(false);}}
  return <div className="overlay"><div className="sheet stack"><div className="row-between"><h2 style={{margin:0}}>Trabajo / servicio</h2><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cerrar</button></div><label><span className="label">Área</span><select className="select" value={area} onChange={e=>setArea(e.target.value as any)}><option value="WORKSHOP">Taller · Cheo</option><option value="ELECTROAUTO">Electroauto · Alexis</option></select></label><label><span className="label">Descripción</span><input className="input" value={description} onChange={e=>setDescription(e.target.value)} placeholder="Ej. Cambio de aceite y filtro"/></label><div className="grid grid-2"><label><span className="label">Base REF</span><input className="input" type="number" min="0" step="0.01" value={baseRef||""} onChange={e=>setBaseRef(Number(e.target.value))}/></label><label><span className="label">Cobro al cliente REF</span><input className="input" type="number" min="0" step="0.01" value={customerRef||""} onChange={e=>setCustomerRef(Number(e.target.value))}/></label></div>{area==="WORKSHOP"&&<label className="row"><input type="checkbox" checked={bonus} onChange={e=>setBonus(e.target.checked)}/><span>Bono meritorio Alexis 5% (sale de Lubricenter)</span></label>}{area!=="OIL_CHANGE"&&<button className="btn btn-ghost" onClick={()=>setAdvanced(v=>!v)}>{advanced?"Ocultar ajuste":"Ajustar reparto excepcional"}</button>}{advanced&&area!=="OIL_CHANGE"&&<label><span className="label">Parte acordada {area==="WORKSHOP"?"Cheo":"Alexis"} REF</span><input className="input" type="number" min="0" step="0.01" value={workerOverride} onChange={e=>setWorkerOverride(e.target.value)} placeholder="Vacío = 40% automático"/></label>}<div className="card">{preview.error?<div className="error">{preview.error}</div>:area==="WORKSHOP"?<div className="stack"><div className="row-between"><span>Cliente</span><strong>{fmtRef(preview.customerRef)}</strong></div><div className="row-between"><span>Cheo</span><strong>{fmtRef(preview.cheoRef)}</strong></div><div className="row-between"><span>Bono Alexis</span><strong>{fmtRef(preview.alexisBonusRef)}</strong></div><div className="row-between"><span>Lubricenter</span><strong>{fmtRef(preview.lubricenterRef)}</strong></div></div>:area==="ELECTROAUTO"?<div className="stack"><div className="row-between"><span>Cliente</span><strong>{fmtRef(preview.customerRef)}</strong></div><div className="row-between"><span>Alexis</span><strong>{fmtRef(preview.alexisRef)}</strong></div><div className="row-between"><span>Lubricenter</span><strong>{fmtRef(preview.lubricenterRef)}</strong></div></div>:<div className="row-between"><span>Total servicio</span><strong>{fmtRef(customerRef)}</strong></div>}</div>{error&&<div className="error">{error}</div>}<button className="btn btn-primary btn-block" disabled={busy||!!preview.error||!description.trim()||baseRef<=0} onClick={add}>{busy?"Agregando…":"Agregar trabajo"}</button></div></div>;
}

function PaymentSheet({ onCashea, ensureOrder, remainingVes, rates, onDone, onCancel }: { onCashea:()=>void; ensureOrder:()=>Promise<string>; remainingVes:number; rates:Rates; onDone:(id:string)=>void|Promise<void>; onCancel:()=>void; }) {
  const [method,setMethod]=useState("TRANSFER_BDV"); const currency=method==="CASH_USD"?"USD":"VES"; const suggested=currency==="USD"?(rates.operative?remainingVes/rates.operative:0):remainingVes; const [amount,setAmount]=useState(0); const [reference,setReference]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false); useEffect(()=>{setAmount(Number(suggested.toFixed(2)));},[method,remainingVes,rates.operative]);
  async function add(){if(busy||!Number.isFinite(amount)||amount<=0)return;setBusy(true);setError("");try{const id=await ensureOrder();const{error}=await supabase.rpc("add_payment",{p_order_id:id,p_method:method,p_amount_original:amount,p_reference:reference||null});if(error)throw error;await onDone(id);}catch(e:any){setError(e.message??String(e));}finally{setBusy(false);}}
  return <div className="overlay"><div className="sheet stack"><div className="row-between"><h2 style={{margin:0}}>Agregar pago</h2><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cerrar</button></div><button className="btn btn-primary" onClick={onCashea} disabled={busy}>Cashea · inicial y 3 cuotas</button><label><span className="label">Pago de contado / abono</span><select className="select" value={method} onChange={e=>setMethod(e.target.value)}><option value="TRANSFER_BDV">Pago móvil · Banco de Venezuela</option><option value="TRANSFER_BNC">Pago móvil · BNC</option><option value="CASH_VES">Efectivo Bs</option><option value="CASH_USD">Efectivo USD físico</option></select></label><label><span className="label">Monto {currency}</span><input className="input" type="number" min="0" step="0.01" value={amount||""} onChange={e=>setAmount(Number(e.target.value))}/></label>{method!=="CASH_USD"&&method!=="CASH_VES"&&<label><span className="label">Referencia opcional</span><input className="input" value={reference} onChange={e=>setReference(e.target.value)}/></label>}<div className="card"><div className="muted small">VALOR DEL PAGO</div><div className="money-lg">{fmtVes(currency==="USD"?amount*rates.operative:amount)}</div><div className="muted small">USD físico usa la tasa operativa del momento.</div></div>{error&&<div className="error">{error}</div>}<button className="btn btn-primary btn-block" disabled={busy||amount<=0} onClick={add}>{busy?"Agregando…":"Agregar pago"}</button></div></div>;
}

function CreditSheet({ orderId, customer, remainingVes, remainingRef, onDone, onCancel }: { orderId:string; customer:Customer|null; remainingVes:number; remainingRef:number; onDone:()=>void; onCancel:()=>void; }) {
  const [dueDate,setDueDate]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); async function confirm(){if(!customer)return setError("Debes asociar un cliente antes de usar Crédito LC.");setBusy(true);setError("");const{error}=await supabase.rpc("close_order_with_credit",{p_order_id:orderId,p_due_date:dueDate||null});setBusy(false);if(error)return setError(error.message);onDone();}
  return <div className="overlay"><div className="sheet stack"><div className="row-between"><h2 style={{margin:0}}>Cerrar con Crédito LC</h2><button className="btn btn-ghost" onClick={onCancel}>Cancelar</button></div><div className="card stack" style={{borderColor:"rgba(255,93,21,.45)"}}><div className="muted small">CLIENTE</div><strong>{customer?.name||customer?.phone||"Sin cliente"}</strong><div className="divider"/><div className="row-between"><span>Saldo que quedará pendiente</span><div style={{textAlign:"right"}}><strong>{fmtVes(remainingVes)}</strong><div className="muted small">{fmtRef(remainingRef)}</div></div></div></div><label><span className="label">Fecha de pago esperada · opcional</span><input className="input" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label><div className="muted small">La orden se cerrará y el saldo quedará en Cuentas por Cobrar. No se considera un pago hasta que el cliente realmente abone.</div>{error&&<div className="error">{error}</div>}<button className="btn btn-primary btn-block" disabled={busy||!customer||remainingVes<=1} onClick={confirm}>{busy?"Cerrando…":"Confirmar Crédito LC"}</button></div></div>;
}

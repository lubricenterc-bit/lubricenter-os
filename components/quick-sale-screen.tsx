"use client";
import { OrderCasheaSheet } from "@/components/order-cashea-sheet";
import { QuickTenderCheckout } from "@/components/quick-tender-checkout";
import { inventorySearchText, matchesSearch } from "@/lib/domain/search";

import { businessInstant,caracasInput } from "@/lib/order-admin";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { D } from "@/lib/finance/money";
import { referenceError } from "@/lib/finance/money";
import { supabase } from "@/lib/supabase";
import { allowsManualSale, useInventorySalePolicy } from "@/lib/inventory-policy";
import { fmtRef, fmtVes } from "@/lib/format";
import { OsIcon } from "@/components/os-icon";
import { QUOTE_HANDOFF_KEY, takeQuoteLines } from "@/lib/sales-quote";

type InventoryProduct = {
  id: string; sku: string; brand: string | null; description: string; category: string | null;
  quantity_on_hand: number; product_id: string | null; catalog_product_name: string | null;
  current_price_ves: number | null; current_ref_bcv: number | null; alt_codes?: string[] | null;
};
type SearchResult = { key: string; kind: "STOCK" | "CATALOG"; inventory_item_id?: string; product_id?: string; title: string; subtitle: string; stock?: number; unit_ref: number; unit_ves: number };
type CartLine = { key: string; kind: "STOCK" | "CATALOG" | "MANUAL"; inventory_item_id?: string; product_id?: string; description: string; quantity: number; unit_ref: number; source_label: string; stock?: number };
type QuickPayloadLine = { kind: "STOCK" | "CATALOG" | "MANUAL"; inventory_item_id: string | null; product_id: string | null; description: string; quantity: number; unit_ref: number };
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };
type Rates = { bcv: number; operative: number };
type PaymentMethod = "TRANSFER_BDV" | "TRANSFER_BNC" | "CASH_VES" | "CASH_USD" | "ZELLE" | "BINANCE";
type CompletedSale = {
  order_id: string; order_number: string; total_ves: number; total_ref: number;
  cashea?: { initial_ref: number; financed_ref: number; commission_ref: number };
  credit?: { outstanding_ves: number; outstanding_ref: number };
};

const PAYMENT_METHODS: readonly [PaymentMethod, string][] = [
  ["TRANSFER_BDV", "Pago móvil · Venezuela"], ["TRANSFER_BNC", "Pago móvil · BNC"], ["CASH_VES", "Efectivo Bs"], ["CASH_USD", "Efectivo USD"],
];
const DIRECT_PAYMENT_METHODS: readonly [PaymentMethod, string][] = [...PAYMENT_METHODS, ["ZELLE", "Zelle USD"], ["BINANCE", "Binance USD"]];
const CASHEA_MIN_REF = 25;

function normalize(value: string | null | undefined) { return (value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

export function QuickSaleScreen() {
  const manualAllowed = allowsManualSale(useInventorySalePolicy());
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const quoteImported = useRef(false);
  const [quoteFlow,setQuoteFlow] = useState<"sale" | "order" | null>(null);
  const [quoteTransferNotice,setQuoteTransferNotice] = useState("");
  const [tenderOpen,setTenderOpen] = useState(false);
  const [inventory, setInventory] = useState<InventoryProduct[]>([]);
  const [rates, setRates] = useState<Rates>({ bcv: 0, operative: 0 });
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [manualDescription, setManualDescription] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [saleDate,setSaleDate] = useState("");
  const [ratesLoading,setRatesLoading]=useState(true);
  const [rateRefresh,setRateRefresh]=useState(0);
  const [rateSource,setRateSource]=useState("");
  const [draftHydrated,setDraftHydrated]=useState(false);
  const [recovering,setRecovering]=useState(true);
  const [prepared,setPrepared]=useState<CompletedSale|null>(null);
  const prepareRequest=useRef<{signature:string;id:string}|null>(null);
  const directRequest=useRef<{signature:string;id:string}|null>(null);
  const submitLock=useRef(false);
  const [received,setReceived] = useState(false);
  const [checkoutMode, setCheckoutMode] = useState<"DIRECT" | "CASHEA">("DIRECT");
  const [selectedPayment, setSelectedPayment] = useState<PaymentMethod>("TRANSFER_BDV");
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [partialCreditOpen, setPartialCreditOpen] = useState(false);

  async function load() {
    setLoading(true); setWarning("");
    const invRes = await supabase.from("inventory_current").select("id,sku,brand,description,category,quantity_on_hand,product_id,catalog_product_name,current_price_ves,current_ref_bcv,alt_codes").eq("location_code", "CABUDARE").gt("quantity_on_hand", 0).eq("needs_review", false).order("brand").order("sku").limit(1000);
    const warnings: string[] = [];
    if (invRes.error) warnings.push(`Inventario: ${invRes.error.message}`); else setInventory((invRes.data ?? []).map((x: any) => ({ ...x, quantity_on_hand: Number(x.quantity_on_hand ?? 0), current_price_ves: x.current_price_ves == null ? null : Number(x.current_price_ves), current_ref_bcv: x.current_ref_bcv == null ? null : Number(x.current_ref_bcv) })) as InventoryProduct[]);
    setWarning(warnings.join(" · ")); setLoading(false); setTimeout(() => searchRef.current?.focus(), 50);
  }
  useEffect(() => {
    load();
    const refreshPricing = () => {load();setRateRefresh(n=>n+1);};
    window.addEventListener("lubricenter:pricing-updated", refreshPricing);
    return () => window.removeEventListener("lubricenter:pricing-updated", refreshPricing);
  }, []);

  useEffect(()=>{
    let active=true;setRatesLoading(true);setReceived(false);
    supabase.rpc("get_exchange_rates_for_date",{p_date:saleDate.slice(0,10)||null}).then(({data,error})=>{
      if(!active)return;
      if(error){setRates({bcv:0,operative:0});setError(error.message);}
      else {const r=Array.isArray(data)?data[0]:data;setRates({bcv:Number(r.bcv_rate),operative:Number(r.operative_rate)});setRateSource('BCV vigente desde '+r.bcv_date+' · operativa desde '+r.operative_date);}
      setRatesLoading(false);
    });return()=>{active=false;};
  },[saleDate,rateRefresh]);
  useEffect(()=>{
    let active=true;
    const id=sessionStorage.getItem('lubricenter:pending-quick-sale');
    if(!id){setRecovering(false);return;}
    (async()=>{
      try{
        const q=await supabase.from('orders').select('id,order_number,status,total_ves,total_ref').eq('id',id).single();
        if(q.error)throw q.error;if(!active)return;
        if(q.data.status==='CLOSED'){
          const cs=await supabase.from('cashea_sales').select('initial_ref,financed_ref,commission_ref').eq('order_id',id).maybeSingle();
          if(cs.error)throw cs.error;
          setCompleted({order_id:id,order_number:q.data.order_number,total_ves:Number(q.data.total_ves),total_ref:Number(q.data.total_ref),...(cs.data?{cashea:{initial_ref:Number(cs.data.initial_ref),financed_ref:Number(cs.data.financed_ref),commission_ref:Number(cs.data.commission_ref)}}:{})});
          sessionStorage.removeItem('lubricenter:pending-quick-sale');resetAfterSale();return;
        }
        if(q.data.status!=='OPEN'){sessionStorage.removeItem('lubricenter:pending-quick-sale');setError('La orden pendiente fue anulada. Revisa su historial antes de crear otra venta.');resetAfterSale();return;}
        const its=await supabase.from('order_items').select('charged_ves_amount,charged_ref_amount').eq('order_id',id);
        if(its.error)throw its.error;
        if(active)setPrepared({order_id:id,order_number:q.data.order_number,total_ves:(its.data??[]).reduce((n,i)=>n+Number(i.charged_ves_amount),0),total_ref:(its.data??[]).reduce((n,i)=>n+Number(i.charged_ref_amount),0)});
      }catch(e:any){if(active){setError(e.message||'No se pudo recuperar la orden pendiente.');setPrepared({order_id:id,order_number:'Orden pendiente de recuperar',total_ves:0,total_ref:0});}}
      finally{if(active)setRecovering(false);}
    })();return()=>{active=false;};
  },[]);

  async function prepareCashea(){
    if(!cartValid||ratesLoading||submitLock.current)return;
    submitLock.current=true;setBusy(true);setError('');
    const signature=JSON.stringify([payload(),businessInstant(saleDate)]);
    if(!prepareRequest.current){try{prepareRequest.current=JSON.parse(sessionStorage.getItem('lubricenter:quick-prepare-request')||'null');}catch{}}
    if(prepareRequest.current?.signature!==signature)prepareRequest.current={signature,id:crypto.randomUUID()};
    sessionStorage.setItem('lubricenter:quick-prepare-request',JSON.stringify(prepareRequest.current));
    try{const r=await supabase.rpc('prepare_quick_sale',{p_request:prepareRequest.current.id,p_items:payload(),p_business_at:businessInstant(saleDate)});if(r.error)throw r.error;const row=Array.isArray(r.data)?r.data[0]:r.data;setPrepared(row);sessionStorage.setItem('lubricenter:pending-quick-sale',row.order_id);}
    catch(e:any){setError(e.message||'No se pudo guardar. Conservamos la venta para reintentar.');}
    finally{submitLock.current=false;setBusy(false);}
  }

  useEffect(()=>{
    try{const saved=JSON.parse(sessionStorage.getItem('lubricenter:quick-cart')||'null');if(saved){setCart(saved.cart||[]);setSaleDate(saved.saleDate||'');setSelectedPayment(saved.method||'TRANSFER_BDV');setReference(saved.reference||'');}}catch{}
    setDraftHydrated(true);
  },[]);
  useEffect(()=>{if(draftHydrated)sessionStorage.setItem('lubricenter:quick-cart',JSON.stringify({cart,saleDate,method:selectedPayment,reference}));},[draftHydrated,cart,saleDate,selectedPayment,reference]);
  // Importa una cotización guardada al mismo carrito de venta rápida. Nunca registra ventas automáticamente.
  useEffect(() => {
    if (loading || quoteImported.current || !inventory.length) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") !== "quote") return;
    quoteImported.current = true;
    const transfer = takeQuoteLines(QUOTE_HANDOFF_KEY);
    if (!transfer.length) {
      setWarning(previous => [previous,"No se encontró una cotización pendiente. Vuelve al cotizador."].filter(Boolean).join(" · "));
      return;
    }
    const imported: CartLine[] = [];
    const skipped: string[] = [];
    for (const line of transfer) {
      if (line.kind === "MANUAL") {
        imported.push({
          key: "MANUAL:QUOTE:"+line.id,
          kind: "MANUAL", description:line.description, quantity:line.quantity,
          unit_ref:line.unitRef, source_label:"Desde cotización · importe editable"
        });
        continue;
      }
      // La cotización guarda el id del artículo de inventario (único catálogo).
      const stock = inventory.find(item=>item.id===line.productId && item.quantity_on_hand>=line.quantity && (item.current_ref_bcv??0)>0);
      if (stock) {
        imported.push({
          key:"STOCK:"+stock.id,kind:"STOCK",inventory_item_id:stock.id,
          product_id:stock.product_id??undefined,
          description:[stock.brand,stock.sku,stock.description].filter(Boolean).join(" · "),
          quantity:line.quantity,unit_ref:Number(stock.current_ref_bcv),
          source_label:"Desde cotización · stock disponible",stock:stock.quantity_on_hand
        });
        continue;
      }
      skipped.push("Un producto de la cotización ya no tiene existencia o precio en inventario.");
    }
    if (imported.length) {
      setCart(previous => {
        const merged = [...previous];
        for (const line of imported) {
          const index=merged.findIndex(item=>item.key===line.key);
          if (index < 0) merged.push(line);
          else if (merged[index].kind !== "STOCK" ||
            merged[index].quantity + line.quantity <= (merged[index].stock??0))
            merged[index]={...merged[index],quantity:merged[index].quantity+line.quantity};
          else skipped.push("Un artículo supera la existencia disponible.");
        }
        return merged;
      });
      setQuoteFlow(params.get("flow")==="order"?"order":"sale");
      setQuoteTransferNotice(imported.length+" concepto(s) cargados desde la cotización. Revisa los precios y confirma "+(params.get("flow")==="order"?"la creación de la orden":"el cobro")+".");
    }
    if (skipped.length) setWarning(previous=>[previous,...skipped].filter(Boolean).join(" · "));
    const url=new URL(window.location.href);
    url.searchParams.delete("from");url.searchParams.delete("flow");
    window.history.replaceState(window.history.state,"",url.pathname+url.search+url.hash);
  }, [loading,inventory]);

  useEffect(()=>{setReceived(false);},[cart,selectedPayment,reference]);

  const results = useMemo<SearchResult[]>(() => {
    const q = normalize(search.trim());
    const stockResults = inventory.filter(i => !q || matchesSearch(inventorySearchText(i), q)).map(i => ({ key: `STOCK:${i.id}`, kind: "STOCK" as const, inventory_item_id: i.id, product_id: i.product_id ?? undefined, title: i.catalog_product_name || [i.brand, i.sku].filter(Boolean).join(" · ") || i.sku, subtitle: [i.sku, i.current_ref_bcv == null ? "sin precio: escríbelo" : null].filter(Boolean).join(" · "), stock: i.quantity_on_hand, unit_ref: Number(i.current_ref_bcv ?? 0), unit_ves: Number(i.current_price_ves ?? 0) }));
    return stockResults.slice(0, q ? 12 : 6);
  }, [inventory, search]);

  function addResult(r: SearchResult) {
    if (r.kind === "STOCK" && (cart.find(x => x.key === r.key)?.quantity ?? 0) + 1 > (r.stock ?? 0)) return setError("Ya agregaste la existencia disponible de este producto. Revisa la cantidad en la venta.");
    setCompleted(null); setError("");
    setCart(lines => { const existing = lines.find(x => x.key === r.key); if (existing) return lines.map(x => x.key === r.key ? { ...x, quantity: x.quantity + 1 } : x); return [...lines, { key: r.key, kind: r.kind, inventory_item_id: r.inventory_item_id, product_id: r.product_id, description: r.kind === "STOCK" ? `${r.title} · ${r.subtitle}` : r.title, quantity: 1, unit_ref: r.unit_ref, source_label: r.kind === "STOCK" ? `Con stock · ${r.stock ?? 0} disp.` : "Catálogo · sin descontar stock", stock: r.stock }]; });
    setSearch(""); setTimeout(() => searchRef.current?.focus(), 20);
  }
  function addManual() {
    const description = manualDescription.trim(); const unitRef = Number(manualPrice); const quantity = Number(manualQty || 1);
    if (!manualAllowed) return setError("Solo un administrador puede vender productos sin inventario.");
    if (!description) return setError("Escribe el producto manual.");
    if (!Number.isFinite(unitRef) || unitRef <= 0) return setError("Escribe un precio REF válido.");
    if (!Number.isFinite(quantity) || quantity <= 0) return setError("Escribe una cantidad válida.");
    setError(""); setCompleted(null); setCart(lines => [...lines, { key: `MANUAL:${Date.now()}:${Math.random()}`, kind: "MANUAL", description, quantity, unit_ref: unitRef, source_label: "Venta manual · no altera inventario" }]);
    setManualDescription(""); setManualPrice(""); setManualQty("1"); setTimeout(() => searchRef.current?.focus(), 20);
  }
  function updateLine(key: string, patch: Partial<CartLine>) { setCart(lines => lines.map(line => line.key === key ? { ...line, ...patch } : line)); }

  const totalRef = useMemo(() => cart.reduce((sum, line) => sum + line.quantity * Math.max(0, Number(line.unit_ref || 0)), 0), [cart]);
  const totalVes = useMemo(() => cart.reduce((sum, line) => sum + Number(new D(line.unit_ref || 0).mul(rates.bcv).toDecimalPlaces(2).mul(line.quantity).toDecimalPlaces(2)), 0), [cart, rates.bcv]);
  const cashUsd = rates.operative > 0 ? totalVes / rates.operative : 0;
  const cartValid = !recovering && !ratesLoading && rates.bcv>0 && rates.operative>0 && cart.length > 0 && cart.every(x => Number.isFinite(x.quantity) && x.quantity > 0 && Number.isFinite(Number(x.unit_ref)) && Number(x.unit_ref) > 0 && (x.kind !== "STOCK" || x.stock == null || x.quantity <= x.stock));

  function payload(): QuickPayloadLine[] { return cart.map(line => ({ kind: line.kind, inventory_item_id: line.inventory_item_id ?? null, product_id: line.product_id ?? null, description: line.description, quantity: line.quantity, unit_ref: Number(line.unit_ref) })); }
  function resetAfterSale() { directRequest.current=null;prepareRequest.current=null;sessionStorage.removeItem("lubricenter:quick-direct-request");sessionStorage.removeItem("lubricenter:quick-prepare-request");sessionStorage.removeItem("lubricenter:quick-cart"); setQuoteFlow(null);setQuoteTransferNotice("");setSaleDate("");setReceived(false); setCart([]); setReference(""); setSearch(""); setCheckoutMode("DIRECT"); setSelectedPayment("TRANSFER_BDV"); }

  async function completeDirect() {
    if (!cartValid || submitLock.current) return;
    const re = referenceError(selectedPayment, reference); if (re) return setError(re);
    if(selectedPayment.startsWith("CASH")){setTenderOpen(true);return;}
    submitLock.current=true;setBusy(true);setError("");setCompleted(null);
    const signature=JSON.stringify([payload(),selectedPayment,reference.trim(),businessInstant(saleDate)]);
    if(!directRequest.current){try{directRequest.current=JSON.parse(sessionStorage.getItem('lubricenter:quick-direct-request')||'null');}catch{}}
    if(directRequest.current?.signature!==signature)directRequest.current={signature,id:crypto.randomUUID()};
    sessionStorage.setItem('lubricenter:quick-direct-request',JSON.stringify(directRequest.current));
    try{
      const r=await supabase.rpc("quick_sale_direct_v2",{p_request:directRequest.current.id,p_items:payload(),p_method:selectedPayment,p_reference:reference.trim()||null,p_business_at:businessInstant(saleDate)});
      if(r.error)throw r.error;
      const row=Array.isArray(r.data)?r.data[0]:r.data;
      if(!row?.order_id)throw new Error('No se recibió la confirmación de guardado. Reintenta esta misma venta.');
      setCompleted({order_id:row.order_id,order_number:row.order_number,total_ves:Number(row.total_ves),total_ref:Number(row.total_ref)});
      resetAfterSale();await load();
    }catch(e:any){setError(e.message||'No se pudo confirmar el guardado. Reintenta sin cambiar los datos.');}
    finally{submitLock.current=false;setBusy(false);}
  }


  async function continueAsOrder() {
    if (!cartValid || busy) return;
    setBusy(true); setError(""); const { data, error } = await supabase.rpc("quick_sale_dated", { p_items: payload(), p_mode: "DRAFT", p_business_at: businessInstant(saleDate) }); setBusy(false);
    if (error) return setError(error.message); const row = Array.isArray(data) ? data[0] : data; router.push(`/orders/${row.order_id}`);
  }

  if(prepared)return <main className="container stack">{error&&<div className="error" role="alert">{error}</div>}<section className="card stack"><div className="eyebrow">ORDEN GUARDADA · PENDIENTE DE COBRO</div><h1>{prepared.order_number}</h1><p>Usa este número en Cashea antes de que el cliente pague. La venta se registra como cobrada al confirmar la inicial.</p><Link className="btn" href={'/orders/'+prepared.order_id}>Abrir orden / continuar después</Link></section><OrderCasheaSheet orderId={prepared.order_id} totalRef={prepared.total_ref} totalVes={prepared.total_ves} paidVes={0} onCancel={()=>{sessionStorage.removeItem('lubricenter:pending-quick-sale');router.push('/orders/'+prepared.order_id);}} onDone={async()=>{const q=await supabase.from('cashea_sales').select('initial_ref,financed_ref,commission_ref').eq('order_id',prepared.order_id).single();if(q.error)throw q.error;setCompleted({...prepared,cashea:{initial_ref:Number(q.data.initial_ref),financed_ref:Number(q.data.financed_ref),commission_ref:Number(q.data.commission_ref)}});sessionStorage.removeItem('lubricenter:pending-quick-sale');setPrepared(null);prepareRequest.current=null;resetAfterSale();await load();}}/></main>;

  return <main className="container stack mesa-quick-sale"><fieldset disabled={busy} style={{display:"contents"}}>
    <section className="mesa-sale-hero"><div><div className="eyebrow">02 / VENTA RÁPIDA · MOSTRADOR</div><h1>Vender<span>.</span></h1><p>Cotiza sin crear una orden. Para Cashea, guarda primero la orden pendiente y usa su número antes de cobrar.</p></div><span className="mesa-sale-signature" aria-hidden="true">RÁPIDO<br/>SENCILLO<br/>PARA TU<br/>TALLER<span>↗</span></span></section>
    <div className="row-between"><span className="muted small">Venta directa o Cashea tradicional desde el mismo carrito.</span><div className="row"><Link className="btn btn-ghost" href="/quote"><OsIcon name="receipt" size={16}/> Cotizar productos</Link><Link className="btn btn-ghost" href="/cashea">Seguimiento Cashea</Link></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    {quoteFlow && <section className="card stack" style={{borderColor:"rgba(255,128,47,.72)",background:"rgba(255,128,47,.08)"}}>
      <div className="row-between"><div><strong>{quoteFlow==="order"?"Continuar cotización como orden":"Cotización lista para cobrar"}</strong>
        <div className="muted small">{quoteTransferNotice}</div></div><Link className="btn btn-ghost" href="/quote">Volver al cotizador</Link></div>
      <div className="row" style={{flexWrap:"wrap"}}>
        {quoteFlow==="order"
          ? <button className="btn btn-primary" disabled={!cartValid||busy} onClick={()=>void continueAsOrder()}>
              {busy?"Creando orden…":"Confirmar y crear orden"}
            </button>
          : <button className="btn btn-primary" disabled={!cartValid} onClick={()=>
              document.getElementById("quick-sale-checkout")?.scrollIntoView({behavior:"smooth",block:"start"})}>
              Ir a cobrar
            </button>}
        <button className="btn btn-ghost" onClick={()=>setQuoteFlow(v=>v==="order"?"sale":"order")}>
          {quoteFlow==="order"?"Cambiar a venta rápida":"Cambiar a orden"}
        </button>
      </div>
      <div className="muted small">Los importes se toman de los precios actuales del catálogo. Nada se registra hasta que confirmes aquí.</div>
    </section>}
    {warning && <div className="card" style={{ borderColor: "rgba(255,93,21,.45)" }}><strong>Modo degradado disponible</strong><div className="muted small">{warning}. La venta manual sigue disponible si catálogo o inventario no cargan.</div></div>}

    {completed && <section className="card stack" style={{ borderColor: "rgba(63,190,115,.55)" }}>
      <div className="row-between"><div><div className="eyebrow">VENTA REGISTRADA Y CERRADA</div><div className="money-lg">{completed.order_number}</div></div><span className="pill ok">{completed.cashea ? "CASHEA" : completed.credit ? "CRÉDITO LC" : "COBRADA"}</span></div>
      <div className="row-between"><strong>{fmtRef(completed.total_ref)}</strong><strong>{fmtVes(completed.total_ves)}</strong></div>
      {completed.cashea && <div className="grid grid-3"><div><div className="muted small">INICIAL</div><strong>{fmtRef(completed.cashea.initial_ref)}</strong></div><div><div className="muted small">POR RECIBIR</div><strong>{fmtRef(completed.cashea.financed_ref)}</strong></div><div><div className="muted small">COMISIÓN 4%</div><strong>{fmtRef(completed.cashea.commission_ref)}</strong></div></div>}
      {completed.credit && <div className="card" style={{borderColor:"rgba(255,106,26,.6)"}}><div className="muted small">SALDO REGISTRADO EN CRÉDITO LC</div><strong>{fmtVes(completed.credit.outstanding_ves)}</strong><div className="muted small">{fmtRef(completed.credit.outstanding_ref)} · disponible en Cobros</div></div>}
      <div className="grid grid-2"><Link className="btn" href={`/orders/${completed.order_id}/receipt`}>Ver recibo</Link>{completed.cashea ? <Link className="btn btn-primary" href="/cashea">Ver Cashea</Link> : <button className="btn btn-primary" onClick={() => { setCompleted(null); searchRef.current?.focus(); }}>Nueva venta</button>}</div>
    </section>}

    {tenderOpen&&<QuickTenderCheckout items={payload()} method={selectedPayment} reference={reference} totalVes={totalVes} totalRef={totalRef} rate={rates.operative} bcv={rates.bcv} businessAt={businessInstant(saleDate)} onCancel={()=>setTenderOpen(false)} onDone={async row=>{setCompleted({order_id:row.order_id,order_number:row.order_number,total_ves:Number(row.total_ves),total_ref:Number(row.total_ref)});setTenderOpen(false);resetAfterSale();await load();}}/>}
    <div className="mesa-sale-layout">
    <div className="mesa-sale-workbench">
    <section className="card stack mesa-sale-search">
      <div className="row-between"><div><strong>1. Buscar / cotizar</strong><div className="muted small">SKU, marca, descripción, filtro o nombre. Enter agrega el primer resultado.</div></div><span className="pill">{inventory.length} artículos con existencia</span></div>
      <input ref={searchRef} className="input" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && results[0]) { e.preventDefault(); addResult(results[0]); } }} placeholder="Ej: Valvoline, 3387, 20W50, refrigerante…" autoFocus />
      {loading ? <div className="muted">Cargando precios…</div> : <div className="stack" style={{ maxHeight: 430, overflow: "auto" }}>
        {results.map(r => <button key={r.key} className="card directory-option" style={{ padding: 14, textAlign: "left" }} onClick={() => addResult(r)}><div className="row-between" style={{ gap: 12 }}><div style={{ minWidth: 0 }}><strong>{r.title}</strong><div className="muted small">{r.subtitle}</div><div className="muted small">{r.kind === "STOCK" ? `Stock físico: ${r.stock}` : "Sin stock confirmado · venta permitida"}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div className="money-lg">{r.unit_ref > 0 ? fmtRef(r.unit_ref) : "Sin precio"}</div><div className="muted small">{r.unit_ves > 0 ? fmtVes(r.unit_ves) : "editable al agregar"}</div></div></div></button>)}
        {!results.length && <div className="muted">{manualAllowed ? "No aparece en stock ni catálogo. Regístralo abajo como venta manual." : "No aparece en stock ni catálogo. Pide a un administrador que lo cargue en inventario."}</div>}
      </div>}
    </section>

    {manualAllowed && <section className="card stack"><div><strong>Venta manual inmediata</strong><div className="muted small">Para productos que todavía no existen en catálogo. No descuenta inventario.</div></div><input className="input" value={manualDescription} onChange={e => setManualDescription(e.target.value)} placeholder="Descripción del producto" /><div className="grid grid-2"><input className="input" type="number" min="0" step="0.01" value={manualPrice} onChange={e => setManualPrice(e.target.value)} placeholder="Precio unitario REF" /><input className="input" type="number" min="0.01" step="0.01" value={manualQty} onChange={e => setManualQty(e.target.value)} placeholder="Cantidad" /></div><button className="btn" onClick={addManual}>+ Agregar manual</button></section>}

    <section className="card stack">
      <div className="row-between"><div><strong>2. Venta</strong><div className="muted small">Precio editable solo para esta venta; no cambia el catálogo.</div></div><span className="pill">{cart.length} líneas</span></div>
      {cart.map(line => { const exceeds = line.kind === "STOCK" && line.stock != null && line.quantity > line.stock; return <div className="order-item" key={line.key}><div className="row-between"><div><strong>{line.description}</strong><div className="muted small">{line.source_label}</div></div><button className="btn btn-ghost" onClick={() => setCart(lines => lines.filter(x => x.key !== line.key))}>Quitar</button></div><div className="grid grid-2" style={{ marginTop: 10 }}><label><span className="label">Cantidad</span><input className="input" type="number" min="0.01" step="0.01" value={line.quantity} onChange={e => updateLine(line.key, { quantity: Number(e.target.value) })} /></label><label><span className="label">Precio unitario REF</span><input className="input" type="number" min="0.01" step="0.01" value={line.unit_ref || ""} onChange={e => updateLine(line.key, { unit_ref: Number(e.target.value) })} /></label></div><div className="row-between"><span className="muted small">Subtotal</span><strong>{fmtRef(line.quantity * Number(line.unit_ref || 0))}</strong></div>{exceeds && <div className="error">Solo hay {line.stock} en stock físico. Reduce la cantidad o vende la diferencia desde catálogo/manual.</div>}</div>; })}
      {!cart.length && <div className="muted">Agrega productos para armar la cotización. Todavía no se crea ninguna OS.</div>}
    </section>

    </div>
    <section id="quick-sale-checkout" className="card stack mesa-sale-checkout" style={{ borderColor: cart.length ? "rgba(255,93,21,.42)" : undefined, scrollMarginTop: 80 }}>
      <div><div className="eyebrow">3. FINALIZAR VENTA</div><h2 style={{ margin: "4px 0 0" }}>Registrar y cobrar</h2></div>
      <div className="row-between"><div><div className="muted small">TOTAL A COBRAR</div><div className="money-lg">{fmtRef(totalRef)}</div></div><div style={{ textAlign: "right" }}><strong>{fmtVes(totalVes)}</strong><div className="muted small">USD físico aprox. {cashUsd.toFixed(2)}</div></div></div>
      <div className="segmented"><button type="button" className={`btn ${checkoutMode === "DIRECT" ? "btn-primary" : "btn-ghost"}`} onClick={() => setCheckoutMode("DIRECT")}>Cobro directo</button><button type="button" className={`btn ${checkoutMode === "CASHEA" ? "btn-primary" : "btn-ghost"}`} onClick={() => setCheckoutMode("CASHEA")}>Cashea tradicional</button></div>

      <label><span className="label">Fecha de venta · Venezuela (vacío = ahora)</span><input className="input" type="datetime-local" value={saleDate} max={caracasInput()} disabled={busy} onChange={e=>{setRatesLoading(true);setSaleDate(e.target.value);}} /></label>
      <div className="muted small" role="status">{ratesLoading?"Buscando tasas de la fecha…":rateSource} · BCV {rates.bcv} · Operativa {rates.operative}</div>
      {saleDate && <p className="muted small">Se aplican las tasas registradas para esta fecha. Los precios REF son editables para esta venta.</p>}
      {checkoutMode==="DIRECT" && <label className="row"><input type="checkbox" checked={received} onChange={e=>setReceived(e.target.checked)} /> Confirmo que recibí el pago de la venta.</label>}
      {checkoutMode === "DIRECT" ? <>
        <div><span className="label">Forma de pago</span><div className="grid grid-2">{DIRECT_PAYMENT_METHODS.map(([method, label]) => <button key={method} type="button" className={selectedPayment === method ? "btn btn-primary" : "btn"} onClick={() => setSelectedPayment(method)} disabled={busy}>{selectedPayment === method ? `✓ ${label}` : label}</button>)}</div></div>
        <input className="input" value={reference} onChange={e => setReference(e.target.value)} placeholder={selectedPayment.startsWith("TRANSFER") ? "Últimos 4 de referencia · obligatorio" : "Referencia de pago (opcional)"} />
        <button className="btn btn-primary btn-block" style={{ minHeight: 56, fontSize: 17 }} disabled={!cartValid || busy || !received} onClick={completeDirect}>{busy ? "Registrando venta…" : `Registrar y cerrar venta · ${fmtRef(totalRef)}`}</button>
        <button className="btn btn-block" disabled={!cartValid||busy} onClick={()=>setTenderOpen(true)}>Cobro con vuelto o precio pactado USD</button>
        <button className="btn btn-block" style={{border:"1px solid rgba(255,106,26,.72)",background:"rgba(255,106,26,.12)"}} disabled={!cartValid || busy} onClick={() => setPartialCreditOpen(true)}>Abono + saldo a Crédito LC</button>
      </> : <div className="stack">
        <p>Primero guarda la orden para obtener su número. Después registra la compra en Cashea y confirma la inicial recibida.</p>
        <button className="btn btn-primary btn-block" style={{ minHeight: 56, fontSize: 17 }} disabled={!cartValid || totalRef<CASHEA_MIN_REF || busy} onClick={prepareCashea}>{busy ? "Registrando Cashea…" : `Obtener número de orden para Cashea`}</button>
      </div>}

      <p className="muted small">Para preparar un recibo sin cobrar, continúa como orden y usa su cotización. Imprimir no cierra la venta.</p>
      <button className="btn btn-ghost btn-block" disabled={!cartValid || busy} onClick={continueAsOrder}>Saldo a favor / pago mixto / Crédito LC → continuar como orden</button>
      {!cart.length && <div className="muted small">Agrega al menos un producto para habilitar el cierre.</div>}
      {!cartValid && cart.length > 0 && <div className="muted small">Corrige cantidades o precios antes de registrar la venta.</div>}
    </section>
    </div>
    {partialCreditOpen && <QuickPartialCreditSheet items={payload()} totalVes={totalVes} totalRef={totalRef} rates={rates} saleDate={saleDate} onCancel={()=>setPartialCreditOpen(false)} onDone={async row=>{setPartialCreditOpen(false);setCompleted({order_id:row.order_id,order_number:row.order_number,total_ves:Number(row.total_ves??0),total_ref:Number(row.total_ref??0),credit:{outstanding_ves:Number(row.outstanding_ves??0),outstanding_ref:Number(row.outstanding_ref??0)}});resetAfterSale();await load();}}/>}
  </fieldset></main>;
}

function QuickPartialCreditSheet({ items, totalVes, totalRef, rates, saleDate, onCancel, onDone }: { items:QuickPayloadLine[]; totalVes:number; totalRef:number; rates:Rates; saleDate:string; onCancel:()=>void; onDone:(row:any)=>void|Promise<void> }) {
  const [query,setQuery]=useState(""); const [customers,setCustomers]=useState<Customer[]>([]); const [customer,setCustomer]=useState<Customer|null>(null); const [creating,setCreating]=useState(false); const [name,setName]=useState(""); const [phone,setPhone]=useState(""); const [method,setMethod]=useState<PaymentMethod>("TRANSFER_BDV"); const [amount,setAmount]=useState(0); const [reference,setReference]=useState(""); const [dueDate,setDueDate]=useState(""); const [received,setReceived]=useState(false); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const currency=["CASH_USD","ZELLE","BINANCE"].includes(method)?"USD":"VES"; const maxAmount=currency==="USD"?(rates.operative?totalVes/rates.operative:0):totalVes; const paidVes=currency==="USD"?amount*rates.operative:amount; const pendingVes=Math.max(totalVes-paidVes,0); const pendingRef=rates.bcv?pendingVes/rates.bcv:0;
  useEffect(()=>{setAmount(Number((maxAmount*.5).toFixed(2)));},[method,totalVes,rates.operative]);
  useEffect(()=>{let active=true;const text=query.trim().replace(/[,().%_*\\]/g," ").trim();setCustomers([]);if(text.length<2)return;const timer=window.setTimeout(async()=>{const {data,error}=await supabase.from("customers").select("id,name,phone,document_id").or(`name.ilike.%${text}%,phone.ilike.%${text}%,document_id.ilike.%${text}%`).order("name").limit(8);if(!active)return;if(error)setError(error.message);else setCustomers((data??[]) as Customer[]);},250);return()=>{active=false;window.clearTimeout(timer);};},[query]);
  async function createCustomer(){if(!name.trim())return setError("Escribe el nombre del cliente.");setBusy(true);setError("");const {data,error}=await supabase.rpc("upsert_customer",{p_name:name.trim(),p_phone:phone.trim()||null,p_document_id:null});if(error){setBusy(false);return setError(error.message);}const saved=await supabase.from("customers").select("id,name,phone,document_id").eq("id",data).single();setBusy(false);if(saved.error)return setError(saved.error.message);setCustomer(saved.data as Customer);setCreating(false);setQuery("");}
  async function confirm(){const re=referenceError(method,reference);if(re)return setError(re);if(!customer)return setError("Busca o crea el cliente que asumirá el saldo.");if(!received)return setError("Confirma que recibiste el abono antes de registrar la venta.");if(!Number.isFinite(amount)||amount<=0)return setError("Indica el abono recibido.");if(paidVes>=totalVes-1)return setError("El abono cubre todo. Usa Cobro directo para cerrar la venta como pagada.");setBusy(true);setError("");const {data,error}=await supabase.rpc("quick_sale_partial_credit",{p_items:items,p_customer_id:customer.id,p_method:method,p_amount_original:amount,p_reference:reference.trim()||null,p_due_date:dueDate||null,p_business_at:businessInstant(saleDate)});setBusy(false);if(error)return setError(error.message);await onDone(Array.isArray(data)?data[0]:data);}
  return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-labelledby="partial-credit-title"><div className="row-between"><div><h2 id="partial-credit-title" style={{margin:0}}>Abono + Crédito LC</h2><div className="muted small">La venta se cierra; lo recibido entra hoy y el saldo queda por cobrar.</div></div><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancelar</button></div><div className="card stack" style={{borderColor:"rgba(255,106,26,.6)"}}><div className="row-between"><span>Total venta</span><div style={{textAlign:"right"}}><strong>{fmtVes(totalVes)}</strong><div className="muted small">{fmtRef(totalRef)}</div></div></div><div className="divider"/><div><span className="label">Cliente que llevará el saldo</span><input className="input" autoFocus value={query} onChange={e=>{setQuery(e.target.value);setCustomer(null);}} placeholder="Nombre, teléfono o cédula · mínimo 2 caracteres"/></div>{customers.map(c=><button key={c.id} type="button" className={`directory-option ${customer?.id===c.id?"selected":""}`} onClick={()=>{setCustomer(c);setQuery("");setError("");}}><strong>{c.name||c.phone}</strong><span>{[c.phone,c.document_id].filter(Boolean).join(" · ")}</span></button>)}{customer&&<div className="success"><strong>{customer.name||customer.phone}</strong><div className="small">Cliente seleccionado para Crédito LC</div></div>}<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>setCreating(v=>!v)}>{creating?"Ocultar cliente nuevo":"+ Cliente nuevo"}</button>{creating&&<div className="grid grid-2"><label><span className="label">Nombre *</span><input className="input" value={name} onChange={e=>setName(e.target.value)}/></label><label><span className="label">Teléfono</span><input className="input" inputMode="tel" value={phone} onChange={e=>setPhone(e.target.value)}/></label><button type="button" className="btn" disabled={busy||!name.trim()} onClick={createCustomer}>Guardar cliente</button></div>}</div><div><span className="label">Cómo recibiste el abono</span><div className="grid grid-2">{DIRECT_PAYMENT_METHODS.map(([value,label])=><button type="button" key={value} className={method===value?"btn btn-primary":"btn"} onClick={()=>setMethod(value)}>{method===value?`✓ ${label}`:label}</button>)}</div></div><label><span className="label">Abono recibido · {currency}</span><input className="input" type="number" min="0.01" step="0.01" max={maxAmount} value={amount||""} onChange={e=>setAmount(Number(e.target.value))}/></label>{method!=="CASH_USD"&&method!=="CASH_VES"&&<label><span className="label">{method.startsWith("TRANSFER")?"Últimos 4 de referencia · obligatorio":"Referencia · opcional"}</span><input className="input" value={reference} onChange={e=>setReference(e.target.value)}/></label>}<label><span className="label">Fecha prometida de pago · opcional</span><input className="input" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label><div className="grid grid-2"><div className="card"><div className="muted small">ABONO HOY</div><strong>{fmtVes(paidVes)}</strong></div><div className="card" style={{borderColor:"rgba(255,106,26,.65)"}}><div className="muted small">SALDO CRÉDITO LC</div><strong>{fmtVes(pendingVes)}</strong><div className="muted small">{fmtRef(pendingRef)}</div></div></div><label className="row"><input type="checkbox" checked={received} onChange={e=>setReceived(e.target.checked)}/> Confirmo que recibí este abono.</label>{error&&<div className="error">{error}</div>}<button className="btn btn-primary btn-block" disabled={busy||!customer||!received||amount<=0||pendingVes<=1} onClick={confirm}>{busy?"Registrando…":"Registrar abono y cerrar con Crédito LC"}</button></div></div>;
}


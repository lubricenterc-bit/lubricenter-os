"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { OsIcon } from "@/components/os-icon";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import {
  normalizeCatalogProduct, normalizeCatalogSync, normalizeCatalogSearch, catalogIsFresh,
  type CatalogProduct, type CatalogSync
} from "@/lib/catalog";
import {
  QUOTE_DRAFT_KEY, QUOTE_HANDOFF_KEY, OIL_TO_QUOTE_KEY, DEFAULT_SHARE_CURRENCIES,
  peekQuoteLines, mergeQuoteLines, resolvedQuote, quoteCustomerMessage, takeQuoteLines,
  storeQuoteLines, type SalesQuoteLine, type ShareCurrencies, type SalesQuoteMoney
} from "@/lib/sales-quote";

const money = (value:number|null, type:"ves"|"usd") =>
  value == null ? "—" : type === "ves" ? fmtVes(value) : fmtRef(value);

function ProductPhoto({ item, compact = false }: { item: CatalogProduct; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(()=>setFailed(false),[item.image_url]);
  return <span className={"sq-photo" + (compact ? " is-small" : "")}>
    {item.image_url && !failed
      ? <img src={item.image_url} alt={""} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>
      : <span className="sq-no-photo"><OsIcon name="inventory" size={compact ? 22 : 30}/></span>}
  </span>;
}

function QuoteMoneyDisplay({ value, prominent = false }: { value:SalesQuoteMoney; prominent?:boolean }) {
  return <div className={"sq-money" + (prominent ? " is-prominent" : "")}>
    <span><small>Bolívares</small><strong>{money(value.ves,"ves")}</strong></span>
    <span><small>Dólares BCV</small><strong>{money(value.bcv,"usd")}</strong></span>
    <span><small>Divisas</small><strong>{money(value.divisas,"usd")}</strong></span>
  </div>;
}

export default function GeneralQuotePage() {
  const router=useRouter();
  const cartRef=useRef<HTMLElement>(null);
  const initialized=useRef(false);
  const [catalog,setCatalog]=useState<CatalogProduct[]>([]);
  const [sync,setSync]=useState<CatalogSync|null>(null);
  const [loading,setLoading]=useState(true);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [query,setQuery]=useState("");
  const [category,setCategory]=useState("TODAS");
  const [lines,setLines]=useState<SalesQuoteLine[]>([]);
  const [manualOpen,setManualOpen]=useState(false);
  const [manualDescription,setManualDescription]=useState("");
  const [manualPrice,setManualPrice]=useState("");
  const [manualQuantity,setManualQuantity]=useState("1");
  const [currencies,setCurrencies]=useState<ShareCurrencies>({...DEFAULT_SHARE_CURRENCIES});
  const [copied,setCopied]=useState(false);

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    const [catalogRes,rateRes]=await Promise.all([
      supabase.rpc("get_catalog_snapshot"),
      supabase.rpc("get_pricing_sync_status")
    ]);
    if (catalogRes.error || rateRes.error) {
      setError(catalogRes.error?.message || rateRes.error?.message || "No se pudo cargar el catálogo.");
      setLoading(false);
      return;
    }
    const items:CatalogProduct[]=(catalogRes.data||[])
      .map((x:Record<string,unknown>)=>normalizeCatalogProduct(x))
      .filter((x:CatalogProduct)=>x.id && x.name && x.active && x.available);
    setCatalog(items);
    const entry=Array.isArray(rateRes.data)?rateRes.data[0]:rateRes.data;
    setSync(normalizeCatalogSync(entry||null));
    setLoading(false);
  },[]);

  useEffect(()=>{
    void load();
    const onPricing=()=>void load();
    window.addEventListener("lubricenter:pricing-updated",onPricing);
    return ()=>window.removeEventListener("lubricenter:pricing-updated",onPricing);
  },[load]);

  useEffect(()=>{
    if (loading || initialized.current || !catalog.length) return;
    initialized.current=true;
    const draft=peekQuoteLines(QUOTE_DRAFT_KEY);
    const imported=takeQuoteLines(OIL_TO_QUOTE_KEY);
    let next=mergeQuoteLines(draft,imported);
    const url=new URL(window.location.href);
    const productId=url.searchParams.get("add");
    if (productId) {
      const item=catalog.find(x=>x.id===productId);
      if (item) {
        next=mergeQuoteLines(next,[{kind:"CATALOG",id:item.id,productId:item.id,quantity:1}]);
        setNotice("Agregamos "+item.name+" desde el catálogo.");
      }
      url.searchParams.delete("add");
      window.history.replaceState(window.history.state,"",url.pathname+url.search+url.hash);
    }
    if (imported.length) {
      setNotice("Tu selección de aceites ya está en la cotización. Puedes añadir más productos.");
      url.searchParams.delete("from");
      window.history.replaceState(window.history.state,"",url.pathname+url.search+url.hash);
    }
    setLines(next);
    setReady(true);
  },[loading,catalog]);

  useEffect(()=>{
    if(ready)storeQuoteLines(QUOTE_DRAFT_KEY,lines);
  },[lines,ready]);

  const categories=useMemo(()=>[...new Set(catalog.map(x=>x.category||"Sin categoría"))]
    .sort((a,b)=>a.localeCompare(b,"es-VE")), [catalog]);

  const products=useMemo(()=>{
    const term=normalizeCatalogSearch(query);
    return catalog.filter(item=>
      (category==="TODAS" || (item.category||"Sin categoría")===category) &&
      (!term || normalizeCatalogSearch(item.name+" "+(item.category||"")).includes(term))
    ).sort((a,b)=>a.name.localeCompare(b.name,"es-VE",{numeric:true}));
  },[catalog,query,category]);

  const quote=useMemo(()=>resolvedQuote(lines,catalog,sync),[lines,catalog,sync]);
  const fresh=catalogIsFresh(sync);
  const shareText=quote.missing.length===0 && ready
    ?quoteCustomerMessage(quote.lines,quote.total,currencies):"";
  const selectedCurrencies=Object.values(currencies).some(Boolean);
  const allValid=ready && !loading && !error && quote.lines.length>0 && quote.missing.length===0
    && quote.lines.length===lines.length
    && quote.lines.every(row=>row.subtotal.bcv!=null && row.subtotal.ves!=null);

  function addProduct(item:CatalogProduct) {
    setLines(current=>mergeQuoteLines(current,[{kind:"CATALOG",id:item.id,productId:item.id,quantity:1}]));
    setNotice("Agregado: "+item.name);
    setCopied(false);
  }

  function removeLine(id:string) {
    setLines(current=>current.filter(x=>x.id!==id));
    setCopied(false);
  }

  function updateQuantity(id:string, quantity:number) {
    if(!Number.isFinite(quantity)||quantity<=0||quantity>1000)return;
    setLines(current=>current.map(item=>item.id===id ? {...item,quantity} : item));
    setCopied(false);
  }

  function addManual() {
    const description=manualDescription.trim();
    const unitRef=Number(manualPrice);
    const quantity=Number(manualQuantity);
    if(!description || description.length>200 || !Number.isFinite(unitRef) ||
      unitRef<=0 || unitRef>100000 || !Number.isFinite(quantity) || quantity<=0 || quantity>1000){
      setError("Indica la descripción, un precio unitario BCV válido y una cantidad mayor a cero.");
      return;
    }
    setError("");
    setLines(current=>mergeQuoteLines(current,[{
      kind:"MANUAL",id:crypto.randomUUID(),description,quantity,unitRef
    }]));
    setManualDescription("");setManualPrice("");setManualQuantity("1");setManualOpen(false);
    setNotice("Servicio o concepto añadido a la cotización.");
  }

  function goToCheckout(flow:"sale"|"order") {
    if(!allValid){setError("Revisa los productos y precios antes de continuar.");return;}
    if(!storeQuoteLines(QUOTE_HANDOFF_KEY,lines)){
      setError("Tu navegador bloqueó el carrito temporal; no pudimos transferir la cotización.");
      return;
    }
    // Venta rápida es el único módulo autorizado para validar stock, cobros y crear órdenes.
    router.push("/quick-sale?from=quote&flow="+flow);
  }

  async function copyMessage() {
    if(!shareText)return;
    try{await navigator.clipboard.writeText(shareText);setCopied(true);}
    catch{setError("No se pudo copiar el mensaje; puedes enviarlo por WhatsApp.");}
  }

  return <main className="container sq">
    <header className="sq-heading">
      <div>
        <div className="sq-kicker"><OsIcon name="receipt" size={17}/> VENTAS / COTIZACIONES</div>
        <h1>Cotiza cualquier producto, en segundos.</h1>
        <p>Busca en tu catálogo, combina artículos o servicios y continúa directamente a la venta u orden.</p>
      </div>
      <div className="sq-heading-actions">
        <Link href="/quote/oil" className="sq-button sq-oil-shortcut"><OsIcon name="car" size={18}/> Comparar aceites</Link>
        <Link href="/catalog" className="sq-button"><OsIcon name="inventory" size={18}/> Catálogo</Link>
      </div>
    </header>

    <section className="sq-flow" aria-label="Pasos de atención">
      <span className="is-current"><b>1</b> Buscar y agregar</span><OsIcon name="right" size={16}/>
      <span><b>2</b> Cotizar o compartir</span><OsIcon name="right" size={16}/>
      <span><b>3</b> Cobrar o crear orden</span>
    </section>

    {error && <div className="error" role="alert">{error} <button className="sq-text-button" onClick={()=>{setError("");void load();}}>Reintentar</button></div>}
    {notice && <div className="sq-notice" role="status"><OsIcon name="check" size={17}/>{notice}<button aria-label="Cerrar aviso" onClick={()=>setNotice("")}><OsIcon name="close" size={16}/></button></div>}

    <div className="sq-layout">
      <section className="sq-products" aria-label="Buscar productos">
        <div className="sq-section-heading">
          <div><h2>Productos del catálogo</h2><p>{loading?"Cargando precios…":products.length+" opciones para cotizar"}</p></div>
          <button className="sq-refresh" disabled={loading} onClick={()=>void load()}><OsIcon name="refresh" size={16}/> Actualizar</button>
        </div>
        <div className="sq-search-section">
          <label className="sq-search"><OsIcon name="search" size={20}/>
            <input type="search" autoComplete="off" value={query}
              onChange={e=>setQuery(e.target.value)}
              placeholder="Busca marca, aceite, filtro, repuesto, servicio…"
              aria-label="Buscar en el catálogo"/>
          </label>
          <label className="sq-category-select"><span>Categoría</span>
            <select value={category} onChange={e=>setCategory(e.target.value)}>
              <option value="TODAS">Todas</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <div className="sq-category-pills" aria-label="Categorías rápidas">
          <button className={category==="TODAS"?"is-active":""} onClick={()=>setCategory("TODAS")}>Todos</button>
          {categories.slice(0,7).map(c=><button key={c} className={category===c?"is-active":""}
            onClick={()=>setCategory(c)}>{c}</button>)}
        </div>

        {loading && !catalog.length && <div className="sq-loading">Consultando el catálogo y las tasas de venta…</div>}
        {!loading && products.length===0 && <div className="sq-empty">
          <OsIcon name="search" size={30}/>
          <strong>No encontramos productos</strong>
          <p>Prueba otra categoría o término. También puedes añadir un trabajo o servicio manual a tu cotización.</p>
        </div>}
        <div className="sq-product-grid">
          {products.map(product=>{
            const already=lines.some(line=>line.kind==="CATALOG"&&line.productId===product.id);
            return <article className={"sq-product-card"+(already?" is-added":"")} key={product.id}>
              <ProductPhoto item={product}/>
              <div className="sq-product-info">
                <span className="sq-product-category">{product.category||"Sin categoría"}</span>
                <h3>{product.name}</h3>
                <div className="sq-product-price">
                  <strong>{money(product.current_ref_bcv,"usd")} <small>BCV</small></strong>
                  <span>{money(product.current_price_ves,"ves")}</span>
                </div>
                <button type="button" className="sq-add-button" onClick={()=>addProduct(product)}
                  disabled={product.current_ref_bcv==null || product.current_price_ves==null || product.cash_usd_base_price==null}>
                  <OsIcon name={already?"plus":"plus"} size={17}/>
                  {already?"Agregar otra unidad":"Agregar a la cotización"}
                </button>
              </div>
            </article>;
          })}
        </div>
        <div className="sq-manual">
          <button type="button" aria-expanded={manualOpen} className="sq-manual-trigger"
            onClick={()=>setManualOpen(v=>!v)}>
            <OsIcon name="plus" size={19}/> Agregar un servicio o concepto manual
            <OsIcon name="down" size={17}/>
          </button>
          {manualOpen&&<div className="sq-manual-fields">
            <label>Descripción<input value={manualDescription} onChange={e=>setManualDescription(e.target.value)}
              placeholder="Ej. Servicio de mantenimiento"/></label>
            <label>Precio unitario ($ BCV)<input type="number" min="0.01" step="0.01" value={manualPrice}
              onChange={e=>setManualPrice(e.target.value)} placeholder="0,00"/></label>
            <label>Cantidad<input type="number" min="0.01" step="0.01" value={manualQuantity}
              onChange={e=>setManualQuantity(e.target.value)}/></label>
            <button className="sq-button is-primary" type="button" onClick={addManual}>Agregar concepto</button>
          </div>}
        </div>
      </section>

      <aside className="sq-basket" aria-label="Cotización actual" ref={cartRef}>
        <div className="sq-basket-heading">
          <div><span className="sq-kicker">MOSTRADOR / CLIENTE</span><h2>Cotización actual</h2></div>
          <span className="sq-count">{lines.length} {lines.length===1?"artículo":"artículos"}</span>
        </div>
        {!ready || !lines.length ? <div className="sq-basket-empty">
          <OsIcon name="inventory" size={36}/><strong>Tu cotización comienza aquí</strong>
          <p>Selecciona productos del catálogo. Se agregarán con sus precios y podrás compartirlos o cobrarlos.</p>
        </div> : <div className="sq-basket-lines">
          {quote.lines.map(row=><div className="sq-basket-line" key={row.item.id}>
            <div className="sq-basket-line-title">
              <strong>{row.name}</strong>
              <button title={"Eliminar "+row.name} aria-label={"Eliminar "+row.name}
                onClick={()=>removeLine(row.item.id)}><OsIcon name="close" size={16}/></button>
            </div>
            <div className="sq-basket-line-controls">
              <div className="sq-quantity">
                <button onClick={()=>row.item.quantity<=1?removeLine(row.item.id):
                  updateQuantity(row.item.id,Number((row.item.quantity-1).toFixed(2)))}
                  aria-label={"Restar unidad de "+row.name}>−</button>
                <input aria-label={"Cantidad de "+row.name} type="number" min="0.01" max="1000" step="0.01"
                  value={row.item.quantity} onChange={e=>updateQuantity(row.item.id,Number(e.target.value))}/>
                <button onClick={()=>updateQuantity(row.item.id,Number((row.item.quantity+1).toFixed(2)))}
                  aria-label={"Agregar unidad de "+row.name}>+</button>
              </div>
              <strong>{money(row.subtotal.bcv,"usd")} <small>BCV</small></strong>
            </div>
          </div>)}
          {quote.missing.length>0 && <div className="sq-warning" role="alert">{quote.missing.join(" ")}</div>}
        </div>}
        <div className="sq-basket-totals">
          <span>Total estimado</span>
          <QuoteMoneyDisplay value={quote.total} prominent/>
          {!fresh && <small>Las tasas o precios pueden estar desactualizados. Confirma la actualización antes de cobrar.</small>}
        </div>
        <div className="sq-checkout-actions">
          <button className="sq-button is-primary" disabled={!allValid} onClick={()=>goToCheckout("sale")}>
            <OsIcon name="sale" size={18}/> Pasar a venta rápida <OsIcon name="right" size={16}/>
          </button>
          <button className="sq-button" disabled={!allValid} onClick={()=>goToCheckout("order")}>
            <OsIcon name="car" size={18}/> Continuar como orden <OsIcon name="right" size={16}/>
          </button>
          <p>Los artículos y cantidades pasarán al carrito. El cobro o creación de la orden se confirmará allí, sin registrar nada automáticamente.</p>
        </div>
        <div className="sq-share">
          <h3>Compartir con el cliente</h3>
          <div className="sq-share-options">
            {([["ves","Bolívares"],["bcv","Dólares BCV"],["divisas","Divisas"]] as const).map(([key,label])=>
              <label key={key}><input type="checkbox" checked={currencies[key]}
                onChange={()=>{setCurrencies(v=>({...v,[key]:!v[key]}));setCopied(false);}}/>{label}</label>)}
          </div>
          <div className="sq-share-preview"><pre aria-live="polite">{shareText||"Agrega productos y selecciona una moneda para generar un mensaje."}</pre></div>
          <div className="sq-share-actions">
            <button className="sq-button" onClick={()=>void copyMessage()} disabled={!shareText}>
              <OsIcon name={copied?"check":"receipt"} size={17}/>{copied?"Copiado":"Copiar mensaje"}
            </button>
            <a href={shareText?"https://wa.me/?text="+encodeURIComponent(shareText):undefined}
              aria-disabled={!shareText} onClick={e=>{if(!shareText)e.preventDefault();}}
              target="_blank" rel="noopener noreferrer" className={"sq-button is-whatsapp"+(shareText?"":" is-disabled")}>
              <OsIcon name="arrow" size={17}/> WhatsApp
            </a>
          </div>
        </div>
      </aside>
    </div>
    {lines.length>0 && <button className="sq-mobile-cart" onClick={()=>cartRef.current?.scrollIntoView({behavior:"smooth",block:"start"})}>
      <OsIcon name="receipt" size={19}/> Ver cotización · {lines.length} {lines.length===1?"producto":"productos"}
      <strong>{money(quote.total.bcv,"usd")} BCV</strong>
    </button>}
  </main>;
}

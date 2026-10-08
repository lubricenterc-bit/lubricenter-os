"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { OIL_TO_QUOTE_KEY, storeQuoteLines, type SalesQuoteLine } from "@/lib/sales-quote";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { OsIcon } from "@/components/os-icon";
import {
  catalogIsFresh, formatCatalogDate, normalizeCatalogProduct, normalizeCatalogSync,
  type CatalogProduct, type CatalogSync
} from "@/lib/catalog";
import {
  analyzeOil, availableViscosities, normalizeQuoteFilterProducts, quoteAllOils,
  quoteWhatsAppText, validQuoteRequest, DEFAULT_QUOTE_SHARE_CURRENCIES,
  type OilQuote, type OilTechnology, type QuoteRequest, type QuoteMoney, type QuoteShareCurrencies,
} from "@/lib/oil-quote";

function currency(value: number | null, kind: "usd" | "ves") {
  return value === null ? "—" : kind === "ves" ? fmtVes(value) : fmtRef(value);
}

function QuoteImage({ product }: { product: CatalogProduct }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [product.image_url]);
  return <span className="oq-photo">
    {product.image_url && !failed ?
      <img src={product.image_url} alt={""} loading="lazy" decoding="async" onError={() => setFailed(true)}/> :
      <OsIcon name="inventory" size={26}/>}
  </span>;
}

const technologyChoices: { key: OilTechnology; label: string; short: string }[] = [
  { key: "mineral", label: "Mineral", short: "Mineral" },
  { key: "semi", label: "Semisintético", short: "Semi" },
  { key: "full", label: "Full sintético", short: "Full" }
];

function QuoteFigure({ values }: { values: QuoteMoney }) {
  return <div className="oq-result-money">
    <span><small>DIVISAS</small><strong>{currency(values.divisas, "usd")}</strong></span>
    <span><small>$ BCV</small><strong>{currency(values.bcv, "usd")}</strong></span>
    <span><small>BOLÍVARES</small><strong>{currency(values.ves, "ves")}</strong></span>
  </div>;
}

export default function OilQuotePage() {
  const router = useRouter();
  const [transferError, setTransferError] = useState("");
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [sync, setSync] = useState<CatalogSync | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viscosity, setViscosity] = useState("20W50");
  const [technology, setTechnology] = useState<OilTechnology>("semi");
  const [liters, setLiters] = useState("4");
  const [filterMode, setFilterMode] = useState("manual");
  const [manualFilterUsd, setManualFilterUsd] = useState("5");
  const [laborUsd, setLaborUsd] = useState("0");
  const [freeLaborPromotion, setFreeLaborPromotion] = useState(false);
  const [search, setSearch] = useState("");
  // null = todas las alternativas, [] = ninguna, lista = selección del vendedor.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [copyResult, setCopyResult] = useState<"idle" | "copied" | "error">("idle");
  const [shareCurrencies, setShareCurrencies] = useState<QuoteShareCurrencies>({ ...DEFAULT_QUOTE_SHARE_CURRENCIES });

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const [productsRes, ratesRes] = await Promise.all([
      supabase.rpc("get_catalog_snapshot"),
      supabase.rpc("get_pricing_sync_status")
    ]);
    if (productsRes.error || ratesRes.error) {
      setError(productsRes.error?.message || ratesRes.error?.message || "No se pudo cargar Notion.");
      setLoading(false);
      return;
    }
    const items: CatalogProduct[] = (productsRes.data || [])
      .map((item: Record<string, unknown>) => normalizeCatalogProduct(item))
      .filter((item: CatalogProduct) => item.id && item.name);
    setCatalog(items);
    const row = Array.isArray(ratesRes.data) ? ratesRes.data[0] : ratesRes.data;
    setSync(normalizeCatalogSync(row ?? null));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const onPricingUpdated = () => void load();
    window.addEventListener("lubricenter:pricing-updated", onPricingUpdated);
    return () => window.removeEventListener("lubricenter:pricing-updated", onPricingUpdated);
  }, [load]);

  const viscosities = useMemo(() => availableViscosities(catalog), [catalog]);
  const filters = useMemo(() => normalizeQuoteFilterProducts(catalog), [catalog]);
  const catalogFilter = filters.find(item => item.id === filterMode);

  const quantity = liters.trim() === "" ? NaN : Number(liters);
  const filterUsd = manualFilterUsd.trim() === "" ? NaN : Number(manualFilterUsd);
  const labor = laborUsd.trim() === "" ? NaN : Number(laborUsd);
  const filterChoice: QuoteRequest["filter"] = filterMode === "none" ? { mode:"none" }
    : catalogFilter ? { mode:"catalog", product:catalogFilter }
    : { mode:"manual", manualUsd:filterUsd };
  const request: QuoteRequest = {
    viscosity, technology, liters:quantity, filter:filterChoice, laborUsd:labor,
    freeLaborPromotion, rates:sync
  };
  const valid = validQuoteRequest(request);
  const quotes = useMemo(() => quoteAllOils(catalog, request), [
    catalog, viscosity, technology, quantity, filterMode, catalogFilter,
    filterUsd, labor, freeLaborPromotion, sync
  ]);

  const normalizedTerm = search.trim().toLocaleLowerCase("es-VE");
  const displayed = quotes.filter(quote =>
    !normalizedTerm || (quote.oil.brand + " " + quote.oil.product.name)
      .toLocaleLowerCase("es-VE").includes(normalizedTerm));

  const chosen = quotes.filter(quote => selectedIds === null || selectedIds.includes(quote.oil.product.id));
  const selectedVisibleCount = displayed.filter(quote =>
    selectedIds === null || selectedIds.includes(quote.oil.product.id)).length;

  const unclassified = catalog.map(analyzeOil).filter(
    (oil): oil is NonNullable<typeof oil> =>
      Boolean(oil && oil.viscosity === viscosity && (!oil.technology || oil.volumeLiters === null))
  );
  const inconsistent = quotes.filter(quote => quote.oil.warnings.length > 0);
  const fresh = catalogIsFresh(sync);
  const syncedAt = formatCatalogDate(sync?.catalogSyncedAt ?? null);
  const shareText = valid
    ? quoteWhatsAppText(chosen, request, shareCurrencies)
    : "";
  const hasShareCurrency = Object.values(shareCurrencies).some(Boolean);
  const selectedQuoteNeedsRate = hasShareCurrency && chosen.some(quote =>
    (["ves", "bcv", "divisas"] as const).some(key => shareCurrencies[key] && quote.total[key] == null)
  );

  function toggleShareCurrency(currency: keyof QuoteShareCurrencies) {
    setShareCurrencies(current => ({ ...current, [currency]: !current[currency] }));
    setCopyResult("idle");
  }

  function updateQuoteOptions() {
    setSelectedIds(null);
    setCopyResult("idle");
  }

  function toggleQuote(id: string) {
    setSelectedIds(current => {
      const all = current === null ? quotes.map(item => item.oil.product.id) : current;
      return all.includes(id) ? all.filter(x => x !== id) : [...all, id];
    });
    setCopyResult("idle");
  }

  function addOilToGeneralQuote(quote: OilQuote) {
    setTransferError("");
    if (!quote.oil.volumeLiters || quote.total.bcv === null) {
      setTransferError("Faltan precios para convertir esta opción en una cotización general.");
      return;
    }
    const selected: SalesQuoteLine[] = [{
      kind: "CATALOG", id: quote.oil.product.id, productId: quote.oil.product.id,
      quantity: Number((request.liters / quote.oil.volumeLiters).toFixed(4))
    }];
    if (filterChoice.mode === "catalog") {
      selected.push({kind:"CATALOG",id:filterChoice.product.id,productId:filterChoice.product.id,quantity:1});
    } else if (filterChoice.mode === "manual" && quote.filterSubtotal.bcv !== null && quote.filterSubtotal.bcv > 0) {
      selected.push({kind:"MANUAL",id:"filtro-"+quote.oil.product.id,
        description:"Filtro de aceite",quantity:1,unitRef:quote.filterSubtotal.bcv});
    }
    if (quote.laborSubtotal.bcv !== null && quote.laborSubtotal.bcv > 0) {
      selected.push({kind:"MANUAL",id:"mano-obra-"+quote.oil.product.id,
        description:"Mano de obra del cambio de aceite",quantity:1,unitRef:quote.laborSubtotal.bcv});
    }
    if (!storeQuoteLines(OIL_TO_QUOTE_KEY,selected)) {
      setTransferError("No se pudo transferir esta selección. Activa el almacenamiento de sesión del navegador.");
      return;
    }
    router.push("/quote?from=oil");
  }

  async function copyQuote() {
    if (!shareText) return;
    try {
      await navigator.clipboard.writeText(shareText);
      setCopyResult("copied");
    } catch {
      setCopyResult("error");
    }
  }

  const missingRateForManual = valid && filterChoice.mode === "manual" && filterUsd > 0 &&
    (!sync?.operative || !sync?.bcv);

  return <main className="container oq">
    <div className="oq-heading">
      <div>
        <p className="oq-kicker"><OsIcon name="receipt" size={15}/> VENTAS / HERRAMIENTAS</p>
        <h1>Comparador de cambios de aceite</h1>
        <p>Una sola búsqueda, todas las marcas compatibles. Precios de Notion con filtro y mano de obra separados.</p>
      </div>
      <div className="oq-heading-actions"><Link href="/quote" className="oq-button"><OsIcon name="right" size={17}/> Cotizador general</Link><button className="oq-button oq-reload" onClick={() => void load()} disabled={loading}>
        <OsIcon name="refresh" size={17}/>{loading ? "Actualizando…" : "Actualizar precios"}
      </button></div>
    </div>

    <div className={"oq-status" + (fresh ? " is-fresh" : " is-stale")} role="status">
      <OsIcon name={fresh ? "check" : "alert"} size={17}/>
      <div>
        <strong>{fresh ? "Precios sincronizados con Notion" : "Verifica las tasas antes de enviar una cotización"}</strong>
        <small>{syncedAt} · BCV {sync?.bcv ? fmtVes(sync.bcv) : "—"} · Operativa {sync?.operative ? fmtVes(sync.operative) : "—"}</small>
      </div>
      <Link href="/catalog">Ver catálogo <OsIcon name="arrow" size={15}/></Link>
    </div>

    {transferError && <div className="error" role="alert">{transferError}</div>}
    {error && <div className="error" role="alert">No pudimos cargar los productos: {error} <button onClick={() => void load()} className="oq-inline-action">Reintentar</button></div>}

    <div className="oq-layout">
      <section className="oq-form" aria-label="Parámetros de cotización">
        <div className="oq-form-title">
          <span className="oq-form-icon"><OsIcon name="car" size={21}/></span>
          <div><strong>Datos del vehículo</strong><small>Configura una vez y compara todas las marcas</small></div>
        </div>
        <label className="oq-field">
          <span>Viscosidad del aceite</span>
          <select value={viscosity} onChange={e => { setViscosity(e.target.value); updateQuoteOptions(); }}>
            {viscosities.length ? viscosities.map(name => <option key={name} value={name}>{name}</option>)
              : <option value="20W50">20W50</option>}
          </select>
        </label>
        <fieldset className="oq-type-fieldset">
          <legend>Tecnología</legend>
          <div className="oq-type-segments">
            {technologyChoices.map(option => <button key={option.key} type="button"
              aria-pressed={technology === option.key}
              className={technology === option.key ? "is-active" : ""}
              onClick={() => {setTechnology(option.key);updateQuoteOptions();}}>
              {option.label}</button>)}
          </div>
        </fieldset>
        <label className="oq-field">
          <span>Cantidad necesaria · litros</span>
          <input type="number" min="0.5" max="30" step="0.5" inputMode="decimal" value={liters}
            onChange={e=>{setLiters(e.target.value);updateQuoteOptions();}}/>
          <small>Un galón se calcula como 4 litros; los demás aceites por litro.</small>
        </label>
        <div className="oq-field-divider"/>
        <div className="oq-form-subtitle"><OsIcon name="inventory" size={17}/> Filtro de aceite</div>
        <label className="oq-field">
          <span>Precio del filtro</span>
          <select value={filterMode} onChange={e=>{setFilterMode(e.target.value);updateQuoteOptions();}}>
            <option value="manual">Importe manual · estimado</option>
            <option value="none">Sin filtro</option>
            {filters.map(filter => <option key={filter.id} value={filter.id}>{filter.name} · {currency(filter.cash_usd_base_price,"usd")}</option>)}
          </select>
        </label>
        {filterChoice.mode === "manual" && <label className="oq-field">
          <span>Importe estimado del filtro · divisas</span>
          <div className="oq-money-input"><span>$</span><input type="number" min="0" max="1000" step="0.5"
            inputMode="decimal" value={manualFilterUsd} onChange={e=>{setManualFilterUsd(e.target.value);updateQuoteOptions();}} /></div>
          <small>Ajusta el precio según el filtro compatible con el vehículo; $5 es solo un valor inicial editable.</small>
        </label>}
        <div className="oq-field-divider"/>
        <div className="oq-form-subtitle"><OsIcon name="cash" size={17}/> Mano de obra</div>
        <label className="oq-field">
          <span>Costo de mano de obra · divisas</span>
          <div className="oq-money-input"><span>$</span><input type="number" min="0" max="1000" step="0.5"
            inputMode="decimal" value={laborUsd} onChange={e=>{setLaborUsd(e.target.value);updateQuoteOptions();}} /></div>
          <small>Sin cargo por defecto. Se cotiza por separado cuando corresponda.</small>
        </label>
        <label className="oq-promo">
          <input type="checkbox" checked={freeLaborPromotion} onChange={e=>{setFreeLaborPromotion(e.target.checked);updateQuoteOptions();}}/>
          <span><strong>Promoción: mano de obra gratis</strong><small>Si asignaste un importe, se descuenta completo.</small></span>
        </label>
        {!valid && <div className="oq-field-error" role="alert">Ingresa una cantidad entre 0,5 y 30 litros, y costos entre $0 y $1.000.</div>}
        {missingRateForManual && <div className="oq-field-error" role="alert">Faltan tasas para convertir importes manuales a bolívares y $ BCV.</div>}
        <div className="oq-form-end">
          <OsIcon name="shield" size={17}/> Cotización orientativa. Verificar stock y compatibilidad del filtro antes de vender.
        </div>
      </section>

      <section className="oq-results" aria-label="Resultados de comparación">
        <div className="oq-results-heading">
          <div>
            <p className="oq-kicker">COMPARACIÓN INMEDIATA</p>
            <h2>{viscosity} · {technologyChoices.find(t=>t.key===technology)?.label}</h2>
            <span>{loading && !catalog.length ? "Cargando…" :
              quotes.length + " opciones de aceite " + (quotes.length ? "ordenadas por menor precio" : "compatibles")}</span>
          </div>
          <div className="oq-results-pill"><OsIcon name="clock" size={15}/> Precios de Notion</div>
        </div>
        <div className="oq-results-tools">
          <label className="oq-results-search"><OsIcon name="search" size={17}/>
            <input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filtrar por marca…" aria-label="Filtrar por marca"/>
          </label>
          <button onClick={()=>{setSelectedIds(null);setCopyResult("idle");}} className="oq-mini-action">Todas</button>
          <button onClick={()=>{setSelectedIds(quotes.slice(0,3).map(q=>q.oil.product.id));setCopyResult("idle");}} className="oq-mini-action">3 económicas</button>
        </div>

        {loading && !catalog.length && <div className="oq-empty"><OsIcon name="refresh" size={25}/><strong>Buscando productos en Notion…</strong></div>}

        {!loading && valid && quotes.length===0 && <div className="oq-empty">
          <OsIcon name="search" size={30}/>
          <strong>No hay opciones con esta combinación</strong>
          <p>Prueba otra viscosidad o tecnología. Solo cotizamos automáticamente aceites cuya clasificación y precios están claros en Notion.</p>
        </div>}

        {quotes.length > 0 && displayed.length===0 && <div className="oq-empty"><strong>No encontramos esa marca</strong><p>Intenta otra búsqueda.</p></div>}

        {displayed.length > 0 && <div className="oq-list">
          <div className="oq-list-head">
            <span>ACEITE Y MARCA</span><span>TOTAL DIVISAS</span><span>TOTAL $ BCV</span><span>TOTAL BOLÍVARES</span>
          </div>
          {displayed.map((quote,index) => {
            const p = quote.oil.product;
            const checked = selectedIds === null || selectedIds.includes(p.id);
            return <article className={"oq-option" + (checked ? " is-chosen" : "")} key={p.id}>
              <label className="oq-option-select" title="Incluir esta marca en la cotización">
                <input type="checkbox" checked={checked} onChange={()=>toggleQuote(p.id)}
                  aria-label={"Incluir " + p.name}/>
              </label>
              <QuoteImage product={p}/>
              <div className="oq-option-main">
                <div className="oq-option-sub"><span className="oq-brand">{quote.oil.brand}</span>
                  {index === 0 && !search && <span className="oq-cheapest">MENOR PRECIO</span>}
                  {quote.oil.volumeLiters === 4 && <span className="oq-presentation">Galón = 4 L</span>}
                  {quote.oil.warnings.length > 0 && <span className="oq-review" title={quote.oil.warnings.join(" ")}>Revisar categoría</span>}
                </div>
                <strong>{p.name}</strong>
                <small>Aceite: {currency(quote.oilSubtotal.divisas,"usd")} · Filtro: {currency(quote.filterSubtotal.divisas,"usd")} · Mano de obra: {currency(quote.laborSubtotal.divisas,"usd")}</small>
                <button className="oq-add-basket" type="button" onClick={()=>addOilToGeneralQuote(quote)}
                  disabled={quote.total.bcv===null} aria-label={"Agregar "+p.name+" a la cotización general"}>
                  <OsIcon name="plus" size={15}/> Agregar y continuar venta
                </button>
              </div>
              <QuoteFigure values={quote.total}/>
              <details className="oq-breakdown">
                <summary>Ver desglose de precios</summary>
                <div className="oq-breakdown-table">
                  <span>Concepto</span><span>Divisas</span><span>$ BCV</span><span>Bs</span>
                  {[["Aceite · " + quantity + " L",quote.oilSubtotal],["Filtro",quote.filterSubtotal],["Mano de obra" + (freeLaborPromotion ? " (promoción)" : ""),quote.laborSubtotal],["Total",quote.total]].map(([label, money]) => {
                    const m = money as QuoteMoney;
                    return <div key={label as string} className="oq-breakdown-line">
                      <span>{label as string}</span><span>{currency(m.divisas,"usd")}</span>
                      <span>{currency(m.bcv,"usd")}</span><span>{currency(m.ves,"ves")}</span>
                    </div>;
                  })}
                </div>
              </details>
            </article>;
          })}
        </div>}

        {unclassified.length>0 && <details className="oq-catalog-attention">
          <summary><OsIcon name="alert" size={16}/> {unclassified.length} productos {viscosity} requieren clasificar la tecnología</summary>
          <p>No los mezclamos con mineral, semi o full para evitar errores. Corrige sus nombres en Notion si deben aparecer.</p>
          <ul>{unclassified.map(item => <li key={item.product.id}>{item.product.name}</li>)}</ul>
        </details>}
        {inconsistent.length>0 && <p className="oq-small-warning"><OsIcon name="alert" size={14}/>
          {inconsistent.length} opciones tienen categoría contradictoria en Notion. Para ellas se usa la viscosidad escrita en el nombre; revísalas antes de vender.
        </p>}

        {quotes.length>0 && <aside className="oq-share">
          <div className="oq-share-heading">
            <div><p className="oq-kicker">LISTO PARA ENVIAR</p><strong>Comparativa para el cliente</strong><span>{chosen.length} de {quotes.length} alternativas seleccionadas {selectedVisibleCount<displayed.length ? "· ajusta con las casillas" : ""}</span></div>
            <OsIcon name="receipt" size={25}/>
          </div>
          <fieldset className="oq-share-currencies">
            <legend>¿Qué precios quieres incluir en el mensaje?</legend>
            <div className="oq-share-currency-options">
              <label><input type="checkbox" checked={shareCurrencies.ves}
                onChange={() => toggleShareCurrency("ves")}/> <span>Bolívares (Bs)</span></label>
              <label><input type="checkbox" checked={shareCurrencies.bcv}
                onChange={() => toggleShareCurrency("bcv")}/> <span>Dólares BCV</span></label>
              <label><input type="checkbox" checked={shareCurrencies.divisas}
                onChange={() => toggleShareCurrency("divisas")}/> <span>Divisas (USD)</span></label>
            </div>
            <small>Por defecto enviamos Bs y $ BCV. Las divisas solo se incluyen si las activas.</small>
          </fieldset>
          {!hasShareCurrency && <div className="oq-field-error" role="alert">Selecciona al menos una moneda para compartir.</div>}
          {selectedQuoteNeedsRate && <div className="oq-field-error" role="alert">Falta el valor de una moneda seleccionada. Revisa las tasas o elige otra moneda antes de enviar.</div>}
          <div className="oq-share-preview">
            <div className="oq-share-preview-label"><OsIcon name="receipt" size={16}/> Vista previa para el cliente</div>
            <pre aria-live="polite">{shareText || "Selecciona una o más opciones y al menos una moneda para preparar tu mensaje."}</pre>
          </div>
          <div className="oq-share-actions">
            <button className="oq-button is-primary" disabled={!valid || !chosen.length || !shareText}
              onClick={()=>void copyQuote()}><OsIcon name={copyResult==="copied"?"check":"receipt"} size={17}/>
              {copyResult==="copied"?"Cotización copiada":"Copiar cotización"}</button>
            <a className={"oq-button oq-whatsapp" + (!shareText ? " is-disabled" : "")}
              href={shareText ? "https://wa.me/?text=" + encodeURIComponent(shareText) : undefined}
              target="_blank" rel="noopener noreferrer" aria-disabled={!shareText}
              onClick={event=>{if(!shareText)event.preventDefault();}}>
              <OsIcon name="arrow" size={17}/> Compartir por WhatsApp
            </a>
            <Link href="/quote" className="oq-button oq-open-sale">Cotizar otros productos <OsIcon name="right" size={16}/></Link>
          </div>
          {copyResult==="error" && <p role="alert" className="oq-small-warning">Tu navegador bloqueó la copia; usa el botón de WhatsApp o los precios en pantalla.</p>}
          <p>El cliente recibe un mensaje breve y cordial con las opciones y los precios que marques arriba.
            No incluimos datos internos del catálogo, inventario ni tasas de sincronización.
            La venta rápida se abre por separado; todavía no importa automáticamente la cotización.
          </p>
        </aside>}
      </section>
    </div>
  </main>;
}

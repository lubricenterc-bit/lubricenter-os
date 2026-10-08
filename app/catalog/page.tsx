"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes, fmtRate } from "@/lib/format";
import { OsIcon } from "@/components/os-icon";
import {
  catalogIsFresh, filterCatalog, formatCatalogDate, normalizeCatalogProduct,
  normalizeCatalogSync, type CatalogFilters, type CatalogProduct, type CatalogSort,
  type CatalogSync
} from "@/lib/catalog";

const NOTION_CATALOG_URL = "https://app.notion.com/p/206741157d2580748ae8fbed01bfab56";

function Photo({ url, name, large = false }: { url: string | null; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={"lc-catalog-photo" + (large ? " is-large" : "")}>
    {url && !failed
      ? <img src={url} alt={"Fotografía de " + name} loading={large ? "eager" : "lazy"}
          decoding="async" onError={() => setFailed(true)} />
      : <div className="lc-catalog-no-photo">
          <OsIcon name="inventory" size={large ? 48 : 33}/>
          <span>Sin fotografía</span>
        </div>}
  </div>;
}

function Price({ label, amount, currency, prominent = false }: {
  label: string;
  amount: number | null;
  currency: "usd" | "bs";
  prominent?: boolean;
}) {
  return <div className={"lc-catalog-price" + (prominent ? " is-prominent" : "")}>
    <span>{label}</span>
    <strong>{amount === null ? "Sin precio" : currency === "usd" ? fmtRef(amount) : fmtVes(amount)}</strong>
  </div>;
}

function PriceSet({ item, compact = false }: { item: CatalogProduct; compact?: boolean }) {
  return <div className={"lc-catalog-prices" + (compact ? " is-compact" : "")}>
    <Price label="Divisas · USD" amount={item.cash_usd_base_price} currency="usd" prominent />
    <Price label="Dólares BCV" amount={item.current_ref_bcv} currency="usd" />
    <Price label="Bolívares" amount={item.current_price_ves} currency="bs" />
  </div>;
}

function ProductDetail({ item, onClose }: { item: CatalogProduct; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");

  useEffect(() => {
    closeButton.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function copyPrice() {
    const text = [
      item.name,
      "Divisas: " + (item.cash_usd_base_price === null ? "No disponible" : fmtRef(item.cash_usd_base_price)),
      "Dólares BCV: " + (item.current_ref_bcv === null ? "No disponible" : fmtRef(item.current_ref_bcv)),
      "Bolívares: " + (item.current_price_ves === null ? "No disponible" : fmtVes(item.current_price_ves)),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("done");
    } catch {
      setCopyState("error");
    }
  }

  return <div className="lc-catalog-dialog-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="lc-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="lc-catalog-detail-title">
      <button ref={closeButton} className="lc-catalog-dialog-close" onClick={onClose} aria-label="Cerrar detalle"><OsIcon name="close"/></button>
      <Photo url={item.image_url} name={item.name} large/>
      <div className="lc-catalog-dialog-content">
        <div className="lc-catalog-kicker">FICHA DE PRODUCTO · NOTION</div>
        <h2 id="lc-catalog-detail-title">{item.name}</h2>
        <span className="lc-catalog-category">{item.category || "Sin categoría"}</span>
        <div className="lc-catalog-dialog-section">
          <div className="lc-catalog-dialog-section-title">Precios actuales</div>
          <PriceSet item={item}/>
        </div>
        <p className="lc-catalog-dialog-caption">Precios sincronizados desde Notion. El importe en divisas corresponde al campo «Precio» de Notion; los equivalentes en Bs y dólares BCV reflejan las tasas sincronizadas.</p>
        <div className="lc-catalog-dialog-actions">
          <button className="lc-catalog-button is-primary" onClick={() => void copyPrice()}>
            <OsIcon name={copyState === "done" ? "check" : "receipt"} size={17}/>
            {copyState === "done" ? "Precios copiados" : "Copiar precios"}
          </button>
          <Link className="lc-catalog-button" href={"/quote?add="+encodeURIComponent(item.id)}><OsIcon name="plus" size={16}/> Cotizar producto</Link>
          <button className="lc-catalog-button" onClick={onClose}>Volver</button>
        </div>
        {copyState === "error" && <p className="lc-catalog-copy-error" role="alert">Tu navegador impidió copiar. Puedes seleccionar los precios de esta ficha.</p>}
        <div className="lc-catalog-dialog-footer">Última sincronización del producto: {formatCatalogDate(item.catalog_synced_at)}</div>
      </div>
    </section>
  </div>;
}

export default function CatalogPage() {
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [sync, setSync] = useState<CatalogSync | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<CatalogFilters>({
    query: "", category: "TODAS", imagesOnly: false, sort: "name"
  });
  const [view, setView] = useState<"gallery" | "list">("gallery");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = catalog.find(product => product.id === selectedId);
  const closeDetail = () => setSelectedId(null);

  async function load() {
    setLoading(true);
    setError("");
    const [products, current] = await Promise.all([
      supabase.rpc("get_catalog_snapshot"),
      supabase.rpc("get_pricing_sync_status"),
    ]);
    if (products.error || current.error) {
      setError(products.error?.message || current.error?.message || "No fue posible cargar el catálogo de Notion.");
      setLoading(false);
      return;
    }
    const normalized: CatalogProduct[] = (products.data || [])
      .map((item: Record<string, unknown>) => normalizeCatalogProduct(item))
      .filter((item: CatalogProduct) => item.name && item.id);
    setCatalog(normalized);
    const row = Array.isArray(current.data) ? current.data[0] : current.data;
    setSync(normalizeCatalogSync(row ?? null));
    setLoading(false);
  }

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("lubricenter:pricing-updated", refresh);
    return () => window.removeEventListener("lubricenter:pricing-updated", refresh);
  }, []);

  const categories = useMemo(() => Array.from(new Set(
    catalog.map(item => item.category || "Sin categoría")
  )).sort((a, b) => a.localeCompare(b, "es-VE")), [catalog]);

  const filtered = useMemo(() => filterCatalog(catalog, filters), [catalog, filters]);
  const withPhotos = catalog.filter(item => item.image_url).length;
  const upToDate = catalogIsFresh(sync);
  const updateFilter = <K extends keyof CatalogFilters>(name: K, value: CatalogFilters[K]) =>
    setFilters(previous => ({ ...previous, [name]: value }));

  return <main className="container lc-catalog">
    <header className="lc-catalog-heading">
      <div>
        <div className="lc-catalog-kicker"><OsIcon name="inventory" size={15}/> INVENTARIO / CATÁLOGO NOTION</div>
        <h1>Catálogo de productos</h1>
        <p>Consulta productos, fotografías y los tres precios de venta sin salir de Lubricenter OS.</p>
      </div>
      <div className="lc-catalog-heading-actions">
        <Link href="/quote" className="lc-catalog-button is-primary"><OsIcon name="receipt" size={17}/> Abrir cotizador</Link>
        <a href={NOTION_CATALOG_URL} target="_blank" rel="noopener noreferrer" className="lc-catalog-button">
          Ver en Notion <OsIcon name="arrow" size={16}/>
        </a>
        <button className="lc-catalog-button is-primary" onClick={() => void load()} disabled={loading}>
          <OsIcon name="refresh" size={16}/>{loading ? "Cargando…" : "Actualizar catálogo"}
        </button>
      </div>
    </header>

    <section className="lc-catalog-summary" aria-label="Resumen del catálogo">
      <div className="lc-catalog-summary-main">
        <span className="lc-catalog-summary-icon"><OsIcon name="inventory" size={23}/></span>
        <div><span>Productos disponibles</span><strong>{loading && !catalog.length ? "—" : catalog.length}</strong></div>
      </div>
      <div><span>Con fotografía</span><strong>{loading && !catalog.length ? "—" : withPhotos}</strong></div>
      <div><span>Tasa BCV</span><strong>{sync?.bcv ? fmtRate(sync.bcv) : "—"}</strong></div>
      <div><span>Tasa operativa</span><strong>{sync?.operative ? fmtRate(sync.operative) : "—"}</strong></div>
    </section>

    <div className={"lc-catalog-sync" + (upToDate ? " is-fresh" : " is-stale")} role="status">
      <OsIcon name={upToDate ? "check" : "alert"} size={17}/>
      <span><strong>{upToDate ? "Precios sincronizados" : "Verifica la actualización de precios"}</strong>
        <small>Notion · Nuestros Productos · Última sincronización: {formatCatalogDate(sync?.catalogSyncedAt ?? null)}</small></span>
      {!upToDate && <Link href="/settings">Revisar tasas</Link>}
    </div>

    {error && <div className="error" role="alert">
      {error} <button className="lc-catalog-retry" onClick={() => void load()}>Intentar nuevamente</button>
    </div>}

    <section className="lc-catalog-toolbar" aria-label="Buscar y filtrar el catálogo">
      <div className="lc-catalog-controls">
        <label className="lc-catalog-search">
          <OsIcon name="search" size={20}/>
          <input type="search" placeholder="Buscar aceite, filtro, marca o código…"
            value={filters.query} onChange={e => updateFilter("query", e.target.value)}
            aria-label="Buscar productos por nombre o categoría"/>
        </label>
        <label className="lc-catalog-select">
          <span>Categoría</span>
          <select value={filters.category} onChange={e => updateFilter("category", e.target.value)}>
            <option value="TODAS">Todas las categorías</option>
            {categories.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="lc-catalog-select">
          <span>Ordenar</span>
          <select value={filters.sort} onChange={e => updateFilter("sort", e.target.value as CatalogSort)}>
            <option value="name">Nombre A–Z</option>
            <option value="divisas-low">Divisas: menor a mayor</option>
            <option value="divisas-high">Divisas: mayor a menor</option>
            <option value="bcv-low">$ BCV: menor a mayor</option>
            <option value="bcv-high">$ BCV: mayor a menor</option>
          </select>
        </label>
      </div>
      <div className="lc-catalog-toolbar-footer">
        <label className="lc-catalog-toggle"><input type="checkbox" checked={filters.imagesOnly}
          onChange={e => updateFilter("imagesOnly", e.target.checked)}/>
          Solo con fotografías
        </label>
        <div className="lc-catalog-view-toggle" role="group" aria-label="Modo de visualización">
          <button className={view === "gallery" ? "is-selected" : ""}
            aria-pressed={view === "gallery"} onClick={() => setView("gallery")}>
            <OsIcon name="layers" size={17}/> Galería
          </button>
          <button className={view === "list" ? "is-selected" : ""}
            aria-pressed={view === "list"} onClick={() => setView("list")}>
            <OsIcon name="list" size={17}/> Lista
          </button>
        </div>
      </div>
    </section>

    <div className="lc-catalog-count" aria-live="polite">
      <span>{loading && !catalog.length ? "Cargando productos…" : filtered.length + " de " + catalog.length + " productos"}</span>
      <small>Solo productos marcados «Disponible» en Notion. No representa el stock físico.</small>
    </div>

    {loading && !catalog.length && <div className="lc-catalog-grid">
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="lc-catalog-skeleton"><span/><span/><span/><span/></div>)}
    </div>}

    {!loading && !error && !filtered.length && <div className="lc-catalog-empty">
      <OsIcon name="search" size={34}/>
      <strong>{catalog.length ? "No se encontraron productos" : "El catálogo está vacío"}</strong>
      <p>{catalog.length ? "Prueba otra búsqueda o elimina alguno de los filtros." : "Revisa la última sincronización de Notion."}</p>
      {catalog.length > 0 && <button className="lc-catalog-button" onClick={() => setFilters({ query: "", category: "TODAS", imagesOnly: false, sort: "name" })}>Limpiar filtros</button>}
    </div>}

    {filtered.length > 0 && view === "gallery" && <section className="lc-catalog-grid" aria-label="Productos en galería">
      {filtered.map(item => <article className="lc-catalog-card" key={item.id}>
        <button type="button" className="lc-catalog-card-detail" onClick={() => setSelectedId(item.id)}
          aria-label={"Ver detalles de "+item.name}>
          <Photo url={item.image_url} name={item.name}/>
          <div className="lc-catalog-card-body">
            <span className="lc-catalog-category">{item.category || "Sin categoría"}</span>
            <h2>{item.name}</h2>
            <PriceSet item={item}/>
            <span className="lc-catalog-card-open">Ver detalles <OsIcon name="right" size={15}/></span>
          </div>
        </button>
        <Link className="lc-catalog-quote-link" href={"/quote?add="+encodeURIComponent(item.id)}>
          <OsIcon name="plus" size={16}/> Agregar a cotización
        </Link>
      </article>)}
    </section>}

    {filtered.length > 0 && view === "list" && <section className="lc-catalog-list" aria-label="Productos en lista">
      <div className="lc-catalog-list-head"><span>Producto</span><span>Divisas</span><span>Dólares BCV</span><span>Bolívares</span><span>Acción</span></div>
      {filtered.map(item => <div key={item.id} className="lc-catalog-list-entry">
        <button type="button" className="lc-catalog-list-row" onClick={() => setSelectedId(item.id)}>
          <span className="lc-catalog-list-name"><Photo url={item.image_url} name={item.name}/>
            <span><strong>{item.name}</strong><small>{item.category || "Sin categoría"}</small></span></span>
          <span className="lc-catalog-list-price"><small>Divisas</small>{item.cash_usd_base_price === null ? "—" : fmtRef(item.cash_usd_base_price)}</span>
          <span className="lc-catalog-list-price"><small>Dólares BCV</small>{item.current_ref_bcv === null ? "—" : fmtRef(item.current_ref_bcv)}</span>
          <span className="lc-catalog-list-price"><small>Bolívares</small>{item.current_price_ves === null ? "—" : fmtVes(item.current_price_ves)}</span>
        </button>
        <Link href={"/quote?add="+encodeURIComponent(item.id)} className="lc-catalog-list-quote">
          <OsIcon name="plus" size={15}/> Cotizar
        </Link>
      </div>)}
    </section>}

    <p className="lc-catalog-disclaimer">Los precios se actualizan mediante la integración existente de Notion. Este módulo es de consulta y no modifica los precios maestros ni el inventario físico.</p>
    {selected && <ProductDetail key={selected.id} item={selected} onClose={closeDetail}/>}
  </main>;
}

import { describe, expect, it } from "vitest";
import {
  catalogIsFresh, filterCatalog, formatCatalogDate, normalizeCatalogProduct,
  normalizeCatalogSearch, normalizeCatalogSync, safeCatalogImageUrl
} from "../lib/catalog";
import { NAV_MODULES, moduleForPath, navigationSearch } from "../lib/navigation";

const product = (name: string, price: number, image_url: string | null, category = "Aceite 20w50") =>
  normalizeCatalogProduct({
    id: name,
    name,
    category,
    available: true,
    active: true,
    cash_usd_base_price: price,
    current_ref_bcv: price * 1.21,
    current_price_ves: price * 500,
    image_url,
    catalog_source: "Notion · Nuestros Productos",
    catalog_synced_at: "2026-10-08T17:00:00Z"
  });

const catalog = [
  product("BRAVA 20W50", 10, "https://i.postimg.cc/products/brava.png"),
  product("K9 20W50", 8, null),
  product("VALVOLINE 10W30", 17, "https://i.postimg.cc/products/valvoline.png", "Aceite 10w30"),
];

describe("Catálogo visual sincronizado desde Notion", () => {
  it("mantiene los tres precios recibidos sin recalcularlos ni confundir tasas", () => {
    const item = normalizeCatalogProduct({
      id: "p", name: "Aceite", category: "Lubricantes",
      available: true, active: true,
      cash_usd_base_price: "11.5", current_ref_bcv: "13.945",
      current_price_ves: "12533.70",
      image_url: "https://i.postimg.cc/aceite.png"
    });
    expect(item.cash_usd_base_price).toBe(11.5);
    expect(item.current_ref_bcv).toBe(13.945);
    expect(item.current_price_ves).toBe(12533.70);
    expect(item.image_url).toBe("https://i.postimg.cc/aceite.png");
  });

  it("no inventa precios cuando no hay valor", () => {
    const item = normalizeCatalogProduct({
      id: "p", name: "Filtro", available: true, active: true,
      cash_usd_base_price: null, current_ref_bcv: "", current_price_ves: null
    });
    expect(item.cash_usd_base_price).toBeNull();
    expect(item.current_ref_bcv).toBeNull();
    expect(item.current_price_ves).toBeNull();
  });

  it("acepta enlaces de imagen válidos, rechaza javascript, data y referencias inválidas", () => {
    expect(safeCatalogImageUrl("https://i.postimg.cc/foto.png")).toBe("https://i.postimg.cc/foto.png");
    expect(safeCatalogImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeCatalogImageUrl("data:image/svg+xml,payload")).toBeNull();
    expect(safeCatalogImageUrl("foto.jpg")).toBeNull();
    expect(safeCatalogImageUrl(null)).toBeNull();
  });

  it("busca por nombre y categoría ignorando tildes y mayúsculas", () => {
    const subset = filterCatalog(catalog, {
      query: "aceite 10W30", category: "TODAS", imagesOnly: false, sort: "name"
    });
    expect(subset.map(item => item.name)).toEqual(["VALVOLINE 10W30"]);
    expect(normalizeCatalogSearch(" SEMISINTÉTICO ")).toBe("semisintetico");
  });

  it("filtra fotos y ordena por precio en divisas sin modificar el original", () => {
    const sorted = filterCatalog(catalog, {
      query: "", category: "TODAS", imagesOnly: true, sort: "divisas-high"
    });
    expect(sorted.map(item => item.name)).toEqual(["VALVOLINE 10W30", "BRAVA 20W50"]);
    expect(catalog[0].name).toBe("BRAVA 20W50");
    const priceSort = filterCatalog(catalog, {
      query: "", category: "Aceite 20w50", imagesOnly: false, sort: "bcv-low"
    });
    expect(priceSort.map(item => item.name)).toEqual(["K9 20W50", "BRAVA 20W50"]);
  });

  it("excluye productos que Notion haya marcado como no disponibles", () => {
    const hidden = {...catalog[0],available:false};
    const sorted = filterCatalog([hidden,...catalog.slice(1)],{
      query:"",category:"TODAS",imagesOnly:false,sort:"name"
    });
    expect(sorted.some(item => item.name === hidden.name)).toBe(false);
  });

  it("expone la ruta visual en Inventario y permite encontrarla con Ctrl K", () => {
    expect(moduleForPath("/catalog").id).toBe("inventory");
    expect(NAV_MODULES.find(m=>m.id==="inventory")?.links.some(l=>l.href==="/catalog")).toBe(true);
    expect(navigationSearch("foto", "OPERATOR").some(l=>l.href==="/catalog")).toBe(true);
    expect(navigationSearch("notion", "OWNER").some(l=>l.href==="/catalog")).toBe(true);
  });

  it("advierte si los precios están desactualizados y expresa la hora de Caracas", () => {
    const sync = normalizeCatalogSync({
      catalog_synced_at:"2026-10-08T17:00:00Z",
      catalog_products:76,bcv_rate:187.8,operative_rate:191,
      bcv_effective_at:"2026-10-08T17:00:00Z",
      operative_effective_at:"2026-10-08T17:00:00Z"
    });
    expect(sync?.catalogProducts).toBe(76);
    expect(catalogIsFresh(sync, new Date("2026-10-08T18:00:00Z").getTime())).toBe(true);
    expect(catalogIsFresh(sync, new Date("2026-10-08T22:00:00Z").getTime())).toBe(false);
    expect(formatCatalogDate(null)).toBe("Sin sincronizar");
  });
});

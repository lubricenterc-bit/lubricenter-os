import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeCatalogProduct, type CatalogSync } from "../lib/catalog";
import { moduleForPath, navigationSearch, NAV_MODULES } from "../lib/navigation";
import {
  DEFAULT_SHARE_CURRENCIES, QUOTE_HANDOFF_KEY, OIL_TO_QUOTE_KEY,
  QUOTE_DRAFT_KEY, deserializeQuoteLines, mergeQuoteLines,
  quoteCustomerMessage, resolvedQuote, sanitizeQuoteLines,
  serializeQuoteLines,
  type SalesQuoteLine
} from "../lib/sales-quote";

const rates: CatalogSync = {
  catalogSyncedAt:"2026-10-08T19:00:00Z",catalogProducts:76,
  bcv:100,operative:120,bcvEffectiveAt:"2026-10-08T19:00:00Z",
  operativeEffectiveAt:"2026-10-08T19:00:00Z"
};
const oil=normalizeCatalogProduct({
  id:"oil1",name:"BRAVA 20W50 SEMISINTÉTICO",category:"Aceite de motor",
  active:true,available:true,cash_usd_base_price:10,current_ref_bcv:12,
  current_price_ves:1200,image_url:"https://i.postimg.cc/brava.png",
});
const filter=normalizeCatalogProduct({
  id:"filter1",name:"FILTRO MILLARD 3387",category:"Filtro de aceite",
  active:true,available:true,cash_usd_base_price:4,current_ref_bcv:4.8,
  current_price_ves:480
});
const items:SalesQuoteLine[]=[
  {kind:"CATALOG",id:"oil1",productId:"oil1",quantity:4},
  {kind:"CATALOG",id:"filter1",productId:"filter1",quantity:1},
  {kind:"MANUAL",id:"svc",description:"Servicio especial",quantity:1,unitRef:6}
];

describe("Flujo de cotizaciones generales",()=>{
  it("calcula por los valores vigentes del catálogo, sin confundir las tres monedas",()=>{
    const r=resolvedQuote(items,[oil,filter],rates);
    expect(r.missing).toEqual([]);
    expect(r.lines.map(row=>row.name)).toEqual(["BRAVA 20W50 SEMISINTÉTICO","FILTRO MILLARD 3387","Servicio especial"]);
    expect(r.lines[0].subtotal).toEqual({bcv:48,ves:4800,divisas:40});
    expect(r.total.bcv).toBe(58.8);
    expect(r.total.ves).toBe(5880);
    expect(r.total.divisas).toBe(49);
  });
  it("no inventa precios de servicios manuales sin tasas",()=>{
    const r=resolvedQuote(items,[oil,filter],null);
    expect(r.lines[0].subtotal.divisas).toBe(40);
    expect(r.lines[2].subtotal).toEqual({bcv:6,ves:null,divisas:null});
    expect(r.total.bcv).toBe(58.8);
    expect(r.total.ves).toBeNull();
    expect(r.total.divisas).toBeNull();
  });
  it("no incluye ni cotiza productos inactivos o perdidos del catálogo",()=>{
    const r=resolvedQuote(items,[oil],rates);
    expect(r.missing.length).toBe(1);
    expect(r.lines.length).toBe(2);
  });
  it("cuida la integridad del carrito: deduplica productos sin perder sus cantidades",()=>{
    const incoming:[SalesQuoteLine,SalesQuoteLine]=[
      {kind:"CATALOG",id:"oil2",productId:"oil1",quantity:1.5},
      {kind:"CATALOG",id:"new",productId:"filter1",quantity:2}
    ];
    const merged=mergeQuoteLines([items[0]],incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].quantity).toBe(5.5);
    expect(merged[1].quantity).toBe(2);
  });
  it("las cotizaciones tienen vencimiento temporal y validación contra datos manipulados",()=>{
    const now=Date.parse("2026-10-08T19:00:00Z");
    const value=serializeQuoteLines(items,now);
    expect(deserializeQuoteLines(value,now+1000)).toEqual(items);
    expect(deserializeQuoteLines(value,now+3*3600000)).toEqual([]);
    expect(deserializeQuoteLines("invalid",now)).toEqual([]);
    expect(deserializeQuoteLines(JSON.stringify({version:999,createdAt:now,lines:items}),now)).toEqual([]);
    expect(sanitizeQuoteLines([{kind:"MANUAL",id:"bad",description:"X",quantity:1,unitRef:-20}])).toEqual([]);
    expect(sanitizeQuoteLines([{kind:"CATALOG",id:"bad",productId:"p",quantity:Infinity}])).toEqual([]);
    expect(QUOTE_DRAFT_KEY).not.toEqual(QUOTE_HANDOFF_KEY);
    expect(OIL_TO_QUOTE_KEY).not.toEqual(QUOTE_HANDOFF_KEY);
  });
  it("mensaje comercial con bolívares y BCV por defecto, sin divisas ni advertencias internas",()=>{
    const q=resolvedQuote(items,[oil,filter],rates);
    const text=quoteCustomerMessage(q.lines,q.total);
    expect(DEFAULT_SHARE_CURRENCIES).toEqual({ves:true,bcv:true,divisas:false});
    expect(text).toContain("¡Hola! 👋🧡");
    expect(text).toContain("FILTRO MILLARD");
    expect(text).toContain("Bs. 5.880,00");
    expect(text).toContain("$58,80 BCV");
    expect(text).toContain("coordinemos tu visita");
    expect(text).not.toMatch(/divisas|stock|sincroniz|Notion|compatibilidad|inventario/i);
  });
  it("permite las tres monedas opcionales y bloquea textos sin tasas suficientes",()=>{
    const q=resolvedQuote(items,[oil,filter],rates);
    expect(quoteCustomerMessage(q.lines,q.total,{ves:false,bcv:false,divisas:true})).toContain("$49,00 divisas");
    expect(quoteCustomerMessage(q.lines,q.total,{ves:false,bcv:false,divisas:false})).toBe("");
    expect(quoteCustomerMessage(resolvedQuote(items,[oil,filter],null).lines,
      resolvedQuote(items,[oil,filter],null).total)).toBe("");
  });
  it("módulos y rutas permiten ir al catálogo, cotizar, cobrar y continuar a orden",()=>{
    expect(moduleForPath("/quote").id).toBe("sales");
    expect(moduleForPath("/quote/oil").id).toBe("sales");
    expect(navigationSearch("cotizar", "OPERATOR").some(x=>x.href==="/quote")).toBe(true);
    expect(NAV_MODULES.find(m=>m.id==="sales")?.links.some(x=>x.href==="/quote/oil")).toBe(true);
    const app=readFileSync("components/app-shell.tsx","utf8");
    const mesaNavigation=readFileSync("components/mesa-navigation.tsx","utf8");
    expect(app+mesaNavigation).toContain('href: "/quote"');
    const cat=readFileSync("app/catalog/page.tsx","utf8");
    expect(cat).toContain('"/quote?add="+encodeURIComponent(item.id)');
    const quick=readFileSync("components/quick-sale-screen.tsx","utf8");
    expect(quick).toContain("takeQuoteLines(QUOTE_HANDOFF_KEY)");
    expect(quick).toContain('p_mode: "DRAFT"');
  });
  it("las fotos no se recortan y las columnas se adaptan a pantallas móviles",()=>{
    const catalog=readFileSync("app/catalog/catalog.css","utf8");
    const oil=readFileSync("app/quote/quote.css","utf8");
    const general=readFileSync("app/quote/general.css","utf8");
    for(const css of [catalog,oil,general]) expect(css).toContain("object-fit:contain");
    expect(general).toContain("@media (max-width:720px)");
    expect(oil).toContain("grid-template-columns:minmax(215px,238px)");
    expect(catalog).toContain("lc-catalog-quote-link");
  });
});

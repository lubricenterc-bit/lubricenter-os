import { describe, expect, it } from "vitest";
import { normalizeCatalogProduct, type CatalogProduct, type CatalogSync } from "../lib/catalog";
import {
  analyzeOil, availableViscosities, classifyOilTechnology, moneyFromManualUsd,
  normalizeQuoteFilterProducts, oilBrandFromName, quoteAllOils, quoteWhatsAppText,
  DEFAULT_QUOTE_SHARE_CURRENCIES,
  validQuoteRequest, viscosityFromName, volumeFromOilName,
  type QuoteRequest
} from "../lib/oil-quote";
import { NAV_MODULES, moduleForPath, navigationSearch } from "../lib/navigation";

const prices: CatalogSync = {
  catalogSyncedAt: "2026-10-08T17:00:00Z", catalogProducts: 76,
  bcv: 100, operative: 120,
  bcvEffectiveAt: "2026-10-08T17:00:00Z", operativeEffectiveAt: "2026-10-08T17:00:00Z"
};

function product(name:string, usd:number, category="Aceite 20w50"):CatalogProduct {
  return normalizeCatalogProduct({
    id:name, name, category, active:true, available:true,
    cash_usd_base_price:usd, current_ref_bcv:usd*1.2,
    current_price_ves:usd*120, image_url:null
  });
}
const products=[
  product("BRAVA 20W50 SEMISINTETICO",8),
  product("VOLTEX 20W50 SEMISINTETICO GALON",30),
  product("VOLTEX 20W50 SEMISINTETICO LITRO",9),
  product("INCA 20w50 SEMI-SINTETICO",12,"Aceite 15w40"),
  product("CHRONUS 20W50 SEMI SYNTETICO",11.5),
  product("BRAVA 20W50 MINERAL",7.5),
  product("GOODYEAR 10W30 FULL SINTETICO",10.5,"Aceite 10w30"),
  product("LIRAX 20W50 MINERAL GRANEL",5),
  product("Brava 4 Tiempos 20w50",7.5),
  product("VALVULINA BRAVA 75-90W",7.5,"Valvulina"),
  product("Filtro Millard",7,"Filtro de Aceite"),
];
const request:QuoteRequest={
  viscosity:"20W50",technology:"semi",liters:4,
  filter:{mode:"manual",manualUsd:5},laborUsd:0,freeLaborPromotion:false,rates:prices
};

describe("Cotizador de cambio de aceite",()=>{
  it("interpreta diferentes escrituras de viscosidad y tecnología",()=>{
    expect(viscosityFromName("20W-50")).toBe("20W50");
    expect(viscosityFromName("15w/40")).toBe("15W40");
    expect(viscosityFromName("0w20")).toBe("0W20");
    expect(classifyOilTechnology("SEMI SYNTETICO")).toBe("semi");
    expect(classifyOilTechnology("SEMI-SINTETICO")).toBe("semi");
    expect(classifyOilTechnology("SEMISINTÉTICO")).toBe("semi");
    expect(classifyOilTechnology("FULL SINTETICO")).toBe("full");
    expect(classifyOilTechnology("100% sintético")).toBe("full");
    expect(classifyOilTechnology("MINERAL")).toBe("mineral");
    expect(classifyOilTechnology("SINTETICO")).toBeNull();
    expect(classifyOilTechnology("")).toBeNull();
  });
  it("el galón es cuatro litros, sin seleccionarlo manualmente",()=>{
    expect(volumeFromOilName("VOLTEX 20W50 SEMISINTETICO GALON")).toBe(4);
    expect(volumeFromOilName("VOLTEX 20W50 SEMISINTETICO LITRO")).toBe(1);
    expect(volumeFromOilName("BRAVA 20W50 SEMISINTETICO")).toBe(1);
    expect(volumeFromOilName("1/2 LITRO")).toBe(0.5);
    expect(oilBrandFromName("GALON 20W50 SEMISINTETICO FANFARO")).toBe("FANFARO");
  });
  it("da prioridad a viscosidad del nombre sobre categorías inconsistentes en Notion",()=>{
    const inca=analyzeOil(products[3]);
    expect(inca?.viscosity).toBe("20W50");
    expect(inca?.warnings[0]).toContain("Notion clasifica 15W40");
    expect(availableViscosities(products)).toContain("20W50");
  });
  it("no cotiza aceite de motos, valvulina, filtros ni tecnología ambigua",()=>{
    expect(analyzeOil(products[8])).toBeNull();
    expect(analyzeOil(products[9])).toBeNull();
    expect(analyzeOil(products[10])).toBeNull();
    const ambiguous=product("SHELL HELIX 20W50",15);
    expect(analyzeOil(ambiguous)?.technology).toBeNull();
    expect(quoteAllOils([...products,ambiguous],request).some(x=>x.oil.product.id===ambiguous.id)).toBe(false);
  });
  it("cotiza todas las marcas compatibles y ordena del menor al mayor costo",()=>{
    const quotes=quoteAllOils(products,request);
    expect(quotes).toHaveLength(5);
    expect(quotes.map(x=>x.oil.product.name)).toEqual([
      "VOLTEX 20W50 SEMISINTETICO GALON",
      "BRAVA 20W50 SEMISINTETICO",
      "VOLTEX 20W50 SEMISINTETICO LITRO",
      "CHRONUS 20W50 SEMI SYNTETICO",
      "INCA 20w50 SEMI-SINTETICO"
    ]);
    expect(quotes[0].oilSubtotal.divisas).toBe(30); // 1 galón = 4 L
    expect(quotes[1].oilSubtotal.divisas).toBe(32); // 4 × litro $8
    expect(quotes[2].oilSubtotal.divisas).toBe(36);
    expect(quotes[0].total.divisas).toBe(35); // galón + filtro
    expect(quotes[0].total.bcv).toBe(42); // (galón + filtro) × 120 / 100
    expect(quotes[0].total.ves).toBe(4200);
  });
  it("convierte 4,5 litros a una fracción comercial del galón acordado",()=>{
    const quotes=quoteAllOils([products[1]],{...request,liters:4.5,filter:{mode:"none"}});
    expect(quotes[0].oilSubtotal.divisas).toBe(33.75);
    expect(quotes[0].oilSubtotal.bcv).toBe(40.5);
    expect(quotes[0].total.ves).toBe(4050);
  });
  it("el filtro puede venir del catálogo, de un precio manual o quedar excluido",()=>{
    expect(normalizeQuoteFilterProducts(products).map(x=>x.name)).toEqual(["Filtro Millard"]);
    const chosenFilter = quoteAllOils(products,{...request,filter:{mode:"catalog",product:products[10]}});
    expect(chosenFilter[0].total.divisas).toBe(37);
    expect(chosenFilter[0].total.bcv).toBe(44.4);
    const without = quoteAllOils(products,{...request,filter:{mode:"none"}});
    expect(without[0].total.divisas).toBe(30);
    expect(without[0].filterSubtotal.divisas).toBe(0);
  });
  it("mano de obra a cero por defecto y costo separado si corresponde",()=>{
    const normal=quoteAllOils(products,request)[0];
    expect(normal.laborSubtotal.divisas).toBe(0);
    const charged=quoteAllOils(products,{...request,laborUsd:6})[0];
    expect(charged.laborSubtotal.divisas).toBe(6);
    expect(charged.total.divisas).toBe(41);
    expect(charged.total.ves).toBe(4920);
    const promo=quoteAllOils(products,{...request,laborUsd:6,freeLaborPromotion:true})[0];
    expect(promo.laborSubtotal.divisas).toBe(0);
    expect(promo.total.divisas).toBe(35);
  });
  it("no inventa conversiones si las tasas están ausentes",()=>{
    expect(moneyFromManualUsd(5,null)).toEqual({divisas:5,bcv:null,ves:null});
    expect(moneyFromManualUsd(0,null)).toEqual({divisas:0,bcv:0,ves:0});
    const result=quoteAllOils(products,{...request,rates:null});
    expect(result[0].total.divisas).toBe(35);
    expect(result[0].total.bcv).toBeNull();
    expect(result[0].total.ves).toBeNull();
  });
  it("rechaza cantidades negativas, no numéricas y importes fuera de rango",()=>{
    expect(validQuoteRequest(request)).toBe(true);
    expect(validQuoteRequest({...request,liters:0})).toBe(false);
    expect(validQuoteRequest({...request,liters:31})).toBe(false);
    expect(validQuoteRequest({...request,liters:NaN})).toBe(false);
    expect(validQuoteRequest({...request,filter:{mode:"manual",manualUsd:-5}})).toBe(false);
    expect(quoteAllOils(products,{...request,liters:-1})).toEqual([]);
  });
  it("por defecto comparte Bs y dólares BCV, pero nunca divisas",()=>{
    const quote=quoteAllOils(products,request)[0];
    expect(DEFAULT_QUOTE_SHARE_CURRENCIES).toEqual({ves:true,bcv:true,divisas:false});
    const msg=quoteWhatsAppText([quote],request);
    expect(msg).toContain("¡Hola! 👋🧡");
    expect(msg).toContain("Gracias por escribir a *Lubricenter Cabudare*");
    expect(msg).toContain("20W50 semisintético · 4 litros");
    expect(msg).toContain("VOLTEX");
    expect(msg).toContain("Bs. 4.200,00");
    expect(msg).toContain("$42,00 BCV");
    expect(msg).not.toContain("$35,00 divisas");
    expect(msg).not.toMatch(/Notion|Catálogo:|verificar compatibilidad|verificar disponibilidad|PRECIOS POR CONFIRMAR|sincronizad|stock|inventario|tasas vencid/i);
    expect(msg).toContain("¿Cuál opción prefieres?");
  });
  it("las casillas permiten elegir una, dos o las tres monedas en el mensaje",()=>{
    const quote=quoteAllOils(products,request)[0];
    const onlyBs=quoteWhatsAppText([quote],request,{ves:true,bcv:false,divisas:false});
    expect(onlyBs).toContain("Bs. 4.200,00");
    expect(onlyBs).not.toContain("BCV");
    expect(onlyBs).not.toContain("divisas");
    const onlyDivisas=quoteWhatsAppText([quote],request,{ves:false,bcv:false,divisas:true});
    expect(onlyDivisas).toContain("$35,00 divisas");
    expect(onlyDivisas).not.toContain("BCV");
    expect(onlyDivisas).not.toContain("Bs.");
    const all=quoteWhatsAppText([quote],request,{ves:true,bcv:true,divisas:true});
    expect(all).toContain("Bs. 4.200,00");
    expect(all).toContain("$42,00 BCV");
    expect(all).toContain("$35,00 divisas");
    expect(quoteWhatsAppText([quote],request,{ves:false,bcv:false,divisas:false})).toBe("");
  });
  it("mantiene el texto breve e incluye solo conceptos relevantes para el cliente",()=>{
    const quotes=quoteAllOils(products,request);
    const selected=[quotes[0],quotes[1],quotes[2]];
    const msg=quoteWhatsAppText(selected,request);
    expect(msg).toContain("filtro de aceite");
    expect(msg).toContain("servicio de cambio de aceite");
    expect(msg).toContain("coordinamos tu visita");
    expect(msg).toContain("1. *VOLTEX");
    expect(msg).toContain("2. *BRAVA");
    expect(msg).toContain("3. *VOLTEX");
    expect(msg).not.toContain("Precio de filtro estimado");
    expect(msg).not.toContain("Fuente");
    expect(quoteWhatsAppText(selected,{...request,filter:{mode:"none"}})).not.toContain("filtro de aceite");
    expect(quoteWhatsAppText([] ,request)).toBe("");
  });
  it("muestra el regalo de mano de obra solo al aplicar promoción",()=>{
    const quoted=quoteAllOils(products,{...request,laborUsd:7,freeLaborPromotion:true});
    const msg=quoteWhatsAppText([quoted[0]],{...request,laborUsd:7,freeLaborPromotion:true});
    expect(msg).toContain("🎁 *Promoción:* mano de obra sin costo adicional.");
    expect(msg).toContain("Bs. 4.200,00");
    expect(quoteWhatsAppText([quoteAllOils(products,request)[0]],request)).not.toContain("Promoción:");
  });
  it("evita compartir importes incompletos si falta una tasa elegida",()=>{
    const missing=quoteAllOils(products,{...request,rates:null})[0];
    expect(quoteWhatsAppText([missing],{...request,rates:null})).toBe("");
    const onlyDivisas=quoteWhatsAppText([missing],{...request,rates:null},{ves:false,bcv:false,divisas:true});
    expect(onlyDivisas).toContain("$35,00 divisas");
    expect(onlyDivisas).not.toContain("No disponible");
  });
  it("se integra como herramienta Ventas sin duplicar rutas",()=>{
    expect(moduleForPath("/quote").id).toBe("sales");
    expect(navigationSearch("cotizar", "OPERATOR").some(x=>x.href==="/quote")).toBe(true);
    expect(NAV_MODULES.find(m=>m.id==="sales")?.links.some(x=>x.href==="/quote")).toBe(true);
  });
});

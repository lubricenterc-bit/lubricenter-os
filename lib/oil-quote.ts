import Decimal from "decimal.js";
import { normalizeCatalogSearch, type CatalogProduct, type CatalogSync } from "@/lib/catalog";

export type OilTechnology = "mineral" | "semi" | "full";
export type QuoteMoney = { divisas: number | null; bcv: number | null; ves: number | null };
export type OilAnalysis = {
  product: CatalogProduct;
  viscosity: string | null;
  technology: OilTechnology | null;
  brand: string;
  volumeLiters: number | null;
  warnings: string[];
};
export type OilQuote = {
  oil: OilAnalysis;
  oilSubtotal: QuoteMoney;
  filterSubtotal: QuoteMoney;
  laborSubtotal: QuoteMoney;
  total: QuoteMoney;
};
export type FilterChoice = { mode: "manual"; manualUsd: number } |
  { mode: "none" } |
  { mode: "catalog"; product: CatalogProduct };
export type QuoteRequest = {
  viscosity: string;
  technology: OilTechnology;
  liters: number;
  filter: FilterChoice;
  laborUsd: number;
  freeLaborPromotion: boolean;
  rates: CatalogSync | null;
};

const normalizeName = (value: string) =>
  normalizeCatalogSearch(value)
    .toUpperCase()
    .replace(/[‐‑–—−]/g, "-")
    .replace(/SYN?TETIC/g, "SINTETIC");

export function viscosityFromName(value: string): string | null {
  const matched = normalizeName(value).match(/\b(\d{1,2})\s*W\s*[-/]?\s*(\d{1,2})\b/);
  return matched ? String(Number(matched[1])) + "W" + String(Number(matched[2])) : null;
}

export function classifyOilTechnology(value: string): OilTechnology | null {
  const name = normalizeName(value);
  const types: OilTechnology[] = [];
  if (/\bMINERAL\b/.test(name)) types.push("mineral");
  if (/\bSEMI[\s-]*SINTETIC[OA]\b/.test(name)) types.push("semi");
  if (/\bFULL[\s-]*SINTETIC[OA]\b|\b100\s*%[\s-]*SINTETIC[OA]\b/.test(name)) types.push("full");
  return types.length === 1 ? types[0] : null;
}

export function volumeFromOilName(value: string): number | null {
  const name = normalizeName(value);
  if (/\bGALON(?:ES)?\b/.test(name)) return 4;
  if (/\b(?:MEDIO|1\/2)\s*LITRO\b/.test(name)) return 0.5;
  const volume = name.match(/\b(\d+(?:[.,]\d+)?)\s*(?:LITROS?|LTS?|L)\b/);
  if (volume) {
    const liters = Number(volume[1].replace(",", "."));
    return liters > 0 && liters <= 20 ? liters : null;
  }
  // Regla comercial acordada: sin etiqueta de presentación = precio por litro.
  return 1;
}

export function oilBrandFromName(value: string) {
  const cleaned = normalizeName(value)
    .replace(/\b\d{1,2}\s*W\s*[-/]?\s*\d{1,2}\b/g, " ")
    .replace(/\b(?:MINERAL|SEMI[\s-]*SINTETIC[OA]|FULL[\s-]*SINTETIC[OA]|SINTETIC[OA]|GALON(?:ES)?|GRANEL|LITROS?|LTS?|L|ACEITE|DIESEL|GASOLINA)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const matched = cleaned.match(/^(?:DR CARE|SKY EVOLUB|MOBIL DELVAC|SHELL HELIX|VALVOLINE VALVODIESEL)\b/);
  return matched?.[0] || cleaned.split(" ").filter(Boolean)[0] || value.trim();
}

export function analyzeOil(product: CatalogProduct): OilAnalysis | null {
  if (!product.active || !product.available) return null;
  const name = normalizeName(product.name);
  const category = normalizeName(product.category || "");
  const nameViscosity = viscosityFromName(product.name);
  const categoryViscosity = viscosityFromName(product.category || "");
  const viscosity = nameViscosity || categoryViscosity;
  const categoryOil = /^ACEITE\b/.test(category) || category === "SEMI-SINTETICO" || category === "SEMI SINTETICO";
  const tech = classifyOilTechnology(product.name);
  // No mezclar filtros, aceites de moto 2T/4T ni fluidos de transmisiones.
  if (/\b(?:2T|4T|2\s*TIEMPOS|4\s*TIEMPOS|VALVULINA|HIDRAULIC[OA]|FRENOS|DEX[\s-]*III|ATF)\b/.test(name)) return null;
  if (!viscosity || (!categoryOil && !nameViscosity)) return null;
  const warnings: string[] = [];
  if (nameViscosity && categoryViscosity && nameViscosity !== categoryViscosity) {
    warnings.push("Notion clasifica " + categoryViscosity + ", pero el nombre indica " + nameViscosity + "; prevalece el nombre.");
  }
  if (!tech) warnings.push("Tecnología no indicada claramente en el nombre. Verificar en Notion.");
  const volumeLiters = volumeFromOilName(product.name);
  if (!volumeLiters) warnings.push("Volumen no identificable. No cotizar automáticamente.");
  if (product.cash_usd_base_price == null || product.current_ref_bcv == null || product.current_price_ves == null) {
    warnings.push("Falta uno o varios precios sincronizados.");
  }
  return { product, viscosity, technology: tech, brand: oilBrandFromName(product.name), volumeLiters, warnings };
}

export function availableViscosities(catalog: CatalogProduct[]): string[] {
  const keys = new Set<string>();
  for (const product of catalog) {
    const item = analyzeOil(product);
    if (item?.technology && item.volumeLiters) keys.add(item.viscosity!);
  }
  return [...keys].sort((a,b) => parseInt(a,10) - parseInt(b,10) || a.localeCompare(b));
}

const rounded = (value: Decimal) => Number(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString());
const zeroMoney = (): QuoteMoney => ({ divisas:0, bcv:0, ves:0 });
export function moneyFromCatalog(product: CatalogProduct, factor: number): QuoteMoney {
  if (!Number.isFinite(factor) || factor < 0) throw new Error("Cantidad inválida");
  const times = (n:number|null) => n == null ? null : rounded(new Decimal(n).times(factor));
  return {
    divisas: times(product.cash_usd_base_price),
    bcv: times(product.current_ref_bcv),
    ves: times(product.current_price_ves)
  };
}

/** Convierte manuales a los mismos tres sistemas utilizados por la integración de Notion. */
export function moneyFromManualUsd(usd: number, rates: CatalogSync | null): QuoteMoney {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("Importe manual inválido");
  if (usd === 0) return zeroMoney();
  const divisas = rounded(new Decimal(usd));
  const operative = rates?.operative;
  const bcv = rates?.bcv;
  const ves = operative != null && operative > 0 ? rounded(new Decimal(usd).times(operative)) : null;
  const refBcv = operative != null && operative > 0 && bcv != null && bcv > 0
    ? rounded(new Decimal(usd).times(operative).div(bcv)) : null;
  return { divisas, bcv:refBcv, ves };
}

function addMoney(...parts: QuoteMoney[]): QuoteMoney {
  const add = (key:keyof QuoteMoney) =>
    parts.some(p => p[key] === null)
      ? null : rounded(parts.reduce((sum,p) => sum.plus(p[key]!), new Decimal(0)));
  return { divisas:add("divisas"), bcv:add("bcv"), ves:add("ves") };
}

function catalogHasAllPrices(product: CatalogProduct) {
  return product.cash_usd_base_price !== null && product.current_ref_bcv !== null && product.current_price_ves !== null;
}

export function validQuoteRequest(request: QuoteRequest) {
  return Number.isFinite(request.liters) && request.liters > 0 && request.liters <= 30
    && Number.isFinite(request.laborUsd) && request.laborUsd >= 0 && request.laborUsd <= 1000
    && (request.filter.mode !== "manual" ||
      (Number.isFinite(request.filter.manualUsd) && request.filter.manualUsd >= 0 && request.filter.manualUsd <= 1000));
}

export function quoteAllOils(catalog: CatalogProduct[], request: QuoteRequest): OilQuote[] {
  if (!validQuoteRequest(request)) return [];
  const filter = request.filter.mode === "none" ? zeroMoney()
    : request.filter.mode === "manual" ? moneyFromManualUsd(request.filter.manualUsd, request.rates)
    : moneyFromCatalog(request.filter.product, 1);
  const labor = moneyFromManualUsd(request.freeLaborPromotion ? 0 : request.laborUsd, request.rates);

  return catalog.flatMap(product => {
    const oil = analyzeOil(product);
    if (!oil || oil.viscosity !== request.viscosity ||
      oil.technology !== request.technology || !oil.volumeLiters ||
      !catalogHasAllPrices(product)) return [];
    const oilSubtotal = moneyFromCatalog(product, request.liters / oil.volumeLiters);
    return [{ oil, oilSubtotal, filterSubtotal:filter, laborSubtotal:labor,
      total:addMoney(oilSubtotal, filter, labor) }];
  }).sort((a,b) => {
    const av = a.total.divisas ?? Infinity;
    const bv = b.total.divisas ?? Infinity;
    return av - bv || a.oil.brand.localeCompare(b.oil.brand, "es-VE")
      || a.oil.product.name.localeCompare(b.oil.product.name, "es-VE");
  });
}

export function normalizeQuoteFilterProducts(catalog: CatalogProduct[]): CatalogProduct[] {
  return catalog.filter(product => product.available && product.active
    && normalizeName(product.category || "").includes("FILTRO DE ACEITE")
    && catalogHasAllPrices(product))
    .sort((a,b) => a.name.localeCompare(b.name, "es-VE"));
}

export function quoteWhatsAppText(quotes: OilQuote[], request: QuoteRequest, filterLabel: string, dated: string, fresh: boolean) {
  if (!quotes.length) return "";
  const money = (value:number|null, prefix:string) => value === null
    ? "No disponible" : prefix + value.toLocaleString("es-VE", { minimumFractionDigits:2, maximumFractionDigits:2 });
  const techLabel = request.technology === "mineral" ? "Mineral" : request.technology === "semi" ? "Semisintético" : "Full sintético";
  const options = quotes.map((quote,i) =>
    String(i+1) + ". " + quote.oil.product.name + "\n   Divisas: " +
    money(quote.total.divisas, "$") + " · $ BCV: " + money(quote.total.bcv,"$") +
    " · Bs: " + money(quote.total.ves,"Bs. "));
  return [
    "LUBRICENTER CABUDARE",
    "COTIZACIÓN · CAMBIO DE ACEITE",
    request.viscosity + " " + techLabel + " · " + request.liters.toLocaleString("es-VE") + " L",
    "Filtro: " + filterLabel + " (verificar compatibilidad)",
    "Mano de obra: " + money(request.freeLaborPromotion ? 0 : request.laborUsd,"$") +
      (request.freeLaborPromotion ? " (sin cargo por promoción)" : ""),
    "",
    ...options,
    "",
    "Catálogo: " + dated,
    !fresh ? "PRECIOS POR CONFIRMAR: tasas o catálogo requieren actualización." :
      "Precios sujetos a verificación al momento de pagar.",
    "Cotización informativa; verificar disponibilidad, presentación y filtro antes de vender.",
  ].join("\n");
}

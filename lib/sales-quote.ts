import Decimal from "decimal.js";
import type { CatalogProduct, CatalogSync } from "./catalog";

export type QuoteCatalogLine = {
  kind: "CATALOG";
  id: string;
  productId: string;
  quantity: number;
};
export type QuoteManualLine = {
  kind: "MANUAL";
  id: string;
  description: string;
  quantity: number;
  unitRef: number;
};
export type SalesQuoteLine = QuoteCatalogLine | QuoteManualLine;
export type SalesQuoteMoney = { ves: number | null; bcv: number | null; divisas: number | null };
export type SalesQuoteResolvedLine = {
  item: SalesQuoteLine;
  name: string;
  imageUrl: string | null;
  unit: SalesQuoteMoney;
  subtotal: SalesQuoteMoney;
};
export type ShareCurrencies = { ves: boolean; bcv: boolean; divisas: boolean };
export const DEFAULT_SHARE_CURRENCIES: ShareCurrencies = { ves: true, bcv: true, divisas: false };
const MAX_LINES = 80;
const MAX_AGE = 1000 * 60 * 60 * 2;

export const QUOTE_DRAFT_KEY = "lubricenter:general-quote:v1";
export const QUOTE_HANDOFF_KEY = "lubricenter:quote-to-sale:v1";
export const OIL_TO_QUOTE_KEY = "lubricenter:oil-to-general:v1";

const fixed = (n: Decimal) => Number(n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString());
const amount = (n: number | null | undefined, multiplier: number) =>
  n == null || !Number.isFinite(n) || !Number.isFinite(multiplier)
    ? null : fixed(new Decimal(n).times(multiplier));

function validLine(value: unknown): value is SalesQuoteLine {
  if (!value || typeof value !== "object") return false;
  const l = value as Record<string, unknown>;
  if (typeof l.id !== "string" || l.id.length < 1 || l.id.length > 150) return false;
  if (typeof l.quantity !== "number" || !Number.isFinite(l.quantity) || l.quantity <= 0 || l.quantity > 1000) return false;
  if (l.kind === "CATALOG") return typeof l.productId === "string" && l.productId.length > 0 && l.productId.length < 150;
  if (l.kind === "MANUAL") return typeof l.description === "string" && l.description.trim().length > 0 &&
    l.description.length <= 200 && typeof l.unitRef === "number" && Number.isFinite(l.unitRef) &&
    l.unitRef > 0 && l.unitRef <= 100000;
  return false;
}

export function sanitizeQuoteLines(value: unknown): SalesQuoteLine[] {
  if (!Array.isArray(value) || value.length > MAX_LINES) return [];
  const result = value.filter(validLine);
  const ids = new Set<string>();
  return result.filter(line => {
    if (ids.has(line.id)) return false;
    ids.add(line.id);
    return true;
  });
}

type Envelope = {version:1;createdAt:number;lines:SalesQuoteLine[]};

export function serializeQuoteLines(lines: SalesQuoteLine[], now = Date.now()): string {
  return JSON.stringify({ version:1, createdAt:now, lines:sanitizeQuoteLines(lines) } satisfies Envelope);
}

export function deserializeQuoteLines(text: string | null, now = Date.now()): SalesQuoteLine[] {
  if (!text) return [];
  try {
    const envelope = JSON.parse(text) as Partial<Envelope>;
    if (envelope.version !== 1 || typeof envelope.createdAt !== "number" ||
      !Number.isFinite(envelope.createdAt) || envelope.createdAt > now + 300000 ||
      now - envelope.createdAt > MAX_AGE) return [];
    return sanitizeQuoteLines(envelope.lines);
  } catch {
    return [];
  }
}

export function storeQuoteLines(key: string, lines: SalesQuoteLine[]) {
  try { window.sessionStorage.setItem(key, serializeQuoteLines(lines)); return true; }
  catch { return false; }
}
export function takeQuoteLines(key: string) {
  try {
    const value = window.sessionStorage.getItem(key);
    const lines = deserializeQuoteLines(value);
    window.sessionStorage.removeItem(key);
    return lines;
  } catch { return []; }
}
export function peekQuoteLines(key: string) {
  try { return deserializeQuoteLines(window.sessionStorage.getItem(key)); }
  catch { return []; }
}

export function mergeQuoteLines(existing: SalesQuoteLine[], incoming: SalesQuoteLine[]) {
  const results = [...existing];
  for (const line of sanitizeQuoteLines(incoming)) {
    if (line.kind === "CATALOG") {
      const found = results.findIndex(x => x.kind === "CATALOG" && x.productId === line.productId);
      if (found >= 0) {
        const previous = results[found];
        const nextQuantity = Number(new Decimal(previous.quantity).plus(line.quantity).toString());
        if (nextQuantity <= 1000) results[found] = {...previous, quantity:nextQuantity};
        continue;
      }
    }
    if (results.length < MAX_LINES) results.push(line);
  }
  return results;
}

export function resolvedQuote(
  lines: SalesQuoteLine[],
  catalog: CatalogProduct[],
  rates: CatalogSync | null,
): { lines: SalesQuoteResolvedLine[]; missing: string[]; total: SalesQuoteMoney } {
  const lookup = new Map(catalog.map(p => [p.id,p]));
  const missing: string[] = [];
  const rows: SalesQuoteResolvedLine[] = [];
  for (const item of sanitizeQuoteLines(lines)) {
    if (item.kind === "CATALOG") {
      const product = lookup.get(item.productId);
      if (!product || !product.active || !product.available) {
        missing.push("Un producto dejó de estar disponible en el catálogo.");
        continue;
      }
      if (product.current_ref_bcv == null || product.current_price_ves == null ||
        product.cash_usd_base_price == null) {
        missing.push("Faltan precios de " + product.name);
        continue;
      }
      rows.push({
        item, name:product.name, imageUrl:product.image_url,
        unit: { bcv:product.current_ref_bcv, ves:product.current_price_ves, divisas:product.cash_usd_base_price },
        subtotal: {
          bcv:amount(product.current_ref_bcv,item.quantity),
          ves:amount(product.current_price_ves,item.quantity),
          divisas:amount(product.cash_usd_base_price,item.quantity),
        }
      });
    } else {
      const rateBcv = rates?.bcv && rates.bcv > 0 ? rates.bcv : null;
      const rateOperating = rates?.operative && rates.operative > 0 ? rates.operative : null;
      const vesUnit = rateBcv ? fixed(new Decimal(item.unitRef).times(rateBcv)) : null;
      const cashUnit = vesUnit != null && rateOperating
        ? fixed(new Decimal(item.unitRef).times(rateBcv!).div(rateOperating)) : null;
      rows.push({
        item, name:item.description, imageUrl:null,
        unit:{bcv:item.unitRef,ves:vesUnit,divisas:cashUnit},
        subtotal:{
          bcv:amount(item.unitRef,item.quantity),
          ves:rateBcv ? fixed(new Decimal(item.unitRef).times(item.quantity).times(rateBcv)) : null,
          divisas:rateBcv && rateOperating
            ? fixed(new Decimal(item.unitRef).times(item.quantity).times(rateBcv).div(rateOperating)) : null
        }
      });
    }
  }
  const sum = (key:keyof SalesQuoteMoney) => rows.some(row=>row.subtotal[key] == null)
    ? null : fixed(rows.reduce((acc,row)=>acc.plus(row.subtotal[key]!),new Decimal(0)));
  return {lines:rows,missing,total:{bcv:sum("bcv"),ves:sum("ves"),divisas:sum("divisas")}};
}

export function quoteCustomerMessage(
  rows: SalesQuoteResolvedLine[],
  total: SalesQuoteMoney,
  currencies: ShareCurrencies = DEFAULT_SHARE_CURRENCIES
) {
  const keys = (["ves","bcv","divisas"] as const).filter(key => currencies[key]);
  if (!rows.length || !keys.length || keys.some(key=>total[key]==null) ||
    rows.some(row => keys.some(key=>row.subtotal[key] == null))) return "";
  const format = (value:number,key:keyof ShareCurrencies) => {
    const formatted = value.toLocaleString("es-VE",{minimumFractionDigits:2,maximumFractionDigits:2});
    return key==="ves" ? "Bs. "+formatted : key==="bcv" ? "$"+formatted+" BCV" : "$"+formatted+" divisas";
  };
  const items=rows.flatMap((row,index)=>[
    String(index+1)+". *"+row.name+"*"+(row.item.quantity===1?"":" · "+row.item.quantity.toLocaleString("es-VE")+" uds."),
    "   "+keys.map(key=>format(row.subtotal[key]!,key)).join("  ·  ")
  ]);
  return [
    "¡Hola! 👋🧡",
    "¡Gracias por escribir a *Lubricenter Cabudare*! Te compartimos la cotización que preparamos para ti.",
    "",
    "*Productos y precios:*",
    ...items,
    "",
    "*Total:* "+keys.map(key=>format(total[key]!,key)).join("  ·  "),
    "",
    "¿Te gustaría que coordinemos tu visita? ¡Será un gusto atenderte! 🚗",
    "*Lubricenter Cabudare* 🧡"
  ].join("\n");
}

/** Prepara traspaso al carrito de venta rápida: valida valores contra el catálogo recién cargado allí. */
export function toQuickSaleLines(lines: SalesQuoteLine[]) {
  return sanitizeQuoteLines(lines).map(line => line.kind==="CATALOG"
    ? {kind:"CATALOG" as const,productId:line.productId,quantity:line.quantity}
    : {kind:"MANUAL" as const,description:line.description,quantity:line.quantity,unitRef:line.unitRef});
}

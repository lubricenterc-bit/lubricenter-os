// Ingresar mercancía: tipos y cálculos de la hoja de compra.
// Las reglas (costo promedio, idempotencia, factura repetida) viven en la base:
// purchase_invoice_and_receive y purchasing_item_search.

export type PurchasingItem = {
  id: string; sku: string; display_name: string; description: string; brand: string | null; brand_key: string | null;
  category: string | null; unit: string | null; stock: number; average_cost_ref: number | null;
  last_purchase_cost_ref: number | null; price_usd: number | null; bought_from_supplier: boolean; last_bought_at: string | null;
};

export type BrandOption = { brand_key: string; name: string; items: number };

export type EntryLine =
  | { key: string; type: "INVENTORY"; item: PurchasingItem; quantity: number | null; unit_cost: number | null }
  | { key: string; type: "EXPENSE"; description: string; category: string; quantity: number | null; unit_cost: number | null };

/** Rubros del inventario (inventory_items.category). */
export const CATEGORIES = [
  "Aceite Motor", "Filtro Aceite", "Filtro Aire", "Filtro Gasolina", "Filtro Cabina", "Refrigerante",
  "Aceite Hidraulico", "Limpiadores", "Aceite Motos", "Pila Gasolina", "Liga", "Valvulina", "Otros",
] as const;

export function brandKey(brand: string | null | undefined): string {
  return (brand ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Código sugerido para un artículo nuevo: 3 letras de la marca + palabras clave del nombre. */
export function suggestCode(brand: string, name: string): string {
  const b = brandKey(brand).slice(0, 3);
  const words = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
    .filter(w => brandKey(w) !== brandKey(brand));
  const visc = words.find(w => /^\d{1,2}W\d{2}$/.test(w));
  const rest = words.filter(w => w !== visc).map(w => (/\d/.test(w) ? w : w.slice(0, 3))).slice(0, 2);
  const parts = [b, ...(visc ? [visc] : []), ...rest].filter(Boolean);
  return parts.length >= 2 ? parts.join("-").slice(0, 40) : "";
}

export function lineTotal(line: { quantity: number | null; unit_cost: number | null }): number {
  return (line.quantity ?? 0) * (line.unit_cost ?? 0);
}

export function entryTotals(lines: EntryLine[], tax: number | null, freight: number | null, discount: number | null) {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  return { subtotal, total: subtotal + (tax ?? 0) + (freight ?? 0) - (discount ?? 0) };
}

/** Costo unitario en REF de una línea (para mostrar el costo promedio nuevo). */
export function unitCostRef(unitCost: number, currency: "USD" | "VES", bcv: number): number {
  return currency === "USD" ? unitCost : bcv > 0 ? unitCost / bcv : 0;
}

/** Mismo cálculo que inventory_receive_purchase: promedio ponderado con la existencia actual. */
export function newAverageCost(stock: number, average: number | null, qty: number, costRef: number): number {
  const prev = Math.max(stock, 0);
  if (prev <= 0) return round4(costRef);
  return round4((prev * (average ?? 0) + qty * costRef) / (prev + qty));
}

function round4(n: number) { return Math.round(n * 10000) / 10000; }

export type LineIssue = string | null;

export function lineIssue(line: EntryLine): LineIssue {
  if (!line.quantity || line.quantity <= 0) return "Falta la cantidad";
  if (line.unit_cost === null || line.unit_cost < 0) return "Falta el costo";
  if (line.type === "EXPENSE" && !line.description.trim()) return "Describe el gasto";
  return null;
}

/** Líneas en el formato de create_supplier_invoice. */
export function invoiceItems(lines: EntryLine[]) {
  return lines.map(l => l.type === "INVENTORY"
    ? { line_type: "INVENTORY", inventory_item_id: l.item.id, description: l.item.display_name, quantity: l.quantity, unit_cost: l.unit_cost }
    : { line_type: "EXPENSE", description: l.description.trim(), expense_category: l.category.trim() || null, quantity: l.quantity, unit_cost: l.unit_cost });
}

export const DRAFT_KEY = "lubricenter:goods-entry-draft";

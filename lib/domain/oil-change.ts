export type OilPickerItem = {
  source: "INVENTORY" | "CATALOG" | "MANUAL";
  category: string | null;
  sku: string;
  brand: string | null;
  description: string;
  catalog_product_name: string | null;
  product_id: string | null;
  quantity_on_hand: number;
};

const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const itemText = (item: OilPickerItem) => normalized(`${item.category ?? ""} ${item.sku} ${item.brand ?? ""} ${item.description} ${item.catalog_product_name ?? ""}`);

export function isOilFilter(item: OilPickerItem): boolean {
  const text = itemText(item);
  return text.includes("filtro") && text.includes("aceite");
}

export function isOilCandidate(item: OilPickerItem): boolean {
  if (isOilFilter(item)) return false;
  const text = itemText(item);
  return normalized(item.category ?? "").startsWith("aceite") || /\baceite\b/.test(text)
    || /\b\d{1,2}\s*w\s*[-/]?\s*\d{2}\b/.test(text) || /\bsae\s*\d{1,2}\b/.test(text);
}

/**
 * Si se pide más de lo que hay en stock, quien puede vender sin inventario sigue por catálogo o a mano;
 * con inventario estricto y sin ese permiso la venta se queda en inventario y la base la rechaza por stock.
 */
export function saleSource(item: OilPickerItem, units: number, availableCatalogIds: Set<string>, allowFallback = true): OilPickerItem["source"] {
  if (item.source !== "INVENTORY" || units <= item.quantity_on_hand || !allowFallback) return item.source;
  return item.product_id && availableCatalogIds.has(item.product_id) ? "CATALOG" : "MANUAL";
}

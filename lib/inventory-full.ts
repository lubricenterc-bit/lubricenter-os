/** Fila de get_inventory_full: un artículo de inventario con todo lo editable. */
export type InventoryFullRow = {
  id: string;
  sku: string;
  display_name: string | null;
  description: string;
  brand: string | null;
  category: string | null;
  unit: string;
  quantity_on_hand: number;
  movement_count: number;
  last_movement_at: string | null;
  last_counted_at: string | null;
  price_usd: number | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  price_updated_at: string | null;
  average_cost_ref: number | null;
  last_purchase_cost_ref: number | null;
  last_purchased_at: string | null;
  source_cost_ref: number | null;
  cost_missing: boolean;
  needs_review: boolean;
  active: boolean;
  in_catalog: boolean;
  merged_into: string | null;
  merged_into_sku: string | null;
  alt_codes: string[];
  image_url: string | null;
  product_id: string | null;
  updated_at: string | null;
};

export type InventoryFilter =
  | "all" | "stock" | "out" | "never" | "negative" | "no_price" | "catalog" | "not_catalog" | "archived";

type StockFields = Pick<InventoryFullRow, "quantity_on_hand" | "movement_count" | "active" | "merged_into">;
type FilterFields = StockFields & Pick<InventoryFullRow, "price_usd" | "in_catalog">;

/** Estado de existencia que se muestra en la fila. */
export function inventoryState(r: StockFields): { label: string; tone: string } {
  if (r.merged_into) return { label: "Fusionado", tone: "is-muted" };
  if (!r.active) return { label: "Archivado", tone: "is-muted" };
  if (r.quantity_on_hand < 0) return { label: "Negativo", tone: "is-crit" };
  if (r.quantity_on_hand > 0) return { label: "Con existencia", tone: "is-ok" };
  if (r.movement_count === 0) return { label: "Nunca ingresó", tone: "is-warn" };
  return { label: "Agotado", tone: "is-muted" };
}

export const INVENTORY_FILTERS: readonly { id: InventoryFilter; label: string; hint: string }[] = [
  { id: "all", label: "Todos", hint: "Todos los artículos, también archivados y fusionados" },
  { id: "stock", label: "Con existencia", hint: "Activos con cantidad mayor que cero" },
  { id: "out", label: "Agotados", hint: "Activos que tuvieron movimientos y hoy están en cero" },
  { id: "never", label: "Nunca ingresó", hint: "Activos sin ningún movimiento: no existen físicamente" },
  { id: "negative", label: "Negativos", hint: "Se vendió más de lo que había: hay que contarlos" },
  { id: "no_price", label: "Sin precio", hint: "Activos sin precio de venta" },
  { id: "catalog", label: "En catálogo", hint: "Se muestran en el catálogo y los cotizadores" },
  { id: "not_catalog", label: "Fuera del catálogo", hint: "Activos que no se muestran en el catálogo" },
  { id: "archived", label: "Archivados", hint: "Inactivos o fusionados con otro artículo" },
];

export function matchesInventoryFilter(r: FilterFields, filter: InventoryFilter): boolean {
  const live = r.active && !r.merged_into;
  switch (filter) {
    case "all": return true;
    case "stock": return live && r.quantity_on_hand > 0;
    case "out": return live && r.quantity_on_hand === 0 && r.movement_count > 0;
    case "never": return live && r.quantity_on_hand === 0 && r.movement_count === 0;
    case "negative": return live && r.quantity_on_hand < 0;
    case "no_price": return live && !((r.price_usd ?? 0) > 0);
    case "catalog": return live && r.in_catalog;
    case "not_catalog": return live && !r.in_catalog;
    case "archived": return !live;
  }
}

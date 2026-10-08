export type CatalogProduct = {
  id: string;
  name: string;
  category: string | null;
  available: boolean;
  active: boolean;
  cash_usd_base_price: number | null;
  current_price_ves: number | null;
  current_ref_bcv: number | null;
  image_url: string | null;
  catalog_source: string | null;
  catalog_synced_at: string | null;
};

export type CatalogSort = "name" | "divisas-low" | "divisas-high" | "bcv-low" | "bcv-high";
export type CatalogFilters = {
  query: string;
  category: string;
  imagesOnly: boolean;
  sort: CatalogSort;
};

export type CatalogSync = {
  catalogSyncedAt: string | null;
  catalogProducts: number;
  bcv: number | null;
  bcvEffectiveAt: string | null;
  operative: number | null;
  operativeEffectiveAt: string | null;
};

function parseNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function safeCatalogImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeCatalogProduct(value: Record<string, unknown>): CatalogProduct {
  return {
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name.trim() : "",
    category: typeof value.category === "string" && value.category.trim() ? value.category.trim() : null,
    available: value.available === true,
    active: value.active === true,
    cash_usd_base_price: parseNumber(value.cash_usd_base_price),
    current_price_ves: parseNumber(value.current_price_ves),
    current_ref_bcv: parseNumber(value.current_ref_bcv),
    image_url: safeCatalogImageUrl(value.image_url),
    catalog_source: typeof value.catalog_source === "string" ? value.catalog_source : null,
    catalog_synced_at: typeof value.catalog_synced_at === "string" ? value.catalog_synced_at : null,
  };
}

export function normalizeCatalogSync(value: Record<string, unknown> | null | undefined): CatalogSync | null {
  if (!value) return null;
  const asText = (v: unknown) => typeof v === "string" ? v : null;
  return {
    catalogSyncedAt: asText(value.catalog_synced_at),
    catalogProducts: parseNumber(value.catalog_products) ?? 0,
    bcv: parseNumber(value.bcv_rate),
    bcvEffectiveAt: asText(value.bcv_effective_at),
    operative: parseNumber(value.operative_rate),
    operativeEffectiveAt: asText(value.operative_effective_at),
  };
}

export const normalizeCatalogSearch = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-VE").trim();

export function filterCatalog(products: CatalogProduct[], filters: CatalogFilters) {
  const term = normalizeCatalogSearch(filters.query);
  return products.filter(product => {
    if (!product.active || !product.available) return false;
    if (filters.category !== "TODAS" && (product.category || "Sin categoría") !== filters.category) return false;
    if (filters.imagesOnly && !product.image_url) return false;
    if (!term) return true;
    return normalizeCatalogSearch([product.name, product.category ?? ""].join(" ")).includes(term);
  }).sort((left, right) => {
    const alphabet = left.name.localeCompare(right.name, "es-VE", { numeric: true });
    if (filters.sort === "name") return alphabet;
    const field = filters.sort.startsWith("divisas") ? "cash_usd_base_price" : "current_ref_bcv";
    const direction = filters.sort.endsWith("low") ? 1 : -1;
    const l = left[field];
    const r = right[field];
    if (l == null && r == null) return alphabet;
    if (l == null) return 1;
    if (r == null) return -1;
    return (l - r) * direction || alphabet;
  });
}

export function catalogIsFresh(sync: CatalogSync | null, nowMs = Date.now()) {
  if (!sync?.catalogSyncedAt || !sync?.bcvEffectiveAt || !sync?.operativeEffectiveAt) return false;
  const ages = [
    nowMs - new Date(sync.catalogSyncedAt).getTime(),
    nowMs - new Date(sync.bcvEffectiveAt).getTime(),
    nowMs - new Date(sync.operativeEffectiveAt).getTime(),
  ];
  return ages.every((v, index) => Number.isFinite(v) && v >= -300000 && v <= (index === 0 ? 24 : 3) * 3600000);
}

export function formatCatalogDate(value: string | null) {
  if (!value) return "Sin sincronizar";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Fecha no disponible";
  return d.toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

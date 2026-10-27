const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cada palabra buscada debe aparecer en el texto. Los códigos se comparan también sin
 * guiones ni espacios, para que "AL20004" encuentre "AL-20004" y "gl 3900" encuentre "GL-3900".
 */
export function matchesSearch(value: string, query: string) {
  const haystack = normalize(value);
  const compact = haystack.replace(/ /g, "");
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.every(token => haystack.includes(token) || compact.includes(token))) return true;
  const joined = tokens.join("");
  return tokens.length > 1 && joined.length >= 3 && compact.includes(joined);
}

type SearchableInventoryItem = {
  sku: string;
  brand?: string | null;
  description?: string | null;
  category?: string | null;
  catalog_product_name?: string | null;
  alt_codes?: string[] | null;
};

/** Texto con el que se busca un artículo de inventario, incluidos sus códigos alternos (etiqueta o conteo). */
export function inventorySearchText(item: SearchableInventoryItem) {
  return [item.sku, item.brand, item.description, item.catalog_product_name, item.category, ...(item.alt_codes ?? [])]
    .filter(Boolean)
    .join(" ");
}

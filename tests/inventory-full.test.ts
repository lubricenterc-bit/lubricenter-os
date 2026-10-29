import { describe, expect, it } from "vitest";
import { inventoryState, matchesInventoryFilter, INVENTORY_FILTERS } from "../lib/inventory-full";

const base = { quantity_on_hand: 0, movement_count: 0, active: true, merged_into: null as string | null, price_usd: null as number | null, in_catalog: false };

describe("inventario completo", () => {
  it("distingue agotado de nunca ingresó", () => {
    expect(inventoryState({ ...base, movement_count: 3 }).label).toBe("Agotado");
    expect(inventoryState(base).label).toBe("Nunca ingresó");
    expect(inventoryState({ ...base, quantity_on_hand: -2, movement_count: 1 }).label).toBe("Negativo");
    expect(inventoryState({ ...base, quantity_on_hand: 4, movement_count: 1 }).label).toBe("Con existencia");
    expect(inventoryState({ ...base, active: false }).label).toBe("Archivado");
    expect(inventoryState({ ...base, merged_into: "x" }).label).toBe("Fusionado");
  });

  it("«Todos» incluye archivados y los demás filtros solo activos", () => {
    const archived = { ...base, active: false, quantity_on_hand: 5, movement_count: 1 };
    expect(matchesInventoryFilter(archived, "all")).toBe(true);
    expect(matchesInventoryFilter(archived, "stock")).toBe(false);
    expect(matchesInventoryFilter(archived, "archived")).toBe(true);
  });

  it("cada artículo activo cae en exactamente un estado de existencia", () => {
    const cases = [
      { ...base, quantity_on_hand: 3, movement_count: 2 },
      { ...base, quantity_on_hand: 0, movement_count: 2 },
      { ...base, quantity_on_hand: 0, movement_count: 0 },
      { ...base, quantity_on_hand: -1, movement_count: 2 },
    ];
    for (const c of cases) {
      const hits = (["stock", "out", "never", "negative"] as const).filter(f => matchesInventoryFilter(c, f));
      expect(hits).toHaveLength(1);
    }
  });

  it("catálogo y sin precio", () => {
    const priced = { ...base, price_usd: 6.5, in_catalog: true };
    expect(matchesInventoryFilter(priced, "catalog")).toBe(true);
    expect(matchesInventoryFilter(priced, "no_price")).toBe(false);
    expect(matchesInventoryFilter(base, "not_catalog")).toBe(true);
    expect(INVENTORY_FILTERS[0].id).toBe("all");
  });
});

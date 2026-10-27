import { describe, expect, it } from "vitest";
import { inventorySearchText, matchesSearch } from "../lib/domain/search";

const cabina = { sku: "TOY-KAVAK-FILHABI", brand: "G/N", description: "Filtro Aire habitaculo Toyota Kavak", category: "Filtro Cabina", catalog_product_name: null, alt_codes: ["CC006", "Rav4", "cabina"] };
const a1 = { sku: "AL-20004", brand: "A1", description: "Filtro de Aceite A1 AL-20004", category: "Filtro Aceite", catalog_product_name: "Filtro A1" };

describe("búsqueda de inventario", () => {
  it("encuentra un artículo por su código de conteo", () => {
    expect(matchesSearch(inventorySearchText(cabina), "CC006")).toBe(true);
    expect(matchesSearch(inventorySearchText(cabina), "cc 006")).toBe(true);
    expect(matchesSearch(inventorySearchText(cabina), "rav4")).toBe(true);
  });

  it("compara los códigos sin guiones ni espacios", () => {
    expect(matchesSearch(inventorySearchText(a1), "AL20004")).toBe(true);
    expect(matchesSearch(inventorySearchText(a1), "al-20004")).toBe(true);
    expect(matchesSearch(inventorySearchText(a1), "filtro a1")).toBe(true);
  });

  it("no encuentra lo que no está", () => {
    expect(matchesSearch(inventorySearchText(cabina), "CC007")).toBe(false);
    expect(matchesSearch(inventorySearchText(a1), "AL20005")).toBe(false);
  });

  it("acepta artículos sin códigos alternos", () => {
    expect(inventorySearchText({ sku: "X", alt_codes: null })).toBe("X");
  });
});

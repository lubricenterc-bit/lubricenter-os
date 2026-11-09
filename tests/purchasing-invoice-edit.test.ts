import { describe, expect, it } from "vitest";
import { editItems, editLineIssue, receivedAfterEdit, stockChanges, type EditLine } from "@/lib/purchasing";

const base: EditLine = {
  key: "k", lineId: "l1", type: "INVENTORY", itemId: "A", name: "Motul 4100", sku: "MOT-4100",
  description: "", category: "", quantity: 12, unit_cost: 11.66, received: 12, ordered: 12,
};

describe("editar factura de proveedor", () => {
  it("lo recibido sigue a la cantidad si la línea estaba completa", () => {
    expect(receivedAfterEdit(12, 12, 10)).toBe(10);
    expect(receivedAfterEdit(12, 12, 15)).toBe(15);
  });
  it("si estaba recibida a medias, lo recibido solo puede bajar", () => {
    expect(receivedAfterEdit(5, 12, 10)).toBe(5);
    expect(receivedAfterEdit(5, 12, 3)).toBe(3);
    expect(receivedAfterEdit(0, 12, 3)).toBe(0);
  });
  it("calcula el ajuste de existencia", () => {
    expect(stockChanges({ ...base, quantity: 10 }, "A")).toEqual([{ itemId: "A", delta: -2 }]);
    expect(stockChanges({ ...base, unit_cost: 12 }, "A")).toEqual([]);
    expect(stockChanges({ ...base, itemId: "B" }, "A")).toEqual([{ itemId: "A", delta: -12 }, { itemId: "B", delta: 12 }]);
    expect(stockChanges({ ...base, received: 0 }, "A")).toEqual([]);
  });
  it("valida y arma el formato de la base", () => {
    expect(editLineIssue({ ...base, quantity: null })).toBe("Falta la cantidad");
    expect(editLineIssue({ ...base, itemId: null })).toBe("Elige el producto");
    expect(editLineIssue(base)).toBeNull();
    const exp: EditLine = { ...base, key: "e", lineId: null, type: "EXPENSE", itemId: null, description: " Flete ", category: "", quantity: 1, unit_cost: 5, received: 0, ordered: 0 };
    expect(editItems([base, exp])).toEqual([
      { id: "l1", line_type: "INVENTORY", inventory_item_id: "A", description: "Motul 4100", quantity: 12, unit_cost: 11.66 },
      { id: null, line_type: "EXPENSE", description: "Flete", expense_category: null, quantity: 1, unit_cost: 5 },
    ]);
  });
});

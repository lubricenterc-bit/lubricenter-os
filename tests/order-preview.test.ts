import { describe, expect, it, vi } from "vitest";
import { collectedShare, createPreviewCache, installmentLabel, neighbor, type OrderPreview } from "@/lib/order-preview";

const preview = (id: string, total = 100, pending = 0) => ({
  order: { id }, totals: { ref: total, pending_ref: pending },
}) as unknown as OrderPreview;

describe("vista previa de órdenes", () => {
  it("recorre la lista con ↑/↓ sin salirse de los extremos", () => {
    const ids = ["a", "b", "c"];
    expect(neighbor(ids, "b", 1)).toBe("c");
    expect(neighbor(ids, "b", -1)).toBe("a");
    expect(neighbor(ids, "c", 1)).toBeNull();
    expect(neighbor(ids, "a", -1)).toBeNull();
    expect(neighbor(ids, "x", 1)).toBeNull();
    expect(neighbor(ids, null, 1)).toBeNull();
  });

  it("barra cobrado / pendiente entre 0 y 1", () => {
    expect(collectedShare(preview("a", 27.32, 16.39))).toBeCloseTo(0.4, 2);
    expect(collectedShare(preview("a", 50, 0))).toBe(1);
    expect(collectedShare(preview("a", 0, 0))).toBe(0);
    expect(collectedShare(preview("a", 10, 30))).toBe(0);
  });

  it("estado de cada cuota en palabras", () => {
    expect(installmentLabel({ status: "PAID", overdue: false, paid_ref: 5, amount_ref: 5 })).toBe("Pagada");
    expect(installmentLabel({ status: "PENDING", overdue: true, paid_ref: 0, amount_ref: 5 })).toBe("Vencida");
    expect(installmentLabel({ status: "PARTIAL", overdue: false, paid_ref: 2, amount_ref: 5 })).toBe("Parcial");
    expect(installmentLabel({ status: "PENDING", overdue: false, paid_ref: 0, amount_ref: 5 })).toBe("Por vencer");
  });

  it("la caché consulta una vez por orden y comparte la consulta en curso", async () => {
    const fetcher = vi.fn(async (id: string) => preview(id));
    const cache = createPreviewCache(fetcher);
    const [a, b] = await Promise.all([cache.load("x"), cache.load("x")]);
    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.peek("x")?.order.id).toBe("x");
    await cache.load("x");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.load("x", true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.age("x")).toBeLessThan(1000);
    expect(cache.age("nada")).toBe(Infinity);
  });

  it("un error no queda guardado: el siguiente intento vuelve a consultar", async () => {
    let fail = true;
    const fetcher = vi.fn(async (id: string) => { if (fail) throw new Error("sin red"); return preview(id); });
    const cache = createPreviewCache(fetcher);
    await expect(cache.load("y")).rejects.toThrow("sin red");
    fail = false;
    await expect(cache.load("y")).resolves.toMatchObject({ order: { id: "y" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

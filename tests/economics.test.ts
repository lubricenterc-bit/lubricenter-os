import { describe, expect, it } from "vitest";
import {
  casheaSurchargePercent, distributeCartAdjustment, previewAdjustments, restoreCartPrices, roundTarget,
} from "../lib/domain/economics";

describe("redondeo en $", () => {
  it("↓ entero, 0,50 y ↑ entero", () => {
    expect(roundTarget(47.63, "DOWN")).toBe(47);
    expect(roundTarget(47.63, "HALF")).toBe(47.5);
    expect(roundTarget(47.8, "HALF")).toBe(48);
    expect(roundTarget(47.63, "UP")).toBe(48);
    expect(roundTarget(47, "UP")).toBe(47);
  });
});

describe("descuento y redondeo", () => {
  it("aplica primero el descuento y después el redondeo", () => {
    // Igual que la prueba contra la base: 103 REF, 5% y 0,50 → 98.
    const p = previewAdjustments(103, 5, "HALF");
    expect(p.discount).toBe(5.15);
    expect(p.total).toBe(98);
    expect(p.rounding).toBeCloseTo(0.15, 4);
  });
  it("no descuenta sobre el recargo Cashea", () => {
    expect(previewAdjustments(109.29, 10, "NONE", 9.29).discount).toBe(10);
  });
});

describe("recargo Cashea", () => {
  it("con 40% de inicial, 45 días y 5% mensual da 9,29%", () => {
    expect(casheaSurchargePercent({ commissionPercent: 4, initialPercent: 40, monthlyOpportunityPercent: 5, financingDays: 45 })).toBeCloseTo(9.2896, 4);
  });
  it("solo comisión da 4,17%", () => {
    expect(casheaSurchargePercent({ commissionPercent: 4, initialPercent: 40, monthlyOpportunityPercent: 0, financingDays: 45 })).toBeCloseTo(4.1667, 4);
  });
});

describe("venta rápida: reparto del ajuste", () => {
  const cart = [
    { key: "a", quantity: 4, unit_ref: 15 },   // 60
    { key: "b", quantity: 1, unit_ref: 5 },    // 5
  ];
  it("cuadra el total exacto y recuerda el precio de lista", () => {
    const out = distributeCartAdjustment(cart, 62);
    const total = out.reduce((n, l) => n + l.quantity * l.unit_ref, 0);
    expect(total).toBeCloseTo(62, 3);
    expect(out[0].listUnitRef).toBe(15);
    expect(restoreCartPrices(out).map(l => l.unit_ref)).toEqual([15, 5]);
  });
  it("vuelve a partir del precio de lista si se ajusta dos veces", () => {
    const once = distributeCartAdjustment(cart, 62);
    const twice = distributeCartAdjustment(once, 65);
    expect(twice.map(l => l.unit_ref)).toEqual([15, 5]);
  });
});

import { describe, expect, it } from "vitest";
import { amountToSettle, appliedToInvoice, exceedsOutstanding, settlesInvoice } from "@/lib/supplier-payment";

// Tasas reales del 5 nov 2026 y la factura de la simulación de 3 meses (24 filtros a 2,10).
const bcv = 894.8876, op = 1061.32, outstanding = 50.4;

describe("pago a proveedor: espejo de record_supplier_payment", () => {
  it("pagar el saldo en dólares de caja tal cual lo rechaza el servidor (lo que vio la simulación)", () => {
    const applied = appliedToInvoice(50.4, "USD", "USD", bcv, op);
    expect(applied).toBeCloseTo(59.7735, 3);
    expect(exceedsOutstanding(applied, outstanding, "USD")).toBe(true);
  });

  it("el monto sugerido desde Caja USD salda la factura sin pasarse", () => {
    const settle = amountToSettle(outstanding, "USD", "USD", bcv, op);
    expect(settle).toBe(42.5);
    const applied = appliedToInvoice(settle, "USD", "USD", bcv, op);
    expect(exceedsOutstanding(applied, outstanding, "USD")).toBe(false);
    expect(settlesInvoice(applied, outstanding, "USD")).toBe(true);
  });

  it("desde una cuenta en bolívares la factura en USD se paga a tasa BCV", () => {
    const settle = amountToSettle(outstanding, "VES", "USD", bcv, op);
    expect(settle).toBeCloseTo(45102.34, 2);
    const applied = appliedToInvoice(settle, "VES", "USD", bcv, op);
    expect(settlesInvoice(applied, outstanding, "USD")).toBe(true);
    expect(exceedsOutstanding(applied, outstanding, "USD")).toBe(false);
  });

  it("factura en bolívares pagada con dólares: el céntimo más alto que acepta el servidor deja pocos Bs", () => {
    const settle = amountToSettle(10000, "USD", "VES", bcv, op);
    expect(settle).toBe(9.42);
    const applied = appliedToInvoice(settle, "USD", "VES", bcv, op);
    expect(exceedsOutstanding(applied, 10000, "VES")).toBe(false);
    expect(exceedsOutstanding(appliedToInvoice(9.43, "USD", "VES", bcv, op), 10000, "VES")).toBe(true);
    expect(10000 - applied).toBeLessThan(op / 100);
  });

  it("nunca sugiere un monto que el servidor rechace, para cualquier saldo", () => {
    for (let cents = 1; cents <= 20000; cents += 7) {
      const owed = cents / 100;
      for (const [account, invoice] of [["USD", "USD"], ["VES", "USD"], ["USD", "VES"], ["VES", "VES"]] as const) {
        const settle = amountToSettle(owed, account, invoice, bcv, op);
        expect(exceedsOutstanding(appliedToInvoice(settle, account, invoice, bcv, op), owed, invoice)).toBe(false);
      }
      expect(settlesInvoice(appliedToInvoice(amountToSettle(owed, "USD", "USD", bcv, op), "USD", "USD", bcv, op), owed, "USD")).toBe(true);
    }
  });

  it("bolívares contra bolívares no convierte y respeta la tolerancia de Bs 1", () => {
    expect(appliedToInvoice(1234.567, "VES", "VES", bcv, op)).toBe(1234.57);
    expect(exceedsOutstanding(1001, 1000, "VES")).toBe(false);
    expect(exceedsOutstanding(1001.01, 1000, "VES")).toBe(true);
  });

  it("un abono parcial no salda la factura", () => {
    const applied = appliedToInvoice(20, "USD", "USD", bcv, op);
    expect(settlesInvoice(applied, outstanding, "USD")).toBe(false);
    expect(exceedsOutstanding(applied, outstanding, "USD")).toBe(false);
  });
});

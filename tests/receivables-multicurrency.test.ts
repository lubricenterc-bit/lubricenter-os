import { describe, expect, it } from "vitest";
import { currencyOf, debtMessage, payAllAmount, previewPayment, remaining } from "@/lib/finance/receivables";

// OS-000327: 29 REF = 24,25 $ divisas; BCV del día 888,1183.
const debt = { principal_ref: 29, principal_usd: 24.25, outstanding_fraction: 1 };
const bcv = 888.1183;

describe("deudas en REF y $ divisas", () => {
  it("muestra lo que falta en las tres formas", () => {
    expect(remaining(debt, bcv)).toEqual({ ref: 29, usd: 24.25, vesToday: 25755.43, percent: 100 });
  });

  it("un abono en Bs baja la deuda en REF al BCV del día", () => {
    const p = previewPayment(debt, "VES", 10000, bcv);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.closes).toBe(false);
    expect(p.after.ref).toBeCloseTo(17.74, 2);
    expect(p.after.usd).toBe(14.83);
  });

  it("Paga todo en Zelle cierra sin restos", () => {
    const half = { ...debt, outstanding_fraction: 0.611732371456712 };
    const all = payAllAmount(half, "USD", bcv)!;
    expect(all).toBe(14.83);
    const p = previewPayment(half, "USD", all, bcv);
    expect(p.ok && p.closes).toBe(true);
    if (p.ok) expect(p.after).toEqual({ ref: 0, usd: 0, vesToday: 0, percent: 0 });
  });

  it("cierra cuando el resto es menor a un céntimo (caso OS-000102)", () => {
    const os102 = { principal_ref: 74, principal_usd: 62.36, outstanding_fraction: 1 };
    const p = previewPayment(os102, "USD", 62.36, 881.8769);
    expect(p.ok && p.closes).toBe(true);
  });

  it("rechaza abonos mayores a lo que falta", () => {
    const p = previewPayment(debt, "USD", 24.27, bcv);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain("$24.25");
  });

  it("identifica la moneda por el método", () => {
    expect(currencyOf("ZELLE")).toBe("USD");
    expect(currencyOf("CASH_USD")).toBe("USD");
    expect(currencyOf("TRANSFER_BDV")).toBe("VES");
  });

  it("arma el mensaje de cobro", () => {
    const text = debtMessage("Ana", "OS-000327", debt, bcv);
    expect(text).toContain("$24,25");
    expect(text).toContain("Bs 25.755,43");
    expect(text).toContain("29,00 REF");
  });
});

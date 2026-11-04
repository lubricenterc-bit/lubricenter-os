import { describe, expect, it } from "vitest";
import { canonicalNumberText, formatLocaleNumber, parseLocaleNumber, readStoredNumber, stepValue } from "../lib/number-input";

describe("parseLocaleNumber", () => {
  it.each([
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["12,5", 12.5],
    ["12.5", 12.5],
    ["1.500", 1500],
    ["0,75", 0.75],
    ["-3", -3],
    ["  4 ", 4],
    ["$ 17,83", 17.83],
    ["Bs 1.234,5", 1234.5],
    ["35%", 35],
    ["17.5", 17.5],
    ["1.5", 1.5],
    [",5", 0.5],
  ])("%s → %s", (text, expected) => {
    expect(parseLocaleNumber(text)).toBe(expected);
  });

  it("vacío es null e inválido es NaN", () => {
    expect(parseLocaleNumber("")).toBeNull();
    expect(parseLocaleNumber("   ")).toBeNull();
    expect(parseLocaleNumber("abc")).toBeNaN();
    expect(parseLocaleNumber("1,2,3")).toBeNaN();
    expect(parseLocaleNumber("1.2.3,4.5")).toBeNaN();
    expect(parseLocaleNumber("-")).toBeNaN();
  });
});

describe("formatLocaleNumber", () => {
  it("cantidades sin ceros de más y montos con 2 decimales", () => {
    expect(formatLocaleNumber(106.9998, "qty")).toBe("107");
    expect(formatLocaleNumber(1.5, "qty")).toBe("1,5");
    expect(formatLocaleNumber(1500.5, "money")).toBe("1.500,50");
    expect(formatLocaleNumber(null, "money")).toBe("");
    expect(formatLocaleNumber(889.2612, "rate")).toBe("889,2612");
  });

  it("lo formateado se vuelve a leer igual", () => {
    for (const v of [0, 1, 1.5, 12.25, 1500, 1234567.89, 0.75]) {
      expect(parseLocaleNumber(formatLocaleNumber(v, "money"))).toBe(v);
    }
  });
});

describe("stepValue", () => {
  it("paso entero que conserva los decimales escritos", () => {
    expect(stepValue(1.5, 1, false)).toBe(2.5);
    expect(stepValue(2.5, -1, false)).toBe(1.5);
    expect(stepValue(0, -1, false, 0)).toBe(0);
    expect(stepValue(5, 1, true)).toBe(15);
    expect(stepValue(15, -1, true)).toBe(5);
    expect(stepValue(null, 1, false)).toBe(1);
    expect(stepValue(9, 1, true, 0, 12)).toBe(12);
    expect(stepValue(null, 1, false, 0.01)).toBe(1);
  });
});

describe("compatibilidad con formularios", () => {
  it("texto canónico con punto decimal", () => {
    expect(canonicalNumberText(1234.56)).toBe("1234.56");
    expect(canonicalNumberText(null)).toBe("");
    expect(readStoredNumber("12.5")).toBe(12.5);
    expect(readStoredNumber("")).toBeNull();
    expect(readStoredNumber(0)).toBe(0);
    expect(readStoredNumber(undefined)).toBeNull();
  });
});

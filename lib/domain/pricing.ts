import type { ProductPriceSnapshot, RateSnapshot } from "./types";

export type RoundingMode = "nearest" | "up" | "down";

export function roundToStep(value: number, step = 10, mode: RoundingMode = "nearest") {
  if (!Number.isFinite(value)) throw new Error("Valor no válido");
  if (step <= 0) return value;
  const q = value / step;
  if (mode === "up") return Math.ceil(q) * step;
  if (mode === "down") return Math.floor(q) * step;
  return Math.round(q) * step;
}

export function productPriceSnapshot(
  cashUsdBase: number,
  rates: RateSnapshot,
  roundingStep = 10,
  roundingMode: RoundingMode = "nearest",
): ProductPriceSnapshot {
  if (cashUsdBase < 0) throw new Error("El precio en divisas no puede ser negativo");
  if (rates.bcv <= 0 || rates.operative <= 0) throw new Error("Las tasas deben ser mayores que cero");

  const ves = roundToStep(cashUsdBase * rates.operative, roundingStep, roundingMode);
  const refBcv = ves / rates.bcv;

  return {
    cashUsd: cashUsdBase,
    ves,
    refBcv,
    rates,
  };
}

export function paymentValueInVes(
  amountOriginal: number,
  currency: "USD" | "VES",
  rates: RateSnapshot,
) {
  if (amountOriginal < 0) throw new Error("El pago no puede ser negativo");
  if (currency === "VES") return amountOriginal;
  return amountOriginal * rates.operative;
}

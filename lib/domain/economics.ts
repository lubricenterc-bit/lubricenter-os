import Decimal from "decimal.js";

/**
 * Reglas de cobro compartidas por Orden y Venta rápida.
 * La base de datos aplica las mismas reglas en apply_order_adjustments y set_cashea_surcharge;
 * aquí sirven para la vista previa y para el carrito de Venta rápida.
 */
export type RoundingMode = "NONE" | "DOWN" | "HALF" | "UP";

export const ROUNDING_OPTIONS: { mode: RoundingMode; label: string; hint: string }[] = [
  { mode: "DOWN", label: "↓ Entero", hint: "Baja al entero de abajo" },
  { mode: "HALF", label: "0,50", hint: "Al múltiplo de 0,50 más cercano" },
  { mode: "UP", label: "↑ Entero", hint: "Sube al entero de arriba" },
];

export const DISCOUNT_REASONS = ["Cliente frecuente", "Familia / amigo", "Compensación", "Otro"] as const;

const D = (n: number | string) => new Decimal(n);

export function roundTarget(total: number, mode: RoundingMode): number {
  const t = D(total);
  switch (mode) {
    case "DOWN": return t.floor().toNumber();
    case "UP": return t.ceil().toNumber();
    case "HALF": return t.mul(2).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).div(2).toNumber();
    default: return t.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  }
}

export type AdjustmentPreview = {
  subtotal: number; discount: number; afterDiscount: number; rounding: number; total: number;
};

/** Primero el descuento (sobre el total sin recargo Cashea) y después el redondeo. */
export function previewAdjustments(
  subtotal: number, discountPercent: number, mode: RoundingMode, casheaSurcharge = 0,
): AdjustmentPreview {
  const discount = discountPercent > 0
    ? D(subtotal).minus(casheaSurcharge).mul(discountPercent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()
    : 0;
  const afterDiscount = D(subtotal).minus(discount).toNumber();
  const total = roundTarget(afterDiscount, mode);
  return { subtotal, discount, afterDiscount, rounding: D(total).minus(afterDiscount).toNumber(), total };
}

/** Recargo Cashea sobre la mano de obra: cubre la comisión y el costo de esperar las cuotas. */
export function casheaSurchargePercent(opts: {
  commissionPercent: number; initialPercent: number; monthlyOpportunityPercent: number; financingDays: number;
}) {
  const financed = Math.max(0, 1 - opts.initialPercent / 100);
  const keep = 1 - opts.commissionPercent / 100 - financed * (opts.monthlyOpportunityPercent / 100) * (opts.financingDays / 30);
  if (keep <= 0) return null;
  return D(1).div(keep).minus(1).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
}

export type CartAdjustLine = { key: string; quantity: number; unit_ref: number; listUnitRef?: number };

/**
 * Venta rápida: reparte el ajuste (descuento + redondeo) entre los precios unitarios
 * en proporción al subtotal de cada línea, sin dejar ninguna en cero, y garantiza que la
 * suma cuadre con el total buscado a 4 decimales.
 */
export function distributeCartAdjustment<T extends CartAdjustLine>(lines: T[], targetTotal: number): T[] {
  const base = lines.map(l => ({ l, list: l.listUnitRef ?? l.unit_ref }));
  const subtotal = base.reduce((acc, x) => acc.plus(D(x.list).mul(x.l.quantity)), D(0));
  if (subtotal.lte(0)) return lines;
  const delta = D(targetTotal).minus(subtotal);
  let left = delta;
  return base.map((x, index) => {
    const lineTotal = D(x.list).mul(x.l.quantity);
    const share = index === base.length - 1 ? left : delta.mul(lineTotal).div(subtotal).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    left = left.minus(share);
    const newUnit = lineTotal.plus(share).div(x.l.quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    return { ...x.l, listUnitRef: x.list, unit_ref: Math.max(0.0001, newUnit.toNumber()) };
  });
}

export function restoreCartPrices<T extends CartAdjustLine>(lines: T[]): T[] {
  return lines.map(l => l.listUnitRef == null ? l : { ...l, unit_ref: l.listUnitRef, listUnitRef: undefined });
}

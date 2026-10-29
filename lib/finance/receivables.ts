import { D } from "./money";

/**
 * Deudas en dos monedas (REF BCV y $ divisas) con la parte pendiente como fracción.
 * Es el mismo cálculo que hace public.record_receivable_payment en la base de datos;
 * aquí solo sirve para mostrar montos y la vista previa del abono.
 */
export type ReceivableBalance = {
  principal_ref: number | string;
  principal_usd: number | string | null;
  outstanding_fraction: number | string;
};
export type PayCurrency = "USD" | "VES";

export const USD_METHODS = ["CASH_USD", "ZELLE", "BINANCE"] as const;
export const currencyOf = (method: string): PayCurrency =>
  (USD_METHODS as readonly string[]).includes(method) ? "USD" : "VES";

const r2 = (n: InstanceType<typeof D>) => Number(n.toDecimalPlaces(2, D.ROUND_HALF_UP).toString());

export function remaining(balance: ReceivableBalance, bcvToday: number) {
  const f = new D(balance.outstanding_fraction ?? 0);
  const ref = f.mul(balance.principal_ref ?? 0);
  const usd = balance.principal_usd == null ? null : f.mul(balance.principal_usd);
  return {
    ref: r2(ref),
    usd: usd == null ? null : r2(usd),
    vesToday: bcvToday > 0 ? r2(ref.mul(bcvToday)) : null,
    percent: r2(f.mul(100)),
  };
}

/** Lo que falta en la moneda del abono: es el monto del botón "Paga todo". */
export function payAllAmount(balance: ReceivableBalance, currency: PayCurrency, bcvToday: number) {
  const left = remaining(balance, bcvToday);
  return currency === "USD" ? left.usd : left.vesToday;
}

export type PaymentPreview =
  | { ok: true; closes: boolean; fractionAfter: number; after: ReturnType<typeof remaining> }
  | { ok: false; error: string };

export function previewPayment(
  balance: ReceivableBalance, currency: PayCurrency, amount: number, bcvToday: number,
): PaymentPreview {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Indica el monto del abono." };
  if (Math.round(amount * 100) / 100 !== amount) return { ok: false, error: "Usa máximo dos decimales." };
  if (currency === "VES" && !(bcvToday > 0)) return { ok: false, error: "Falta la tasa BCV de hoy." };
  if (currency === "USD" && (balance.principal_usd == null || Number(balance.principal_usd) <= 0))
    return { ok: false, error: "La deuda no tiene monto en $ divisas." };
  const all = payAllAmount(balance, currency, bcvToday) ?? 0;
  if (amount > all + 0.01) {
    const label = currency === "USD" ? `$${all.toFixed(2)}` : `Bs ${all.toFixed(2)}`;
    return { ok: false, error: `El abono es mayor que lo que falta (${label}).` };
  }
  const f = new D(balance.outstanding_fraction);
  const share = currency === "USD"
    ? new D(amount).div(balance.principal_usd!)
    : new D(amount).div(bcvToday).div(balance.principal_ref);
  let after = D.max(f.minus(share), 0);
  const leftInCurrency = currency === "USD"
    ? after.mul(balance.principal_usd!)
    : after.mul(balance.principal_ref).mul(bcvToday);
  if (amount >= all - 0.01 || leftInCurrency.lt(0.01)) after = new D(0);
  const next = { ...balance, outstanding_fraction: after.toString() };
  return { ok: true, closes: after.isZero(), fractionAfter: Number(after.toString()), after: remaining(next, bcvToday) };
}

/** Texto para WhatsApp con lo que falta en las tres formas de pago. */
export function debtMessage(name: string | null, orderNumber: string, balance: ReceivableBalance, bcvToday: number) {
  const left = remaining(balance, bcvToday);
  const fmt = (n: number) => n.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = [
    `Hola${name ? " " + name : ""} 👋`,
    `Te recordamos el saldo pendiente de tu orden *${orderNumber}* en *Lubricenter Norte*:`,
    "",
    left.usd != null ? `• En divisas (Zelle, Binance o efectivo $): *$${fmt(left.usd)}*` : null,
    left.vesToday != null ? `• En bolívares hoy (BCV): *Bs ${fmt(left.vesToday)}*` : null,
    `• Referencia BCV: ${fmt(left.ref)} REF`,
    "",
    "El monto en bolívares se calcula con la tasa BCV del día del pago. ¡Gracias! 🧡",
  ];
  return lines.filter(l => l !== null).join("\n");
}

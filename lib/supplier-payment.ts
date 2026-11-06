// Espejo exacto de record_supplier_payment (Supabase) para mostrarlo antes de pagar.
// La cuenta paga en su moneda y la factura se abona en la suya:
// - los dólares de una cuenta en divisas (Caja USD, Zelle, Binance) se valoran a la tasa operativa;
// - una factura en USD se lleva en REF, es decir, a tasa BCV.
// Por eso $1 en efectivo abona más de 1 REF a la factura, y saldarla pide menos dólares que su saldo.
export type SupplierCurrency = "USD" | "VES";

export const SUPPLIER_TOLERANCE: Record<SupplierCurrency, number> = { USD: 0.05, VES: 1 };

const round = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/** Lo que el servidor abonará a la factura por `amount` pagado desde la cuenta. */
export function appliedToInvoice(amount: number, account: SupplierCurrency, invoice: SupplierCurrency, bcv: number, operative: number) {
  const ves = account === "USD" ? round(amount * operative, 2) : round(amount, 2);
  return invoice === "USD" ? round(ves / bcv, 4) : ves;
}

/** El servidor rechaza con «El pago supera el saldo pendiente» por encima de esta línea. */
export function exceedsOutstanding(applied: number, outstanding: number, invoice: SupplierCurrency) {
  return applied > Math.max(outstanding, 0) + SUPPLIER_TOLERANCE[invoice];
}

/**
 * El monto más alto (al céntimo) que la cuenta puede pagar sin que el servidor lo rechace:
 * normalmente deja la factura en cero. Con una factura en Bs pagada en dólares un céntimo
 * vale más que la tolerancia de Bs 1, así que puede quedar un resto de pocos bolívares.
 */
export function amountToSettle(outstanding: number, account: SupplierCurrency, invoice: SupplierCurrency, bcv: number, operative: number) {
  const ves = invoice === "USD" ? outstanding * bcv : outstanding;
  const exact = account === "USD" ? ves / operative : ves;
  let cents = Math.ceil(round(exact * 100, 6));
  while (cents > 0 && exceedsOutstanding(appliedToInvoice(cents / 100, account, invoice, bcv, operative), outstanding, invoice)) cents -= 1;
  return cents / 100;
}

/** El servidor marca la factura PAGADA cuando lo abonado llega al total menos la tolerancia. */
export function settlesInvoice(applied: number, outstanding: number, invoice: SupplierCurrency) {
  return applied >= outstanding - SUPPLIER_TOLERANCE[invoice];
}

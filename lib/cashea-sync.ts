// Cashea: textos de la sincronización verificada (cashea_conc_sync_installments_v2)
// y del seguimiento (cashea_tracking_status). Las reglas viven en la base.

export type UnverifiedReason =
  | "NO_BNC_LINE" | "BNC_AMOUNT_MISMATCH" | "AMOUNT_SHORT" | "NO_SNAPSHOT_NO_PAYMENT" | "ORDER_CANCELLED_IN_CASHEA";

export type UnverifiedInstallment = {
  order_number: string | null; cashea_reference: string | null; installment_no: number; due_date: string;
  amount_ref: number; verified_ref: number; reason: UnverifiedReason; hint: string;
};

export type SyncResult = {
  paid: number; partial: number; settled: number; by_rule: { A: number; B: number };
  unverified: UnverifiedInstallment[]; bnc_range: { from: string | null; to: string | null }; dry_run: boolean;
};

export type PaidSource = "BNC" | "CASHEA" | "MANUAL";

export type TrackingStatus = {
  orders_to: string | null; payments_to: string | null; bnc_to: string | null;
  never_in_orders_export: number; oldest_missing_since: string | null; without_reference: number;
  paid_sources: Record<string, PaidSource>;
};

export const REASON_LABEL: Record<UnverifiedReason, string> = {
  NO_BNC_LINE: "Falta en el BNC",
  BNC_AMOUNT_MISMATCH: "El monto del BNC no coincide",
  AMOUNT_SHORT: "Pago incompleto",
  NO_SNAPSHOT_NO_PAYMENT: "Sin datos de Cashea",
  ORDER_CANCELLED_IN_CASHEA: "Cancelada en Cashea",
};

export function paidSourceLabel(source: PaidSource | undefined): string {
  if (source === "BNC") return "Pagada · verificada con BNC";
  if (source === "CASHEA") return "Pagada · según Cashea";
  return "Pagada a mano";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function syncNotice(r: Pick<SyncResult, "paid" | "partial" | "settled" | "unverified">): string {
  return `Se marcaron ${plural(r.paid, "cuota pagada", "cuotas pagadas")} (verificadas con el BNC o según Cashea), `
    + `${plural(r.partial, "parcial", "parciales")}, ${plural(r.settled, "venta saldada", "ventas saldadas")}. `
    + `${plural(r.unverified.length, "queda por confirmar", "quedan por confirmar")}.`;
}

/** dd/mm a partir de aaaa-mm-dd. */
export function dayMonth(date: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  return m ? `${m[3]}/${m[2]}` : "—";
}

export function freshnessLine(t: TrackingStatus): string {
  return `Último export de órdenes: ${dayMonth(t.orders_to)} · de pagos: ${dayMonth(t.payments_to)} · BNC: ${dayMonth(t.bnc_to)}`;
}

export function trackingWarnings(t: TrackingStatus): string[] {
  const out: string[] = [];
  if (t.never_in_orders_export > 0) {
    out.push(`${plural(t.never_in_orders_export, "venta nunca vino", "ventas nunca vinieron")} en el export de órdenes; pide uno desde el ${dayMonth(t.oldest_missing_since)}.`);
  }
  if (t.without_reference > 0) out.push(`${plural(t.without_reference, "venta", "ventas")} sin número de Cashea.`);
  return out;
}

export type ReportChannel = { orders: number; equivalent: number | null; ves?: number; usd?: number; initial_ref?: number; financed_ref?: number; commission_ref?: number };
export type ManagementOrder = {
  id: string; order_number: string; business_at: string; customer: string; plate: string; location: string;
  channel: string; methods: string[]; total_ves: number; sales_equivalent: number | null;
  cashea_bcv: number | null; contado_bcv: number | null; divisas_usd: number; credit_bcv: number | null;
};
export type FinanceManagementReport = {
  period: { from: string; to: string; timezone: string }; generated_at: string;
  totals: { orders: number; gross_ves: number; sales_equivalent: number | null };
  channels: Record<"cashea" | "contado" | "divisas" | "credito", ReportChannel>;
  receivables: {
    as_of: string; accounts: number; overdue: number; outstanding_ves: number; outstanding_bcv: number | null;
    cashea_recorded_ref: number | null; cashea_opening_on: string | null;
    items: { id: string; order_id: string; order_number: string; customer: string; due_date: string | null; outstanding_ves: number; outstanding_bcv: number | null }[];
  };
  orders: ManagementOrder[];
  warnings: { missing_invoice_rates: number; overpaid_orders: number; excluded_cashea: number };
};
export function financeToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function financeDateStep(value: string, days: number) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function validFinancePeriod(from: string, to: string, today: string) {
  const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;
  return valid(from) && valid(to) && from <= to && to <= today && (Date.parse(to) - Date.parse(from)) / 86400000 <= 366;
}
export function financePeriodLabel(from: string, to: string) {
  const format = (date: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Caracas" }).format(new Date(date + "T12:00:00-04:00"));
  return from === to ? format(from) : `${format(from)} — ${format(to)}`;
}
export const FINANCE_CHANNEL_LABELS: Record<string, string> = { CASHEA: "Cashea", CONTADO: "Contado Bs", DIVISAS: "Divisas", CREDITO: "Crédito LC", MIXTA: "Mixta" };
export function managementReportCsv(report: FinanceManagementReport) {
  const cell = (value: unknown) => {
    const raw = value === null || value === undefined ? "Pendiente" : typeof value === "number" ? value.toFixed(4).replace(".", ",") : String(value);
    const safe = /^[\s]*[=+\-@]/.test(raw) && typeof value !== "number" ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const rows: unknown[][] = [
    ["LUBRICENTER · REPORTE FINANCIERO", financePeriodLabel(report.period.from, report.period.to)],
    ["Zona horaria", "America/Caracas"], ["Total vendido equivalente", report.totals.sales_equivalent],
    ["Base del equivalente", "Bs a BCV histórico de factura + USD nominales; Cashea incluye su inicial"],
    ["Canal", "Equivalente USD", "Bs facturados", "Divisas USD", "Órdenes con participación"],
    ...(["cashea", "contado", "divisas", "credito"] as const).map(k => [FINANCE_CHANNEL_LABELS[k.toUpperCase()], report.channels[k].equivalent, report.channels[k].ves ?? "", report.channels[k].usd ?? "", report.channels[k].orders]),
    [], ["Cuentas por cobrar al", report.receivables.as_of],
    ["Clientes · Bs pendientes", report.receivables.outstanding_ves],
    ["Clientes · equivalente BCV de factura", report.receivables.outstanding_bcv],
    ["Cashea · saldo registrado USD ref", report.receivables.cashea_recorded_ref],
    [], ["Orden", "Fecha Caracas", "Cliente", "Placa", "Sede", "Canal", "Venta equivalente", "Factura Bs", "Cashea BCV", "Contado BCV", "Divisas USD", "Crédito BCV"],
    ...report.orders.map(o => [o.order_number, new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Caracas" }).format(new Date(o.business_at)), o.customer, o.plate, o.location, FINANCE_CHANNEL_LABELS[o.channel], o.sales_equivalent, o.total_ves, o.cashea_bcv, o.contado_bcv, o.divisas_usd, o.credit_bcv]),
    [], ["Cuenta por cobrar", "Cliente", "Vencimiento", "Bs pendientes", "Equivalente BCV de factura"],
    ...report.receivables.items.map(r => [r.order_number, r.customer, r.due_date ?? "Sin fecha", r.outstanding_ves, r.outstanding_bcv]),
  ];
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n");
}

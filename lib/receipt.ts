// Recibo de 58 mm: tipos de public.order_receipt() y textos derivados.
// Solo presentación: los montos y las reglas de líneas vienen de la base.

export type ReceiptLine = {
  name: string;
  qty: number;
  unit_label: string | null;
  unit_price_ref: number | null;
  total_ref: number;
  kind: "PRODUCT" | "SERVICE";
  courtesy: boolean;
};

export type ReceiptData = {
  header: {
    branch: string | null; address: string | null; whatsapp: string | null; instagram: string | null;
    rif: string | null; legend: string | null; total_style: "BLOCK" | "BORDER";
  };
  order: { number: string; status: "OPEN" | "CLOSED" | "CANCELLED"; at: string; attendant: string | null };
  customer: { name: string | null; phone_tail: string | null } | null;
  vehicle: { label: string | null; plate: string | null; odometer: number | null } | null;
  lines: ReceiptLine[];
  adjustments: { discount_ref: number; rounding_ref: number };
  totals: { ref: number; ves: number; bcv_rate: number | null };
  payments: { label: string; ref_tail: string | null; currency: "VES" | "USD"; amount: number }[];
  change: { received: number; currency: "VES" | "USD"; returned_usd: number; pending_usd: number }[];
  cashea: { initial_percent: number; initial_ref: number; installments: { no: number; due: string; amount_ref: number; status: string }[] } | null;
  credit: { outstanding_ves: number; outstanding_ref: number } | null;
  next_service: { odometer: number | null; date: string | null; oil: string | null; filter: string | null } | null;
};

const TZ = "America/Caracas";

export function money(value: number | string | null | undefined, decimals = 2): string {
  return Number(value ?? 0).toLocaleString("es-VE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export const ref = (value: number | string | null | undefined) => `$${money(value)}`;
export const ves = (value: number | string | null | undefined) => `Bs ${money(value)}`;
export const amountIn = (value: number, currency: "VES" | "USD") => (currency === "USD" ? ref(value) : ves(value));

export function qtyText(value: number): string {
  return Number(value).toLocaleString("es-VE", { maximumFractionDigits: 2 });
}

export function km(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : `${Number(value).toLocaleString("es-VE", { maximumFractionDigits: 0 })} km`;
}

/** Fecha corta dd/mm/aaaa. Las fechas sin hora (aaaa-mm-dd) no se corren de día. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return new Intl.DateTimeFormat("es-VE", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export function shortTime(value: string): string {
  return new Intl.DateTimeFormat("es-VE", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(value)).replace(/\s+/g, " ").replace(/\s*a\.\s*m\./i, " am").replace(/\s*p\.\s*m\./i, " pm");
}

export function lineDetail(line: ReceiptLine): string {
  if (line.courtesy) return line.unit_label ?? "Mano de obra";
  const unit = line.unit_label ? ` ${line.unit_label}` : "";
  if (line.qty === 1 && !line.unit_label) return "";
  return `${qtyText(line.qty)}${unit} × ${ref(line.unit_price_ref ?? line.total_ref)}`;
}

export function installmentStatus(status: string): string {
  return ({ PAID: "Pagada", PARTIAL: "Abonada", PENDING: "Pendiente" } as Record<string, string>)[status] ?? "Pendiente";
}

export function footerPhrase(data: ReceiptData): string {
  if (data.next_service) return "Te escribimos cuando se acerque tu cambio.";
  if (data.cashea) return "Las cuotas se pagan en la app de Cashea.";
  return "Gracias por tu compra.";
}

export function statusBand(status: ReceiptData["order"]["status"]): string | null {
  if (status === "OPEN") return "Cotización · venta abierta";
  if (status === "CANCELLED") return "Anulada · sin validez";
  return null;
}

/** Texto para compartir por WhatsApp: el mismo orden del recibo, sin líneas internas. */
export function receiptShareText(data: ReceiptData): string {
  const out: (string | null)[] = [];
  const band = statusBand(data.order.status);
  out.push(`*LUBRICENTER* · ${data.header.branch ?? "Cabudare"}`);
  if (band) out.push(band.toUpperCase());
  out.push(`Nota de entrega ${data.order.number} · ${shortDate(data.order.at)} ${shortTime(data.order.at)}`);
  if (data.customer?.name) out.push(`Cliente: ${data.customer.name}`);
  if (data.vehicle) {
    const v = [data.vehicle.label, data.vehicle.plate, km(data.vehicle.odometer)].filter(Boolean).join(" · ");
    if (v) out.push(`Vehículo: ${v}`);
  }
  out.push("");
  for (const line of data.lines) {
    const detail = lineDetail(line);
    out.push(`${line.name}${detail ? ` (${detail})` : ""} — ${line.courtesy ? "Cortesía" : ref(line.total_ref)}`);
  }
  if (data.adjustments.discount_ref) out.push(`Descuento — -${ref(data.adjustments.discount_ref)}`);
  if (data.adjustments.rounding_ref) out.push(`Redondeo — ${ref(data.adjustments.rounding_ref)}`);
  out.push("");
  out.push(`*Total: ${ref(data.totals.ref)}* · ${ves(data.totals.ves)}`);
  for (const p of data.payments) out.push(`${p.label}${p.ref_tail ? ` ···${p.ref_tail}` : ""}: ${amountIn(p.amount, p.currency)}`);
  for (const c of data.change) if (c.pending_usd > 0) out.push(`Vuelto pendiente: ${ref(c.pending_usd)}`);
  if (data.cashea) {
    out.push(`Cashea: inicial ${qtyText(data.cashea.initial_percent)}% · ${ref(data.cashea.initial_ref)}`);
    for (const i of data.cashea.installments) out.push(`  Cuota ${i.no} · ${shortDate(i.due)} · ${ref(i.amount_ref)} · ${installmentStatus(i.status)}`);
  }
  if (data.credit) out.push(`Saldo pendiente: ${ves(data.credit.outstanding_ves)}`);
  if (data.next_service) {
    const n = data.next_service;
    out.push("");
    out.push(`Tu próximo cambio: ${[km(n.odometer), shortDate(n.date)].filter(Boolean).join(" o el ")}`);
    const parts = [n.oil ? `Aceite ${n.oil}` : null, n.filter ? `Filtro ${n.filter}` : null].filter(Boolean);
    if (parts.length) out.push(parts.join(" · "));
  }
  out.push("");
  out.push("Cuidamos lo que te mueve.");
  return out.filter(x => x !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Respuesta de public.order_preview (F8). */
export type PreviewLine = { name: string; qty: number; unit_price_ref?: number | null; total_ref: number; kind: "PRODUCT" | "SERVICE"; area: string; mechanic?: string | null };
export type OrderPreview = {
  order: { id: string; number: string; status: "OPEN" | "CLOSED" | "CANCELLED"; at: string; attendant: string | null;
    kind: "STORE" | "WORKSHOP" | "MIXED"; payment_type: "CASH" | "CASHEA" | "CREDIT"; cancellation_reason: string | null };
  customer: { id: string; name: string | null; phone: string | null } | null;
  vehicle: { id: string; plate: string | null; label: string | null; odometer: number | null } | null;
  groups: {
    store: { subtotal_ref: number; lines: PreviewLine[] };
    workshop: { subtotal_ref: number; lines: PreviewLine[] };
    internal: { name: string; total_ref: number; role: string }[];
  };
  adjustments: { discount_ref: number; discount_pct: number; discount_reason: string | null; owner_approved: boolean; rounding_ref: number };
  totals: { ref: number; ves: number; bcv_rate: number | null; collected_ref: number; collected_ves: number; pending_ref: number };
  payments: { method: string; label: string; ref_tail: string | null; currency: "VES" | "USD"; amount: number; equivalent_ref: number | null; paid_at: string | null }[];
  cashea: null | { reference: string | null; initial_percent: number; initial_ref: number; financed_ref: number; status: string;
    installments: { no: number; due: string; amount_ref: number; paid_ref: number; status: string; overdue: boolean }[] };
  credit: null | { status: string; outstanding_ref: number; outstanding_ves: number };
  profit: null | { store_ref: number; workshop_ref: number; total_ref: number; cashea_commission_ref: number;
    estimated_cost: boolean; mechanics: { name: string; ref: number }[] };
};

export const KIND_LABEL: Record<OrderPreview["order"]["kind"], string> = { STORE: "Tienda", WORKSHOP: "Taller", MIXED: "Mixta" };
export const PAYMENT_LABEL: Record<OrderPreview["order"]["payment_type"], string> = { CASH: "Contado", CASHEA: "Cashea", CREDIT: "Crédito LC" };
export const STATUS_LABEL: Record<OrderPreview["order"]["status"], string> = { OPEN: "Abierta", CLOSED: "Cerrada", CANCELLED: "Anulada" };

/** Estado de una cuota en palabras. */
export function installmentLabel(i: { status: string; overdue: boolean; paid_ref: number; amount_ref: number }) {
  if (i.status === "PAID") return "Pagada";
  if (i.overdue) return "Vencida";
  if (i.status === "PARTIAL" || i.paid_ref > 0) return "Parcial";
  return "Por vencer";
}

/** Fracción cobrada (0–1) para la barra cobrado / pendiente. */
export function collectedShare(p: Pick<OrderPreview, "totals">) {
  const total = Number(p.totals.ref) || 0;
  if (total <= 0) return 0;
  const pending = Math.max(0, Number(p.totals.pending_ref) || 0);
  return Math.min(1, Math.max(0, (total - pending) / total));
}

/** Orden anterior o siguiente de una lista (sin salirse de los extremos). */
export function neighbor(ids: string[], current: string | null, direction: 1 | -1): string | null {
  if (!current) return null;
  const index = ids.indexOf(current);
  if (index < 0) return null;
  const next = index + direction;
  return next >= 0 && next < ids.length ? ids[next] : null;
}

type Entry = { data?: OrderPreview; at: number; promise?: Promise<OrderPreview> };
/** Caché por pantalla: una consulta por orden; se refresca si pasó más de `maxAge`. */
export function createPreviewCache(fetcher: (id: string) => Promise<OrderPreview>) {
  const map = new Map<string, Entry>();
  return {
    peek(id: string) { return map.get(id)?.data ?? null; },
    age(id: string) { const e = map.get(id); return e?.data ? Date.now() - e.at : Infinity; },
    load(id: string, force = false): Promise<OrderPreview> {
      const entry = map.get(id);
      if (!force && entry?.data) return Promise.resolve(entry.data);
      if (entry?.promise) return entry.promise;
      const promise = fetcher(id).then(data => { map.set(id, { data, at: Date.now() }); return data; })
        .catch(error => { map.delete(id); throw error; });
      map.set(id, { ...entry, at: entry?.at ?? 0, promise });
      return promise;
    },
  };
}

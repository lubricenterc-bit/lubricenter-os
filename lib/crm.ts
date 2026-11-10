import { whatsappUrl } from "./whatsapp";
// CRM semiautomático: tipos y textos de la pantalla Seguimiento.
// Las reglas (a quién, cuándo y qué mensaje) viven en la base: crm_board() y
// crm_vehicle_journeys. Aquí solo se presentan.

export type CrmKind = "POST_SERVICE" | "PRE" | "DUE" | "FINAL" | "RECOVERY" | "RECONNECT" | "AGREED" | "SECOND";
export type CrmTemplateKind = Exclude<CrmKind, "POST_SERVICE">;

export type CrmQueueItem = {
  type: "POST_SERVICE" | "REMINDER";
  id: string;
  order_id?: string;
  order_number?: string;
  vehicle_id?: string;
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  wa_phone: string;
  vehicle: string | null;
  plate: string | null;
  kind: CrmKind;
  step: number | null;
  max_steps: number | null;
  why: string;
  warning: string | null;
  message: string;
  /** Último mensaje de este ciclo (para preguntar «¿respondió?» antes del siguiente). */
  last_sent_at?: string | null;
  /** WhatsApp abierto y falta confirmar (viene de crm_board.pending). */
  attempt_id?: string;
  opened_at?: string;
  mine?: boolean;
};

export type CrmWaiting = {
  id: string; customer_id: string; customer_name: string | null; phone: string | null; wa_phone: string | null;
  vehicle: string | null; plate: string | null; sent_count: number; last_sent_at: string; eligible_on: string | null; status: string;
};
export type CrmBooked = {
  id: string; customer_name: string | null; phone: string | null; wa_phone: string | null;
  vehicle: string | null; plate: string | null; date: string;
};
export type CrmFix = {
  customer_id: string; customer_name: string | null; phone: string | null; vehicles: string | null; flagged: boolean;
};
export type CrmBoard = {
  today: string; cap: number; sent_today: number; remaining: number; ready_total: number;
  queue: CrmQueueItem[]; waiting: CrmWaiting[]; booked: CrmBooked[]; fix: CrmFix[];
  /** Abrieron WhatsApp y falta decir si se envió (sobrevive a recargar la página). */
  pending?: CrmQueueItem[];
};
export type CrmResults = {
  days: number; reminders_sent: number; post_service_sent: number; answered: number; booked: number;
  opted_out: number; returned: number; returned_ref: number; oil_orders: number;
  oil_orders_with_vehicle: number; oil_orders_skipped: number;
};

export type CrmOutcome = "BOOKED" | "POSTPONED" | "OTHER_SHOP" | "DECLINED" | "SOLD_VEHICLE" | "WRONG_NUMBER" | "OPT_OUT" | "RETURNED";

export const KIND_LABEL: Record<CrmKind, string> = {
  POST_SERVICE: "Postservicio",
  PRE: "Se acerca su cambio",
  DUE: "Ya le toca",
  FINAL: "Último mensaje",
  RECOVERY: "Recuperar cliente",
  RECONNECT: "Reconectar",
  AGREED: "Como quedamos",
  SECOND: "Segunda oportunidad",
};

export const TEMPLATE_HELP: Record<CrmTemplateKind, string> = {
  PRE: "Primer aviso, 7 días antes de la fecha recomendada.",
  DUE: "Cuando ya le toca, o 10 días después del primer aviso.",
  FINAL: "Tercer mensaje y último. Sin insistir.",
  RECOVERY: "Primer mensaje a quien se le pasó la fecha hace más de un mes.",
  RECONNECT: "Un solo mensaje a quien no viene hace más de un año.",
  AGREED: "Cuando el cliente dijo «más adelante»: se le escribe en la fecha acordada.",
  SECOND: "Un mensaje más a los 120 días a quien no respondió. Si tampoco responde, queda en la cartera.",
};

/** «No enviar»: cada motivo saca el mensaje de pendientes. */
export type DismissReason = "NOT_NEEDED" | "TOO_LATE" | "ALREADY_DONE" | "NO_WHATSAPP";
export const DISMISS_REASONS: { id: DismissReason; label: string; hint: string; reminderOnly?: boolean }[] = [
  { id: "NOT_NEEDED", label: "No hace falta", hint: "Se cierra el ciclo hasta su próxima visita." },
  { id: "TOO_LATE", label: "Pasó mucho tiempo", hint: "Pasa a la cartera para promociones.", reminderOnly: true },
  { id: "ALREADY_DONE", label: "Ya vino o ya lo hizo", hint: "Empieza un ciclo nuevo desde hoy.", reminderOnly: true },
  { id: "NO_WHATSAPP", label: "No tiene WhatsApp", hint: "Pasa a Corregir datos." },
];
export function dismissReasons(type: CrmQueueItem["type"]) {
  return DISMISS_REASONS.filter(r => type === "REMINDER" || !r.reminderOnly);
}

export const OUTCOMES: { id: CrmOutcome; label: string; hint: string; needsDate?: boolean; danger?: boolean }[] = [
  { id: "BOOKED", label: "Agendó", hint: "Pon el día. Aparece en Citas.", needsDate: true },
  { id: "POSTPONED", label: "Más adelante", hint: "Se le vuelve a escribir en 30 días." },
  { id: "OTHER_SHOP", label: "Ya lo hizo en otro lado", hint: "Empieza un ciclo nuevo desde hoy." },
  { id: "DECLINED", label: "No le interesa", hint: "Se cierra este ciclo." },
  { id: "SOLD_VEHICLE", label: "Vendió el carro", hint: "No se le escribe más por este carro." },
  { id: "WRONG_NUMBER", label: "Número equivocado", hint: "Pasa a Corregir datos." },
  { id: "OPT_OUT", label: "No quiere mensajes", hint: "No se le vuelve a escribir nunca.", danger: true },
];

export function waLink(waPhone: string, message: string) {
  return whatsappUrl(waPhone, message);
}

export function caracasToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function shortDate(value: string | null | undefined) {
  if (!value) return "sin fecha";
  const d = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  return d.toLocaleDateString("es-VE", { day: "numeric", month: "short", timeZone: "America/Caracas" });
}

export function estimateMinutes(count: number) {
  return Math.max(1, Math.round(count * 0.6));
}

export function displayName(name: string | null | undefined) {
  const n = (name ?? "").trim();
  return n || "Cliente sin nombre";
}

/** Solo bloquea la venta cuando hubo cambio de aceite; la captura opcional nunca bloquea. */
export function captureBlocks(status: { needs?: boolean | null; optional?: boolean | null } | null | undefined): boolean {
  return !!status?.needs;
}

// --- Recuperar: tramos de vencidos -------------------------------------------
export type RecoveryBucket = "SOON" | "D0_30" | "D31_90" | "D91_180" | "D181_365" | "D365P" | "POOL";
export const RECOVERY_BUCKETS: RecoveryBucket[] = ["SOON", "D0_30", "D31_90", "D91_180", "D181_365", "D365P"];
/** Celda aparte: sin respuesta (esperan la segunda oportunidad) y en cartera. */
export const RECOVERY_CELLS: RecoveryBucket[] = [...RECOVERY_BUCKETS, "POOL"];
export type RecoverySort = "PRIORITY" | "RECENT" | "OLDEST";

export type RecoverySummaryItem = {
  bucket: RecoveryBucket; label: string; vehicles: number; customers: number; contacted: number;
  awaiting_reply: number; lifetime_ref: number; estimated: number; no_phone: number;
  dormant?: number; second_pending?: number;
};

export type RecoveryRow = {
  service_record_id: string; vehicle_id: string; customer_id: string; customer_name: string | null;
  wa_phone: string | null; plate: string | null; make: string | null; model: string | null;
  performed_at: string; cycle_due: string; days_from_due: number; estimated: boolean;
  oil_brand: string | null; oil_viscosity: string | null; sent_count: number; last_sent_at: string | null;
  last_outcome: string | null; status: string; eligible_on: string | null; lifetime_ref: number; visits: number;
};

/** «vencido hace 47 días», «vence hoy» o «vence en 5 días». */
export function dueText(days: number): string {
  if (days === 0) return "vence hoy";
  if (days < 0) return `vence en ${-days} ${-days === 1 ? "día" : "días"}`;
  return `vencido hace ${days} ${days === 1 ? "día" : "días"}`;
}

/** «2 mensajes · último 12/10» o «sin contactar». */
export function contactText(sentCount: number, lastSentAt: string | null): string {
  if (!sentCount) return "sin contactar";
  return `${sentCount} ${sentCount === 1 ? "mensaje" : "mensajes"}${lastSentAt ? ` · último ${shortDate(lastSentAt)}` : ""}`;
}

/** Cuántos se pueden contactar hoy en un tramo: el mínimo entre el tope restante y los elegibles. */
export function contactableToday(remaining: number, eligible: number): number {
  return Math.max(0, Math.min(remaining, eligible));
}


/** Mueve el elemento actual al final de la cola («Después»). */
export function moveToEnd<T>(list: T[], index: number): T[] {
  if (index < 0 || index >= list.length - 1) return list;
  return [...list.slice(0, index), ...list.slice(index + 1), list[index]];
}

/** Búsqueda sin acentos ni mayúsculas, con todas las palabras. */
export function matchesQuery(text: string, query: string): boolean {
  const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-VE");
  const hay = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

export type MechanicStage = "RECEIVED" | "DIAGNOSIS" | "IN_PROGRESS" | "WAITING_PART" | "READY" | "DELIVERED";

/** Una orden vista por el mecánico: sin montos, solo lo que necesita para trabajar. */
export type MechanicOrder = {
  order_id: string;
  order_number: string;
  status: string;
  workflow_status: MechanicStage;
  workflow_updated_at: string | null;
  opened_at: string;
  closed_at: string | null;
  date: string;
  plate: string | null;
  vehicle: string | null;
  customer: string | null;
  notes: string | null;
  my_jobs: { description: string; helper: boolean }[];
  parts: { description: string; quantity: number }[];
};

export type LaborProposal = {
  id: string;
  mechanic?: string;
  order_id?: string | null;
  order_number: string | null;
  plate: string | null;
  vehicle: string | null;
  description: string;
  amount_ref: number;
  notes: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export const STAGE_LABEL: Record<MechanicStage, string> = {
  RECEIVED: "Recibido",
  DIAGNOSIS: "Diagnóstico",
  IN_PROGRESS: "En trabajo",
  WAITING_PART: "Esperando repuesto",
  READY: "Listo",
  DELIVERED: "Entregado",
};

/** Lo que el mecánico puede marcar (recibir y entregar lo hace el mostrador). */
export const MECHANIC_STAGES: MechanicStage[] = ["DIAGNOSIS", "IN_PROGRESS", "WAITING_PART", "READY"];

export const PROPOSAL_LABEL: Record<LaborProposal["status"], string> = {
  PENDING: "Pendiente",
  ACCEPTED: "Aceptada",
  REJECTED: "No aceptada",
};

export function since(value: string | null) {
  if (!value) return "";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "hace 1 día" : `hace ${days} días`;
}

export function shortDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("es-VE", { timeZone: "America/Caracas", weekday: "short", day: "2-digit", month: "short" });
}

export function quantity(value: number) {
  return Number(value).toLocaleString("es-VE", { maximumFractionDigits: 2 });
}

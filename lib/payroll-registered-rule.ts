// Regla «solo se paga lo registrado», etapa 1 (migración payroll_registered_rule).
// El servidor marca el trabajo de nómina; aquí solo se reconoce el motivo para mostrarlo.
export const OWNER_APPROVAL_PREFIX = "Por aprobar del dueño";
export const REGISTERED_RULE_WARNING = "Marcha blanca:";

type WorkLike = { decision: string; reason: string | null };

export function isOwnerApprovalHold(w: WorkLike): boolean {
  return w.decision === "HOLD" && (w.reason ?? "").startsWith(OWNER_APPROVAL_PREFIX);
}

export function isRegisteredRuleWarning(w: WorkLike): boolean {
  return (w.reason ?? "").includes(REGISTERED_RULE_WARNING);
}

/** Aviso al agregar mano de obra a una orden sin cliente o vehículo. */
export function laborRuleNotice(hasCustomer: boolean, hasVehicle: boolean): string | null {
  if (hasCustomer && hasVehicle) return null;
  return "Esta orden no tiene cliente y vehículo. Desde el 30/11, la mano de obra de órdenes así queda «por aprobar del dueño» en Nómina y no se paga hasta que él la apruebe.";
}

/** Selecciones rápidas reutilizadas por cambios de aceite y órdenes.
 * Guardamos en los campos CRM existentes: no duplicamos tablas, cobros ni mensajes.
 */
export type OrderExtras = {
  services: string[];
  bonuses: string[];
  notes: string;
};

export const OIL_CHANGE_SERVICE_PRESETS = [
  "Calibración de presión de cauchos",
  "Revisión de niveles",
  "Limpieza de parabrisas",
  "Revisión visual de fugas",
] as const;

export const OIL_CHANGE_COURTESY_PRESETS = [
  "Líquido limpiaparabrisas",
  "Lavado de cortesía",
] as const;

export const EMPTY_ORDER_EXTRAS: OrderExtras = {
  services: [],
  bonuses: [],
  notes: "",
};

export function extrasNameKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .trim().replace(/\s+/g," ").toLocaleLowerCase("es-VE");
}

function cleanLabel(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g," ").trim().slice(0,140) : "";
}

export function uniqueExtraLabels(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.slice(0,80)) {
    const item = cleanLabel(raw);
    if (!item) continue;
    const key = extrasNameKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (result.length < 25) result.push(item);
  }
  return result;
}

export function normalizeOrderExtras(value: {
  crm_additional_services?: unknown;
  crm_bonuses?: unknown;
  crm_observations?: unknown;
} | null): OrderExtras {
  return {
    services: uniqueExtraLabels(value?.crm_additional_services),
    bonuses: uniqueExtraLabels(value?.crm_bonuses),
    notes: typeof value?.crm_observations === "string" ? value.crm_observations.slice(0,2000) : "",
  };
}

export function toggleExtra(values: string[], label: string, checked: boolean) {
  const key = extrasNameKey(label);
  return uniqueExtraLabels(checked
    ? [...values, label]
    : values.filter(value => extrasNameKey(value) !== key)
  );
}

export function addManualExtra(values: string[], label: string) {
  return uniqueExtraLabels([...values, label]);
}

export function selectedPresets(values: string[], presets: readonly string[]) {
  const selected = new Set(values.map(extrasNameKey));
  return presets.filter(label => selected.has(extrasNameKey(label)));
}

export function manualExtras(values: string[], presets: readonly string[]) {
  const defaults = new Set(presets.map(extrasNameKey));
  return values.filter(value => !defaults.has(extrasNameKey(value)));
}

export function validateOrderExtras(value: OrderExtras): string | null {
  if (value.notes.trim().length > 2000) return "Las observaciones deben tener menos de 2000 caracteres.";
  if (value.services.length > 25 || value.bonuses.length > 25)
    return "Puedes seleccionar un máximo de 25 servicios o cortesías.";
  if ([...value.services,...value.bonuses].some(item => !item.trim() || item.length > 140))
    return "Cada servicio o cortesía debe tener un máximo de 140 caracteres.";
  return null;
}

export function orderExtrasRpcParams(orderId: string, extras: OrderExtras) {
  return {
    p_order_id: orderId,
    p_additional_services: uniqueExtraLabels(extras.services),
    p_bonuses: uniqueExtraLabels(extras.bonuses),
    p_observations: extras.notes.trim() || null,
  };
}

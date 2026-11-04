// Campos numéricos: lectura de lo que escribe la persona (es-VE o con punto),
// formato de salida y paso entero. Las flechas y botones nunca ponen decimales;
// los decimales solo entran escritos (decisión D-01).

export type NumberKind = "qty" | "money" | "rate" | "percent";
export const KIND_DECIMALS: Record<NumberKind, number> = { qty: 3, money: 2, rate: 4, percent: 2 };

/** Convierte texto escrito por la persona a número. Devuelve null si está vacío y NaN si es inválido. */
export function parseLocaleNumber(text: string): number | null {
  let s = String(text ?? "").replace(/\s+/g, "").replace(/\$|bs\.?|%/gi, "");
  if (s === "") return null;
  let sign = 1;
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return NaN;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // El separador decimal es el último que aparece; el otro es de miles.
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    const [intPart, ...rest] = s.split(decimal);
    if (rest.length !== 1) return NaN;
    if (!/^\d{1,3}([.,]\d{3})*$/.test(intPart) && !/^\d+$/.test(intPart)) return NaN;
    normalized = intPart.split(thousands).join("") + "." + rest[0];
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    if (parts.length !== 2) return NaN;
    normalized = parts[0] + "." + parts[1];
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) normalized = s.split(".").join("");
    else {
      if (s.split(".").length !== 2) return NaN;
      normalized = s;
    }
  } else normalized = s;
  if (normalized.startsWith(".")) normalized = "0" + normalized;
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  const n = sign * Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

/** Muestra el número en es-VE sin ceros de más (qty) o con decimales fijos (money). */
export function formatLocaleNumber(value: number | null, kind: NumberKind, decimals = KIND_DECIMALS[kind]): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const fixed = kind === "money";
  return new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: fixed ? decimals : 0,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(roundTo(value, decimals));
}

/** Paso entero: nunca introduce decimales. 1,5 + 1 = 2,5 (conserva lo escrito). */
export function stepValue(value: number | null, direction: 1 | -1, big: boolean, min?: number, max?: number): number {
  const base = value === null || !Number.isFinite(value) ? 0 : value;
  let next = roundTo(base + direction * (big ? 10 : 1), 6);
  if (min !== undefined && next < min) next = value === null && min > 0 ? min : Math.max(min, next);
  if (max !== undefined && next > max) next = max;
  return next;
}

/** Texto canónico (punto decimal, sin miles) que esperan los formularios existentes. */
export function canonicalNumberText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return String(value);
}

/** Lee el valor que guarda un formulario (número o texto canónico «12.5»). */
export function readStoredNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = value.trim();
  if (s === "") return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const parsed = parseLocaleNumber(s);
  return parsed === null || Number.isNaN(parsed) ? null : parsed;
}

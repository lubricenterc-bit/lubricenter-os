/**
 * Vibración corta en teléfonos que la permiten (Android). iOS la ignora sin error.
 * Solo para momentos que importan: una venta cerrada, una tarjeta que cambia de etapa,
 * soltar para refrescar. Nunca en cada toque, y nunca en modo tranquilo.
 */
export type HapticKind = "tick" | "success" | "warn";

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  success: [12, 40, 18],
  warn: [24, 60, 24],
};

export function haptic(kind: HapticKind = "tick") {
  if (typeof window === "undefined" || typeof navigator === "undefined" || !("vibrate" in navigator)) return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("calm-motion")) return;
  try { navigator.vibrate(PATTERNS[kind]); } catch { /* sin vibración */ }
}

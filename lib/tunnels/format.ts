/** "38639.5" -> "38.639,50". Deterministic (does not depend on the runtime's locale data). */
export function money(value: number | string | null | undefined, decimals = 2): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0,00";
  const [int, dec] = Math.abs(n).toFixed(decimals).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "−" : ""}${grouped}${dec ? "," + dec : ""}`;
}

export const bs = (value: number | string | null | undefined) => `${money(value)} Bs`;
export const usd = (value: number | string | null | undefined) => `${money(value)} USD`;

/** Today in Venezuela (UTC−4, no DST), YYYY-MM-DD. */
export function todayCaracas(now = new Date()): string {
  return new Date(now.getTime() - 4 * 3600_000).toISOString().slice(0, 10);
}

// Rebajas frente al precio de lista validadas en el servidor (migración quick_sale_server_pricing).
export const PRICE_OVERRIDE_CODE = "REBAJA_SIN_AUTORIZACION";

export function isPriceOverrideError(message: string | null | undefined): boolean {
  return !!message && message.includes(PRICE_OVERRIDE_CODE);
}

/** Quita el código técnico y deja el texto para la persona. */
export function priceOverrideText(message: string): string {
  const at = message.indexOf(PRICE_OVERRIDE_CODE);
  if (at < 0) return message;
  return message.slice(at + PRICE_OVERRIDE_CODE.length).replace(/^[:\s]+/, "").trim();
}

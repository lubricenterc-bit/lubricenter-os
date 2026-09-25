import Decimal from 'decimal.js';

// Decimal strings cross the API boundary; binary floating point never totals money.
export const D = Decimal.clone({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
export function money(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error('Monto vacío o inválido');
  const n = new D(value);
  if (!n.isFinite() || n.abs().gte('1000000000000')) throw new Error('Monto fuera de rango');
  return n.toFixed(8);
}
export function positive(value: unknown): string {
  const n = money(value);
  if (new D(n).lte(0)) throw new Error('El monto debe ser mayor que cero');
  return n;
}
export function veMoney(value: string): string {
  const s = value.trim().replace(/\s/g, '');
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/.test(s)) throw new Error(`Monto BDV inválido: ${value}`);
  return money(s.replace(/\./g, '').replace(',', '.'));
}
export function tolerance(expected: string, absolute = '5', relative = '0.001'): string {
  return D.min(new D(absolute), new D(expected).abs().mul(relative)).toFixed(8);
}
export const bankMethod = (method: string) => ['TRANSFER_BDV', 'TRANSFER_BNC', 'MOBILE_PAYMENT'].includes(method);
export function referenceError(method: string, reference: string): string | null {
  return bankMethod(method) && !/^\d{4,32}$/.test(reference.trim()) ? 'Escribe al menos los últimos 4 números de la referencia bancaria.' : null;
}
export const natures = {
  EXPENSE: 'Gasto del negocio', INVENTORY_PURCHASE: 'Compra de inventario', ASSET_PURCHASE: 'Equipo o activo',
  SUPPLIER_PAYMENT: 'Pago de factura a proveedor', OWNER_DRAW: 'Retiro del dueño', PAYROLL: 'Nómina',
  INTERNAL_TRANSFER: 'Entre cuentas propias', REFUND: 'Devolución', TAX: 'Impuesto', BANK_FEE: 'Comisión bancaria', UNCLASSIFIED: 'No sé todavía',
} as const;
export type Nature = keyof typeof natures;

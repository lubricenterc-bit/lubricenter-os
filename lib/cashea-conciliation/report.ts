import { D } from '../finance/money';
import { normalizeText } from './bnc';
import { BRANCHES, caracasDate, type BranchCode, type ClassifiedLine, type EngineException, type EngineResult, type PeriodSummary, type ReceivableRow } from './engine';

// File detection, BDV panel and Excel export for the Cashea branch reconciliation screen.

export type FileKind = 'BNC' | 'CASHEA_TRANSACTIONS' | 'CASHEA_ORDERS' | 'UNKNOWN';

const TRANSACTION_HEADERS = ['Fecha de Transaccion', 'Moneda', 'Método de pago', 'Cuenta', 'Monto pagado en VES', 'Monto Pagado en USD', 'Fecha Tasa de Cambio', 'Tasa de Cambio', '# Referencia', '# Cuota Pagada', '# Orden', '# Factura', 'Sucursal', 'Monto asignado'];
const ORDER_HEADERS = ['# Orden', '# Factura', 'Nombre del comprador', 'Nombre de la tienda', 'Venta total', 'Fecha compra', 'Estado orden', 'Pago en caja', 'Estado pago inicial',
  ...Array.from({ length: 16 }, (_, i) => [`Fecha cuota ${i + 1}`, `Monto cuota ${i + 1}`, `Pagado cuota ${i + 1}`, `Estado cuota ${i + 1}`]).flat()];

export function detectKind(cells: unknown[][]): FileKind {
  const first = (cells[0] ?? []).map(normalizeText);
  if (first.includes('# cuota pagada')) return 'CASHEA_TRANSACTIONS';
  if (first.includes('estado orden')) return 'CASHEA_ORDERS';
  const header = cells.slice(0, 40).find(r => r?.some(c => normalizeText(c) === 'fecha'));
  if (header && header.some(c => normalizeText(c) === 'haber') && header.some(c => normalizeText(c) === 'saldo')) return 'BNC';
  return 'UNKNOWN';
}

/** Cashea writes some headers with and some without accents; the importer expects one spelling. */
export function canonicalCasheaHeaders(cells: unknown[][], kind: 'CASHEA_TRANSACTIONS' | 'CASHEA_ORDERS'): unknown[][] {
  const canon = new Map((kind === 'CASHEA_TRANSACTIONS' ? TRANSACTION_HEADERS : ORDER_HEADERS).map(h => [normalizeText(h), h]));
  return [(cells[0] ?? []).map(h => canon.get(normalizeText(h)) ?? h), ...cells.slice(1)];
}

export type BdvLine = { id: string; occurred_at: string; reference: string; description: string; direction: 'IN' | 'OUT'; amount: string; balance: string | null };
export type BdvPanel = {
  from: string | null; to: string | null; opening: string; fromBnc: string; sales: string; bigOut: string; smallOut: string; fees: string; otherIn: string; closing: string;
  computedClosing: string; big: BdvLine[]; bncTransfers: BdvLine[];
};

/** Cabudare BDV: opening + transfers received from BNC + sales − outflows = closing. */
export function bdvPanel(lines: BdvLine[], cabudareWithdrawals: ClassifiedLine[], salesRefs: Set<string>, bigThreshold = '30000'): BdvPanel {
  const sorted = [...lines].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const z = new D(0); let fromBnc = z, sales = z, big = z, small = z, fees = z, otherIn = z;
  const bigLines: BdvLine[] = [], bncTransfers: BdvLine[] = [];
  const pending = cabudareWithdrawals.map(w => ({ date: w.line_date, amount: new D(w.debit) }));
  for (const l of sorted) {
    const amt = new D(l.amount), day = caracasDate(l.occurred_at);
    if (l.direction === 'IN') {
      const i = pending.findIndex(w => w.amount.eq(amt) && day >= w.date && day <= addDay(w.date));
      if (i >= 0) { pending.splice(i, 1); fromBnc = fromBnc.add(amt); bncTransfers.push(l); }
      else if (salesRefs.has(l.reference.replace(/\D/g, '').slice(-4))) sales = sales.add(amt);
      else otherIn = otherIn.add(amt);
    } else if (/COMISI/i.test(l.description)) fees = fees.add(amt);
    else if (amt.gte(bigThreshold)) { big = big.add(amt); bigLines.push(l); }
    else small = small.add(amt);
  }
  const first = sorted[0], last = sorted.at(-1);
  const opening = first?.balance ? new D(first.balance).sub(first.direction === 'IN' ? first.amount : new D(first.amount).neg()) : z;
  const computed = opening.add(fromBnc).add(sales).add(otherIn).sub(big).sub(small).sub(fees);
  return {
    from: first ? caracasDate(first.occurred_at) : null, to: last ? caracasDate(last.occurred_at) : null,
    opening: opening.toFixed(2), fromBnc: fromBnc.toFixed(2), sales: sales.toFixed(2), otherIn: otherIn.toFixed(2), bigOut: big.toFixed(2), smallOut: small.toFixed(2), fees: fees.toFixed(2),
    closing: last?.balance ? new D(last.balance).toFixed(2) : computed.toFixed(2), computedClosing: computed.toFixed(2), big: bigLines, bncTransfers,
  };
}
function addDay(d: string) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

export const ORIGIN_LABELS: Record<string, string> = {
  MANUAL: 'Asignación manual', CASHEA_REF: 'Referencia en export Cashea', OS_PAYMENT: 'Pago registrado en el OS', CAJA_RATE: 'Pago en caja × tasa',
  CASHEA_SETTLEMENT: 'Liquidación Grupo Cashea', RETIRO_CEDULA: 'Retiro por cédula', COMISION_RETIRO: 'Comisión del retiro', SIN_IDENTIFICAR: 'Sin identificar',
};
export const RULE_LABELS: Record<string, string> = {
  MANUAL: 'Manual', OS_LINK: 'Enlazada en el OS', INVOICE_OS: 'Factura OS-', PAPER_SERIES: 'Serie de papel 01975–02109', PREFIX_NT: 'Factura NT', PREFIX_LM: 'Factura LM',
  TO_CONFIRM: 'Por confirmar', NO_NOMENCLATURE: 'Sin nomenclatura',
};

const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

/** Sheets for the Excel export of a cut. Values are numbers so Excel can sum them. */
export function exportSheets(input: { result: EngineResult; summary: PeriodSummary; receivables: ReceivableRow[]; rate: string; branchName: Map<BranchCode, string>; bdv: BdvPanel | null; exceptions: EngineException[] }) {
  const { result, summary } = input;
  const inPeriod = new Set<string>();
  let on = summary.from_line_id === null;
  for (const l of result.lines) { if (l.id === summary.from_line_id) on = true; if (on) inPeriod.add(l.id); if (l.id === summary.to_line_id) on = false; }
  const periodLines = result.lines.filter(l => inPeriod.has(l.id));
  const name = (b: string) => input.branchName.get(b) ?? b;
  const bold = (v: string) => ({ value: v, fontWeight: 'bold' as const });
  const resumen = [
    [bold(`Corte desde ${summary.from_date ?? '—'} hasta ${summary.to_date ?? '—'}`)],
    [],
    ['Sucursal', 'Entró al BNC', 'Retiró del BNC', 'Ajustes', 'Le toca'].map(bold),
    ...summary.rows.map(r => [r.name, num(r.entered), num(r.withdrawn), num(r.adjustments), num(r.due)]),
    ['Saldo que quedó en el cero', null, null, null, num(summary.residual)],
    [bold('Total'), num(summary.entered), num(summary.withdrawn), 0, num(summary.total)],
    ['Saldo del BNC', null, null, null, num(summary.bank_balance)],
    ['Diferencia', null, null, null, num(summary.difference)],
    [],
    [bold('Por cobrar de Cashea'), null, null, null, `Tasa ${input.rate}`],
    ['Sucursal', 'Vencido USD', 'Por vencer USD', 'Total USD', 'Total Bs'].map(bold),
    ...input.receivables.map(r => [r.name, num(r.overdue_ref), num(r.upcoming_ref), num(r.total_ref), Number(new D(r.total_ref).mul(input.rate || 0).toFixed(2))]),
  ];
  const pagos = [
    ['Fecha', 'Referencia', 'Monto Bs', 'Sucursal', 'Origen', 'Orden Cashea', 'Orden OS', 'Cuotas', 'Detalle', 'Descripción banco'].map(bold),
    ...periodLines.filter(l => new D(l.credit).gt(0)).flatMap(l => l.allocations.map(a => [l.line_date, l.reference, num(a.amount), name(a.branch), ORIGIN_LABELS[l.origin], a.external_order, a.os_order_number, a.installments.join(','), l.note, l.description])),
  ];
  const retiros = [
    ['Fecha', 'Referencia', 'Tipo', 'Monto Bs', 'Sucursal', 'Cédula', 'Detalle', 'Saldo'].map(bold),
    ...periodLines.filter(l => new D(l.debit).gt(0)).map(l => [l.line_date, l.reference, l.kind, num(l.debit), name(l.allocations[0]?.branch ?? BRANCHES.POR_CONFIRMAR), l.cedula, l.note, num(l.balance)]),
  ];
  const ordenes = [
    ['Orden Cashea', 'Factura', 'Comprador', 'Fecha compra', 'Estado', 'Total USD', 'Sucursal', 'Regla', 'Orden OS', 'Vencido USD', 'Por vencer USD', 'Bs recibidos'].map(bold),
    ...result.orders.map(o => [o.external_order, o.invoice, o.buyer, o.purchased_on, o.status, num(o.total_ref), name(o.ownership.branch), RULE_LABELS[o.ownership.rule], o.ownership.os_order_number, num(o.overdue_ref), num(o.upcoming_ref), num(o.received_ves)]),
  ];
  const excepciones = [['Tipo', 'Título', 'Detalle', 'Monto Bs'].map(bold), ...input.exceptions.map(e => [e.kind, e.title, e.detail, num(e.amount_ves)])];
  const sheets = [
    { sheet: 'Resumen', data: resumen, columns: [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 16 }] },
    { sheet: 'Pagos BNC', data: pagos, columns: [{ width: 12 }, { width: 16 }, { width: 14 }, { width: 22 }, { width: 24 }, { width: 14 }, { width: 12 }, { width: 8 }, { width: 40 }, { width: 40 }] },
    { sheet: 'Retiros', data: retiros, columns: [{ width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 22 }, { width: 12 }, { width: 36 }, { width: 14 }] },
    { sheet: 'Órdenes', data: ordenes, columns: [{ width: 14 }, { width: 14 }, { width: 24 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 22 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }] },
    { sheet: 'Excepciones', data: excepciones, columns: [{ width: 24 }, { width: 60 }, { width: 70 }, { width: 14 }] },
  ];
  if (input.bdv) sheets.push({ sheet: 'BDV Cabudare', columns: [{ width: 34 }, { width: 18 }, { width: 50 }], data: [
    [bold(`BDV Cabudare ${input.bdv.from ?? ''} → ${input.bdv.to ?? ''}`)], [],
    ['Saldo inicial', num(input.bdv.opening)], ['Retiros recibidos del BNC', num(input.bdv.fromBnc)], ['Cobros de ventas', num(input.bdv.sales)], ['Otras entradas', num(input.bdv.otherIn)],
    ['Egresos grandes', num(input.bdv.bigOut)], ['Gastos menores', num(input.bdv.smallOut)], ['Comisiones', num(input.bdv.fees)], ['Saldo final', num(input.bdv.closing)], [],
    ['Egresos grandes', 'Monto', 'Descripción'].map(bold), ...input.bdv.big.map(l => [caracasDate(l.occurred_at) + ' ref ' + l.reference, num(l.amount), l.description]),
  ] as never });
  return sheets;
}

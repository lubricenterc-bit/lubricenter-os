import { D, money, positive, veMoney } from './money';

export type Provider = 'BDV' | 'CASHEA_TRANSACTIONS' | 'CASHEA_ORDERS';
export type Issue = { row: number; message: string };
export type ExternalRow = {
  row: number; occurred_at: string; reference: string; description: string; direction: 'IN' | 'OUT'; currency: 'VES' | 'USD';
  amount: string; balance?: string; amount_ref?: string; assigned_ref?: string; rate?: string; rate_date?: string;
  external_order?: string; installments?: number[]; provider_account?: string; channel_label?: string; raw: Record<string, unknown>;
};
export type OrderSnapshot = {
  row: number; external_order: string; purchased_on: string; status: string; total_ref: string; initial_ref: string;
  installments: { number: number; due_date: string; amount_ref: string; paid_ref: string; status: string }[]; raw: Record<string, unknown>;
};
export type Preview = { provider: Provider; rows: ExternalRow[]; orders: OrderSnapshot[]; errors: Issue[]; warnings: Issue[]; duplicates: number; balance_chain: boolean | null; observed_from: string | null; observed_to: string | null };
const empty = (provider: Provider): Preview => ({ provider, rows: [], orders: [], errors: [], warnings: [], duplicates: 0, balance_chain: null, observed_from: null, observed_to: null });
function dates(p: Preview) {
  const dates = [...p.rows.map(r => r.occurred_at.slice(0, 10)), ...p.orders.map(r => r.purchased_on)].sort();
  p.observed_from = dates[0] ?? null; p.observed_to = dates.at(-1) ?? null;
  return p;
}
function dateOnly(v: unknown): string {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) !== s) throw new Error('Fecha inválida');
  return s;
}
function localTimestamp(v: unknown): string {
  // Cashea exports wall-clock timestamps without offset. Explicit Caracas avoids host/browser TZ drift.
  const s = v instanceof Date ? v.toISOString().slice(0, 19) : String(v ?? '');
  dateOnly(s);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) || +s.slice(11, 13) > 23 || +s.slice(14, 16) > 59 || +s.slice(17, 19) > 59) throw new Error('Hora inválida');
  return s + '-04:00';
}
function id(v: unknown, label: string): string {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error(`${label} inválido`);
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error(`${label} perdió precisión en Excel`);
  return s;
}
function nonnegative(v: unknown): string { const s = money(v); if (new D(s).lt(0)) throw new Error('Monto negativo'); return s; }

export function parseBdv(text: string): Preview {
  const p = empty('BDV');
  const tokens = text.replace(/\r/g, '').split(/[\n\t]/).map(s => s.trim()).filter(Boolean);
  const header = ['Fecha', 'Referencia', 'Descripción', 'Débito / Crédito', 'Monto', 'Saldo'];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length;) {
    if (tokens[i] === 'Fecha' && header.every((s, n) => tokens[i + n] === s)) { i += 6; continue; }
    const line = i + 1;
    try {
      const m = /^(\d{2})-(\d{2})-(\d{4}) - (\d{2}):(\d{2})$/.exec(tokens[i]);
      if (!m) throw new Error('Fila no reconocida. Copia las seis columnas completas del banco.');
      if (i + 5 >= tokens.length) throw new Error('Última fila incompleta');
      const occurred_at = localTimestamp(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`);
      const reference = id(tokens[i + 1], 'Referencia');
      const sign = tokens[i + 3].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
      if (!['CREDITO', 'DEBITO'].includes(sign)) throw new Error('Débito/crédito no reconocido');
      const amountSigned = new D(veMoney(tokens[i + 4]));
      if (amountSigned.isZero() || (sign === 'CREDITO' && amountSigned.lt(0)) || (sign === 'DEBITO' && amountSigned.gt(0))) throw new Error('Signo del monto contradice débito/crédito');
      const row: ExternalRow = { row: line, occurred_at, reference, description: tokens[i + 2], direction: sign === 'CREDITO' ? 'IN' : 'OUT', currency: 'VES', amount: amountSigned.abs().toFixed(8), balance: veMoney(tokens[i + 5]), raw: { cells: tokens.slice(i, i + 6) } };
      const key = JSON.stringify([occurred_at, reference, row.direction, row.amount, row.balance]);
      if (seen.has(key)) p.duplicates++; else { seen.add(key); p.rows.push(row); }
      i += 6;
    } catch (e) {
      p.errors.push({ row: line, message: (e as Error).message });
      i++; while (i < tokens.length && !/^\d{2}-\d{2}-\d{4} -/.test(tokens[i]) && tokens[i] !== 'Fecha') i++;
    }
  }
  if (!p.rows.length) p.errors.push({ row: 0, message: 'No hay movimientos completos para importar.' });
  // Preserve source ordering at equal timestamps: bank running balances disambiguate fee/payment pairs.
  const descending = p.rows.length < 2 || p.rows[0].occurred_at >= p.rows.at(-1)!.occurred_at;
  const ordered = descending ? [...p.rows].reverse() : [...p.rows];
  p.balance_chain = p.errors.length === 0 && ordered.length > 0;
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    const expected = new D(a.balance!).add(new D(b.amount).mul(b.direction === 'IN' ? 1 : -1));
    if (a.occurred_at > b.occurred_at || !expected.eq(b.balance!)) {
      p.balance_chain = false; p.warnings.push({ row: b.row, message: 'La secuencia de saldos tiene un salto. Revisa si falta una página.' });
    }
  }
  return dates(p);
}

export function parseCashea(cells: unknown[][], provider: Exclude<Provider, 'BDV'>): Preview {
  const p = empty(provider);
  const headers = (cells[0] ?? []).map(h => String(h ?? '').trim());
  const required = provider === 'CASHEA_TRANSACTIONS'
    ? ['Fecha de Transaccion', 'Moneda', 'Método de pago', 'Cuenta', 'Monto pagado en VES', 'Monto Pagado en USD', 'Fecha Tasa de Cambio', 'Tasa de Cambio', '# Referencia', '# Cuota Pagada', '# Orden', 'Monto asignado']
    : ['# Orden', 'Venta total', 'Fecha compra', 'Estado orden', 'Pago en caja', 'Fecha cuota 1', 'Monto cuota 1', 'Pagado cuota 1', 'Estado cuota 1'];
  if (required.some(h => !headers.includes(h)) || new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
    p.errors.push({ row: 1, message: 'Columnas incompatibles o duplicadas. Usa el reporte original de Cashea.' }); return p;
  }
  const seen = new Set<string>();
  cells.slice(1).forEach((values, index) => {
    if (values.every(v => v === null || v === undefined || v === '')) return;
    const row = index + 2, raw = Object.fromEntries(headers.map((h, i) => [h, values[i] instanceof Date ? (values[i] as Date).toISOString() : values[i] ?? null]));
    const r = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    try {
      const key = JSON.stringify(raw); if (seen.has(key)) { p.duplicates++; return; } seen.add(key);
      const external_order = id(r['# Orden'], 'Número de orden Cashea');
      if (provider === 'CASHEA_TRANSACTIONS') {
        const currency = String(r.Moneda); if (!['VES', 'USD'].includes(currency)) throw new Error('Moneda desconocida');
        const installments = String(r['# Cuota Pagada']).split(',').map(v => Number(v.trim()));
        // Cashea uses installment 0 for the initial payment; preserve it separately from financed installments.
        if (!installments.length || installments.some(v => !Number.isInteger(v) || v < 0 || v > 16) || new Set(installments).size !== installments.length) throw new Error('Cuotas inválidas');
        const amount_ref = positive(r['Monto Pagado en USD']), assigned_ref = positive(r['Monto asignado']);
        const rate = positive(r['Tasa de Cambio']);
        const tx: ExternalRow = { row, occurred_at: localTimestamp(r['Fecha de Transaccion']), reference: id(r['# Referencia'], 'Referencia'), description: `Cashea · ${String(r['Método de pago'])}`, currency: currency as 'VES' | 'USD', direction: 'IN', amount: currency === 'VES' ? positive(r['Monto pagado en VES']) : amount_ref, amount_ref, assigned_ref, rate, rate_date: dateOnly(r['Fecha Tasa de Cambio']), external_order, installments, provider_account: String(r.Cuenta ?? ''), raw };
        if (!tx.provider_account) throw new Error('Cuenta externa vacía');
        if (new D(assigned_ref).gt(amount_ref)) p.warnings.push({ row, message: new D(assigned_ref).sub(amount_ref).lte('.005') ? 'Precisión del reporte: diferencia inferior a medio centavo USD; se conservará explícitamente.' : 'Monto asignado supera el USD cobrado: requiere revisar el reporte.' });
        p.rows.push(tx);
      } else {
        const status = String(r['Estado orden']);
        if (!['IN PROGRESS', 'CANCELLED', 'CLOSED'].includes(status)) throw new Error('Estado de orden no reconocido');
        const snapshot: OrderSnapshot = { row, external_order, purchased_on: dateOnly(r['Fecha compra']), status, total_ref: positive(r['Venta total']), initial_ref: nonnegative(r['Pago en caja']), installments: [], raw };
        for (let n = 1; n <= 16; n++) {
          const amount = r[`Monto cuota ${n}`];
          if (amount === undefined || amount === null || amount === '' || new D(String(amount)).isZero()) continue;
          snapshot.installments.push({ number: n, due_date: dateOnly(r[`Fecha cuota ${n}`]), amount_ref: positive(amount), paid_ref: nonnegative(r[`Pagado cuota ${n}`]), status: String(r[`Estado cuota ${n}`] ?? '') });
        }
        const schedule = snapshot.installments.reduce((s, x) => s.add(x.amount_ref), new D(snapshot.initial_ref));
        if (schedule.sub(snapshot.total_ref).abs().gt('.01')) p.warnings.push({ row, message: 'Inicial más cuotas no coincide con total de la orden.' });
        if (snapshot.installments.some(x => new D(x.paid_ref).gt(x.amount_ref))) p.warnings.push({ row, message: 'Una cuota muestra un pago mayor que su importe.' });
        if (p.orders.some(o => o.external_order === external_order)) throw new Error('La orden aparece con dos versiones en el mismo archivo');
        p.orders.push(snapshot);
      }
    } catch (e) { p.errors.push({ row, message: (e as Error).message }); }
  });
  if (!p.rows.length && !p.orders.length) p.errors.push({ row: 0, message: 'El archivo no contiene filas válidas.' });
  return dates(p);
}

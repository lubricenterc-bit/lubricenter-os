import { D, money } from '../finance/money';
import type { XlsCell } from '../xls-biff';

// Parser for the BNC account statement ("Rpt*.xls"). The bank places a title block
// above the table, so the header row is located by the cell that reads "Fecha".
export type BncLine = {
  row: number; line_date: string; day_index: number; tx_code: string; tx_type: string; op_type: string;
  description: string; reference: string; debit: string; credit: string; balance: string;
};
export type BncPreview = {
  lines: BncLine[]; errors: { row: number; message: string }[]; warnings: { row: number; message: string }[];
  duplicates: number; chain_ok: boolean; observed_from: string | null; observed_to: string | null; account: string | null;
};

export const normalizeText = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const normalizeRef = (s: unknown) => String(s ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');

const HEADERS = {
  fecha: ['fecha'], codigo: ['codigo transaccion', 'codigo de transaccion'], tipoTx: ['tipo transaccion', 'tipo de transaccion'],
  tipoOp: ['tipo operacion', 'tipo de operacion'], descripcion: ['descripcion'], referencia: ['referencia'],
  debe: ['debe', 'debito', 'cargo'], haber: ['haber', 'credito', 'abono'], saldo: ['saldo'],
} as const;

function excelSerialToDate(n: number): string {
  if (!Number.isFinite(n) || n < 30000 || n > 80000) throw new Error('Fecha inválida');
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

export function bncDate(v: XlsCell | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return excelSerialToDate(v);
  const s = String(v ?? '').trim();
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s.*)?$/.exec(s);
  const iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)) ? `${m[1]}-${m[2]}-${m[3]}` : '';
  if (!iso || new Date(iso + 'T12:00:00Z').toISOString().slice(0, 10) !== iso) throw new Error('Fecha inválida');
  return iso;
}

/** Accepts native numbers, "1.234,56" (Venezuelan) and "1234.56". Empty means zero. */
export function bncAmount(v: XlsCell | Date): string {
  if (v === null || v === undefined || v === '') return money(0);
  if (typeof v === 'number') return money(v);
  let s = String(v).replace(/\s|Bs\.?/gi, '');
  if (s === '' || s === '-') return money(0);
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Monto inválido: ${v}`);
  return money(s);
}

export function withdrawalCedula(description: string): string | null {
  const m = /C\.?\s*E\.?\s*D\.?\s*[:.]?\s*([VEJPG])\s*-?\s*0*(\d{5,10})/i.exec(description);
  return m ? m[1].toUpperCase() + m[2] : null;
}

export function lineKey(l: Pick<BncLine, 'line_date' | 'reference' | 'debit' | 'credit' | 'balance'>): string {
  return [l.line_date, normalizeRef(l.reference), new D(l.debit).toFixed(2), new D(l.credit).toFixed(2), new D(l.balance).toFixed(2)].join('|');
}

function chainBreaks(lines: BncLine[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const expected = new D(lines[i - 1].balance).add(lines[i].credit).sub(lines[i].debit);
    if (!expected.sub(lines[i].balance).abs().lte('0.005')) out.push(i);
  }
  return out;
}

export function parseBnc(cells: (XlsCell | Date)[][]): BncPreview {
  const p: BncPreview = { lines: [], errors: [], warnings: [], duplicates: 0, chain_ok: false, observed_from: null, observed_to: null, account: null };
  const headerRow = cells.findIndex(r => r?.some(c => normalizeText(c) === 'fecha'));
  if (headerRow < 0) { p.errors.push({ row: 0, message: 'No se encontró la fila de encabezados (Fecha, Referencia, Debe, Haber, Saldo).' }); return p; }
  for (const r of cells.slice(0, headerRow)) for (const c of r ?? []) { const m = /(\d{4}[-\s]?\d{4}[-\s]?\d{2}[-\s]?\d{10}|\d{20})/.exec(String(c ?? '')); if (m && !p.account) p.account = m[1].replace(/\D/g, ''); }
  const header = cells[headerRow].map(normalizeText);
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, header.findIndex(h => (names as readonly string[]).includes(h))])) as Record<keyof typeof HEADERS, number>;
  const missing = (['fecha', 'referencia', 'debe', 'haber', 'saldo'] as const).filter(k => col[k] < 0);
  if (missing.length) { p.errors.push({ row: headerRow + 1, message: `Faltan columnas: ${missing.join(', ')}` }); return p; }
  const cell = (r: (XlsCell | Date)[], k: keyof typeof HEADERS) => (col[k] < 0 ? null : r[col[k]] ?? null);
  const parsed: BncLine[] = [];
  cells.slice(headerRow + 1).forEach((r, i) => {
    const row = headerRow + 2 + i;
    if (!r || r.every(c => c === null || c === '')) return;
    let line_date: string;
    try { line_date = bncDate(cell(r, 'fecha') as XlsCell); } catch {
      const hasMoney = [cell(r, 'debe'), cell(r, 'haber')].some(v => v !== null && v !== '' && v !== 0);
      if (hasMoney) p.errors.push({ row, message: 'Fecha inválida en un movimiento con monto' });
      return; // totals/footer rows
    }
    try {
      const debit = bncAmount(cell(r, 'debe') as XlsCell), credit = bncAmount(cell(r, 'haber') as XlsCell), balance = bncAmount(cell(r, 'saldo') as XlsCell);
      if (new D(debit).lt(0) || new D(credit).lt(0)) throw new Error('Debe/Haber negativo');
      if (new D(debit).isZero() === new D(credit).isZero()) throw new Error('El movimiento debe tener Debe o Haber, no ambos');
      const s = (k: keyof typeof HEADERS) => String(cell(r, k) ?? '').trim();
      const refCell = cell(r, 'referencia');
      const reference = typeof refCell === 'number' ? String(Math.round(refCell)) : s('referencia');
      parsed.push({ row, line_date, day_index: 0, tx_code: s('codigo'), tx_type: s('tipoTx'), op_type: s('tipoOp'), description: s('descripcion'), reference, debit, credit, balance });
    } catch (e) { p.errors.push({ row, message: (e as Error).message }); }
  });
  if (!parsed.length) { p.errors.push({ row: 0, message: 'El estado de cuenta no tiene movimientos.' }); return p; }
  // Keep statement order; if it is newest-first, reverse so the running balance reads forward.
  let ordered = parsed;
  const reversed = [...parsed].reverse();
  if (parsed[0].line_date > parsed.at(-1)!.line_date || (parsed[0].line_date === parsed.at(-1)!.line_date && chainBreaks(reversed).length < chainBreaks(parsed).length)) ordered = reversed;
  const seen = new Set<string>();
  for (const l of ordered) { const k = lineKey(l); if (seen.has(k)) { p.duplicates++; continue; } seen.add(k); p.lines.push(l); }
  let day = '', idx = 0;
  for (const l of p.lines) { if (l.line_date !== day) { day = l.line_date; idx = 0; } l.day_index = idx++; }
  const breaks = chainBreaks(p.lines);
  for (const b of breaks) p.warnings.push({ row: p.lines[b].row, message: 'Saldo no encadena con el movimiento anterior. Falta una página o hay un movimiento fuera de orden.' });
  p.chain_ok = breaks.length === 0 && p.errors.length === 0;
  p.observed_from = p.lines[0].line_date; p.observed_to = p.lines.at(-1)!.line_date;
  return p;
}

/** Merge several statements (they overlap), keep first occurrence and report chain continuity. */
export function mergeBnc(previews: BncPreview[]): BncPreview {
  const all = previews.flatMap(p => p.lines).sort((a, b) => a.line_date.localeCompare(b.line_date));
  const byDay = new Map<string, BncLine[][]>();
  for (const p of previews) {
    const days = new Map<string, BncLine[]>();
    for (const l of p.lines) (days.get(l.line_date) ?? days.set(l.line_date, []).get(l.line_date)!).push(l);
    for (const [d, ls] of days) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(ls);
  }
  // For each day keep the longest version: overlapping exports repeat whole days.
  const lines: BncLine[] = [];
  for (const d of [...byDay.keys()].sort()) {
    const versions = byDay.get(d)!.sort((a, b) => b.length - a.length);
    const keep = versions[0]; const keys = new Set(keep.map(lineKey));
    for (const v of versions.slice(1)) for (const l of v) if (!keys.has(lineKey(l))) { keep.push(l); keys.add(lineKey(l)); }
    keep.forEach((l, i) => lines.push({ ...l, day_index: i }));
  }
  const merged: BncPreview = { lines, errors: previews.flatMap(p => p.errors), warnings: [], duplicates: all.length - lines.length, chain_ok: false, observed_from: lines[0]?.line_date ?? null, observed_to: lines.at(-1)?.line_date ?? null, account: previews.find(p => p.account)?.account ?? null };
  const breaks = chainBreaks(lines);
  for (const b of breaks) merged.warnings.push({ row: lines[b].row, message: `Salto de saldo el ${lines[b].line_date} (ref ${lines[b].reference}).` });
  merged.chain_ok = breaks.length === 0 && merged.errors.length === 0;
  return merged;
}

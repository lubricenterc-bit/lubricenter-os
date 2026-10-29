import { D } from '../finance/money';
import { normalizeRef, normalizeText, withdrawalCedula } from './bnc';

// Cashea has a single merchant store for every Lubricenter branch and all instalments land
// in one BNC account. This engine decides whose money each bank line is, using only data
// already stored (bank lines, Cashea exports, OS sales/payments) plus manual decisions.
// It is pure: the same input always yields the same report, so it is unit-tested.

export const BRANCHES = {
  CABUDARE: 'CABUDARE', NORTE: 'NORTE', LA_MORAN: 'LA_MORAN', AFUERA: 'AFUERA',
  AFUERA_SIN_ASIGNAR: 'AFUERA_SIN_ASIGNAR', POR_CONFIRMAR: 'POR_CONFIRMAR',
} as const;
export type BranchCode = string;
export type Branch = { code: BranchCode; name: string; sort: number };

export type BankLine = {
  id: string; line_date: string; day_index: number; reference: string; op_type: string; tx_type: string;
  description: string; debit: string; credit: string; balance: string;
};
export type CasheaPayment = {
  id: string; occurred_at: string; reference: string; external_order: string; installments: number[];
  currency: 'VES' | 'USD'; amount: string; amount_ref: string; rate: string | null; rate_date: string | null; invoice: string | null;
};
export type CasheaInstallment = { number: number; due_date: string; amount_ref: string; paid_ref: string; status: string };
export type CasheaOrder = {
  external_order: string; invoice: string | null; buyer: string | null; purchased_on: string; status: string;
  total_ref: string; initial_ref: string; installments: CasheaInstallment[];
};
export type OsSale = {
  sale_id: string; order_id: string; order_number: string; cashea_reference: string | null; status: string;
  order_date: string; gross_ref: string; initial_ref: string;
};
export type OsOrder = { order_id: string; order_number: string; order_date: string; total_ref: string; status: string; has_cashea: boolean };
export type OsPayment = {
  payment_id: string; order_id: string; order_number: string; method: string; currency: string; amount: string;
  reference: string | null; paid_at: string; cashea_order: boolean;
};
export type Override = { id: string; subject: 'ORDER' | 'BANK_LINE'; subject_key: string; branch: BranchCode; note: string };
export type Adjustment = { id: string; occurred_on: string; amount_ves: string; debit_branch: BranchCode; credit_branch: BranchCode; note: string; reference: string | null };
export type Cutoff = { id: string; cut_date: string; reference: string; balance_ves: string; bank_line_id: string | null; created_at: string; note: string | null };
export type Destination = { cedula: string; branch: BranchCode; label: string };

export type EngineInput = {
  branches: Branch[]; bankLines: BankLine[]; casheaPayments: CasheaPayment[]; casheaOrders: CasheaOrder[];
  osSales: OsSale[]; osOrders: OsOrder[]; osPayments: OsPayment[]; overrides: Override[]; adjustments: Adjustment[];
  cutoffs: Cutoff[]; destinations: Destination[]; today: string; zeroThreshold?: string;
};

export type OwnershipRule = 'MANUAL' | 'OS_LINK' | 'INVOICE_OS' | 'PAPER_SERIES' | 'PREFIX_NT' | 'PREFIX_LM' | 'TO_CONFIRM' | 'NO_NOMENCLATURE';
export type Ownership = { branch: BranchCode; rule: OwnershipRule; os_order_number: string | null; invoice: string | null };
export type LineKind = 'ABONO' | 'LIQUIDACION_CASHEA' | 'RETIRO' | 'COMISION' | 'OTRO_DEBITO';
export type MatchOrigin = 'MANUAL' | 'CASHEA_REF' | 'OS_PAYMENT' | 'CAJA_RATE' | 'CASHEA_SETTLEMENT' | 'RETIRO_CEDULA' | 'COMISION_RETIRO' | 'SIN_IDENTIFICAR';
export type Allocation = { branch: BranchCode; amount: string; external_order: string | null; os_order_number: string | null; installments: number[] };
export type ClassifiedLine = BankLine & { kind: LineKind; origin: MatchOrigin; allocations: Allocation[]; note: string; cedula: string | null };
export type ExceptionKind =
  | 'SIN_IDENTIFICAR' | 'DEBITO_SIN_CLASIFICAR' | 'RETIRO_CEDULA_DESCONOCIDA' | 'CANCELADA_CON_INICIAL' | 'OS_BDV_EN_BNC'
  | 'MONTO_DIFERENTE' | 'FACTURA_MAL_ESCRITA' | 'REFERENCIA_MAL_CARGADA' | 'POSIBLE_CABUDARE' | 'CABUDARE_SIN_ENLACE'
  | 'INICIAL_NO_REGISTRADO' | 'SALTO_DE_SALDO' | 'CORTE_NO_ENCONTRADO' | 'REFERENCIA_PAGO_DISTINTA';
export type MoveToBncFix = {
  action: 'MOVE_TO_BNC'; payment_id: string; bank_line_id: string; order_id: string; order_number: string; from_method: string;
  from_reference: string; to_reference: string; amount_ves: string; bank_amount_ves: string; bank_date: string;
};
export type EngineException = {
  key: string; kind: ExceptionKind; title: string; detail: string; amount_ves?: string; amount_ref?: string;
  bank_line_id?: string; external_order?: string; order_id?: string; order_number?: string; sale_id?: string;
  fix?: MoveToBncFix | { action: 'SET_REFERENCE'; sale_id: string; reference: string } | { action: 'CORRECT_PAYMENT'; order_id: string } | { action: 'ASSIGN_ORDER'; external_order: string; branch: BranchCode };
};
export type BranchRow = { branch: BranchCode; name: string; entered: string; withdrawn: string; adjustments: string; due: string };
export type PeriodSummary = {
  cutoff: Cutoff | null; from_line_id: string | null; to_line_id: string | null; from_date: string | null; to_date: string | null;
  rows: BranchRow[]; residual: string; total: string; bank_balance: string | null; difference: string; entered: string; withdrawn: string;
  credits: number; anchor_found: boolean;
};
export type ReceivableRow = { branch: BranchCode; name: string; overdue_ref: string; upcoming_ref: string; total_ref: string };
export type OrderRow = {
  external_order: string; invoice: string | null; buyer: string | null; purchased_on: string; status: string; total_ref: string;
  ownership: Ownership; overdue_ref: string; upcoming_ref: string; received_ves: string;
};
export type ZeroSuggestion = { line: ClassifiedLine; balance: string };
export type EngineResult = {
  ownership: Map<string, Ownership>; lines: ClassifiedLine[]; current: PeriodSummary; receivables: ReceivableRow[];
  orders: OrderRow[]; exceptions: EngineException[]; chainBreaks: string[]; zeroSuggestion: ZeroSuggestion | null;
  rateByDate: Map<string, string>;
};

const ZERO = new D(0);
const PAPER_FROM = 1975, PAPER_TO = 2109;
const NO_INVOICE_CUTOVER = '2026-09-22';
export const UNASSIGNED_RULES: OwnershipRule[] = ['TO_CONFIRM', 'NO_NOMENCLATURE'];

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function caracasDate(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
const fixed = (d: InstanceType<typeof D>) => d.toFixed(2);
const sum = (xs: (string | InstanceType<typeof D>)[]) => xs.reduce<InstanceType<typeof D>>((s, x) => s.add(x), ZERO);
const cleanInvoice = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');
const lineOrder = (a: BankLine, b: BankLine) => a.line_date.localeCompare(b.line_date) || a.day_index - b.day_index;

/** Branch rules, in order. A manual decision always wins. */
export function ownershipOf(input: {
  external_order: string; invoice: string | null; purchased_on: string | null; linked: OsSale | undefined; manual: Override | undefined;
}): Ownership {
  const invoice = cleanInvoice(input.invoice) || null;
  const base = { invoice, os_order_number: input.linked?.order_number ?? null };
  if (input.manual) return { ...base, branch: input.manual.branch, rule: 'MANUAL' };
  if (input.linked) return { ...base, branch: BRANCHES.CABUDARE, rule: 'OS_LINK' };
  const inv = invoice ?? '';
  if (inv.startsWith('OS-')) return { ...base, branch: BRANCHES.CABUDARE, rule: 'INVOICE_OS' };
  if (/^\d{5}$/.test(inv) && +inv >= PAPER_FROM && +inv <= PAPER_TO) return { ...base, branch: BRANCHES.CABUDARE, rule: 'PAPER_SERIES' };
  if (inv.startsWith('NT')) return { ...base, branch: BRANCHES.NORTE, rule: 'PREFIX_NT' };
  if (inv.startsWith('LM')) return { ...base, branch: BRANCHES.LA_MORAN, rule: 'PREFIX_LM' };
  if (inv === '2007' || inv === '2008' || (!inv && (!input.purchased_on || input.purchased_on < NO_INVOICE_CUTOVER))) return { ...base, branch: BRANCHES.POR_CONFIRMAR, rule: 'TO_CONFIRM' };
  return { ...base, branch: BRANCHES.AFUERA, rule: 'NO_NOMENCLATURE' };
}

function lineKind(l: BankLine): LineKind {
  if (new D(l.credit).gt(0)) return /GRUPO\s*CASHEA/i.test(l.description) ? 'LIQUIDACION_CASHEA' : 'ABONO';
  const op = normalizeText(l.op_type + ' ' + l.tx_type);
  if (op.includes('comision')) return 'COMISION';
  if (op.includes('emitido') || withdrawalCedula(l.description)) return 'RETIRO';
  return 'OTRO_DEBITO';
}

function splitAmount(total: string, weights: InstanceType<typeof D>[]): string[] {
  const w = sum(weights);
  if (w.lte(0)) return weights.map((_, i) => (i === 0 ? fixed(new D(total)) : '0.00'));
  const parts = weights.map(x => new D(total).mul(x).div(w).toDecimalPlaces(2));
  const diff = new D(total).sub(sum(parts));
  parts[parts.length - 1] = parts[parts.length - 1].add(diff);
  return parts.map(fixed);
}

function levenshteinAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function runEngine(input: EngineInput): EngineResult {
  const threshold = new D(input.zeroThreshold ?? '10000');
  const branchName = new Map(input.branches.map(b => [b.code, b.name]));
  const exceptions: EngineException[] = [];
  const addException = (e: EngineException) => { if (!exceptions.some(x => x.key === e.key)) exceptions.push(e); };

  // --- Rates: Cashea's own daily rate from the payment export, nearest previous date as fallback.
  const rateByDate = new Map<string, string>();
  for (const p of input.casheaPayments) if (p.rate && p.rate_date && !rateByDate.has(p.rate_date)) rateByDate.set(p.rate_date, p.rate);
  const rateDates = [...rateByDate.keys()].sort();
  const rateFor = (date: string): InstanceType<typeof D> | null => {
    let best: string | null = null;
    for (const d of rateDates) { if (d <= date) best = d; else break; }
    best ??= rateDates[0] ?? null;
    return best ? new D(rateByDate.get(best)!) : null;
  };

  // --- Ownership of every Cashea order we know about (orders export + payment export).
  const salesByRef = new Map<string, OsSale>();
  for (const s of input.osSales) if (s.cashea_reference && s.status !== 'CANCELLED') salesByRef.set(normalizeRef(s.cashea_reference), s);
  for (const s of input.osSales) if (s.cashea_reference && !salesByRef.has(normalizeRef(s.cashea_reference))) salesByRef.set(normalizeRef(s.cashea_reference), s);
  const manualOrder = new Map(input.overrides.filter(o => o.subject === 'ORDER').map(o => [o.subject_key, o]));
  const manualLine = new Map(input.overrides.filter(o => o.subject === 'BANK_LINE').map(o => [o.subject_key, o]));
  const orderByNumber = new Map(input.casheaOrders.map(o => [o.external_order, o]));
  const paymentsByOrder = new Map<string, CasheaPayment[]>();
  for (const p of input.casheaPayments) (paymentsByOrder.get(p.external_order) ?? paymentsByOrder.set(p.external_order, []).get(p.external_order)!).push(p);
  const ownership = new Map<string, Ownership>();
  for (const key of new Set([...orderByNumber.keys(), ...paymentsByOrder.keys()])) {
    const o = orderByNumber.get(key), pays = paymentsByOrder.get(key) ?? [];
    const invoice = o?.invoice ?? pays.find(p => p.invoice)?.invoice ?? null;
    const purchased = o?.purchased_on ?? (pays.length ? pays.map(p => caracasDate(p.occurred_at)).sort()[0] : null);
    ownership.set(key, ownershipOf({ external_order: key, invoice, purchased_on: purchased, linked: salesByRef.get(normalizeRef(key)), manual: manualOrder.get(key) }));
  }
  const ownerOf = (order: string): Ownership => ownership.get(order) ?? { branch: BRANCHES.POR_CONFIRMAR, rule: 'TO_CONFIRM', os_order_number: null, invoice: null };

  // --- Classify every bank line.
  const casheaByRef = new Map<string, CasheaPayment[]>();
  for (const p of input.casheaPayments) { const r = normalizeRef(p.reference); if (r) (casheaByRef.get(r) ?? casheaByRef.set(r, []).get(r)!).push(p); }
  const destinations = new Map(input.destinations.map(d => [d.cedula.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z])0+/, '$1'), d]));
  const sorted = [...input.bankLines].sort(lineOrder);
  const usedOsPayments = new Set<string>();
  const initialMatched = new Set<string>(); // external orders whose initial was located in the bank
  for (const p of input.casheaPayments) if (p.installments.includes(0)) initialMatched.add(p.external_order);
  const lines: ClassifiedLine[] = [];
  const pendingCommissions: ClassifiedLine[] = [];
  const deferred: ClassifiedLine[] = [];

  for (const l of sorted) {
    const kind = lineKind(l), amount = kind === 'ABONO' || kind === 'LIQUIDACION_CASHEA' ? l.credit : l.debit;
    const cl: ClassifiedLine = { ...l, kind, origin: 'SIN_IDENTIFICAR', allocations: [], note: '', cedula: withdrawalCedula(l.description) };
    const single = (branch: BranchCode, extra: Partial<Allocation> = {}) => [{ branch, amount: fixed(new D(amount)), external_order: null, os_order_number: null, installments: [], ...extra }];
    const manual = manualLine.get(l.id);
    if (manual) { cl.origin = 'MANUAL'; cl.allocations = single(manual.branch); cl.note = manual.note; lines.push(cl); continue; }

    if (kind === 'RETIRO') {
      const dest = cl.cedula ? destinations.get(cl.cedula) : undefined;
      cl.origin = 'RETIRO_CEDULA';
      cl.allocations = single(dest?.branch ?? BRANCHES.POR_CONFIRMAR);
      cl.note = dest ? `Retiro a ${dest.label}` : `Retiro a cédula ${cl.cedula ?? 'sin cédula'} no registrada`;
      if (!dest) addException({ key: `retiro:${l.id}`, kind: 'RETIRO_CEDULA_DESCONOCIDA', title: 'Retiro a una cédula no registrada', detail: `${l.line_date} · ref ${l.reference} · ${cl.cedula ?? 'sin cédula'}`, amount_ves: l.debit, bank_line_id: l.id });
    } else if (kind === 'COMISION') {
      cl.origin = 'COMISION_RETIRO'; pendingCommissions.push(cl);
    } else if (kind === 'OTRO_DEBITO') {
      cl.allocations = single(BRANCHES.POR_CONFIRMAR); cl.note = 'Débito sin clasificar';
      addException({ key: `debito:${l.id}`, kind: 'DEBITO_SIN_CLASIFICAR', title: 'Salida del BNC sin clasificar', detail: `${l.line_date} · ${l.op_type} · ${l.description}`, amount_ves: l.debit, bank_line_id: l.id });
    } else if (kind === 'LIQUIDACION_CASHEA') {
      cl.origin = 'CASHEA_SETTLEMENT'; cl.allocations = single(BRANCHES.POR_CONFIRMAR); cl.note = 'Liquidación de Grupo Cashea sin desglose';
    } else {
      const ref = normalizeRef(l.reference);
      const cashea = (casheaByRef.get(ref) ?? []).filter(p => Math.abs(dayDiff(caracasDate(p.occurred_at), l.line_date)) <= 5);
      if (ref && cashea.length) {
        const weights = cashea.map(p => (p.currency === 'VES' ? new D(p.amount) : new D(p.amount_ref).mul(p.rate ?? 0)));
        const parts = splitAmount(l.credit, weights);
        cl.origin = 'CASHEA_REF';
        cl.allocations = cashea.map((p, i) => { const own = ownerOf(p.external_order); return { branch: own.branch, amount: parts[i], external_order: p.external_order, os_order_number: own.os_order_number, installments: p.installments }; });
        cl.note = cashea.map(p => `Orden ${p.external_order} · cuota ${p.installments.join(',')}`).join(' · ');
      } else {
        // OS payment registered with the last 4 digits of the bank reference (initials paid to BNC).
        const last4 = l.reference.replace(/\D/g, '').slice(-4);
        const near = input.osPayments.filter(p => !usedOsPayments.has(p.payment_id) && p.currency === 'VES' && /^(TRANSFER_|MOBILE_PAYMENT)/.test(p.method)
          && Math.abs(dayDiff(caracasDate(p.paid_at), l.line_date)) <= 1);
        const candidates = near.filter(p => (p.reference ?? '').replace(/\D/g, '').slice(-4) === last4 && last4.length === 4)
          .map(p => ({ p, diff: new D(p.amount).sub(l.credit).abs() }))
          .filter(x => x.p.cashea_order || x.diff.lte(D.max(1, new D(l.credit).mul('0.02'))))
          .sort((a, b) => a.diff.cmp(b.diff));
        // Same Cashea initial typed with another reference: exact amount to the cent, unique, same day ±1.
        const exact = candidates.length ? [] : near.filter(p => p.cashea_order && new D(p.amount).sub(l.credit).abs().lte('0.01'));
        const os = candidates[0]?.p ?? (exact.length === 1 ? exact[0] : undefined);
        if (os) {
          usedOsPayments.add(os.payment_id);
          const sale = input.osSales.find(s => s.order_id === os.order_id);
          if (sale?.cashea_reference) initialMatched.add(sale.cashea_reference);
          const refMatches = candidates.length > 0;
          cl.origin = 'OS_PAYMENT';
          cl.allocations = single(BRANCHES.CABUDARE, { os_order_number: os.order_number, external_order: sale?.cashea_reference ?? null, installments: [0] });
          cl.note = `${os.order_number} · pago ${os.method} ref ${os.reference}${refMatches ? '' : ' (monto exacto, referencia distinta)'}`;
          const move = { action: 'MOVE_TO_BNC' as const, payment_id: os.payment_id, bank_line_id: l.id, order_id: os.order_id, order_number: os.order_number, from_method: os.method, from_reference: os.reference ?? '', to_reference: l.reference.replace(/\D/g, ''), amount_ves: fixed(new D(os.amount)), bank_amount_ves: fixed(new D(l.credit)), bank_date: l.line_date };
          if (os.method !== 'TRANSFER_BNC') addException({ key: `bdv-en-bnc:${os.payment_id}`, kind: 'OS_BDV_EN_BNC', title: `${os.order_number}: el OS registró ${os.method} pero el dinero cayó en el BNC`, detail: `${l.line_date} · ref ${l.reference} · ${fixed(new D(l.credit))} Bs${refMatches ? '' : ` · el OS tiene la referencia ${os.reference}`}`, amount_ves: l.credit, bank_line_id: l.id, order_id: os.order_id, order_number: os.order_number, fix: move });
          else if (!refMatches) addException({ key: `ref-pago:${os.payment_id}`, kind: 'REFERENCIA_PAGO_DISTINTA', title: `${os.order_number}: el pago BNC del OS tiene otra referencia`, detail: `OS ref ${os.reference} · banco ${l.reference} · ${fixed(new D(l.credit))} Bs el ${l.line_date}`, amount_ves: l.credit, bank_line_id: l.id, order_id: os.order_id, order_number: os.order_number, fix: move });
          if (new D(os.amount).sub(l.credit).abs().gt(1)) {
            const snap = sale?.cashea_reference ? orderByNumber.get(sale.cashea_reference) : undefined;
            const rate = rateFor(l.line_date);
            const cashea = snap && rate ? ` · Cashea: inicial ${new D(snap.initial_ref).toFixed(2)} USD ≈ ${fixed(new D(snap.initial_ref).mul(rate))} Bs` : '';
            addException({ key: `monto:${os.payment_id}`, kind: 'MONTO_DIFERENTE', title: `${os.order_number}: monto del OS distinto al del banco`, detail: `OS ${fixed(new D(os.amount))} Bs · banco ${fixed(new D(l.credit))} Bs${cashea}. Requiere decidir si es sobrepago, vuelto o error del total.`, amount_ves: fixed(new D(l.credit).sub(os.amount)), bank_line_id: l.id, order_id: os.order_id, order_number: os.order_number, fix: { action: 'CORRECT_PAYMENT', order_id: os.order_id } });
          }
        } else deferred.push(cl);
      }
    }
    lines.push(cl);
  }
  // Second pass, once every OS payment is taken: Cashea "Pago en caja" (USD) × Cashea rate of the day ≈ amount received.
  for (const cl of deferred) {
    const l = cl;
    const single = (branch: BranchCode, extra: Partial<Allocation> = {}) => [{ branch, amount: fixed(new D(l.credit)), external_order: null, os_order_number: null, installments: [], ...extra }];
    const rate = rateFor(l.line_date);
    const usd = rate ? new D(l.credit).div(rate) : null;
    const caja = usd ? input.casheaOrders.filter(o => !initialMatched.has(o.external_order) && new D(o.initial_ref).gt(0)
      && Math.abs(dayDiff(o.purchased_on, l.line_date)) <= 1 && new D(o.initial_ref).sub(usd).abs().lte('0.5')) : [];
    if (caja.length === 1) {
      const o = caja[0], own = ownerOf(o.external_order);
      initialMatched.add(o.external_order);
      cl.origin = 'CAJA_RATE';
      cl.allocations = single(own.branch, { external_order: o.external_order, os_order_number: own.os_order_number, installments: [0] });
      cl.note = `Inicial de la orden ${o.external_order} (${o.initial_ref} USD × ${rate!.toFixed(2)})`;
      if (own.branch === BRANCHES.CABUDARE) addException({ key: `inicial:${o.external_order}`, kind: 'INICIAL_NO_REGISTRADO', title: `Inicial de Cabudare sin pago en el OS (${own.invoice ?? o.external_order})`, detail: `${l.line_date} · ${fixed(new D(l.credit))} Bs = ${new D(o.initial_ref).toFixed(2)} USD · orden Cashea ${o.external_order}`, amount_ves: l.credit, bank_line_id: l.id, external_order: o.external_order });
    } else {
      cl.allocations = single(BRANCHES.POR_CONFIRMAR);
      cl.note = caja.length > 1 ? `Coincide con ${caja.length} iniciales: ${caja.map(o => o.external_order).join(', ')}` : 'Sin identificar';
      addException({ key: `sin-id:${l.id}`, kind: 'SIN_IDENTIFICAR', title: 'Abono al BNC sin identificar', detail: `${l.line_date} · ref ${l.reference} · ${l.description}${caja.length > 1 ? ' · ' + cl.note : ''}`, amount_ves: l.credit, bank_line_id: l.id });
    }
  }
  // Commissions follow the withdrawal with the same reference.
  for (const c of pendingCommissions) {
    const ref = normalizeRef(c.reference);
    const w = lines.find(x => x.kind === 'RETIRO' && normalizeRef(x.reference) === ref && Math.abs(dayDiff(x.line_date, c.line_date)) <= 1);
    c.allocations = [{ branch: w?.allocations[0]?.branch ?? BRANCHES.POR_CONFIRMAR, amount: fixed(new D(c.debit)), external_order: null, os_order_number: null, installments: [] }];
    c.note = w ? `Comisión del retiro ref ${w.reference}` : 'Comisión sin retiro asociado';
    if (!w) addException({ key: `comision:${c.id}`, kind: 'DEBITO_SIN_CLASIFICAR', title: 'Comisión del BNC sin retiro asociado', detail: `${c.line_date} · ref ${c.reference}`, amount_ves: c.debit, bank_line_id: c.id });
  }

  // --- Balance chain.
  const chainBreaks: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const expected = new D(lines[i - 1].balance).add(lines[i].credit).sub(lines[i].debit);
    if (expected.sub(lines[i].balance).abs().gt('0.005')) {
      chainBreaks.push(lines[i].id);
      addException({ key: `salto:${lines[i].id}`, kind: 'SALTO_DE_SALDO', title: 'El saldo del BNC no encadena', detail: `Antes de ${lines[i].line_date} ref ${lines[i].reference}: esperado ${fixed(expected)}, banco ${fixed(new D(lines[i].balance))}. Falta un reporte.`, bank_line_id: lines[i].id });
    }
  }

  // --- Current period: from the last saved zero to the last bank line.
  const cutoffs = [...input.cutoffs].sort((a, b) => a.cut_date.localeCompare(b.cut_date) || a.created_at.localeCompare(b.created_at));
  const active = cutoffs.at(-1) ?? null;
  const anchorIndex = (c: Cutoff | null) => {
    if (!c) return -1;
    if (c.bank_line_id) { const i = lines.findIndex(l => l.id === c.bank_line_id); if (i >= 0) return i; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.line_date === c.cut_date && normalizeRef(l.reference) === normalizeRef(c.reference) && new D(l.balance).sub(c.balance_ves).abs().lte('0.005')) return i;
    }
    return null;
  };
  const current = summarizePeriod(input, lines, active, anchorIndex(active), lines.length - 1, branchName);
  if (active && !current.anchor_found) addException({ key: `corte:${active.id}`, kind: 'CORTE_NO_ENCONTRADO', title: 'No se encontró la línea del último cero en el BNC cargado', detail: `${active.cut_date} · ref ${active.reference} · saldo ${active.balance_ves}. Se usan los movimientos posteriores a esa fecha.` });

  // --- Suggested new zero: first withdrawal after the active zero that leaves the balance under the threshold.
  let zeroSuggestion: ZeroSuggestion | null = null;
  const activeAnchor = anchorIndex(active);
  const startIdx = activeAnchor === null ? lines.findIndex(l => l.line_date > active!.cut_date) : activeAnchor + 1;
  for (let i = startIdx < 0 ? lines.length : startIdx; i < lines.length; i++) {
    const l = lines[i];
    if ((l.kind === 'RETIRO' || l.kind === 'COMISION') && new D(l.balance).lt(threshold)) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].kind === 'COMISION' && normalizeRef(lines[j + 1].reference) === normalizeRef(l.reference)) j++;
      zeroSuggestion = { line: lines[j], balance: lines[j].balance };
      break;
    }
  }

  // --- Receivables (latest Cashea order export), money received per order.
  const receivedByOrder = new Map<string, InstanceType<typeof D>>();
  for (const l of lines) for (const a of l.allocations) if (a.external_order && (l.kind === 'ABONO')) receivedByOrder.set(a.external_order, (receivedByOrder.get(a.external_order) ?? ZERO).add(a.amount));
  const recv = new Map<BranchCode, { overdue: InstanceType<typeof D>; upcoming: InstanceType<typeof D> }>();
  const orders: OrderRow[] = [];
  for (const o of input.casheaOrders) {
    const own = ownerOf(o.external_order);
    let overdue = ZERO, upcoming = ZERO;
    if (o.status !== 'CANCELLED') for (const q of o.installments) {
      if (q.status === 'DONE' || q.status === 'CANCELLED') continue;
      const pending = new D(q.amount_ref).sub(q.paid_ref);
      if (pending.lte('0.005')) continue;
      if (q.status === 'DELAYED' || q.due_date < input.today) overdue = overdue.add(pending); else upcoming = upcoming.add(pending);
    }
    const r = recv.get(own.branch) ?? { overdue: ZERO, upcoming: ZERO };
    recv.set(own.branch, { overdue: r.overdue.add(overdue), upcoming: r.upcoming.add(upcoming) });
    orders.push({ external_order: o.external_order, invoice: o.invoice, buyer: o.buyer, purchased_on: o.purchased_on, status: o.status, total_ref: o.total_ref, ownership: own, overdue_ref: fixed(overdue), upcoming_ref: fixed(upcoming), received_ves: fixed(receivedByOrder.get(o.external_order) ?? ZERO) });

    // Cancelled order whose initial already reached the bank.
    if (o.status === 'CANCELLED') {
      const initialLines = lines.filter(l => l.allocations.some(a => a.external_order === o.external_order && a.installments.includes(0)));
      if (initialLines.length) addException({ key: `cancelada:${o.external_order}`, kind: 'CANCELADA_CON_INICIAL', title: `Orden ${o.external_order} cancelada en Cashea con inicial cobrado`, detail: `${new D(o.total_ref).toFixed(2)} USD · inicial ${fixed(sum(initialLines.map(l => l.credit)))} Bs recibido el ${initialLines[0].line_date} · ${branchName.get(own.branch) ?? own.branch}`, amount_ves: fixed(sum(initialLines.map(l => l.credit))), external_order: o.external_order });
    }
    // Cabudare invoice typed differently from the OS order number.
    if (own.rule === 'OS_LINK' && own.os_order_number && cleanInvoice(o.invoice) !== cleanInvoice(own.os_order_number))
      addException({ key: `factura:${o.external_order}`, kind: 'FACTURA_MAL_ESCRITA', title: `Factura de Cabudare mal escrita en Cashea: "${o.invoice ?? 'vacía'}" = ${own.os_order_number}`, detail: `Orden Cashea ${o.external_order}. Pide escribir la factura exactamente como ${own.os_order_number}.`, external_order: o.external_order, order_number: own.os_order_number });
  }
  const receivables: ReceivableRow[] = input.branches.filter(b => recv.has(b.code)).map(b => {
    const r = recv.get(b.code)!;
    return { branch: b.code, name: b.name, overdue_ref: fixed(r.overdue), upcoming_ref: fixed(r.upcoming), total_ref: fixed(r.overdue.add(r.upcoming)) };
  });

  // --- Linking suggestions between Cashea orders and OS sales.
  const linkedOrders = new Set(input.osSales.filter(s => s.cashea_reference).map(s => normalizeRef(s.cashea_reference)));
  // Cashea orders seen in either export; an order outside the orders window still appears in payments.
  const knownOrders = new Map<string, { invoice: string | null; detail: string }>();
  for (const [n, pays] of paymentsByOrder) knownOrders.set(n, { invoice: pays.find(p => p.invoice)?.invoice ?? null, detail: `${pays.length} pago(s) en el export de pagos` });
  for (const o of input.casheaOrders) knownOrders.set(o.external_order, { invoice: o.invoice, detail: `${o.purchased_on} · ${o.total_ref} USD` });
  for (const s of input.osSales) {
    if (!s.cashea_reference || s.status === 'CANCELLED' || knownOrders.has(s.cashea_reference.trim())) continue;
    const ref = normalizeRef(s.cashea_reference);
    const near = [...knownOrders.entries()].filter(([n]) => !linkedOrders.has(n) && ownerOf(n).rule !== 'MANUAL'
      && (n.includes(ref) || ref.includes(n) || levenshteinAtMostOne(n, ref)));
    if (near.length === 1) { const [n, k] = near[0]; addException({ key: `ref:${s.sale_id}`, kind: 'REFERENCIA_MAL_CARGADA', title: `${s.order_number}: la referencia Cashea del OS (${s.cashea_reference}) parece ser ${n}`, detail: `Factura en Cashea "${k.invoice ?? 'vacía'}" · ${k.detail}`, sale_id: s.sale_id, order_id: s.order_id, order_number: s.order_number, external_order: n, fix: { action: 'SET_REFERENCE', sale_id: s.sale_id, reference: n } }); }
  }
  const salesWithoutRef = input.osSales.filter(s => !s.cashea_reference && s.status !== 'CANCELLED');
  for (const o of input.casheaOrders) {
    const own = ownerOf(o.external_order);
    if (own.rule === 'INVOICE_OS') {
      const target = salesWithoutRef.find(s => cleanInvoice(s.order_number) === own.invoice);
      addException({ key: `sin-enlace:${o.external_order}`, kind: 'CABUDARE_SIN_ENLACE', title: `Orden Cashea ${o.external_order} con factura ${own.invoice} sin enlace en el OS`, detail: target ? `${target.order_number} tiene venta Cashea sin referencia: vincúlala.` : 'La venta Cashea no está registrada en el OS con esta referencia.', external_order: o.external_order, ...(target ? { sale_id: target.sale_id, order_number: target.order_number, fix: { action: 'SET_REFERENCE' as const, sale_id: target.sale_id, reference: o.external_order } } : {}) });
      continue;
    }
    if (own.branch !== BRANCHES.AFUERA && own.branch !== BRANCHES.POR_CONFIRMAR) continue;
    const sameDay = (date: string, total: string) => date === o.purchased_on && new D(total).sub(o.total_ref).abs().lte('0.01');
    const sale = salesWithoutRef.find(s => sameDay(s.order_date, s.gross_ref));
    if (sale) { addException({ key: `posible:${o.external_order}`, kind: 'POSIBLE_CABUDARE', title: `Orden Cashea ${o.external_order} (factura "${o.invoice ?? 'vacía'}") podría ser ${sale.order_number}`, detail: `Mismo día y mismo total (${o.total_ref} USD). ${sale.order_number} tiene venta Cashea sin referencia.`, external_order: o.external_order, sale_id: sale.sale_id, order_number: sale.order_number, fix: { action: 'SET_REFERENCE', sale_id: sale.sale_id, reference: o.external_order } }); continue; }
    const os = input.osOrders.find(x => !x.has_cashea && x.status === 'CLOSED' && sameDay(x.order_date, x.total_ref));
    if (os) addException({ key: `posible:${o.external_order}`, kind: 'POSIBLE_CABUDARE', title: `Orden Cashea ${o.external_order} (factura "${o.invoice ?? 'vacía'}") podría ser ${os.order_number}`, detail: `Mismo día y mismo total (${o.total_ref} USD), pero ${os.order_number} no tiene venta Cashea en el OS: puede ser coincidencia.`, external_order: o.external_order, order_id: os.order_id, order_number: os.order_number, fix: { action: 'ASSIGN_ORDER', external_order: o.external_order, branch: BRANCHES.CABUDARE } });
  }

  // Bank-only exceptions before the active zero belong to a closed period: not actionable any more.
  const closedLines = new Set(activeAnchor !== null && activeAnchor >= 0 ? lines.slice(0, activeAnchor + 1).map(l => l.id) : []);
  const bankOnly: ExceptionKind[] = ['SIN_IDENTIFICAR', 'DEBITO_SIN_CLASIFICAR', 'RETIRO_CEDULA_DESCONOCIDA', 'SALTO_DE_SALDO'];
  const open = exceptions.filter(e => !(e.bank_line_id && closedLines.has(e.bank_line_id) && bankOnly.includes(e.kind)));

  return { ownership, lines, current, receivables, orders, exceptions: open, chainBreaks, zeroSuggestion, rateByDate };
}

/** Totals by branch for the lines after `anchor` up to `endIdx` (inclusive). */
export function summarizePeriod(input: Pick<EngineInput, 'branches' | 'adjustments'>, lines: ClassifiedLine[], cutoff: Cutoff | null, anchor: number | null, endIdx: number, branchName = new Map(input.branches.map(b => [b.code, b.name]))): PeriodSummary {
  const anchorFound = anchor !== null;
  const startIdx = anchor === null ? lines.findIndex(l => cutoff !== null && l.line_date > cutoff.cut_date) : anchor + 1;
  const period = startIdx < 0 ? [] : lines.slice(startIdx, endIdx + 1);
  const totals = new Map<BranchCode, { in: InstanceType<typeof D>; out: InstanceType<typeof D>; adj: InstanceType<typeof D> }>();
  const get = (b: BranchCode) => totals.get(b) ?? totals.set(b, { in: ZERO, out: ZERO, adj: ZERO }).get(b)!;
  for (const b of input.branches) get(b.code);
  for (const l of period) for (const a of l.allocations) {
    const t = get(a.branch);
    if (new D(l.credit).gt(0)) t.in = t.in.add(a.amount); else t.out = t.out.add(a.amount);
  }
  const fromDate = cutoff?.cut_date ?? period[0]?.line_date ?? null, toDate = period.at(-1)?.line_date ?? null;
  for (const a of input.adjustments) {
    if (fromDate && a.occurred_on < fromDate) continue;
    if (toDate && a.occurred_on > toDate && endIdx < lines.length - 1) continue;
    get(a.credit_branch).adj = get(a.credit_branch).adj.add(a.amount_ves);
    get(a.debit_branch).adj = get(a.debit_branch).adj.sub(a.amount_ves);
  }
  const order = new Map(input.branches.map(b => [b.code, b.sort]));
  const rows: BranchRow[] = [...totals.entries()].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99)).map(([branch, t]) => ({
    branch, name: branchName.get(branch) ?? branch, entered: fixed(t.in), withdrawn: fixed(t.out), adjustments: fixed(t.adj), due: fixed(t.in.sub(t.out).add(t.adj)),
  }));
  const residual = new D(cutoff?.balance_ves ?? (period.length ? new D(period[0].balance).sub(period[0].credit).add(period[0].debit) : 0));
  const total = residual.add(sum(rows.map(r => r.due)));
  const bank = period.at(-1)?.balance ?? (anchor !== null && anchor >= 0 ? lines[anchor].balance : null);
  return {
    cutoff, from_line_id: period[0]?.id ?? null, to_line_id: period.at(-1)?.id ?? null, from_date: fromDate, to_date: toDate,
    rows, residual: fixed(residual), total: fixed(total), bank_balance: bank === null ? null : fixed(new D(bank)),
    difference: bank === null ? '0.00' : fixed(new D(bank).sub(total)), entered: fixed(sum(rows.map(r => r.entered))), withdrawn: fixed(sum(rows.map(r => r.withdrawn))),
    credits: period.filter(l => new D(l.credit).gt(0)).length, anchor_found: anchorFound,
  };
}

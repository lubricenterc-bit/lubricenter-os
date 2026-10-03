import { D } from './money';

export type Currency = 'USD' | 'VES';
export type PriceBasis = 'USD_FIXED' | 'USD_REF_BCV' | 'VES_FIXED';
export type Ownership = 'SELF' | 'THIRD_PARTY' | 'UNRESOLVED';
export type Commission = { worker: string; mode: 'CHEO_COLLECTION'; percent: '40' };
export type Component = {
  id: string; basis: PriceBasis; principal: string; covered: string; financed: string;
  ownership: Ownership; commission?: Commission;
  commissionBase?: Partial<Record<Currency, string>>;
  commissionAccrued?: Partial<Record<Currency, string>>;
  conversionTotals?: Record<string, { native: string; covered: string }>;
};
export type Exchange =
  | { mode: 'PAR' }
  | { mode: 'RATE'; bcv: string; acceptance: string }
  | { mode: 'EXACT'; id: string; native: string; covered: string; usedNative?: string };
export type Target = { component: string; amount: string | 'EXACT_DUE'; exchange?: Exchange };
export type Tender = {
  id: string; currency: Currency; received: string; cash: boolean;
  targets: Target[]; bcv?: string;
};
export type Application = {
  tender: string; component: string; currency: Currency; native: string;
  covered: string; baseline: string; benefit: string; roundingNative: string;
  exchange: Exchange; bcv: string | null;
  commission: { worker: string; amount: string; currency: Currency } | null;
};
export type Collection = {
  applications: Application[];
  tenders: { id: string; currency: Currency; received: string; applied: string; change: string }[];
  components: Component[];
  exactAgreements: Record<string, string>;
};

const ZERO = new D(0);
const HALF_CENT = new D('0.005');
function decimal(value: string, label: string, positive = false, places = 8) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${label}: decimal inválido`);
  const n = new D(value);
  if (!n.isFinite() || n.gte('1000000000000') || n.lt(0) || (positive && n.eq(0)) || n.decimalPlaces() > places) {
    throw new Error(`${label}: monto fuera de rango o precisión inválida`);
  }
  return n;
}
function currency(value: string): asserts value is Currency {
  if (value !== 'USD' && value !== 'VES') throw new Error('Moneda inválida');
}
function unit(basis: PriceBasis) { return basis === 'VES_FIXED' ? 'VES' : 'USD'; }
/** Stable identity excludes changing consumed capacity and normalizes decimal spellings. */
export function conversionGroupKey(basis: PriceBasis, coin: Currency, exchange: Exchange, bcv?: string) {
  const normalize = (n?: string) => n === undefined ? null : new D(n).toString();
  return JSON.stringify([basis, coin, exchange.mode, normalize(bcv),
    exchange.mode === 'RATE' ? normalize(exchange.acceptance) : null,
    exchange.mode === 'EXACT' ? exchange.id : null,
    exchange.mode === 'EXACT' ? normalize(exchange.native) : null,
    exchange.mode === 'EXACT' ? normalize(exchange.covered) : null]);
}
function validateComponent(c: Component) {
  if (!c.id || !['USD_FIXED', 'USD_REF_BCV', 'VES_FIXED'].includes(c.basis)) throw new Error('Concepto o base inválida');
  if (!['SELF', 'THIRD_PARTY', 'UNRESOLVED'].includes(c.ownership)) throw new Error('Propiedad inválida');
  const principal = decimal(c.principal, 'Principal');
  const covered = decimal(c.covered, 'Cobertura');
  const financed = decimal(c.financed, 'Financiación');
  if (covered.add(financed).gt(principal)) throw new Error(`${c.id}: cobertura y financiación superan el principal`);
  if (c.commission) {
    if (c.ownership !== 'SELF' || !c.commission.worker || c.commission.mode !== 'CHEO_COLLECTION' || c.commission.percent !== '40') {
      throw new Error('La comisión de Cheo exige mano de obra propia y 40 %');
    }
    for (const coin of ['USD', 'VES'] as const) {
      const base = decimal(c.commissionBase?.[coin] ?? '0', 'Base acumulada');
      const paid = decimal(c.commissionAccrued?.[coin] ?? '0', 'Comisión acumulada', false, 2);
      if (!paid.eq(base.mul('0.4').toDecimalPlaces(2))) throw new Error('Comisión acumulada inconsistente');
    }
  }
}
export function outstanding(c: Component): string {
  validateComponent(c);
  return new D(c.principal).sub(c.covered).sub(c.financed).toFixed(8);
}

/** Commercial coverage per unit of real money. Never uses the operative rate. */
function conversion(c: Component, t: Tender, exchange: Exchange) {
  if (exchange.mode === 'EXACT') {
    if (c.basis !== 'USD_REF_BCV' || t.currency !== 'USD') throw new Error('El acuerdo exacto aplica solo a USD sobre referencia BCV');
    return decimal(exchange.covered, 'Cobertura acordada', true).div(decimal(exchange.native, 'USD acordados', true, 2));
  }
  if (exchange.mode === 'RATE') {
    if (t.currency !== 'USD' || c.basis === 'USD_FIXED') throw new Error('Una tasa preferencial no cambia un precio USD pactado');
    const acceptance = decimal(exchange.acceptance, 'Tasa de aceptación', true);
    const bcv = decimal(exchange.bcv, 'BCV del acuerdo', true);
    if (!t.bcv || !bcv.eq(decimal(t.bcv, 'BCV del cobro', true))) throw new Error('El acuerdo y el cobro deben conservar el mismo BCV');
    return c.basis === 'VES_FIXED' ? acceptance : acceptance.div(bcv);
  }
  if (exchange.mode !== 'PAR') throw new Error('Acuerdo de conversión inválido');
  if (unit(c.basis) === t.currency) return new D(1);
  const bcv = decimal(t.bcv ?? '', 'Falta BCV para convertir', true);
  return t.currency === 'VES' ? new D(1).div(bcv) : bcv;
}

/** Pure preview. Database authorization, ownership of service and locks remain mandatory at commit. */
export function quoteCollection(input: readonly Component[], tenders: readonly Tender[]): Collection {
  const components = input.map(c => ({ ...c, commissionBase: { ...c.commissionBase }, commissionAccrued: { ...c.commissionAccrued }, conversionTotals: { ...c.conversionTotals } }));
  const index = new Map<string, Component>();
  for (const c of components) {
    validateComponent(c);
    if (index.has(c.id)) throw new Error('Concepto duplicado');
    index.set(c.id, c);
  }
  const seen = new Set<string>();
  const agreements = new Map<string, { signature: string; consumed: InstanceType<typeof D> }>();
  const applications: Application[] = [];
  const receipts: Collection['tenders'] = [];
  for (const t of tenders) {
    currency(t.currency);
    if (!t.id || seen.has(t.id)) throw new Error('Recepción duplicada o sin ID');
    if (typeof t.cash !== 'boolean') throw new Error('Indica si el medio es efectivo');
    seen.add(t.id);
    const received = decimal(t.received, 'Recibido', true, 2);
    if (!t.targets.length) throw new Error('Selecciona a qué conceptos aplicas el pago');
    let applied = ZERO;
    for (const target of t.targets) {
      const c = index.get(target.component);
      if (!c) throw new Error('Concepto ajeno a la orden');
      const remaining = new D(outstanding(c));
      if (remaining.eq(0)) throw new Error(`${c.id}: el concepto ya está cubierto o financiado`);
      const exchange = target.exchange ?? { mode: 'PAR' as const };
      const factor = conversion(c, t, exchange);
      const exactDue = remaining.div(factor);
      const exact = target.amount === 'EXACT_DUE';
      const amount = exact ? exactDue.toDecimalPlaces(2) : decimal(target.amount, 'Aplicado', true, 2);
      if (amount.lte(0)) throw new Error('El pendiente no admite un cobro positivo a centavos');
      if (exchange.mode === 'EXACT') {
        if (!exchange.id) throw new Error('El acuerdo exacto necesita ID estable');
        const signature = JSON.stringify([c.id, exchange.native, exchange.covered, exchange.usedNative ?? '0']);
        const agreement = agreements.get(exchange.id) ?? { signature, consumed: decimal(exchange.usedNative ?? '0', 'Acuerdo ya usado', false, 2) };
        if (agreement.signature !== signature) throw new Error('Acuerdo reutilizado con condiciones diferentes');
        if (agreement.consumed.add(amount).gt(new D(exchange.native))) throw new Error('El pago supera el tramo de acuerdo exacto');
        agreement.consumed = agreement.consumed.add(amount);
        agreements.set(exchange.id, agreement);
      }
      if (applied.add(amount).gt(received)) throw new Error('Las aplicaciones superan el dinero recibido');
      const computed = amount.mul(factor);
      const groupKey = conversionGroupKey(c.basis, t.currency, exchange, t.bcv);
      const group = c.conversionTotals![groupKey] ?? { native: '0', covered: '0' };
      const priorGroupNative = decimal(group.native, 'Conversión acumulada');
      const priorGroupCovered = decimal(group.covered, 'Cobertura acumulada');
      if (priorGroupCovered.gt(c.covered)) throw new Error('Cobertura acumulada inconsistente');
      const nextGroupNative = priorGroupNative.add(amount);
      let covered = nextGroupNative.mul(factor).toDecimalPlaces(8).sub(priorGroupCovered);
      if (covered.lte(0)) throw new Error('Cobertura de conversión inconsistente o inferior a la precisión admitida');
      let rounding = ZERO;
      if (exact) {
        rounding = amount.sub(exactDue);
        if (rounding.abs().gt(HALF_CENT)) throw new Error('Residual superior a medio centavo nativo');
        covered = remaining;
      } else if (covered.gt(remaining)) {
        throw new Error(`${c.id}: el pago supera el saldo; usa el importe exacto o registra el sobrante`);
      }
      // REF and native USD have an explicitly comparable baseline; Bs are converted by B.
      const baseline = c.basis === 'VES_FIXED'
        ? (t.currency === 'VES' ? amount : amount.mul(decimal(t.bcv ?? '', 'BCV de valoración', true)))
        : (t.currency === 'USD' ? amount : amount.div(decimal(t.bcv ?? '', 'BCV de valoración', true)));
      let commission: Application['commission'] = null;
      if (c.commission) {
        const prior = new D(c.commissionBase?.[t.currency] ?? '0');
        const priorCommission = new D(c.commissionAccrued?.[t.currency] ?? '0');
        const accumulated = prior.add(amount);
        const nextCommission = accumulated.mul('0.4').toDecimalPlaces(2);
        commission = { worker: c.commission.worker, currency: t.currency, amount: nextCommission.sub(priorCommission).toFixed(2) };
        c.commissionBase![t.currency] = accumulated.toFixed(2);
        c.commissionAccrued![t.currency] = nextCommission.toFixed(2);
      }
      c.covered = new D(c.covered).add(covered).toFixed(8);
      c.conversionTotals![groupKey] = { native: nextGroupNative.sub(rounding).toFixed(8), covered: priorGroupCovered.add(covered).toFixed(8) };
      applications.push({ tender: t.id, component: c.id, currency: t.currency, native: amount.toFixed(2),
        covered: covered.toFixed(8), baseline: baseline.toFixed(8), benefit: exchange.mode === 'PAR' ? '0.00000000' : computed.sub(baseline).toDecimalPlaces(8).abs().eq(0) ? '0.00000000' : computed.sub(baseline).toFixed(8),
        roundingNative: rounding.toFixed(8), exchange, bcv: t.bcv ?? null, commission });
      applied = applied.add(amount);
    }
    const change = received.sub(applied);
    if (!t.cash && change.gt(0)) throw new Error('Exceso digital: registra un anticipo explícito o corrige el monto');
    receipts.push({ id: t.id, currency: t.currency, received: received.toFixed(2), applied: applied.toFixed(2), change: change.toFixed(2) });
  }
  return { applications, tenders: receipts, components, exactAgreements: Object.fromEntries([...agreements].map(([id, a]) => [id, a.consumed.toFixed(2)])) };
}

export function financingQuote(principal: string, percent: string) {
  const total = decimal(principal, 'Principal Cashea', true, 2);
  const p = decimal(percent, 'Inicial', true);
  if (p.gt(100)) throw new Error('Inicial superior al 100 %');
  const initial = total.mul(p).div(100).toDecimalPlaces(2);
  const financed = total.sub(initial);
  const regular = financed.div(3).toDecimalPlaces(2);
  return { initial: initial.toFixed(2), financed: financed.toFixed(2),
    installments: [regular.toFixed(2), regular.toFixed(2), financed.sub(regular.mul(2)).toFixed(2)] };
}

export function reserveFinancing(component: Component, amount: string): Component {
  const reserved = decimal(amount, 'Financiación', true);
  if (reserved.gt(outstanding(component))) throw new Error('Financiación superior al saldo disponible');
  return { ...component, financed: new D(component.financed).add(reserved).toFixed(8) };
}

/** Native totals remain separate; principal totals are grouped by contractual basis. */
export function collectionSummary(q: Collection) {
  const native = { USD: ZERO, VES: ZERO };
  const pending = { USD_FIXED: ZERO, USD_REF_BCV: ZERO, VES_FIXED: ZERO };
  const financed = { USD_FIXED: ZERO, USD_REF_BCV: ZERO, VES_FIXED: ZERO };
  const own = { USD: ZERO, VES: ZERO }, third = { USD: ZERO, VES: ZERO }, unresolved = { USD: ZERO, VES: ZERO };
  const commissions = new Map<string, { USD: InstanceType<typeof D>; VES: InstanceType<typeof D> }>();
  const index = new Map(q.components.map(c => [c.id, c]));
  for (const t of q.tenders) native[t.currency] = native[t.currency].add(t.received);
  for (const c of q.components) {
    pending[c.basis] = pending[c.basis].add(outstanding(c));
    financed[c.basis] = financed[c.basis].add(c.financed);
  }
  for (const a of q.applications) {
    const c = index.get(a.component)!;
    const bucket = c.ownership === 'SELF' ? own : c.ownership === 'THIRD_PARTY' ? third : unresolved;
    bucket[a.currency] = bucket[a.currency].add(a.native);
    if (a.commission) {
      const n = commissions.get(a.commission.worker) ?? { USD: ZERO, VES: ZERO };
      n[a.currency] = n[a.currency].add(a.commission.amount);
      commissions.set(a.commission.worker, n);
    }
  }
  const coins = (v: typeof native) => ({ USD: v.USD.toFixed(2), VES: v.VES.toFixed(2) });
  const bases = (v: typeof pending) => ({ USD_FIXED: v.USD_FIXED.toFixed(8), USD_REF_BCV: v.USD_REF_BCV.toFixed(8), VES_FIXED: v.VES_FIXED.toFixed(8) });
  return { received: coins(native), ownApplied: coins(own), thirdPartyApplied: coins(third), unresolvedApplied: coins(unresolved),
    pending: bases(pending), financed: bases(financed), commissions: Object.fromEntries([...commissions].map(([id, v]) => [id, coins(v)])) };
}

import { describe, expect, it } from 'vitest';
import { collectionSummary, financingQuote, outstanding, quoteCollection, reserveFinancing, type Component, type Tender } from '../lib/finance/settlement';

const component = (id: string, principal: string, extra: Partial<Component> = {}): Component => ({
  id, basis: 'USD_FIXED', principal, covered: '0', financed: '0', ownership: 'SELF', ...extra,
});
const service = (amount = '300', extra: Partial<Component> = {}) => component('motor', amount, {
  commission: { worker: 'CHEO', mode: 'CHEO_COLLECTION', percent: '40' }, ...extra,
});
const tender = (id: string, received: string, target = 'motor', extra: Partial<Tender> = {}): Tender => ({
  id, received, currency: 'USD', cash: true, targets: [{ component: target, amount: received }], ...extra,
});

describe('Payments assigned to contractual components', () => {
  it('the owner confirmed the external oil is a resale: all 355 USD are own collections', () => {
    const c = [service(), component('oil', '45'), component('filter', '3'), component('resale', '7')];
    const q = quoteCollection(c, [tender('cash', '355', 'motor', { targets: c.map(x => ({ component: x.id, amount: 'EXACT_DUE' })) })]);
    expect(collectionSummary(q)).toMatchObject({ ownApplied: { USD: '355.00' }, thirdPartyApplied: { USD: '0.00' }, commissions: { CHEO: { USD: '120.00' } } });
  });
  it('A01/A03 preserves the 355 USD price and excludes store, third party and change from Cheo', () => {
    const c = [service(), component('oil', '45'), component('filter', '3'), component('external', '7', { ownership: 'THIRD_PARTY' })];
    const q = quoteCollection(c, [tender('cash', '400', 'motor', { targets: c.map(x => ({ component: x.id, amount: 'EXACT_DUE' })) })]);
    expect(q.tenders).toEqual([{ id: 'cash', currency: 'USD', received: '400.00', applied: '355.00', change: '45.00' }]);
    expect(collectionSummary(q)).toMatchObject({ ownApplied: { USD: '348.00' }, thirdPartyApplied: { USD: '7.00' }, pending: { USD_FIXED: '0.00000000' }, commissions: { CHEO: { USD: '120.00', VES: '0.00' } } });
    expect(c[0].covered).toBe('0'); // Pure preview does not mutate historical inputs.
  });
  it('A04 directs USD to workshop and Bs only to products', () => {
    const q = quoteCollection([service(), component('store', '55')], [tender('cash', '300'), tender('bank', '5500', 'store', { currency: 'VES', bcv: '100', cash: false })]);
    expect(collectionSummary(q)).toMatchObject({ received: { USD: '300.00', VES: '5500.00' }, commissions: { CHEO: { USD: '120.00', VES: '0.00' } }, pending: { USD_FIXED: '0.00000000' } });
  });
  it('A05/A06 splits commission by actual native money over different days', () => {
    const q1 = quoteCollection([service()], [tender('usd', '100'), tender('ves', '10000', 'motor', { currency: 'VES', bcv: '100' })]);
    expect(outstanding(q1.components[0])).toBe('100.00000000');
    const q2 = quoteCollection(q1.components, [tender('ves-next', '12000', 'motor', { currency: 'VES', bcv: '120' })]);
    expect(outstanding(q2.components[0])).toBe('0.00000000');
    expect(q2.applications[0].commission?.amount).toBe('4800.00');
    expect(q2.components[0].commissionPaid).toEqual({ USD: '40.00', VES: '8800.00' });
  });
  it('A07/A10 reduces REF with negotiated rate while commission uses only real money', () => {
    const q = quoteCollection([service('400', { basis: 'USD_REF_BCV' })], [tender('cash', '200', 'motor', { bcv: '100', targets: [{ component: 'motor', amount: '200', exchange: { mode: 'RATE', bcv: '100', acceptance: '120' } }] })]);
    expect(q.applications[0]).toMatchObject({ native: '200.00', covered: '240.00000000', benefit: '40.00000000', commission: { amount: '80.00' } });
    expect(outstanding(q.components[0])).toBe('160.00000000');
    const next = quoteCollection(q.components, [tender('bank', '20800', 'motor', { currency: 'VES', bcv: '130', cash: false })]);
    expect(outstanding(next.components[0])).toBe('0.00000000');
    expect(next.applications[0].commission?.amount).toBe('8320.00');
  });
  it('A08/A09 isolates Cashea initial and financing from motor payments', () => {
    const c = [service('400', { basis: 'USD_REF_BCV' }), component('oil', '65', { basis: 'USD_REF_BCV' })];
    const q = quoteCollection(c, [tender('cash', '200', 'motor', { bcv: '100', targets: [{ component: 'motor', amount: '200', exchange: { mode: 'RATE', bcv: '100', acceptance: '120' } }] }), tender('initial', '2600', 'oil', { currency: 'VES', bcv: '100', cash: false })]);
    expect(financingQuote('65', '40')).toEqual({ initial: '26.00', financed: '39.00', installments: ['13.00', '13.00', '13.00'] });
    q.components[1] = reserveFinancing(q.components[1], '39');
    expect(outstanding(q.components[1])).toBe('0.00000000');
    expect(outstanding(q.components[0])).toBe('160.00000000');
    expect(collectionSummary(q).commissions.CHEO).toEqual({ USD: '80.00', VES: '0.00' });
    expect(() => quoteCollection(q.components, [tender('duplicate', '39', 'oil')])).toThrow(/financiado/);
  });
  it('A11 keeps a fixed Bs debt fixed', () => {
    const c = component('bs', '16000', { basis: 'VES_FIXED' });
    const q = quoteCollection([c], [tender('bank', '16000', 'bs', { currency: 'VES', bcv: '130', cash: false })]);
    expect(outstanding(q.components[0])).toBe('0.00000000');
  });
  it('A12 rejects preferential acceptance on fixed USD', () => {
    expect(() => quoteCollection([service()], [tender('cash', '200', 'motor', { bcv: '100', targets: [{ component: 'motor', amount: '200', exchange: { mode: 'RATE', bcv: '100', acceptance: '120' } }] })])).toThrow(/USD pactado/);
  });
  it('A13 uses the exact debt agreement without truncating a derived exchange rate', () => {
    const q = quoteCollection([service('400', { basis: 'USD_REF_BCV' })], [tender('cash', '200', 'motor', { targets: [{ component: 'motor', amount: '200', exchange: { mode: 'EXACT', id: 'agreement', native: '200', covered: '237.17' } }] })]);
    expect(outstanding(q.components[0])).toBe('162.83000000');
    expect(q.applications[0].commission?.amount).toBe('80.00');
  });
  it('A14 gives two parts of the same payment different commercial rules', () => {
    const q = quoteCollection([service('400', { basis: 'USD_REF_BCV' }), component('store', '50')], [tender('cash', '250', 'motor', { bcv: '100', targets: [{ component: 'motor', amount: '200', exchange: { mode: 'RATE', bcv: '100', acceptance: '120' } }, { component: 'store', amount: '50' }] })]);
    expect(q.applications.map(a => a.covered)).toEqual(['240.00000000', '50.00000000']);
    expect(collectionSummary(q).commissions.CHEO.USD).toBe('80.00');
  });
  it('A16 closes exact cents with signed residual, not a discount', () => {
    const q = quoteCollection([service('40')], [tender('bank', '34407.01', 'motor', { currency: 'VES', bcv: '860.175300', cash: false, targets: [{ component: 'motor', amount: 'EXACT_DUE' }] })]);
    expect(outstanding(q.components[0])).toBe('0.00000000');
    expect(q.applications[0]).toMatchObject({ roundingNative: '-0.00200000', benefit: '0.00000000' });
  });
  it('A19 rejects a digital excess but retains cash excess outside commissions', () => {
    expect(() => quoteCollection([service('40')], [tender('bank', '50', 'motor', { cash: false, targets: [{ component: 'motor', amount: 'EXACT_DUE' }] })])).toThrow(/Exceso digital/);
  });
  it('A30 allows native USD with no invented rate; A31 requires BCV for conversion', () => {
    expect(quoteCollection([service()], [tender('cash', '300')]).applications[0].bcv).toBeNull();
    expect(() => quoteCollection([service()], [tender('cash-bs', '30000', 'motor', { currency: 'VES' })])).toThrow(/BCV/);
  });
  it('does not use an unrelated component as commission denominator', () => {
    const t = [tender('cash', '200')];
    const a = quoteCollection([service('400')], t);
    const b = quoteCollection([service('400'), component('unrelated', '900000')], t);
    expect(b.applications).toEqual(a.applications);
  });
  it('limits exact agreements over multiple receipts and previous usage', () => {
    const exchange = { mode: 'EXACT' as const, id: 'agreement', native: '200', covered: '240' };
    const pay = (id: string) => tender(id, '150', 'motor', { targets: [{ component: 'motor', amount: '150', exchange }] });
    expect(() => quoteCollection([service('1000', { basis: 'USD_REF_BCV' })], [pay('a'), pay('b')])).toThrow(/tramo/);
    expect(() => quoteCollection([service('1000', { basis: 'USD_REF_BCV' })], [tender('cash', '150', 'motor', { targets: [{ component: 'motor', amount: '150', exchange: { ...exchange, usedNative: '100' } }] })])).toThrow(/tramo/);
  });
  it('commission is invariant to payment fragmentation at half-cent boundaries', () => {
    const whole = quoteCollection([service('1')], [tender('whole', '1')]);
    const split = quoteCollection([service('1')], Array.from({ length: 100 }, (_, i) => tender(`fragment-${i}`, '0.01')));
    expect(split.components[0].commissionPaid).toEqual(whole.components[0].commissionPaid);
    expect(collectionSummary(split).commissions).toEqual(collectionSummary(whole).commissions);
  });
  it('coverage is also invariant to fragmenting repeating conversions across previews', () => {
    const initial = service('100', { basis: 'USD_REF_BCV' });
    const whole = quoteCollection([initial], [tender('whole', '1', 'motor', { currency: 'VES', bcv: '3' })]);
    let state = [initial];
    for (let i = 0; i < 100; i++) state = quoteCollection(state, [tender(`piece-${i}`, '0.01', 'motor', { currency: 'VES', bcv: '3' })]).components;
    expect(state[0].covered).toBe('0.33333333');
    expect(state[0].covered).toBe(whole.components[0].covered);
    expect(state[0].commissionPaid).toEqual(whole.components[0].commissionPaid);
  });
  it('rejects the same agreement ID reused for another concept', () => {
    const exchange = { mode: 'EXACT' as const, id: 'same', native: '200', covered: '240' };
    const c = [service('400', { basis: 'USD_REF_BCV' }), component('store', '400', { basis: 'USD_REF_BCV' })];
    expect(() => quoteCollection(c, [tender('cash', '200', 'motor', { targets: [{ component: 'motor', amount: '100', exchange }, { component: 'store', amount: '100', exchange }] })])).toThrow(/condiciones/);
  });
  it('limits spending even when each individual target fits its obligation', () => {
    expect(() => quoteCollection([service(), component('store', '300')], [tender('cash', '100', 'motor', { targets: [{ component: 'motor', amount: '60' }, { component: 'store', amount: '60' }] })])).toThrow(/dinero recibido/);
  });
  it('does not include unknown ownership in confirmed business receipts or commissions', () => {
    const q = quoteCollection([component('unknown', '7', { ownership: 'UNRESOLVED' })], [tender('cash', '7', 'unknown')]);
    expect(collectionSummary(q)).toMatchObject({ ownApplied: { USD: '0.00' }, unresolvedApplied: { USD: '7.00' }, commissions: {} });
  });
  it('permits courtesy lines with no principal and never collects them', () => {
    const c = component('courtesy', '0');
    expect(outstanding(c)).toBe('0.00000000');
    expect(() => quoteCollection([c], [tender('cash', '1', 'courtesy')])).toThrow(/cubierto/);
  });
  it('preserves the last installment cent without creating debt', () => {
    expect(financingQuote('100', '40').installments).toEqual(['20.00', '20.00', '20.00']);
    expect(financingQuote('65.01', '40')).toEqual({ initial: '26.00', financed: '39.01', installments: ['13.00', '13.00', '13.01'] });
  });
  it('validates capacity, types and corrupted balances before any preview', () => {
    for (const bad of ['NaN', 'Infinity', '-1', '1.001', '1e2']) expect(() => quoteCollection([service()], [tender('bad', bad)])).toThrow();
    expect(() => quoteCollection([service()], [tender('double', '200'), tender('double', '100')])).toThrow(/duplicada/);
    expect(() => quoteCollection([service()], [tender('bad', '301')])).toThrow(/saldo/);
    expect(() => quoteCollection([service()], [tender('bad', '1', 'foreign')])).toThrow(/ajeno/);
    expect(() => reserveFinancing(service(), '301')).toThrow(/saldo/);
    expect(() => quoteCollection([service('300', { ownership: 'THIRD_PARTY' })], [])).toThrow(/propia/);
    expect(() => quoteCollection([service('300', { commissionBase: { USD: '200' }, commissionPaid: { USD: '96' } })], [])).toThrow(/inconsistente/);
  });
});

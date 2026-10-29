import Decimal from 'decimal.js';
import type { BankLine, CasheaOrder, CasheaPayment, EngineInput, OsSale } from '../../lib/cashea-conciliation/engine';

// Synthetic data shaped like the 21–27 Oct 2026 manual reconciliation (Cabudare). Order numbers,
// references and names are invented; the totals reproduce the acceptance table of the brief.
export const branches = [
  { code: 'CABUDARE', name: 'Cabudare', sort: 1 }, { code: 'NORTE', name: 'Norte', sort: 2 }, { code: 'LA_MORAN', name: 'La Morán', sort: 3 },
  { code: 'AFUERA', name: 'Afuera (sin nomenclatura)', sort: 4 }, { code: 'AFUERA_SIN_ASIGNAR', name: 'Afuera (sin asignar)', sort: 5 }, { code: 'POR_CONFIRMAR', name: 'Por confirmar', sort: 6 },
];
type Spec = [date: string, ref: string, op: string, desc: string, debit: number, credit: number];
export function bank(opening: number, specs: Spec[]): BankLine[] {
  let bal = new Decimal(opening); const day = new Map<string, number>();
  return specs.map(([date, ref, op, desc, debit, credit], i) => {
    bal = bal.add(credit).sub(debit); const idx = day.get(date) ?? 0; day.set(date, idx + 1);
    return { id: `L${i}`, line_date: date, day_index: idx, reference: ref, op_type: op, tx_type: '', description: desc, debit: debit.toFixed(2), credit: credit.toFixed(2), balance: bal.toFixed(2) };
  });
}
export const IN = 'Abono Pago Movil BNC', OUT = 'Crédito Inmediato Emitido', FEE = 'Comisión Credito Inmediato';
export const rate = '886.2271';
function pay(id: string, ref: string, order: string, ves: number, cuotas: number[], date = '2026-10-23', invoice: string | null = null): CasheaPayment {
  return { id, occurred_at: `${date}T10:00:00-04:00`, reference: ref, external_order: order, installments: cuotas, currency: 'VES', amount: ves.toFixed(2), amount_ref: new Decimal(ves).div(rate).toFixed(4), rate, rate_date: date, invoice };
}
function order(n: string, invoice: string | null, purchased_on: string, total: string, initial: string, status = 'IN PROGRESS', installments: CasheaOrder['installments'] = []): CasheaOrder {
  return { external_order: n, invoice, buyer: 'Cliente', purchased_on, status, total_ref: total, initial_ref: initial, installments };
}
export function sale(n: string, ref: string | null, date = '2026-10-10', gross = '100', status = 'ACTIVE'): OsSale {
  return { sale_id: `S-${n}`, order_id: `O-${n}`, order_number: n, cashea_reference: ref, status, order_date: date, gross_ref: gross, initial_ref: '40' };
}

export function scenario(): EngineInput {
  const lines = bank(270606.12, [
    ['2026-10-21', '000034806', OUT, 'TRANSF CED.:V030881436 CTA.:01020000000000941198', 268000, 0],
    ['2026-10-21', '000034806', FEE, 'COMISION', 804, 0],
    ['2026-10-22', '001198693760', IN, 'PAGO MOVIL', 0, 100000],        // Cabudare, linked order
    ['2026-10-22', '001198693761', IN, 'PAGO MOVIL', 0, 50000],         // Cabudare, invoice typed "000089"
    ['2026-10-22', '000055443443', IN, 'PAGO MOVIL', 0, 39740.10],      // OS-000326 initial, registered BDV 34.782,24
    ['2026-10-23', '000077771111', IN, 'PAGO MOVIL', 0, 38639.50],      // OS-000312 initial: 43,60 USD × rate
    ['2026-10-23', '001198693762', IN, 'PAGO MOVIL', 0, 80000],         // paper series 02001
    ['2026-10-23', '001198693763', IN, 'PAGO MOVIL', 0, 60000],         // one transfer, two orders (Cabudare + afuera)
    ['2026-10-23', '001198693764', IN, 'PAGO MOVIL', 0, 290613.37],     // Cabudare linked
    ['2026-10-24', '001198693765', IN, 'PAGO MOVIL', 0, 57363.55],      // Norte NT-
    ['2026-10-24', '001198693766', IN, 'PAGO MOVIL', 0, 50000],         // Norte NT
    ['2026-10-24', '001198693767', IN, 'PAGO MOVIL', 0, 96723.40],      // La Morán
    ['2026-10-24', '000000034900', OUT, 'TRANSF CED.:V030881436 CTA.:01020000000000941198', 400000, 0],
    ['2026-10-24', '000000034900', FEE, 'COMISION', 1200, 0],
    ['2026-10-25', '001198693768', IN, 'PAGO MOVIL', 0, 530750.94],     // afuera, no nomenclature
    ['2026-10-25', '000000003549', IN, 'Adelanto CED V10779824', 0, 3549.21], // unidentified
    ['2026-10-25', '000000035100', OUT, 'TRANSF CED.:V012306298 CTA.:01080000000000071576', 200000, 0],
    ['2026-10-25', '000000035100', FEE, 'COMISION', 600, 0],
    ['2026-10-26', '001198693769', IN, 'PAGO MOVIL', 0, 56077.49],      // initial of an order now CANCELLED
    ['2026-10-26', '000000035200', OUT, 'TRANSF CED.:V030881436 CTA.:01020000000000941198', 200000, 0],
    ['2026-10-26', '000000035200', FEE, 'COMISION', 600, 0],
  ]);
  const casheaPayments = [
    pay('p1', '1198693760', '236000001', 100000, [1]),
    pay('p2', '1198693761', '217707716', 50000, [2], '2026-10-22', '000089'),
    pay('p3', '1198693762', '220000002', 80000, [3]),
    pay('p4', '1198693763', '236000001', 25000, [2]),
    pay('p5', '1198693763', '236000099', 35000, [1]),
    pay('p6', '1198693764', '236000001', 290613.37, [3]),
    pay('p7', '1198693765', '236100001', 57363.55, [1]),
    pay('p8', '1198693766', '236100002', 50000, [1]),
    pay('p9', '1198693767', '236200001', 96723.40, [1, 2]),
    pay('p10', '1198693768', '236300001', 530750.94, [1]),
    pay('p11', '1198693769', '236436090', 56077.49, [0], '2026-10-26'),
  ];
  const casheaOrders = [
    order('236000001', 'OS-000300', '2026-10-01', '400', '160'),
    order('217707716', '000089', '2026-09-24', '80', '32'),
    order('220000002', '02001', '2026-08-20', '300', '120'),
    order('236000099', '05584400', '2026-10-05', '200', '80'),
    order('236100001', 'NT-0001', '2026-10-22', '200', '80', 'IN PROGRESS', [{ number: 1, due_date: '2026-11-06', amount_ref: '40', paid_ref: '0', status: 'SCHEDULED' }]),
    order('236100002', 'NT0002', '2026-10-22', '150', '60'),
    order('236200001', 'LM0001', '2026-10-22', '250', '100', 'IN PROGRESS', [{ number: 1, due_date: '2026-10-20', amount_ref: '30', paid_ref: '10', status: 'DELAYED' }, { number: 2, due_date: '2026-11-04', amount_ref: '30', paid_ref: '0', status: 'DONE' }]),
    order('236300001', '05584401', '2026-10-02', '900', '360', 'IN PROGRESS', [{ number: 1, due_date: '2026-10-27', amount_ref: '100', paid_ref: '0', status: 'SCHEDULED' }, { number: 2, due_date: '2026-11-11', amount_ref: '100', paid_ref: '0', status: 'SCHEDULED' }]),
    order('236436090', '05584402', '2026-10-26', '158', '63.2', 'CANCELLED', [{ number: 1, due_date: '2026-11-10', amount_ref: '31.6', paid_ref: '0', status: 'SCHEDULED' }]),
    order('236500000', 'OS-000312', '2026-10-23', '109', '43.60'),
    order('216061026', '2104', '2026-09-26', '81', '32.4'),
    order('228000001', '2105', '2026-09-28', '63', '25.2'),
    order('223392042', '035548', '2026-09-29', '45', '18'),
  ];
  return {
    branches, bankLines: lines, casheaPayments, casheaOrders,
    osSales: [sale('OS-000300', '236000001'), sale('OS-000089', '217707716'), sale('OS-000326', '236467244'), sale('OS-000064', '21606102'), sale('OS-000082', null, '2026-09-28', '63')],
    osOrders: [{ order_id: 'O-134', order_number: 'OS-000134', order_date: '2026-09-29', total_ref: '45', status: 'CLOSED', has_cashea: false }],
    osPayments: [
      { payment_id: 'pay-326', order_id: 'O-OS-000326', order_number: 'OS-000326', method: 'TRANSFER_BDV', currency: 'VES', amount: '34782.24', reference: '3443', paid_at: '2026-10-22T09:00:00-04:00', cashea_order: true },
      { payment_id: 'pay-other', order_id: 'O-x', order_number: 'OS-000999', method: 'TRANSFER_BDV', currency: 'VES', amount: '999.00', reference: '1111', paid_at: '2026-10-23T09:00:00-04:00', cashea_order: false },
    ],
    overrides: [],
    adjustments: [{ id: 'a1', occurred_on: '2026-10-25', amount_ves: '45000', debit_branch: 'NORTE', credit_branch: 'CABUDARE', note: 'Traspaso BDV a Norte', reference: '0591326216508' }],
    cutoffs: [{ id: 'c1', cut_date: '2026-10-21', reference: '34806', balance_ves: '1802.12', bank_line_id: null, created_at: '2026-10-21T20:00:00Z', note: null }],
    destinations: [{ cedula: 'V30881436', branch: 'CABUDARE', label: 'Cabudare (BDV)' }, { cedula: 'V12306298', branch: 'AFUERA_SIN_ASIGNAR', label: 'Afuera' }],
    today: '2026-10-28',
  };
}


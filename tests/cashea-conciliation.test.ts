import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readXlsFirstSheet } from '../lib/xls-biff';
import { mergeBnc, parseBnc, withdrawalCedula, normalizeRef } from '../lib/cashea-conciliation/bnc';
import { ownershipOf, runEngine, type OsSale } from '../lib/cashea-conciliation/engine';
import { bank, branches, FEE, IN, OUT, rate, sale, scenario } from './fixtures/cashea-scenario';

describe('Cashea branch reconciliation engine', () => {
  it('reproduces the acceptance table of the 21–27 Oct cut', () => {
    const r = runEngine(scenario());
    const row = (b: string) => r.current.rows.find(x => x.branch === b)!;
    expect(row('CABUDARE')).toMatchObject({ entered: '623992.97', withdrawn: '601800.00', adjustments: '45000.00', due: '67192.97' });
    expect(row('NORTE')).toMatchObject({ entered: '107363.55', withdrawn: '0.00', adjustments: '-45000.00', due: '62363.55' });
    expect(row('LA_MORAN').due).toBe('96723.40');
    expect(row('AFUERA').due).toBe('621828.43');
    expect(row('AFUERA_SIN_ASIGNAR')).toMatchObject({ entered: '0.00', withdrawn: '200600.00', due: '-200600.00' });
    expect(row('POR_CONFIRMAR').due).toBe('3549.21');
    expect(r.current).toMatchObject({ residual: '1802.12', entered: '1453457.56', withdrawn: '802400.00', total: '652859.68', bank_balance: '652859.68', difference: '0.00', anchor_found: true });
    expect(r.chainBreaks).toEqual([]);
  });

  it('records how each credit was identified and raises the expected exceptions', () => {
    const r = runEngine(scenario());
    const byRef = (ref: string) => r.lines.find(l => l.reference === ref)!;
    expect(byRef('000055443443')).toMatchObject({ origin: 'OS_PAYMENT', allocations: [{ branch: 'CABUDARE', os_order_number: 'OS-000326' }] });
    expect(byRef('000077771111')).toMatchObject({ origin: 'CAJA_RATE', allocations: [{ branch: 'CABUDARE', external_order: '236500000' }] });
    expect(byRef('001198693763').allocations.map(a => [a.branch, a.amount])).toEqual([['CABUDARE', '25000.00'], ['AFUERA', '35000.00']]);
    expect(byRef('000000003549')).toMatchObject({ origin: 'SIN_IDENTIFICAR' });
    const kinds = r.exceptions.map(e => e.kind);
    for (const k of ['OS_BDV_EN_BNC', 'MONTO_DIFERENTE', 'INICIAL_NO_REGISTRADO', 'SIN_IDENTIFICAR', 'CANCELADA_CON_INICIAL', 'FACTURA_MAL_ESCRITA', 'REFERENCIA_MAL_CARGADA', 'POSIBLE_CABUDARE', 'CABUDARE_SIN_ENLACE'] as const) expect(kinds).toContain(k);
    expect(r.exceptions.find(e => e.kind === 'REFERENCIA_MAL_CARGADA')?.fix).toEqual({ action: 'SET_REFERENCE', sale_id: 'S-OS-000064', reference: '216061026' });
    expect(r.exceptions.find(e => e.key === 'posible:228000001')?.fix).toEqual({ action: 'SET_REFERENCE', sale_id: 'S-OS-000082', reference: '228000001' });
    expect(r.exceptions.find(e => e.key === 'posible:223392042')?.fix).toMatchObject({ action: 'ASSIGN_ORDER', branch: 'CABUDARE' });
    expect(r.exceptions.find(e => e.kind === 'CANCELADA_CON_INICIAL')?.amount_ves).toBe('56077.49');
  });

  it('computes receivables: pending = amount − paid, overdue when DELAYED or past due, cancelled orders ignored', () => {
    const r = runEngine(scenario());
    const rec = (b: string) => r.receivables.find(x => x.branch === b);
    expect(rec('NORTE')).toMatchObject({ overdue_ref: '0.00', upcoming_ref: '40.00' });
    expect(rec('LA_MORAN')).toMatchObject({ overdue_ref: '20.00', upcoming_ref: '0.00' });
    expect(rec('AFUERA')).toMatchObject({ overdue_ref: '100.00', upcoming_ref: '100.00', total_ref: '200.00' });
  });

  it('manual reassignment wins over the rules and moves the money', () => {
    const input = scenario();
    input.overrides = [{ id: 'o1', subject: 'ORDER', subject_key: '236300001', branch: 'NORTE', note: 'Confirmado con Norte' }, { id: 'o2', subject: 'BANK_LINE', subject_key: 'L15', branch: 'CABUDARE', note: 'Adelanto de Cabudare' }];
    const r = runEngine(input);
    expect(r.current.rows.find(x => x.branch === 'NORTE')!.entered).toBe('638114.49');
    expect(r.current.rows.find(x => x.branch === 'POR_CONFIRMAR')!.entered).toBe('0.00');
    expect(r.current.difference).toBe('0.00');
  });

  it('suggests the next zero and flags gaps in the balance chain', () => {
    const input = scenario();
    input.bankLines = bank(270606.12, [
      ['2026-10-21', '34806', OUT, 'CED.:V030881436', 268000, 0], ['2026-10-21', '34806', FEE, 'COMISION', 804, 0],
      ['2026-10-22', '1', IN, 'X', 0, 20000], ['2026-10-23', '9', OUT, 'CED.:V030881436', 15000, 0], ['2026-10-23', '9', FEE, 'COMISION', 45, 0],
    ]);
    const r = runEngine(input);
    expect(r.zeroSuggestion?.line.id).toBe('L4');
    expect(r.zeroSuggestion?.balance).toBe('6757.12');
    input.bankLines.splice(2, 1);
    expect(runEngine(input).chainBreaks).toEqual(['L3']);
    expect(runEngine(input).current.difference).not.toBe('0.00');
  });

  it('applies the invoice rules in order', () => {
    const own = (invoice: string | null, purchased = '2026-10-10', linked?: OsSale) => ownershipOf({ external_order: '1', invoice, purchased_on: purchased, linked, manual: undefined }).branch;
    expect(own('NT-5', '2026-10-10', sale('OS-000117', '1'))).toBe('CABUDARE');
    expect(own('os-000150')).toBe('CABUDARE');
    expect(own('01975')).toBe('CABUDARE');
    expect(own('02110')).toBe('AFUERA');
    expect(own('2104')).toBe('AFUERA');
    expect(own('NT-12')).toBe('NORTE');
    expect(own('LM7')).toBe('LA_MORAN');
    expect(own('2007')).toBe('POR_CONFIRMAR');
    expect(own(null, '2026-09-21')).toBe('POR_CONFIRMAR');
    expect(own(null, '2026-09-22')).toBe('AFUERA');
  });
});

describe('BNC statement (.xls)', () => {
  it('reads the binary Excel 97 statement, finds the header and validates the chain', () => {
    const p = parseBnc(readXlsFirstSheet(readFileSync('tests/fixtures/bnc-sintetico.xls')));
    expect(p.errors).toEqual([]);
    expect(p.lines).toHaveLength(302);
    expect(p.chain_ok).toBe(true);
    expect(p.account).toBe('01910000000000004493');
    expect(p.lines[0]).toMatchObject({ line_date: '2026-10-22', reference: '001198690000', credit: '1000.00000000', balance: '2802.12000000', op_type: 'Abono Pago Movil BNC' });
    expect(p.lines[150].description).toContain('–'); // 16-bit characters survive the SST continuation
    expect(p.lines.at(-1)).toMatchObject({ line_date: '2026-10-24', op_type: 'Comisión Credito Inmediato', debit: '150.00000000' });
    expect(new Set(p.lines.map(l => l.description)).size).toBeGreaterThan(290);
  });

  it('merges overlapping statements without duplicating lines', () => {
    const cells = readXlsFirstSheet(readFileSync('tests/fixtures/bnc-sintetico.xls'));
    const full = parseBnc(cells);
    const head = parseBnc(cells.slice(0, 16 + 150));
    const merged = mergeBnc([head, full]);
    expect(merged.lines).toHaveLength(302);
    expect(merged.chain_ok).toBe(true);
  });

  it('extracts withdrawal cédulas and normalizes references', () => {
    expect(withdrawalCedula('TRANSF CED.:V030881436 CTA.:0102')).toBe('V30881436');
    expect(withdrawalCedula('CED.: V-12306298')).toBe('V12306298');
    expect(normalizeRef('001198693760')).toBe('1198693760');
  });
});

describe('Upload detection, BDV panel and export', () => {
  it('detects each report and normalizes Cashea headers written with accents', async () => {
    const { detectKind, canonicalCasheaHeaders } = await import('../lib/cashea-conciliation/report');
    expect(detectKind([['Fecha de Transacción', '# Cuota Pagada', '# Orden']])).toBe('CASHEA_TRANSACTIONS');
    expect(detectKind([['# Orden', 'Estado orden']])).toBe('CASHEA_ORDERS');
    expect(detectKind([['Banco'], [], ['Fecha', 'Referencia', 'Debe', 'Haber', 'Saldo']])).toBe('BNC');
    expect(detectKind([['Hola']])).toBe('UNKNOWN');
    expect(canonicalCasheaHeaders([['Fecha de Transacción', 'Metodo de pago', '# Orden']], 'CASHEA_TRANSACTIONS')[0]).toEqual(['Fecha de Transaccion', 'Método de pago', '# Orden']);
  });

  it('builds the Cabudare BDV panel: opening + BNC withdrawals + sales − outflows = closing', async () => {
    const { bdvPanel } = await import('../lib/cashea-conciliation/report');
    const r = runEngine(scenario());
    const withdrawals = r.lines.filter(l => l.kind === 'RETIRO' && l.allocations[0].branch === 'CABUDARE' && l.line_date >= '2026-10-22');
    const bdv = [
      { id: 'b1', occurred_at: '2026-10-24T15:00:00-04:00', reference: '1', description: 'TRANSF BNC', direction: 'IN' as const, amount: '400000', balance: '851492.46' },
      { id: 'b2', occurred_at: '2026-10-24T16:00:00-04:00', reference: '5550001234', description: 'PAGO MOVIL', direction: 'IN' as const, amount: '20000', balance: '871492.46' },
      { id: 'b3', occurred_at: '2026-10-25T18:15:00-04:00', reference: '0591326216508', description: 'TRASPASO', direction: 'OUT' as const, amount: '45000', balance: '826492.46' },
      { id: 'b4', occurred_at: '2026-10-25T18:20:00-04:00', reference: '7', description: 'COMISION', direction: 'OUT' as const, amount: '10', balance: '826482.46' },
      { id: 'b5', occurred_at: '2026-10-26T10:00:00-04:00', reference: '8', description: 'COMPRA', direction: 'OUT' as const, amount: '500', balance: '825982.46' },
    ];
    const p = bdvPanel(bdv, withdrawals, new Set(['1234']));
    expect(p).toMatchObject({ opening: '451492.46', fromBnc: '400000.00', sales: '20000.00', bigOut: '45000.00', smallOut: '500.00', fees: '10.00', closing: '825982.46', computedClosing: '825982.46' });
    expect(p.big.map(l => l.reference)).toEqual(['0591326216508']);
  });

  it('exports the cut with the summary, payments, withdrawals and orders sheets', async () => {
    const { exportSheets } = await import('../lib/cashea-conciliation/report');
    const r = runEngine(scenario());
    const sheets = exportSheets({ result: r, summary: r.current, receivables: r.receivables, rate: rate, branchName: new Map(branches.map(b => [b.code, b.name])), bdv: null, exceptions: r.exceptions });
    expect(sheets.map(s => s.sheet)).toEqual(['Resumen', 'Pagos BNC', 'Retiros', 'Órdenes', 'Excepciones']);
    const resumen = sheets[0].data as unknown[][];
    expect(resumen.find(row => row[0] === 'Cabudare')).toEqual(['Cabudare', 623992.97, 601800, 45000, 67192.97]);
    expect((sheets[1].data as unknown[][]).length - 1).toBe(r.lines.filter(l => Number(l.credit) > 0 && l.line_date > '2026-10-21').reduce((n, l) => n + l.allocations.length, 0));
    expect((sheets[2].data as unknown[][]).length - 1).toBe(6);
  });
});

describe('Lessons from the real 1–28 Oct statement', () => {
  const header = [null, 'Fecha', 'Código\n Transacción', 'Tipo \nTransacción', 'Tipo \nOperación', 'Descripción', 'Referencia', 'Debe', 'Haber', 'Saldo'];
  const rows = [
    [null, '01/10/2026', '388', 'P2COTR', 'Abono Pago Movil BNC', 'PMPC', 1126681985, 0, 10666.17, 206209.85],
    [null, '01/10/2026', '388', 'P2COTR', 'Abono Pago Movil BNC', 'PMPC', 565961, 0, 12558.56, 218768.41],
  ];
  it('uses the bank "Totales" row as a control instead of a movement', () => {
    const ok = parseBnc([[null, 'CUENTA CORRIENTE ***4493'], header, ...rows, [null, 'Totales', null, null, null, null, null, 0, 23224.73, 218768.41]]);
    expect(ok).toMatchObject({ errors: [], chain_ok: true, account: '***4493' });
    expect(ok.lines.map(l => l.reference)).toEqual(['1126681985', '565961']);
    const bad = parseBnc([header, ...rows, [null, 'Totales', null, null, null, null, null, 0, 99999, 218768.41]]);
    expect(bad.errors[0].message).toMatch(/totales del banco/i);
  });

  it('suggests a mistyped OS reference even when the order only appears in the payments export', () => {
    const input = scenario();
    input.casheaOrders = input.casheaOrders.filter(o => o.external_order !== '216061026');
    input.casheaPayments.push({ id: 'p-2104', occurred_at: '2026-10-26T18:47:00-04:00', reference: '62991953123', external_order: '216061026', installments: [3], currency: 'VES', amount: '12130.00', amount_ref: '13.67', rate, rate_date: '2026-10-26', invoice: '2104' });
    const e = runEngine(input).exceptions.find(x => x.kind === 'REFERENCIA_MAL_CARGADA');
    expect(e?.fix).toEqual({ action: 'SET_REFERENCE', sale_id: 'S-OS-000064', reference: '216061026' });
  });

  it('hides bank-only exceptions of the period already closed by a zero', () => {
    const input = scenario();
    input.bankLines = bank(270606.12, [
      ['2026-10-02', '131927', OUT, 'TRANSF CED.:J413105438', 0.01, 0], ['2026-10-21', '34806', OUT, 'CED.:V030881436', 268000, 0], ['2026-10-21', '34806', FEE, 'COMISION', 804 - 0.01, 0],
      ['2026-10-22', '77', OUT, 'TRANSF CED.:J999999999', 100, 0],
    ]);
    const kinds = runEngine(input).exceptions.filter(e => e.kind === 'RETIRO_CEDULA_DESCONOCIDA').map(e => e.bank_line_id);
    expect(kinds).toEqual(['L3']);
  });
});

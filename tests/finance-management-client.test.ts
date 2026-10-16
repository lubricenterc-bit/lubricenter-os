import {describe,it,expect} from 'vitest';
import {financeDateStep,validFinancePeriod,managementReportCsv,type FinanceManagementReport} from '../lib/finance/management-report';
describe('Management report dates and export',()=>{
 it('handles a historical day, month boundaries and leap dates without the machine timezone',()=>{
  expect(financeDateStep('2026-10-01',-1)).toBe('2026-09-30');
  expect(financeDateStep('2024-02-28',1)).toBe('2024-02-29');
  expect(validFinancePeriod('2026-09-10','2026-09-10','2026-10-16')).toBe(true);
  for(const [from,to] of [['2026-02-30','2026-03-01'],['','2026-10-16'],['2026-10-17','2026-10-17'],['2026-10-16','2026-10-15'],['2024-01-01','2026-01-01']])expect(validFinancePeriod(from,to,'2026-10-16')).toBe(false);
 });
 it('exports separate currency fields, marks missing values and neutralizes spreadsheet formulas',()=>{
  const r={period:{from:'2026-09-10',to:'2026-09-10'},totals:{sales_equivalent:100},channels:Object.fromEntries(['cashea','contado','divisas','credito'].map(k=>[k,{equivalent:25,ves:20000,orders:1}])),receivables:{as_of:'2026-09-10',outstanding_ves:0,outstanding_bcv:null,cashea_recorded_ref:null,items:[]},orders:[{order_number:'OS-TEST',business_at:'2026-09-10T16:00:00Z',customer:'=HYPERLINK("test")',plate:'ABC',location:'Cabudare',channel:'MIXTA',sales_equivalent:100,total_ves:80000,cashea_bcv:25,contado_bcv:25,divisas_usd:25,credit_bcv:25}]} as unknown as FinanceManagementReport;
  const csv=managementReportCsv(r);
  expect(csv.startsWith('\uFEFF')).toBe(true);expect(csv).toContain('"\'=HYPERLINK');expect(csv).toContain('"Pendiente"');expect(csv).toContain('"100,0000"');expect(csv).toContain('Factura Bs');
 });
});

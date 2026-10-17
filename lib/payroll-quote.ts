/** Pure payroll-preview math. All amounts in USD reference, not bank currency.
 * Cashea's merchant fee is a cost of Lubricenter and never enters mechanic wages.
 */
export interface PayrollAdjustmentPreview {
 id: string;
 amount_ref: number | string;
 decision: string;
}
export interface PayrollQuoteInput {
 fixedUsd: number;
 collectedCommissionUsd: number;
 adjustments: PayrollAdjustmentPreview[];
 casheaAdvanceAdjustmentIds: string[];
 prepaidUsd: number;
}
const cents=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export function calculatePayrollQuote(input:PayrollQuoteInput){
 const active=input.adjustments.filter(a=>a.decision==="PAY");
 const casheaIds=new Set(input.casheaAdvanceAdjustmentIds.filter(Boolean));
 const casheaAdvances=cents(active.filter(a=>casheaIds.has(a.id)&&Number(a.amount_ref)>0)
   .reduce((n,a)=>n+Number(a.amount_ref),0));
 const otherBonuses=cents(active.filter(a=>!casheaIds.has(a.id)&&Number(a.amount_ref)>0)
   .reduce((n,a)=>n+Number(a.amount_ref),0));
 const deductions=cents(active.filter(a=>Number(a.amount_ref)<0)
   .reduce((n,a)=>n+Number(a.amount_ref),0));
 const adjustmentsNet=cents(casheaAdvances+otherBonuses+deductions);
 const baseCommissions=cents(input.collectedCommissionUsd);
 const fixedUsd=cents(input.fixedUsd);
 const gross=cents(fixedUsd+baseCommissions+adjustmentsNet);
 const prepaidApplied=cents(Math.min(Math.max(0,gross),Math.max(0,input.prepaidUsd)));
 const netToPay=cents(Math.max(0,gross-prepaidApplied));
 return {fixedUsd,baseCommissions,casheaAdvances,otherBonuses,deductions,
  adjustmentsNet,gross,prepaidApplied,netToPay};
}

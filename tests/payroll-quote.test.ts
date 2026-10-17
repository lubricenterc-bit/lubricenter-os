import {describe,it,expect} from "vitest";
import {calculatePayrollQuote} from "../lib/payroll-quote";
describe("Preliquidación Cheo con comisiones Cashea completas",()=>{
 it("shows 173 instead of 142.40 collected or 127.40 net of discounts only",()=>{
  const q=calculatePayrollQuote({fixedUsd:0,collectedCommissionUsd:142.4,prepaidUsd:0,
   casheaAdvanceAdjustmentIds:["os209","os222"],
   adjustments:[
    {id:"old",amount_ref:-5,decision:"PAY"},
    {id:"alt",amount_ref:-10,decision:"PAY"},
    {id:"os209",amount_ref:7.2,decision:"PAY"},
    {id:"os222",amount_ref:38.4,decision:"PAY"}
   ]});
  expect(q.baseCommissions).toBe(142.4);
  expect(q.casheaAdvances).toBe(45.6);
  expect(q.deductions).toBe(-15);
  expect(q.adjustmentsNet).toBe(30.6);
  expect(q.gross).toBe(173);
  expect(q.netToPay).toBe(173);
 });
 it("doesn't double count a held Cashea bonus or an advance already received",()=>{
  const q=calculatePayrollQuote({fixedUsd:0,collectedCommissionUsd:142.4,prepaidUsd:32,
   casheaAdvanceAdjustmentIds:["os209","os222"],
   adjustments:[
    {id:"old",amount_ref:-15,decision:"PAY"},
    {id:"os209",amount_ref:7.2,decision:"HOLD"},
    {id:"os222",amount_ref:38.4,decision:"PAY"}
   ]});
  expect(q.casheaAdvances).toBe(38.4);
  expect(q.gross).toBe(165.8);
  expect(q.prepaidApplied).toBe(32);
  expect(q.netToPay).toBe(133.8);
 });
 it("never subtracts the Cashea 4 percent merchant fee from the worker",()=>{
  const q=calculatePayrollQuote({fixedUsd:0,collectedCommissionUsd:25.60,prepaidUsd:0,
   casheaAdvanceAdjustmentIds:["os222"],adjustments:[
    {id:"os222",amount_ref:38.4,decision:"PAY"}]});
  expect(q.netToPay).toBe(64);
  expect(q.casheaAdvances).toBe(38.4);
 });
});

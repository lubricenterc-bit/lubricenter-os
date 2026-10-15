import {describe,it,expect} from "vitest";
import {readPendingReceipt,receiptStorageKey,validateReceiptQuantities,type ReceiptRequest} from "../lib/purchase-receipts";
describe("Receipt recovery after lost response",()=>{
 it("preserves the exact UUID and payload through closing and reopening the form",()=>{
  const pending:ReceiptRequest={p_request_id:"request-one",p_invoice_id:"invoice-one",p_location_id:"cabudare",p_received_on:"2026-10-15",p_items:[{line_id:"oil",quantity:4}],p_notes:null};
  const store=new Map([[receiptStorageKey("invoice-one"),JSON.stringify(pending)]]);
  const storage={getItem:(key:string)=>store.get(key)??null};
  expect(readPendingReceipt(storage,"invoice-one")).toEqual(pending);
  expect(readPendingReceipt(storage,"invoice-two")).toBeNull();
  store.set(receiptStorageKey("invoice-one"),"invalid");
  expect(()=>readPendingReceipt(storage,"invoice-one")).toThrow();
 });
 it("rejects excess, negative and nonfinite input before sending quantities",()=>{
  const lines=[{id:"oil",quantity:12,received_quantity:6}];
  for(const qty of [-1,7,NaN,Infinity])expect(validateReceiptQuantities(lines,{oil:qty})).toBeTruthy();
  expect(validateReceiptQuantities(lines,{oil:0})).toBeTruthy();
  expect(validateReceiptQuantities(lines,{oil:6})).toBeNull();
 });
});

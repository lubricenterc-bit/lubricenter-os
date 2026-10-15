import {describe,expect,it} from "vitest";
import {caracasCalendarDate,isSafeBcvSnapshot,selectCurrentRate} from "../lib/bcv-effective-date";
const schedule=[
 {effective_date:"2026-10-09",USD:875.6505,updated_at:"2026-10-08T21:46:00Z"},
 {effective_date:"2026-10-13",USD:876.7976,updated_at:"2026-10-09T20:13:54Z"},
 {effective_date:"2026-10-14",USD:878.0000,updated_at:"2026-10-13T21:00:00Z"},
];
describe("BCV Fecha Valor por día Caracas",()=>{
 it("uses Friday's effective rate on Saturday and Sunday even if Tuesday rate was already published",()=>{
  expect(selectCurrentRate(schedule,"2026-10-10")?.USD).toBe(875.6505);
  expect(selectCurrentRate(schedule,"2026-10-11")?.USD).toBe(875.6505);
 });
 it("keeps Friday's rate through Monday 12 October national banking holiday",()=>{
  expect(selectCurrentRate(schedule,"2026-10-12")?.USD).toBe(875.6505);
 });
 it("activates the future-dated rate only on its own effective date",()=>{
  expect(selectCurrentRate(schedule,"2026-10-09")?.USD).toBe(875.6505);
  expect(selectCurrentRate(schedule,"2026-10-13")?.USD).toBe(876.7976);
  expect(selectCurrentRate(schedule,"2026-10-14")?.USD).toBe(878);
 });
 it("does not require hardcoded national/bank holiday calendar",()=>{
  expect(selectCurrentRate(schedule,"2026-10-15")?.USD).toBe(878);
  expect(selectCurrentRate(schedule,"2026-10-08")).toBeNull();
 });
 it("uses the local Venezuela date, not UTC date",()=>{
  expect(caracasCalendarDate(new Date("2026-10-14T03:30:00Z"))).toBe("2026-10-13");
  expect(caracasCalendarDate(new Date("2026-10-14T04:30:00Z"))).toBe("2026-10-14");
 });
 it("rejects dates or unusable source values",()=>{
  expect(selectCurrentRate([{effective_date:"2026-10-13",USD:NaN}],"2026-10-13")).toBeNull();
  expect(isSafeBcvSnapshot({effective_date:"2026-10-13",USD:876.7976,updated_at:"2026-10-09T20:13:54Z"},
    new Date("2026-10-13T20:40:00Z"))).toBe(true);
  expect(isSafeBcvSnapshot({effective_date:"2026-10-13",USD:0,updated_at:"2026-10-09T20:13:54Z"},
    new Date("2026-10-13T20:40:00Z"))).toBe(false);
 });
});

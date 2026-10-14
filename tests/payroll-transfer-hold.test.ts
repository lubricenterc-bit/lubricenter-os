import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
const mig=readFileSync("supabase/migrations/20261014193000_payroll_adjustments_payment_facades.sql","utf8");
describe("Nómina: propuesta retenida y saldo neutro",()=>{
 it("creates an atomic held Cheo/Alexis $10 pair",async()=>{
  const db=new PGlite();
  try{
   await db.exec(`
    create role anon;create role authenticated;create schema auth;create schema lubricenter_private;
    create function auth.uid() returns uuid language sql as 'select ''ffffffff-ffff-4fff-8fff-ffffffffffff''::uuid';
    create function lubricenter_private.require_order_admin() returns void language plpgsql as 'begin if auth.uid() is null then raise exception ''No autorizado'';end if;end';
    create table public.employees(id uuid primary key,name text,active boolean);
    create table public.payroll_runs(id uuid primary key);
    create table public.payroll_adjustments(
      id uuid primary key default gen_random_uuid(),employee_id uuid,adjustment_type text,
      amount_ref numeric,note text,occurred_on date,decision text default 'PAY',
      version integer default 1,updated_at timestamptz default now(),payroll_run_id uuid);
    create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb);
    create function lubricenter_private.payroll_review_adjustment(uuid,integer,text,numeric,text)
      returns uuid language sql as 'select $1';
    create function lubricenter_private.payroll_record_payment(uuid,uuid,date,numeric,text,text)
      returns uuid language sql as 'select $1';
    create function lubricenter_private.payroll_mark_historical_paid(uuid,date,text)
      returns uuid language sql as 'select $1';
   `);
   await db.exec(mig);
   const cheo="11111111-1111-4111-8111-111111111111",alexis="22222222-2222-4222-8222-222222222222";
   await db.query("insert into public.employees(id,name,active) values ($1,'Cheo',true),($2,'Alexis',true)",[cheo,alexis]);
   const created=await db.query<{id:string}>(
    "select public.payroll_transfer_draft($1::uuid,$2::uuid,10,'Trabajo de Alexis cobrado con diferencia de 10 USD','2026-10-14') id",[cheo,alexis]);
   const tid=created.rows[0].id;
   const rows=await db.query<{decision:string;amount:number}>(
     "select decision,amount_ref::float8 amount from public.payroll_adjustments where transfer_id=$1 order by amount_ref",[tid]);
   expect(rows.rows).toEqual([{decision:"HOLD",amount:-10},{decision:"HOLD",amount:10}]);
   await expect(db.query("select public.payroll_transfer_decide($1::uuid,'APPROVE','Sin autorización suficiente',false)",[tid])).rejects.toThrow();
   await db.query("select public.payroll_transfer_decide($1::uuid,'REJECT','No procede deducción salarial sin autorización',false)",[tid]);
   const final=await db.query<{decision:string}>("select decision from public.payroll_adjustments where transfer_id=$1",[tid]);
   expect(final.rows.every(x=>x.decision==="EXCLUDE")).toBe(true);
  }finally{await db.close();}
 },120000);
});

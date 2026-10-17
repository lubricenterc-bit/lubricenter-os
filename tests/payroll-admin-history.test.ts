import {PGlite} from "@electric-sql/pglite";
import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";

const sql=(path:string)=>readFileSync("supabase/migrations/"+path,"utf8");
async function setup(){
 const db=new PGlite();
 await db.exec(`
  CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;CREATE SCHEMA lubricenter_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
  CREATE FUNCTION lubricenter_private.require_order_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  CREATE FUNCTION lubricenter_private.payroll_sync() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  CREATE TABLE public.employees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,active boolean DEFAULT true);
  CREATE TABLE public.payroll_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,period_start date,period_end date,status text DEFAULT 'SETTLED',created_at timestamptz DEFAULT now(),
   fixed_ref numeric,variable_ref numeric,adjustments_ref numeric,total_ref numeric,payroll_version integer DEFAULT 3,commission_usd numeric,commission_ves numeric,commission_hard_usd numeric,commission_bcv_usd numeric);
  CREATE TABLE public.payroll_work_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,order_id uuid,order_number text,description text,source_type text,payout_mode text,
   earned_at timestamptz,created_at timestamptz,decision text,reason text,obligation_usd numeric,payroll_run_id uuid,version integer DEFAULT 1);
  CREATE TABLE public.payroll_work_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_item_id uuid,occurred_at timestamptz,reason text,before_data jsonb,after_data jsonb);
  CREATE TABLE public.payroll_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,amount_ref numeric,adjustment_type text,note text,decision text,occurred_on date,payroll_run_id uuid,created_at timestamptz);
  CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text);
  CREATE TABLE public.payroll_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payroll_run_id uuid,account_id uuid,paid_on date,currency text,amount_original numeric,usd_equivalent numeric,
     payment_mode text,component text,reference text,note text,account_movement_id uuid,created_at timestamptz DEFAULT now());
  CREATE TABLE public.audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,created_at timestamptz DEFAULT now());
  CREATE TABLE public.compensation_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,rule_type text,valid_from date,valid_to date,value numeric);
 `);
 await db.exec(sql("20261017190000_payroll_carryover_snapshot.sql"));
 await db.exec(sql("20261017191000_payroll_admin_history_report.sql"));
 await db.exec(`
  INSERT INTO employees(id,name) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alexis');
  INSERT INTO payroll_runs(id,employee_id,period_start,period_end,created_at,fixed_ref,variable_ref,adjustments_ref,total_ref)
  VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-05','2026-10-10',
    '2026-10-10 21:00+00',60,10.95,0,70.95);
  INSERT INTO payroll_work_items(employee_id,order_id,order_number,description,source_type,payout_mode,earned_at,created_at,
    decision,reason,obligation_usd,payroll_run_id)
  VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',gen_random_uuid(),'OS-000167','Arranque Silverado',
     'ELECTROAUTO_COMMISSION','BCV_VES','2026-10-05 20:43+00','2026-10-07 15:13+00',
     'HOLD','Solicitud de Alexis',16,null),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',gen_random_uuid(),'OS-000166','Trabajo liquidado',
    'ELECTROAUTO_COMMISSION','BCV_VES','2026-10-07 15:00+00','2026-10-07 15:00+00',
    'PAY','',10.95,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  INSERT INTO payroll_payments(payroll_run_id,paid_on,currency,amount_original,usd_equivalent,payment_mode,reference,note)
  VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-10','VES',62127.4,70.95,'ACTUAL','8036','Quedan a favor dos trabajos');
 `);
 return db;
}
describe("Administrative payroll history and deferred carryovers",()=>{
 it("retains held Silverado separately from paid total and preserves actual payment",async()=>{
  const db=await setup();try{
   const r=await db.query<{data:{runs:any[]}}>("SELECT public.payroll_admin_week_history('2026-10-10') data");
   const run=r.rows[0].data.runs[0],held=run.work.find((x:any)=>x.order_number==="OS-000167");
   expect(run.total_ref).toBe(70.95);expect(run.paid_usd).toBe(70.95);
   expect(held.decision_at_settlement).toBe("HOLD");
   expect(held.amount_at_settlement).toBe(16);expect(held.reason_at_settlement).toBe("Solicitud de Alexis");
   expect(run.payments[0].payment_mode).toBe("ACTUAL");
  }finally{await db.close();}
 });
 it("shows older deferred work in the next week even though it was earned previously",async()=>{
  const db=await setup();try{
    let r=await db.query<{work:any[]}>("SELECT lubricenter_private.payroll_review('2026-10-17') work");
    expect(r.rows[0].work.some(x=>x.order_number==="OS-000167")).toBe(true);
    await db.exec("UPDATE payroll_work_items SET decision='PAY' WHERE order_number='OS-000167'");
    r=await db.query<{work:any[]}>("SELECT lubricenter_private.payroll_review('2026-10-17') work");
    expect(r.rows[0].work.some(x=>x.order_number==="OS-000167"&&x.decision==="PAY")).toBe(true);
  }finally{await db.close();}
 });
 it("marks an order entered after settlement as late, not as retroactively paid",async()=>{
  const db=await setup();try{
   await db.exec(`
    INSERT INTO payroll_work_items(employee_id,order_id,order_number,description,source_type,payout_mode,earned_at,created_at,
     decision,reason,obligation_usd)
    VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',gen_random_uuid(),'OS-TEST-LATE','Arranque no facturado a tiempo',
     'ELECTROAUTO_COMMISSION','BCV_VES','2026-10-08 20:43+00','2026-10-17 14:00+00',
     'PAY','Regularización posterior',12.8);
   `);
   const r=await db.query<{data:{runs:any[]}}>("SELECT public.payroll_admin_week_history('2026-10-10') data");
   const late=r.rows[0].data.runs[0].work.find((w:any)=>w.order_number==="OS-TEST-LATE");
   expect(late.decision_at_settlement).toBe("LATE_POSTING");
   expect(late.amount_at_settlement).toBe(0);
   expect(r.rows[0].data.runs[0].total_ref).toBe(70.95);
  }finally{await db.close();}
 });
});

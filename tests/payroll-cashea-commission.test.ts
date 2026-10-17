import {describe,it,expect} from "vitest";
import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
const migration=readFileSync("supabase/migrations/20261017195000_payroll_cashea_commission_policy.sql","utf8");
const accrual="44444444-4444-4444-8444-444444444444";
async function setup(){
 const db=new PGlite();
 const schema=[
 "CREATE ROLE authenticated","CREATE ROLE anon","CREATE SCHEMA auth","CREATE SCHEMA lubricenter_private",
 "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$",
 "CREATE FUNCTION lubricenter_private.require_order_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$",
 "CREATE TABLE employees(id uuid PRIMARY KEY,name text)",
 "CREATE TABLE orders(id uuid PRIMARY KEY,order_number text,status text,total_ves numeric)",
 "CREATE TABLE order_items(id uuid PRIMARY KEY,order_id uuid,description text,price_denomination text,bcv_rate_snapshot numeric,operative_rate_snapshot numeric)",
 "CREATE TABLE payroll_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid())",
 "CREATE TABLE payroll_accruals(id uuid PRIMARY KEY,employee_id uuid,source_order_item_id uuid,source_type text,amount_ref numeric,description text,occurred_at timestamptz,payroll_run_id uuid)",
 "CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,currency text,amount_original numeric,value_ref numeric,value_ves numeric,paid_at timestamptz)",
 "CREATE TABLE payroll_work_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),accrual_id uuid,payment_id uuid,employee_id uuid,order_id uuid,order_number text,description text,source_type text,currency text,original_amount numeric,amount numeric,ref_per_unit numeric,obligation_usd numeric,payout_mode text,earned_at timestamptz,created_at timestamptz DEFAULT now(),payroll_run_id uuid,reversal_of uuid,reason text,decision text DEFAULT 'PAY',version integer DEFAULT 1)",
 "CREATE UNIQUE INDEX payroll_work_source ON payroll_work_items(accrual_id,payment_id) WHERE reversal_of IS NULL",
 "CREATE UNIQUE INDEX payroll_work_reversal ON payroll_work_items(reversal_of) WHERE reversal_of IS NOT NULL",
 "CREATE TABLE payroll_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,adjustment_type text,amount_ref numeric,note text,occurred_on date,decision text,version integer DEFAULT 1,updated_at timestamptz,created_at timestamptz DEFAULT now(),payroll_run_id uuid)",
 "CREATE TABLE cashea_sales(id uuid PRIMARY KEY,order_id uuid,status text,ownership_status text,gross_ref numeric,initial_ref numeric,financed_ref numeric,commission_ref numeric,cashea_reference text)",
 "CREATE TABLE cashea_installments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cashea_sale_id uuid,installment_no integer,amount_ref numeric,paid_ref numeric,due_date date,status text)",
 "CREATE TABLE audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,created_at timestamptz DEFAULT now())",
 "INSERT INTO employees VALUES('11111111-1111-4111-8111-111111111111','Cheo')",
 "INSERT INTO orders VALUES('22222222-2222-4222-8222-222222222222','OS-000222','CLOSED',153846.44)",
 "INSERT INTO order_items VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','Mano de obra motor','REF',879.1225,1061.32)",
 "INSERT INTO payroll_accruals VALUES('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','WORKSHOP_COMMISSION',64,'Mano de obra motor','2026-10-15 15:00+00',NULL)",
 "INSERT INTO cashea_sales VALUES('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222','ACTIVE','OWN',175,70,105,7,'230791407')",
 "INSERT INTO cashea_installments(cashea_sale_id,installment_no,amount_ref,paid_ref,due_date,status) SELECT '55555555-5555-4555-8555-555555555555',n,35,0,('2026-10-29'::date+(n-1)*14),'PENDING' FROM generate_series(1,3) n",
 "INSERT INTO payments(order_id,currency,amount_original,value_ref,value_ves,paid_at) VALUES('22222222-2222-4222-8222-222222222222','VES',61538.58,70,61538.58,'2026-10-15 15:41+00')"
 ];
 await db.exec(schema.join(";\n")+";");
 await db.exec(migration);
 return db;
}
async function installment(db:PGlite){
 await db.exec("INSERT INTO payments(order_id,currency,amount_original,value_ref,value_ves,paid_at) VALUES('22222222-2222-4222-8222-222222222222','VES',30769.29,35,30769.29,'2026-10-29 15:41+00')");
}
describe("Cashea 4% is exclusively a business cost",()=>{
 it("Cheo earns the full 64 USD and an advance prevents later duplicate commissions",async()=>{
   const db=await setup();try{
    await db.exec("SELECT lubricenter_private.payroll_sync()");
    const first=await db.query<{obligation_usd:number}>("SELECT obligation_usd FROM payroll_work_items WHERE decision='PAY'");
    expect(Number(first.rows[0].obligation_usd)).toBe(25.6);
    const result=await db.query<{result:{full_ref:number;advance_ref:number}}>("SELECT public.payroll_cashea_set_policy($1,'FULL_UPFRONT','2026-10-17','Cheo acepta adelanto completo de la comisión') result",[accrual]);
    expect(Number(result.rows[0].result.full_ref)).toBe(64);
    expect(Number(result.rows[0].result.advance_ref)).toBe(38.4);
    const fee=await db.query<{commission_ref:number}>("SELECT commission_ref FROM cashea_sales");
    expect(Number(fee.rows[0].commission_ref)).toBe(7);
    await installment(db);
    await db.exec("SELECT lubricenter_private.payroll_sync()");
    await db.exec("SELECT lubricenter_private.payroll_sync()");
    const status=await db.query<{decision:string;obligation_usd:number}>("SELECT decision,obligation_usd FROM payroll_work_items ORDER BY created_at,id");
    expect(status.rows).toHaveLength(2);
    expect(status.rows.filter(x=>x.decision==='EXCLUDE')).toHaveLength(1);
    const balances=await db.query<{amount:number}>("SELECT (SELECT sum(obligation_usd) FROM payroll_work_items WHERE decision='PAY') + (SELECT sum(amount_ref) FROM payroll_adjustments WHERE decision='PAY') amount");
    expect(Number(balances.rows[0].amount)).toBe(64);
   }finally{await db.close();}
 });
 it("Pay-as-collected has no advance and does not apply the 4% fee to wages",async()=>{
   const db=await setup();try{
    await db.exec("SELECT lubricenter_private.payroll_sync()");
    await db.query("SELECT public.payroll_cashea_set_policy($1,'AS_COLLECTED','2026-10-17','Cheo recibe comisión al ingresar cada cuota')",[accrual]);
    await installment(db);await db.exec("SELECT lubricenter_private.payroll_sync()");
    const result=await db.query<{amount:number}>("SELECT sum(obligation_usd) amount FROM payroll_work_items WHERE decision='PAY'");
    expect(Number(result.rows[0].amount)).toBe(38.4);
    const n=await db.query<{count:number}>("SELECT count(*)::int count FROM payroll_adjustments");
    expect(n.rows[0].count).toBe(0);
   }finally{await db.close();}
 });
});

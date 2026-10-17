import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";

const migration=(name:string)=>readFileSync("supabase/migrations/"+name,"utf8");
async function setup(){
 const db=new PGlite();
 await db.exec(`
 CREATE ROLE authenticated;CREATE ROLE anon;
 CREATE SCHEMA auth;CREATE SCHEMA lubricenter_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '11111111-1111-4111-8111-111111111111'::uuid $$;
 CREATE FUNCTION lubricenter_private.require_order_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
 CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_number text,status text);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE,currency text,active boolean DEFAULT true);
 CREATE TABLE public.payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,method text,currency text,amount_original numeric,bcv_rate_snapshot numeric,operative_rate_snapshot numeric,value_ves numeric,value_ref numeric,reference text,financial_account_id uuid,paid_at timestamptz,created_by uuid,receivable_id uuid);
 CREATE TABLE public.cashea_sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,status text,ownership_status text,initial_percent numeric,gross_ref numeric,initial_ref numeric,initial_ves_snapshot numeric,financed_ref numeric,bcv_rate_snapshot numeric,initial_payment_method text,created_at timestamptz);
 CREATE TABLE public.cashea_installments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cashea_sale_id uuid,installment_no integer,paid_ref numeric,amount_ref numeric,amount_ves_snapshot numeric,status text);
 CREATE TABLE public.audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text,entity_type text,entity_id uuid,actor_id uuid,data jsonb);
 CREATE TABLE public.order_tenders(payment_id uuid,order_id uuid);
 CREATE TABLE public.reconciliation_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_movement_id uuid,cashea_sale_id uuid,cashea_installment_id uuid,reversed_at timestamptz);
 CREATE TABLE public.account_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_payment_id uuid,account_id uuid,currency text,amount_original numeric,value_ves numeric,reference text);
 CREATE TABLE public.external_sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text,account_id uuid);
 CREATE TABLE public.external_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid,occurred_at timestamptz,reference text,direction text,currency text,amount numeric);
 CREATE FUNCTION public.test_movement_on_new_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO public.account_movements(source_payment_id,account_id,currency,amount_original,value_ves,reference)
 VALUES(NEW.id,NEW.financial_account_id,NEW.currency,NEW.amount_original,NEW.value_ves,NEW.reference);
 RETURN NEW; END $$;
 CREATE TRIGGER test_movement_after_payment AFTER INSERT ON public.payments
 FOR EACH ROW EXECUTE FUNCTION public.test_movement_on_new_payment();
 INSERT INTO public.financial_accounts(code,currency) VALUES ('BDV','VES'),('BNC','VES'),('CASH_VES','VES'),('CASH_USD','USD'),('ZELLE','USD'),('BINANCE','USD');
 `);
 await db.exec(migration("20261017180000_cashea_initial_safe_correction.sql"));
 await db.exec(migration("20261017181000_finance_bank_mismatch_advisor.sql"));
 await db.exec(`
 INSERT INTO public.orders(order_number,status) VALUES('OS-TEST','CLOSED');
 INSERT INTO public.cashea_sales(order_id,status,ownership_status,initial_percent,gross_ref,initial_ref,initial_ves_snapshot,financed_ref,bcv_rate_snapshot,initial_payment_method,created_at)
 SELECT id,'ACTIVE','OWN',40,141,56.4,49582.51,84.6,879.1225,'TRANSFER_BDV','2026-10-15 13:00:00+00' FROM public.orders;
 INSERT INTO public.cashea_installments(cashea_sale_id,installment_no,paid_ref,amount_ref,amount_ves_snapshot,status)
 SELECT s.id,g.n,0,28.2,24791.25,'PENDING' FROM public.cashea_sales s CROSS JOIN generate_series(1,3) g(n);
 INSERT INTO public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,financial_account_id,paid_at)
 SELECT o.id,'TRANSFER_BDV','VES',49582.51,879.1225,879.1225,49582.51,56.4,'1515',a.id,'2026-10-15 13:00:00+00'
 FROM public.orders o JOIN public.financial_accounts a ON a.code='BDV';
 `);
 return db;
}
const root=async(db:PGlite)=>{const r=await db.query<{id:string}>("select id from public.orders limit 1");return r.rows[0].id;};
const oldPayment=async(db:PGlite)=>{const r=await db.query<{id:string}>("select id from public.payments limit 1");return r.rows[0].id;};

describe("Correction of closed Cashea initial without sale reversal",()=>{
 it("updates bank, percent and future installments without creating another order",async()=>{
  const db=await setup();try{
   const id=await root(db),payment=await oldPayment(db);
   const lines=JSON.stringify([{source_id:payment,method:"TRANSFER_BNC",amount:"61453.00",reference:"1515"}]);
   const r=await db.query<{result:{ok:boolean;initial_ref:number;financed_ref:number}}>(
     "select public.correct_cashea_initial($1,$2,$3,$4::jsonb,true) result",
     [id,"La inicial era 70 USD y entró al BNC",70/141*100,lines]);
   expect(r.rows[0].result.ok).toBe(true);
   const accounts=await db.query<{bank:string}>(`select fa.code bank from public.account_movements m
    join public.financial_accounts fa on fa.id=m.account_id`);
   expect(accounts.rows).toEqual([{bank:"BNC"}]);
   const sales=await db.query<{initial_ref:number;financed_ref:number}>("select initial_ref,financed_ref from public.cashea_sales");
   expect(Number(sales.rows[0].initial_ref)).toBeCloseTo(70,2);
   expect(Number(sales.rows[0].financed_ref)).toBeCloseTo(71,2);
   const totals=await db.query<{n:number;amount:number}>(`select count(*)::integer n,sum(amount_ref) amount from public.cashea_installments`);
   expect(totals.rows[0].n).toBe(3);
   expect(Number(totals.rows[0].amount)).toBeCloseTo(71,2);
   const orders=await db.query<{n:number}>("select count(*)::integer n from public.orders");
   expect(orders.rows[0].n).toBe(1);
   const audit=await db.query<{n:number}>(`select count(*)::integer n from public.audit_events where event_type='cashea.initial_correction'`);
   expect(audit.rows[0].n).toBe(1);
  }finally{await db.close();}
 });
 it("rejects an allocated payment and leaves ledger intact",async()=>{
  const db=await setup();try{
   const id=await root(db),payment=await oldPayment(db);
   await db.exec("insert into public.reconciliation_allocations(account_movement_id) select id from public.account_movements limit 1");
   const lines=JSON.stringify([{source_id:payment,method:"TRANSFER_BNC",amount:"61453.00",reference:"1515"}]);
   await expect(db.query("select public.correct_cashea_initial($1,$2,$3,$4::jsonb,true)",[id,"Banco anotado equivocado",70/141*100,lines])).rejects.toThrow(/conciliado/i);
   const r=await db.query<{bank:string}>(`select a.code bank from public.account_movements m join public.financial_accounts a on a.id=m.account_id`);
   expect(r.rows[0].bank).toBe("BDV");
  }finally{await db.close();}
 });
 it("auto-repairs only a unique imported exact bank match, once",async()=>{
  const db=await setup();try{
   const account=await db.query<{id:string}>("select id from public.financial_accounts where code='BNC'");
   await db.query("insert into public.external_sources(provider,account_id) values ('BNC',$1)",[account.rows[0].id]);
   await db.exec(`insert into public.external_transactions(source_id,occurred_at,reference,direction,currency,amount)
       select s.id,'2026-10-15 13:10+00','0050926021515','IN','VES',49582.51 from public.external_sources s where s.provider='BNC'`);
   const preview=await db.query<{payment_id:string}>(`select * from public.finance_exact_bank_mismatches('2026-10-12','2026-10-17')`);
   expect(preview.rows).toHaveLength(1);
   const r=await db.query<{result:{corrected:number;skipped:number}}>(
     "select public.finance_autofix_bank_mismatches('2026-10-12','2026-10-17') result");
   expect(r.rows[0].result.corrected).toBe(1);
   const again=await db.query<{result:{corrected:number}}>("select public.finance_autofix_bank_mismatches('2026-10-12','2026-10-17') result");
   expect(again.rows[0].result.corrected).toBe(0);
   const bank=await db.query<{code:string}>(`select a.code from public.payments p join public.financial_accounts a on a.id=p.financial_account_id`);
   expect(bank.rows[0].code).toBe("BNC");
  }finally{await db.close();}
 });
 it("does not guess when bank statement has duplicate candidates",async()=>{
  const db=await setup();try{
   const a=await db.query<{id:string}>("select id from public.financial_accounts where code='BNC'");
   await db.query("insert into public.external_sources(provider,account_id) values ('BNC',$1)",[a.rows[0].id]);
   await db.exec(`insert into public.external_transactions(source_id,occurred_at,reference,direction,currency,amount)
    select s.id,'2026-10-15 13:10+00','0050926021515','IN','VES',49582.51 from public.external_sources s where s.provider='BNC';
    insert into public.external_transactions(source_id,occurred_at,reference,direction,currency,amount)
    select s.id,'2026-10-15 13:11+00','0050926021515','IN','VES',49582.51 from public.external_sources s where s.provider='BNC';`);
   const matches=await db.query("select * from public.finance_exact_bank_mismatches('2026-10-12','2026-10-17')");
   expect(matches.rows).toHaveLength(0);
  }finally{await db.close();}
 });
});

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

let db: PGlite;
const owner="10000000-0000-0000-0000-000000000001";
const bdv="20000000-0000-0000-0000-000000000001";
const cash="20000000-0000-0000-0000-000000000002";
const binance="20000000-0000-0000-0000-000000000003";

async function asOwner(){
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.exec("set role authenticated");
}
async function root(){await db.exec("reset role")}
async function dashboard():Promise<any>{
  return (await db.query("select public.finance_currency_summary('2026-09-10','2026-09-11') as report")).rows[0] as any;
}
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(gunzipSync(readFileSync("tests/fixtures/production-structure.sql.gz")).toString());
  // The fixture predates Finance Core. Reproduce the current dependency chain.
  await db.exec(readFileSync("supabase/migrations/20260924145617_usd_pricing_payroll_review.sql","utf8"));
  for (const file of [
    "20260923145542_finance_core_v22.sql",
    "20260923150824_finance_reconciliation_v22.sql",
    "20260923150830_finance_cash_v22.sql",
    "20260925103000_finance_cashea_mixed_accounts_usd_quick_sale.sql",
    "20260930143615_finance_integrity_residuals.sql",
    "20260930151245_finance_report_navigation.sql",
    "20260930153613_finance_conflict_visibility.sql",
    "20260930154654_finance_allocation_guard.sql",
    "20260930155832_finance_cash_anchor_review.sql",
    "20260930160819_finance_cash_due_tasks.sql",
    "20260930175314_cashea_merchant_balance.sql",
    "20261001132405_cash_change_phone_alerts.sql",
    "20261001154229_exact_bcv_digital_checkout.sql",
    "20261001153446_finance_followup.sql",
    "20261007210757_finance_weekly_reconciliation_core.sql",
    "20261007211631_finance_rules_resolve_outflows.sql",
  ]) await db.exec(readFileSync("supabase/migrations/" + file,"utf8"));
  await db.exec(readFileSync("supabase/migrations/20261013170000_finance_three_currency_views.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20261013184500_finance_bcv_sales_invoice.sql","utf8"));
  await db.exec(readFileSync("scripts/finance-management-report.sql","utf8"));
  await db.exec("insert into auth.users values('"+owner+"','lubricenterc@gmail.com',now())");
  await db.exec("insert into public.financial_accounts(id,code,name,currency,account_type) values "+
    "('"+bdv+"','FIN_TEST_BDV','Banco de Venezuela','VES','BANK'),"+
    "('"+cash+"','FIN_TEST_CASHUSD','Caja USD','USD','CASH'),"+
    "('"+binance+"','FIN_TEST_BINANCE','Binance USDT','USD','CLEARING')");
  await db.exec("insert into public.exchange_rates(rate_type,value,effective_at) values "+
    "('BCV',800,'2026-09-10T00:00:00-04:00'),"+
    "('BCV',1000,'2026-09-11T00:00:00-04:00'),"+
    "('OPERATIVE',1000,'2026-09-10T00:00:00-04:00')");
},120000);
afterAll(async()=>{await db?.close()});
beforeEach(async()=>{await db.exec("begin");await asOwner()});
afterEach(async()=>{await db.exec("rollback");await root()});

describe("Invoice sales take precedence over collections",()=>{
  it("counts the full invoice in BCV including financed portions while excluding real USD",async()=>{
    await root();
    const idA=(await db.query<{id:string}>(`insert into public.orders(status,total_ves,total_ref,closed_at,business_at)
      values('CLOSED',80000,100,'2026-09-10T15:00:00-04:00','2026-09-10T15:00:00-04:00') returning id`)).rows[0].id;
    const idB=(await db.query<{id:string}>(`insert into public.orders(status,total_ves,total_ref,closed_at,business_at)
      values('CLOSED',80000,100,'2026-09-11T15:00:00-04:00','2026-09-11T15:00:00-04:00') returning id`)).rows[0].id;
    await db.query(`insert into public.order_items
      (order_id,item_type,business_area,description,charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot)
      values($1,'SERVICE','WORKSHOP','Test',80000,100,800,900),
            ($2,'SERVICE','WORKSHOP','Test',80000,80,1000,1100)`,[idA,idB]);
    await db.query(`insert into public.payments
      (order_id,method,currency,amount_original,value_ves,value_ref,bcv_rate_snapshot,operative_rate_snapshot,financial_account_id)
      values($1,'CASH_USD','USD',20,16000,20,800,900,$2)`,[idA,cash]);
    await asOwner();
    const result=(await db.query<{data:any}>("select public.finance_sales_bcv('2026-09-10','2026-09-11') as data")).rows[0].data;
    expect(Number(result.sales_ves)).toBe(144000);
    expect(Number(result.sales_bcv)).toBe(160);
    expect(Number(result.sales_divisas_usd)).toBe(20);
    expect(Number(result.orders)).toBe(2);
  });
  it("keeps financial billing access unavailable to anon",async()=>{
    await root();
    const r=await db.query<{ok:boolean}>("select has_function_privilege('anon','public.finance_sales_bcv(date,date)','EXECUTE') as ok");
    expect(r.rows[0].ok).toBe(false);
    await asOwner();
  });
});

async function report(from="2026-09-10",to=from):Promise<any> {
  await asOwner();
  return (await db.query<{r:any}>("select public.finance_management_report($1,$2) r",[from,to])).rows[0].r;
}
async function sale(total=100,date="2026-09-10T12:00:00-04:00",rate=800,lines=true) {
  await root();
  const id=(await db.query<{id:string}>("insert into public.orders(status,total_ves,total_ref,closed_at,business_at) values('CLOSED',$1,$2,$3,$3) returning id",[total*rate,total,date])).rows[0].id;
  if(lines) await db.query("insert into public.order_items(order_id,item_type,business_area,description,charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot) values($1,'SERVICE','WORKSHOP','Servicio de prueba',$2,$3,$4,1000)",[id,total*rate,total,rate]);
  return id;
}
async function pay(order:string,currency:string,amount:number,date="2026-09-10T12:00:00-04:00",receivable:string|null=null) {
  await root();
  await db.query("insert into public.payments(order_id,method,currency,amount_original,value_ves,value_ref,bcv_rate_snapshot,operative_rate_snapshot,financial_account_id,paid_at,receivable_id,reference) values($1,$2,$3,$4,$5,$6,800,1000,$7,$8,$9,'99112233')",[order,currency==='USD'?'CASH_USD':'TRANSFER_BDV',currency,amount,currency==='USD'?amount*800:amount,currency==='USD'?amount:amount/800,currency==='USD'?cash:bdv,date,receivable]);
}
async function credit(order:string,principal=50) {
  await root();
  return (await db.query<{id:string}>("insert into public.receivables(order_id,debtor_type,principal_ves,principal_ref,outstanding_ves,status,created_at,due_date) values($1,'CUSTOMER',$2,$3,$2,'OPEN','2026-09-10T12:00:00-04:00','2026-09-11') returning id",[order,principal*800,principal])).rows[0].id;
}
describe("Management report: complete daily sales and historical receivables",()=>{
  it("partitions mixed sales exactly once and keeps a Cashea USD initial inside the full Cashea sale",async()=>{
    const cs=await sale();await pay(cs,'USD',20);
    await db.query("insert into public.cashea_sales(order_id,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_percent,commission_percent,initial_payment_method,cashea_reference,ownership_status) values($1,100,80000,20,16000,80,4,3200,800,20,4,'CASH_USD','99881001','OWN')",[cs]);
    const bs=await sale(80);await pay(bs,'VES',64000);
    const usd=await sale(50);await pay(usd,'USD',50);
    const mix=await sale();await pay(mix,'VES',16000);await pay(mix,'USD',30);await credit(mix);
    const r=await report();
    expect(r.totals).toMatchObject({orders:4,sales_equivalent:330});
    expect(r.channels.cashea.equivalent).toBe(100);
    expect(r.channels.contado.equivalent).toBe(100);
    expect(r.channels.divisas.equivalent).toBe(80);
    expect(r.channels.credito.equivalent).toBe(50);
    expect(Object.values(r.channels).reduce((n:number,c:any)=>n+c.equivalent,0)).toBe(r.totals.sales_equivalent);
    expect(r.orders.find((o:any)=>o.id===mix).channel).toBe('MIXTA');
    expect(r.receivables.outstanding_bcv).toBe(50);
    if(process.env.E2E_FINANCE_FIXTURE_DIR){
      const currency=(await db.query<{r:any}>("select public.finance_currency_summary('2026-09-10','2026-09-10') r")).rows[0].r;
      const billing=(await db.query<{r:any}>("select public.finance_sales_bcv('2026-09-10','2026-09-10') r")).rows[0].r;
      mkdirSync(process.env.E2E_FINANCE_FIXTURE_DIR,{recursive:true});
      writeFileSync(process.env.E2E_FINANCE_FIXTURE_DIR+'/finance.json',JSON.stringify({owner,report:r,currency,billing}));
    }
  });
  it("reconstructs a past receivable even after later payment marks it paid",async()=>{
    const id=await sale(50);const debt=await credit(id,50);
    await pay(id,'USD',50,'2026-09-11T12:00:00-04:00',debt);
    await db.query("update public.receivables set status='PAID',outstanding_ves=0,closed_at='2026-09-11T12:00:00-04:00' where id=$1",[debt]);
    const past=await report();
    expect(past.receivables.outstanding_ves).toBe(40000);
    expect(past.channels.credito.equivalent).toBe(50);
    expect(past.channels.divisas.equivalent).toBe(0);
    const next=await report('2026-09-11');
    expect(next.totals.orders).toBe(0);
    expect(next.receivables.outstanding_ves).toBe(0);
    const range=await report('2026-09-10','2026-09-11');
    expect(range.channels.credito.equivalent).toBe(50);
    expect(range.channels.divisas.equivalent).toBe(0);
  });
  it("uses the Caracas business date with exact midnight boundaries and excludes open or cancelled orders",async()=>{
    const before=await sale(10,'2026-09-10T03:59:59Z');
    const start=await sale(20,'2026-09-10T04:00:00Z');
    const end=await sale(30,'2026-09-11T03:59:59Z');
    await sale(40,'2026-09-11T04:00:00Z');
    const cancelled=await sale();await db.query("update public.orders set status='CANCELLED' where id=$1",[cancelled]);
    const open=await sale();await db.query("update public.orders set status='OPEN' where id=$1",[open]);
    await db.query("update public.orders set closed_at='2026-09-11T16:00:00Z' where id=$1",[start]);
    const r=await report();
    expect(r.orders.map((o:any)=>o.id).sort()).toEqual([start,end].sort());
    expect(r.orders.some((o:any)=>o.id===before)).toBe(false);
    expect(r.totals.sales_equivalent).toBe(50);
  });
  it("does not fabricate a BCV total when invoice rates are missing or payments exceed the invoice",async()=>{
    await sale(10,undefined,800,false);
    const r=await report();expect(r.totals.sales_equivalent).toBeNull();expect(r.warnings.missing_invoice_rates).toBe(1);
    const id=await sale(20);await pay(id,'USD',25);
    const invalid=await report();expect(invalid.warnings.overpaid_orders).toBe(1);expect(invalid.orders.find((o:any)=>o.id===id).sales_equivalent).toBeNull();
  });
  it("excludes a Cashea order belonging to another business instead of counting it in cash",async()=>{
    const id=await sale();
    await db.query("insert into public.cashea_sales(order_id,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_percent,commission_percent,initial_payment_method,cashea_reference,ownership_status) values($1,100,80000,20,16000,80,4,3200,800,20,4,'CASH_VES','99881002','OTHER_LOCATION')",[id]);
    const r=await report();expect(r.totals.orders).toBe(0);expect(r.warnings.excluded_cashea).toBe(1);
  });
  it("keeps the recorded Cashea balance separate and respects payout and reversal cutoffs",async()=>{
    await root();
    await db.exec("insert into public.cashea_balance_events(request_id,kind,occurred_on,amount_ref,reference,evidence) values(gen_random_uuid(),'OPENING_CREDIT','2026-09-09',100,'FIXTURE-OPEN','Test only'),(gen_random_uuid(),'PAYOUT','2026-09-11',40,'FIXTURE-PAYOUT','Test only')");
    expect((await report()).receivables.cashea_recorded_ref).toBe(100);
    expect((await report('2026-09-11')).receivables.cashea_recorded_ref).toBe(60);
  });
  it("returns a complete zero-sales report without inventing a Cashea opening",async()=>{
    const r=await report();expect(r.totals.orders).toBe(0);expect(r.totals.sales_equivalent).toBe(0);expect(r.orders).toEqual([]);expect(r.receivables.cashea_recorded_ref).toBeNull();
  });
  it("rejects anonymous users, operators and invalid date ranges",async()=>{
    await root();
    expect((await db.query<{v:boolean}>("select has_function_privilege('anon','public.finance_management_report(date,date)','EXECUTE') v")).rows[0].v).toBe(false);
    await db.query("select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000099',false)");await db.exec("set role authenticated");
    await expect(db.query("select public.finance_management_report('2026-09-10','2026-09-10')")).rejects.toThrow(/administrador/);
  });
  it.each([['2026-09-11','2026-09-10'],['2999-01-01','2999-01-01'],['2020-01-01','2026-01-01']])("rejects invalid date range %s through %s",async(from,to)=>{
    await expect(report(from,to)).rejects.toThrow(/fechas/);
  });
});

describe("Separated finance currencies",()=>{
  it("uses the historical BCV rate of each VES collection and never converts USD collections into Bs",async()=>{
    await root();
    await db.exec("insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,occurred_at) values "+
      "('"+bdv+"','IN','PAYMENT','VES',10000,10000,'2026-09-10T12:00:00-04:00'),"+
      "('"+bdv+"','IN','PAYMENT','VES',10000,10000,'2026-09-11T12:00:00-04:00'),"+
      "('"+cash+"','IN','PAYMENT','USD',20,20000,'2026-09-10T12:00:00-04:00')");
    await asOwner();
    const r=(await dashboard()).report as any;
    expect(Number(r.bs.collections)).toBe(20000);
    expect(Number(r.bcv.collections)).toBe(22.5);
    expect(Number(r.usd.collections)).toBe(20);
    expect(Number(r.operative.external_entries)).toBe(20);
    expect(r.accounts.find((a:any)=>a.code==="FIN_TEST_CASHUSD").closing).toBe(20);
  });

  it("records an exchange as two linked transfers without creating any sale",async()=>{
    const group=(await db.query<{id:string}>("select public.finance_transfer_fx($1,$2,$3,$4,$5,$6) as id",
      [bdv,binance,10000,10,"Compra USDT","1234"])).rows[0].id;
    const raw=await db.query<{currency:string;amount_original:string;direction:string;movement_type:string}>(
      "select currency,amount_original,direction,movement_type from public.account_movements where transfer_group=$1 order by direction",[group]);
    expect(raw.rows).toHaveLength(2);
    expect(raw.rows.map(x=>x.movement_type)).toEqual(["TRANSFER","TRANSFER"]);
    // FX transfers use the real current timestamp, not September's historical fixture window.
    const r=(await db.query<{report: any}>("select public.finance_currency_summary((now() at time zone 'America/Caracas')::date,(now() at time zone 'America/Caracas')::date) as report")).rows[0].report;
    expect(Number(r.bs.outflows)).toBe(10000);
    expect(Number(r.usd.entries)).toBe(10);
    expect(Number(r.bs.collections)).toBe(0);
    expect(Number(r.usd.collections)).toBe(0);
    expect(Number(r.usd.external_entries)).toBe(0);
    expect(Number(r.bs.external_outflows)).toBe(0);
  });

  it("never grants the new finance RPC anonymously",async()=>{
    await root();
    const {rows}=await db.query<{allowed:boolean}>("select has_function_privilege('anon','public.finance_currency_summary(date,date)','EXECUTE') allowed");
    expect(rows[0].allowed).toBe(false);
    await asOwner();
  });
});

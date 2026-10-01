import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { parseBdv, parseCashea, type Preview, type ExternalRow } from '../lib/finance/importers';

let db: PGlite;
type CashTaskFixture = { task_key: string };
const owner='10000000-0000-0000-0000-000000000001', operator='10000000-0000-0000-0000-000000000002', admin='10000000-0000-0000-0000-000000000003';
const bank='20000000-0000-0000-0000-000000000001', usd='20000000-0000-0000-0000-000000000002', ves='20000000-0000-0000-0000-000000000003';
const source='30000000-0000-0000-0000-000000000001', cashea='30000000-0000-0000-0000-000000000002';
async function scalar<T=unknown>(sql:string,args:unknown[]=[]):Promise<T>{const r=await db.query(sql,args);return Object.values(r.rows[0] as object)[0] as T;}
async function asUser(id=owner){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
async function root(){await db.exec('reset role');}
function preview(rows:ExternalRow[],provider:Preview['provider']='BDV'):Preview{return {provider,rows,orders:[],errors:[],warnings:[],duplicates:0,balance_chain:true,observed_from:'2026-09-01',observed_to:'2026-09-30'};}
function row(n=1,amount='100',override:Partial<ExternalRow>={}):ExternalRow{return {row:n,occurred_at:`2026-09-10T12:${String(n%60).padStart(2,'0')}:00-04:00`,reference:String(1000+n),description:'TEST',direction:'IN',currency:'VES',amount,balance:amount,raw:{fixture:true},...override};}
async function ingest(rows:ExternalRow[],provider:Preview['provider']='BDV'){return scalar<string>('select public.finance_import($1,$2,$3,$4,$5::jsonb)',[provider==='BDV'?source:cashea,'fixture','2026-09-01','2026-09-30',JSON.stringify(preview(rows,provider))]);}
async function movement(amount='100',reference='1001',date='2026-09-10T12:01:00-04:00',account=bank,direction='IN'){
 await root();const id=await scalar<string>(`insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,reference,occurred_at) values($1,$2,'PAYMENT',$3,$4,$4,$5,$6) returning id`,[account,direction,account===usd?'USD':'VES',amount,reference,date]);await asUser();return id;
}
async function tx(){return scalar<string>('select id from public.external_transactions order by created_at,id limit 1');}
async function allocate(external:string,movement:string|null,installment:string|null,ea:string,ta=ea,method='EXACT',request=randomUUID()){
 return scalar<string>('select public.finance_allocate($1,$2,$3,$4,$5,$6,$7,$8)',[request,external,movement,installment,ea,ta,method,'Comprobado en prueba']);
}
async function seedCashea(reference:string,status='ACTIVE'){
 await root();const o=await scalar<string>("insert into orders(status,total_ref,total_ves,closed_at) values('CLOSED',50,40000,'2026-08-01') returning id");
 const sale=await scalar<string>(`insert into cashea_sales(order_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference) values($1,$2,40,4,50,40000,20,16000,30,2,1600,800,'TRANSFER_BDV',$3) returning id`,[o,status,reference]);
 const installments:string[]=[];for(let n=1;n<=3;n++)installments.push(await scalar<string>("insert into cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot) values($1,$2,$3,10,8000) returning id",[sale,n,`2026-${n===3?'10':'08'}-${String(n*7).padStart(2,'0')}`]));
 await asUser();return {sale,installments};
}
// PostgreSQL errors abort a transaction, so rejected-path assertions use a savepoint.
async function rejects(fn:()=>Promise<unknown>,message?:RegExp){await db.exec('savepoint rejection');let error:unknown;try{await fn();}catch(e){error=e;}await db.exec('rollback to rejection');expect(error).toBeTruthy();if(message)expect((error as Error).message).toMatch(message);}

beforeAll(async()=>{
 db=new PGlite();await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());await db.exec('set check_function_bodies=on');
 // Production received the USD/payroll hotfix before Finance Core is deployed.
 await db.exec(readFileSync('supabase/migrations/20260924145617_usd_pricing_payroll_review.sql','utf8'));
 for(const file of readdirSync('supabase/migrations').filter(f=>f.includes('v22')).sort())await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 await db.exec(readFileSync('supabase/migrations/20260925103000_finance_cashea_mixed_accounts_usd_quick_sale.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930143615_finance_integrity_residuals.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930151245_finance_report_navigation.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930153613_finance_conflict_visibility.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930154654_finance_allocation_guard.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930155832_finance_cash_anchor_review.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930160819_finance_cash_due_tasks.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260930175314_cashea_merchant_balance.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261001132405_cash_change_phone_alerts.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261001154229_exact_bcv_digital_checkout.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261001153446_finance_followup.sql','utf8'));
 await db.exec(`insert into auth.users values('${owner}','lubricenterc@gmail.com',now()),('${operator}','operator@example.test',now()),('${admin}','admin@example.test',now());
 insert into public.locations(code,name) values('TEST','Test location');
 insert into public.financial_accounts(id,code,name,currency,account_type) values('${bank}','BDV','Bank','VES','BANK'),('${usd}','CASH_USD','USD','USD','CASH'),('${ves}','CASH_VES','Bs','VES','CASH');
 insert into public.external_sources(id,provider,name,account_id,external_account,currency) values('${source}','BDV','BDV','${bank}','bank-test','VES'),('${cashea}','CASHEA_TRANSACTIONS','Cashea',null,'Shared','VES');
 insert into public.finance_memberships(user_id,role,granted_by) values('${admin}','ADMIN','${owner}');
 insert into public.exchange_rates(rate_type,value,effective_at) values('OPERATIVE',850,'2026-01-01'),('BCV',800,'2026-01-01');`);
},120000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');await asUser();});
afterEach(async()=>{await db.exec('rollback');await root();});

const tenderItems=JSON.stringify([{kind:'MANUAL',description:'Producto de prueba',quantity:1,unit_ref:40}]);
async function quickTender(received=50,returned=10,returnCurrency='USD',exchange=900,method='CASH_USD',label:string|null=null,request=randomUUID()){
 return scalar<{order_id:string}>('select quick_sale_with_tender($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,null,40)',[request,tenderItems,method,received,returned,returnCurrency,exchange,method.startsWith('TRANSFER')?'1234':null,label]);
}
describe('Tender, change and automatic notices',()=>{
 it.each(['USD','VES'])('separates $50 received, $40 price and $10 returned in %s',async currency=>{
  const sale=await quickTender(50,10,currency,900);
  expect(await scalar('select status from orders where id=$1',[sale.order_id])).toBe('CLOSED');
  expect(Number(await scalar('select sum(agreed_usd) from order_items where order_id=$1',[sale.order_id]))).toBe(40);
  expect(Number(await scalar('select sum(amount_original) from payments where order_id=$1',[sale.order_id]))).toBe(40);
  expect(Number(await scalar("select sum(case when direction='IN' then amount_original else -amount_original end) from account_movements where currency='USD'"))).toBe(currency==='USD'?40:50);
  expect(Number(await scalar("select coalesce(sum(case when direction='IN' then amount_original else -amount_original end),0) from account_movements where currency='VES'"))).toBe(currency==='USD'?0:-9000);
  expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(0);
  expect(Number(await scalar("select count(*) from account_movements where movement_type='EXPENSE'"))).toBe(0);
 });
 it('preserves a USD liability then returns it in parts without duplicates',async()=>{
  await quickTender(50,0,'USD',900,'CASH_USD','Cliente pendiente');
  const tender=await scalar<string>('select id from order_tenders');
  expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(10);
  const request=randomUUID();const args=[request,tender,4,'VES',1000,'Cliente recibió los Bs'];
  await scalar('select return_order_change($1,$2,$3,$4,$5,$6)',args);await scalar('select return_order_change($1,$2,$3,$4,$5,$6)',args);
  expect(Number(await scalar('select count(*) from order_change_returns'))).toBe(1);
  expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(6);
  await rejects(()=>scalar('select return_order_change($1,$2,7,$3,1000,$4)',[randomUUID(),tender,'USD','Devolución']),/superior/);
  await scalar('select return_order_change($1,$2,6,$3,1000,$4)',[randomUUID(),tender,'USD','Entrega final']);
  expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(0);
 });
 it('records Bs tender and USD change in the two actual physical boxes',async()=>{
  await quickTender(46000,17.5,'USD',800,'CASH_VES');
  expect(Number(await scalar("select sum(amount_original) from account_movements where currency='VES' and direction='IN'"))).toBe(46000);
  expect(Number(await scalar("select sum(amount_original) from account_movements where currency='USD' and direction='OUT'"))).toBe(17.5);
 });
 it('keeps a 40 USD price settled at the agreed Bs rate without inventing Bs receipts',async()=>{
  await quickTender(32000,0,'USD',800,'CASH_VES');
  expect(Number(await scalar('select sum(value_ves) from payments'))).toBe(34000);
  expect(Number(await scalar('select sum(value_ves) from account_movements'))).toBe(32000);
  expect(Number(await scalar('select sum(agreed_usd) from order_items'))).toBe(40);
  expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(0);
 });
 it('retains the signed rounding difference separately from sale coverage',async()=>{
  await quickTender(32001,0,'USD',800,'CASH_VES');
  expect(Number(await scalar('select rounding_ves from order_tenders'))).toBe(1);
  expect(Number(await scalar('select sum(amount_original) from payments'))).toBe(32000);
 });
 it('does not lose a pending walk-in refund or create a half-completed sale',async()=>{
  await rejects(()=>quickTender(50,0),/Identifica/);
  expect(Number(await scalar('select count(*) from orders'))).toBe(0);
  await rejects(()=>quickTender(50,11),/supera/);
  expect(Number(await scalar('select count(*) from payments'))).toBe(0);
 });
 it('retries a quick sale atomically and rejects reuse with changed amounts',async()=>{
  const request=randomUUID();const a=await quickTender(50,10,'USD',900,'CASH_USD',null,request);const b=await quickTender(50,10,'USD',900,'CASH_USD',null,request);
  expect(a.order_id).toBe(b.order_id);expect(Number(await scalar('select count(*) from orders'))).toBe(1);
  await rejects(()=>quickTender(100,60,'USD',900,'CASH_USD',null,request),/reutilizada/);
 });
 it('keeps the two mixed payments distinct and the remaining coverage accurate',async()=>{
  const order=await scalar<string>('select order_id from build_quick_sale_order($1::jsonb)',[tenderItems]);
  await scalar('select collect_order_tender($1,$2,$3,20,0,$4,1000,null,null)',[randomUUID(),order,'CASH_USD','USD']);
  expect(Number(await scalar('select sum(value_ves) from payments where order_id=$1',[order]))).toBe(17000);
  await scalar('select collect_order_tender($1,$2,$3,20000,5,$4,1000,null,null)',[randomUUID(),order,'CASH_VES','USD']);
  await scalar('select close_order($1)',[order]);
  expect(Number(await scalar('select sum(value_ves) from payments where order_id=$1',[order]))).toBe(32000);
  expect(Number(await scalar("select sum(case when direction='IN' then amount_original else -amount_original end) from account_movements where currency='USD'"))).toBe(15);
 });
 it('does not let legacy cancellation, deletion or editing erase a recorded return',async()=>{
  const sale=await quickTender();const payment=await scalar<string>('select payment_id from order_tenders');
  await root();await rejects(()=>db.query('delete from payments where id=$1',[payment]),/documentados/);
  await rejects(()=>db.query("update orders set status='CANCELLED' where id=$1",[sale.order_id]),/auditada/);
  await rejects(()=>db.exec('update account_movements set amount_original=1 where tender_id is not null'),/auditada/);
 });
 it('restricts the scheduler and enforces device ownership and daily delivery claims',async()=>{
  await rejects(()=>scalar('select finance_push_digest($1)',[owner]),/permission denied/);
  await rejects(()=>scalar('select finance_push_refresh()'),/permission denied/);
  const subscription=await scalar<string>("insert into finance_push_subscriptions(endpoint,p256dh,auth) values('https://fcm.googleapis.com/test','test','test') returning id");
  await asUser(operator);expect(Number(await scalar('select count(*) from finance_push_subscriptions'))).toBe(0);
  await root();await db.exec('set role service_role');
  expect((await scalar<{role:string}>('select finance_push_digest($1)',[operator])).role).toBe('OPERATOR');
  expect(await scalar('select finance_push_claim($1,timezone($2,now())::date)',[subscription,'America/Caracas'])).toBe(true);
  expect(await scalar('select finance_push_claim($1,timezone($2,now())::date)',[subscription,'America/Caracas'])).toBe(false);
 });
 it('simulates a month of sales across all payment methods without counting change as revenue',async()=>{
  await root();await db.exec("insert into financial_accounts(code,name,currency,account_type) values('BNC','BNC','VES','BANK')");await asUser();
  const methods=['CASH_USD','CASH_VES','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE'];
  let cashUsd=0,cashVes=0;
  for(let day=1;day<=30;day++){
   const method=methods[(day-1)%methods.length],currency=['CASH_USD','ZELLE','BINANCE'].includes(method)?'USD':'VES';
   const cash=method.startsWith('CASH');
   const received=cash?(currency==='USD'?50:40000):(currency==='USD'?40:32000);
   await scalar('select quick_sale_with_tender($1,$2::jsonb,$3,$4,$8,$5,$9,$6,null,$7,40)',[randomUUID(),tenderItems,method,received,'USD',method.startsWith('TRANSFER')?String(1000+day):null,`2026-09-${String(day).padStart(2,'0')}T12:00:00-04:00`,cash?10:0,currency==='VES'?800:900]);
   if(method==='CASH_USD')cashUsd+=50;
   if(method==='CASH_VES')cashVes+=40000;
   if(cash)cashUsd-=10;
  }
  expect(Number(await scalar('select count(*) from orders where status=$1',['CLOSED']))).toBe(30);
  expect(Number(await scalar('select sum(agreed_usd) from order_items'))).toBe(1200);
  expect(Number(await scalar('select sum(change_usd-returned_usd) from order_tenders'))).toBe(0);
  expect(Number(await scalar("select coalesce(sum(case when direction='IN' then amount_original else -amount_original end),0) from account_movements where account_id=$1",[usd]))).toBe(cashUsd);
  expect(Number(await scalar("select coalesce(sum(case when direction='IN' then amount_original else -amount_original end),0) from account_movements where account_id=$1",[ves]))).toBe(cashVes);
  await quickTender(50,0,'USD',900,'CASH_USD','Cliente por devolver');
  const history=await scalar<{total:number;pending_usd:number;rows:{change_usd:number;returned_usd:number}[]}>('select order_change_history(null,0)');
  expect(history.total).toBe(31);expect(Number(history.pending_usd)).toBe(10);
  expect(history.rows).toHaveLength(20);expect(Number(history.rows[0].change_usd)-Number(history.rows[0].returned_usd)).toBe(10);
  const page2=await scalar<{pending_usd:number}>('select order_change_history(null,20)');expect(Number(page2.pending_usd)).toBe(10);
 });
});

describe('Exact BCV and normal digital payments',()=>{
 it('preserves all six BCV digits when charging a 40 REF product',async()=>{
  await root();await db.exec("insert into exchange_rates(rate_type,value,effective_at) values('BCV',860.1753,now())");await asUser();
  const o=await scalar<string>('select order_id from build_quick_sale_order($1::jsonb)',[tenderItems]);
  expect(Number(await scalar('select sum(charged_ves_amount) from order_items where order_id=$1',[o]))).toBe(34407.01);
  await scalar("select collect_order_tender($1,$2,'TRANSFER_BDV',34407.01,0,'USD',860.1753,'1234',null)",[randomUUID(),o]);
  await scalar('select close_order($1)',[o]);expect(await scalar('select status from orders where id=$1',[o])).toBe('CLOSED');
 });
 it('does not manufacture physical change for a digital overpayment',async()=>{
  await rejects(()=>quickTender(50,10,'USD',900,'ZELLE'),/digital supera/);
  expect(Number(await scalar('select count(*) from payments'))).toBe(0);
  await quickTender(40,0,'USD',900,'ZELLE');
  expect(Number(await scalar('select coalesce(sum(amount_original),0) from account_movements where account_id=$1',[usd]))).toBe(0);
  expect(Number(await scalar('select count(*) from order_change_returns'))).toBe(0);
 });
 it('rejects an operative or negotiated Bs rate for a USD-priced sale',async()=>{
  await rejects(()=>quickTender(34000,0,'USD',850,'CASH_VES'),/BCV completa/);
  expect(Number(await scalar('select count(*) from orders'))).toBe(0);
 });
});

describe('Finance Core database invariants',()=>{
 it('isolates operator, admin and owner permissions in SQL',async()=>{
  await asUser(operator);expect(await scalar('select public.finance_role()')).toBe('OPERATOR');
  await rejects(()=>ingest([row()]),/administrador/);expect(await scalar('select count(*)::int from external_sources')).toBe(0);
  await rejects(()=>db.exec("insert into external_transactions(source_id) values(null)"),/permission denied/);
  await asUser(admin);await ingest([row()]);await rejects(()=>scalar("select public.finance_configure('MEMBERSHIP',$1)",[JSON.stringify({user_id:operator,role:'ADMIN'})]),/administrador/);
 });
 it('keeps imports and reimports separate from cash, payments and revenue',async()=>{
  const before=await scalar('select count(*)::int from account_movements');const b=await ingest([row()]);expect(await ingest([row()])).toBe(b);
  expect(await scalar('select count(*)::int from external_transactions')).toBe(1);expect(await scalar('select count(*)::int from account_movements')).toBe(before);
  expect(await scalar('select count(*)::int from payments')).toBe(0);expect(await scalar('select count(*)::int from orders')).toBe(0);
 });
 it('accepts mixed Cashea accounts and currencies while preserving each row as evidence',async()=>{
  await ingest([
   row(1,'8000',{external_order:'888888',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Cuenta A',installments:[1]}),
   row(2,'10',{currency:'USD',external_order:'888889',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Cuenta B',installments:[1]})
  ],'CASHEA_TRANSACTIONS');
  expect(await scalar('select count(*)::int from external_transactions')).toBe(2);
  expect(await scalar("select count(distinct provider_account)::int from external_transactions")).toBe(2);
  expect(await scalar("select count(distinct currency)::int from external_transactions")).toBe(2);
  expect(await scalar("select count(*)::int from external_transactions where ownership_status='UNRESOLVED'")).toBe(2);
 });
 it('does not expose financial import evidence through the legacy audit log to operators',async()=>{await ingest([row()]);expect(Number(await scalar("select count(*)::int from audit_events where event_type like 'finance.%'"))).toBeGreaterThan(0);await asUser(operator);expect(await scalar("select count(*)::int from audit_events where event_type like 'finance.%'")).toBe(0);await root();await rejects(()=>db.exec("delete from audit_events where event_type like 'finance.%'"),/inmutable/);});
 it('keeps a continuing exception open without filling the audit trail on refresh',async()=>{
  await ingest([row()]);await scalar('select finance_reconcile()');
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='UNMATCHED' and status='OPEN'")).toBe(1);
  const history=await scalar("select count(*)::int from audit_events where entity_type='reconciliation_cases'");
  await scalar('select finance_reconcile()');
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='UNMATCHED' and status='OPEN'")).toBe(1);
  expect(await scalar("select count(*)::int from audit_events where entity_type='reconciliation_cases'")).toBe(history);
 });
 it('records an explicitly classified bank outflow once and links it atomically',async()=>{await ingest([row(1,'14',{direction:'OUT',description:'COMISION PAGOMOVILBDV'})]);const x=await tx();await scalar("select finance_resolve('CLASSIFY',$1,$2)",[x,JSON.stringify({nature:'BANK_FEE',category:'Comisiones',reason:'Verified bank commission'})]);const id=await scalar('select finance_record_external_outflow($1,$2)',[x,'Verified no prior internal record']);expect(await scalar('select finance_record_external_outflow($1,$2)',[x,'Retry after connection timeout'])).toBe(id);expect(await scalar('select count(*)::int from account_movements')).toBe(1);expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(1);});
 it('resolves an unknown internal outflow without recording money twice',async()=>{const id=await scalar<string>('select finance_outflow($1,$2,10,$3,null,null,null,$4,$5)',[randomUUID(),bank,'UNCLASSIFIED','1234','2026-09-10']);await scalar("select finance_resolve('CLASSIFY_MOVEMENT',$1,$2)",[id,JSON.stringify({nature:'ASSET_PURCHASE',reason:'Purchase of business equipment'})]);expect(await scalar('select count(*)::int from account_movements')).toBe(1);expect(await scalar('select movement_type from account_movements')).toBe('ADJUSTMENT');expect(await scalar("select status from reconciliation_cases where kind='OUTFLOW_NATURE'")).toBe('RESOLVED');});
 it('deduplicates overlapping batches without dropping their provenance',async()=>{
  await ingest([row()]);await scalar('select public.finance_import($1,$2,$3,$4,$5)',[source,'next week','2026-09-05','2026-09-15',JSON.stringify(preview([row()]))]);
  expect(await scalar('select count(*)::int from external_transactions')).toBe(1);expect(await scalar('select count(*)::int from external_batch_transactions')).toBe(2);
 });
 it('supports many-to-many allocations and prevents capacity overrun on BOTH ends',async()=>{
  await ingest([row(1,'60'),row(2,'40')]);const ids=(await db.query<{id:string}>('select id from external_transactions order by reference')).rows.map(x=>x.id);
  const a=await movement('50'),b=await movement('50','1002');await allocate(ids[0],a,null,'30');await allocate(ids[0],b,null,'30');await allocate(ids[1],a,null,'20');await allocate(ids[1],b,null,'20');
  expect(await scalar('select sum(external_amount)::text from reconciliation_allocations')).toBe('100.00000000');
  await rejects(()=>allocate(ids[0],a,null,'1'),/excede|suficiente/);
 });
 it('treats idempotency key reuse with changed inputs as an error',async()=>{await ingest([row()]);const m=await movement();const request=randomUUID(),x=await tx();const a=await allocate(x,m,null,'60','60','EXACT',request);expect(await allocate(x,m,null,'60','60','EXACT',request)).toBe(a);await rejects(()=>allocate(x,m,null,'50','50','EXACT',request),/otros datos/);});
 it('reverses with audit and never silently deletes an allocation',async()=>{await ingest([row()]);const m=await movement(),x=await tx(),id=await allocate(x,m,null,'100');await scalar("select public.finance_resolve('REVERSE_ALLOCATION',$1,$2)",[id,JSON.stringify({reason:'Referencia equivocada'})]);await allocate(x,m,null,'100');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(2);expect(await scalar("select count(*)::int from audit_events where entity_type='reconciliation_allocations'")).toBe(3);});
 it('requires an audited reversal before changing an allocated bank movement or Cashea amount',async()=>{
  await ingest([row()]);const m=await movement(),x=await tx(),allocation=await allocate(x,m,null,'100');
  await root();
  await rejects(()=>db.query('update account_movements set amount_original=90 where id=$1',[m]),/conciliaciones activas/);
  await rejects(()=>db.query("update account_movements set reference='9999' where id=$1",[m]),/conciliaciones activas/);
  await asUser();
  await scalar("select finance_resolve('REVERSE_ALLOCATION',$1,$2)",[allocation,JSON.stringify({reason:'Se corrige el importe original'})]);
  await root();await db.query('update account_movements set amount_original=90 where id=$1',[m]);await asUser();
  expect(Number(await scalar('select amount_original from account_movements where id=$1',[m]))).toBe(90);

  const {sale,installments}=await seedCashea('999777');
  await ingest([row(2,'8000',{external_order:'999777',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]})],'CASHEA_TRANSACTIONS');
  const installmentTx=await scalar<string>("select id from external_transactions where external_order='999777'");
  const installmentAllocation=await allocate(installmentTx,null,installments[0],'10');
  await root();await rejects(()=>db.query('update cashea_installments set amount_ref=9 where id=$1',[installments[0]]),/conciliaciones activas/);await asUser();
  await scalar("select finance_resolve('REVERSE_ALLOCATION',$1,$2)",[installmentAllocation,JSON.stringify({reason:'Cuota corregida según soporte'})]);
  await root();await db.query('update cashea_installments set amount_ref=9 where id=$1',[installments[0]]);await asUser();

  await ingest([row(3,'16000',{external_order:'999777',amount_ref:'20',assigned_ref:'20',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[0]})],'CASHEA_TRANSACTIONS');
  const initialTx=await scalar<string>("select id from external_transactions where external_order='999777' and amount_ref=20");
  const initialAllocation=await scalar<string>("select finance_allocate($1,$2,null,null,20,20,'EXACT','Inicial comprobada',$3)",[randomUUID(),initialTx,sale]);
  await root();await rejects(()=>db.query('update cashea_sales set initial_ref=19 where id=$1',[sale]),/conciliaciones activas/);await asUser();
  await scalar("select finance_resolve('REVERSE_ALLOCATION',$1,$2)",[initialAllocation,JSON.stringify({reason:'Inicial corregida según soporte'})]);
  await root();await db.query('update cashea_sales set initial_ref=19 where id=$1',[sale]);await asUser();
 });
 it('rejects NaN, infinity and currency/account mismatch',async()=>{await ingest([row()]);const m=await movement('100','1001',undefined,usd);await rejects(()=>allocate(awaitNever(),m,null,'NaN'));const x=await tx();await rejects(()=>allocate(x,m,null,'100'),/incompatible/);await rejects(()=>ingest([row(2,'Infinity')]),/inválido/);});
 it('matches unique reference/account/time candidates with bounded rounding',async()=>{await ingest([row(1,'42675')]);await movement('42670');await scalar('select public.finance_reconcile()');expect(await scalar('select difference::text from reconciliation_allocations')).toBe('5.00000000');expect(await scalar('select count(*)::int from account_movements')).toBe(1);});
 it('refuses ambiguous graphs in either direction',async()=>{await ingest([row(1,'100'),row(2,'100',{reference:'1001'})]);await movement();await scalar('select public.finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(0);});
 it('refuses amount-only matching or an excessive relative rounding difference',async()=>{await ingest([row(1,'101')]);await movement('100');await movement('101','9999');await scalar('select public.finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(0);});
 it('does not create missing-payment noise for incomplete coverage',async()=>{await ingest([row()]);await movement('777','7777');await scalar('select public.finance_reconcile()');expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(0);await rejects(()=>scalar('select public.finance_verify_batch($1,$2)',[awaitNever(),JSON.stringify({all_pages:true})]));});
 it('shows missing report coverage even when the exception inbox is empty',async()=>{
  const report=await scalar<{sources:{provider:string;status:string}[]}>('select finance_report_coverage($1,$2)',['2026-09-01','2026-09-30']);
  expect(report.sources.find(s=>s.provider==='BDV')?.status).toBe('MISSING_REPORT');
  expect(report.sources.find(s=>s.provider==='CASHEA_TRANSACTIONS')?.status).toBe('MISSING_REPORT');
  await asUser(operator);
  await rejects(()=>scalar('select finance_report_coverage($1,$2)',['2026-09-01','2026-09-30']),/administrador/);
 });
 it('does not certify the current day before it has ended',async()=>{
  const day=await scalar<string>("select timezone('America/Caracas',now())::date::text");
  await root();await db.query("insert into external_import_batches(source_id,fingerprint,source_name,requested_from,requested_to,status,row_count,controls,payload) values($1,$2,'Synthetic current-day control',$3,$3,'COMPLETE',0,'{\"opening\":\"0\",\"closing\":\"0\"}','{}')",[source,randomUUID(),day]);await asUser();
  const result=await scalar<{sources:{provider:string;status:string}[]}>('select finance_report_coverage($1,$2)',[day,day]);
  expect(result.sources.find(s=>s.provider==='BDV')?.status).toBe('IN_PROGRESS');
 });
 it('paginates all reports and opens an older report without exposing its raw payload',async()=>{
  await root();
  for(let n=1;n<=25;n++)await db.query("insert into external_import_batches(source_id,fingerprint,source_name,requested_from,requested_to,row_count,payload,created_at) values($1,$2,$3,'2026-09-01','2026-09-30',0,'{}',now()-$4::integer*interval '1 minute')",[source,randomUUID(),`Extract ${n}`,n]);
  await asUser();
  const first=await scalar<{total:number;batches:{id:string}[]}>('select finance_batches($1,$2,$3)',['2026-09-01','2026-09-30',0]);
  const next=await scalar<{total:number;batches:{id:string}[]}>('select finance_batches($1,$2,$3)',['2026-09-01','2026-09-30',20]);
  expect(first.total).toBe(25);expect(first.batches).toHaveLength(20);expect(next.batches).toHaveLength(5);
  expect(new Set([...first.batches,...next.batches].map(x=>x.id)).size).toBe(25);
  const detail=await scalar<Record<string,unknown>>('select finance_batch($1)',[next.batches[0].id]);
  expect(detail.id).toBe(next.batches[0].id);expect(detail.payload).toBeUndefined();
  await asUser(operator);await rejects(()=>scalar('select finance_batch($1)',[next.batches[0].id]),/administrador/);
 });
 it('keeps the unverified 40 of a 100 bank receipt after allocating 60',async()=>{
  const batch=await ingest([row(1,'60',{balance:'60'})]);
  const m=await movement('100','1001');const x=await tx();
  await allocate(x,m,null,'60');
  await scalar('select finance_verify_batch($1,$2)',[batch,JSON.stringify({from:'2026-09-01',to:'2026-09-30',all_pages:true,evidence:'Independent bank statement control',expected_count:1,expected_total:'60',opening:'0',closing:'60'})]);
  await scalar('select finance_reconcile()');
  const evidence=await scalar<{remaining:number;matched:number}>("select evidence from reconciliation_cases where kind='MISSING_EXTERNAL' and subject_id=$1 and status='OPEN'",[m]);
  expect(Number(evidence.remaining)).toBe(40);expect(Number(evidence.matched)).toBe(60);
  const id=await scalar<string>("select id from reconciliation_cases where kind='MISSING_EXTERNAL' and subject_id=$1",[m]);
  await ingest([row(2,'40',{reference:'1001',balance:'100'})]);
  const y=await scalar<string>("select id from external_transactions where reference='1001' and amount=40");
  await allocate(y,m,null,'40');await scalar('select finance_reconcile()');
  expect(await scalar<string>('select status from reconciliation_cases where id=$1',[id])).toBe('RESOLVED');
  expect(await scalar('select count(*)::int from account_movements')).toBe(1);
  await scalar('select finance_resolve($1,$2,$3)', ['REVERSE_ALLOCATION',await scalar<string>("select id from reconciliation_allocations where external_transaction_id=$1 and reversed_at is null",[y]),JSON.stringify({reason:'Bank receipt reference rechecked'})]);
  await scalar('select finance_reconcile()');
  expect(Number((await scalar<{remaining:number}>("select evidence from reconciliation_cases where id=$1 and status='OPEN'",[id])).remaining)).toBe(40);
 });
 it('joins adjacent verified bank extracts but does not trust a balance discontinuity',async()=>{
  const first=await scalar<string>('select finance_import($1,$2,$3,$4,$5::jsonb)',[source,'First extract','2026-09-08','2026-09-10',JSON.stringify(preview([row(1,'60',{balance:'60'})]))]);
  const movementId=await movement('100','1001');
  await scalar('select finance_verify_batch($1,$2)',[first,JSON.stringify({from:'2026-09-08',to:'2026-09-10',all_pages:true,evidence:'Independent first statement control',expected_count:1,expected_total:'60',opening:'0',closing:'60'})]);
  await scalar('select finance_reconcile()');
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(0);
  const second=await scalar<string>('select finance_import($1,$2,$3,$4,$5::jsonb)',[source,'Next extract','2026-09-11','2026-09-13',JSON.stringify(preview([row(2,'40',{occurred_at:'2026-09-11T12:02:00-04:00',balance:'100'})]))]);
  await scalar('select finance_verify_batch($1,$2)',[second,JSON.stringify({from:'2026-09-11',to:'2026-09-13',all_pages:true,evidence:'Independent second statement control',expected_count:1,expected_total:'40',opening:'60',closing:'100'})]);
  expect(await scalar<boolean>('select lubricenter_private.finance_bdv_window_covered($1,$2)',[bank,'2026-09-10T12:01:00-04:00'])).toBe(true);
  const covered=await scalar<{sources:{provider:string;status:string}[]}>('select finance_report_coverage($1,$2)',['2026-09-08','2026-09-13']);
  expect(covered.sources.find(s=>s.provider==='BDV')?.status).toBe('COVERAGE_VERIFIED');
  await scalar('select finance_reconcile()');
  expect(Number((await scalar<{remaining:number}>("select evidence from reconciliation_cases where kind='MISSING_EXTERNAL' and subject_id=$1 and status='OPEN'",[movementId])).remaining)).toBe(100);
  await root();await db.query("update external_import_batches set controls=controls||'{\"opening\":\"59\"}'::jsonb where id=$1",[second]);await asUser();
  expect(await scalar<boolean>('select lubricenter_private.finance_bdv_window_covered($1,$2)',[bank,'2026-09-10T12:01:00-04:00'])).toBe(false);
  const conflicted=await scalar<{sources:{provider:string;status:string}[]}>('select finance_report_coverage($1,$2)',['2026-09-08','2026-09-13']);
  expect(conflicted.sources.find(s=>s.provider==='BDV')?.status).toBe('BALANCE_CONFLICT');
  await scalar('select finance_reconcile()');
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(0);
 });
 it('never labels contradictory Cashea reports as verified coverage',async()=>{
  const firstRow=row(1,'8000',{external_order:'888888',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]});
  const first=await ingest([firstRow],'CASHEA_TRANSACTIONS');
  await scalar('select finance_verify_batch($1,$2)',[first,JSON.stringify({
   from:'2026-09-01',to:'2026-09-30',all_pages:true,
   evidence:'Independent Cashea export control',expected_count:1,expected_total:'10'
  })]);
  const before=await scalar<{sources:{provider:string;status:string}[]}>('select finance_report_coverage($1,$2)',['2026-09-01','2026-09-29']);
  expect(before.sources.find(s=>s.provider==='CASHEA_TRANSACTIONS')?.status).toBe('COVERAGE_VERIFIED');
  await ingest([{...firstRow,external_order:'999999'}],'CASHEA_TRANSACTIONS');
  const after=await scalar<{sources:{provider:string;status:string;source_conflicts:number}[]}>('select finance_report_coverage($1,$2)',['2026-09-01','2026-09-29']);
  expect(after.sources.find(s=>s.provider==='CASHEA_TRANSACTIONS')?.status).toBe('SOURCE_CONFLICT');
  expect(Number(after.sources.find(s=>s.provider==='CASHEA_TRANSACTIONS')?.source_conflicts)).toBe(1);
  expect(await scalar('select count(*)::int from external_transactions')).toBe(1);
 });
 it('requires independent controls, recomputes balance chain, and rejects bad completeness',async()=>{
  const p=parseBdv('10-09-2026 - 12:01\n1001\nTEST\nCREDITO\n100,00\n150,00');const b=await scalar<string>('select finance_import($1,$2,$3,$4,$5)',[source,'test','2026-09-01','2026-09-30',JSON.stringify(p)]);
  const controls={from:'2026-09-01',to:'2026-09-30',all_pages:true,evidence:'Official independent control',expected_count:1,expected_total:'100',opening:'50',closing:'150'};
  await rejects(()=>scalar('select finance_verify_batch($1,$2)',[b,JSON.stringify({...controls,expected_count:2})]),/Cantidad/);
  await scalar('select finance_verify_batch($1,$2)',[b,JSON.stringify(controls)]);expect(await scalar('select status from external_import_batches')).toBe('COMPLETE');
 });
 it('requires references for new bank payments and Cashea, but not cash',async()=>{
  await root();const order=await scalar<string>('insert into orders default values returning id');await asUser();
  await rejects(()=>scalar("select add_payment($1,'TRANSFER_BDV',10,null)",[order]),/referencia/);
  await scalar("select add_payment($1,'CASH_USD',1,null)",[order]);expect(await scalar('select count(*)::int from payments')).toBe(1);
 });
 it('keeps unresolved and other-location Cashea out of internal collections',async()=>{await ingest([row(1,'8000',{external_order:'888888',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]})],'CASHEA_TRANSACTIONS');expect(await scalar('select ownership_status from external_transactions')).toBe('UNRESOLVED');await scalar('select finance_reconcile()');const x=await tx();await scalar("select finance_resolve('OWNERSHIP',$1,$2)",[x,JSON.stringify({status:'OTHER_LOCATION',reason:'Comprobado: otro local'})]);await scalar('select finance_reconcile()');expect(await scalar('select count(*)::int from payments')).toBe(0);expect(await scalar("select count(*)::int from reconciliation_cases where kind='OWNERSHIP' and status='OPEN'")).toBe(0);});
 it('forces real cash counts, permits zero, closes with variances without posting adjustments',async()=>{
  await scalar('select finance_cash_activate($1,100,$2)',[usd,'Opening physical count']);await scalar('select finance_cash_activate($1,0,$2)',[ves,'Opening physical count']);const day=await scalar<string>("select timezone('America/Caracas',now())::date::text");
  await rejects(()=>scalar('select close_cash_day($1)',[day]),/cuenta/);
  await scalar('select save_cash_count($1,$2,98)',[day,usd]);await rejects(()=>scalar('select close_cash_day($1)',[day]),/Falta/);
  await scalar('select save_cash_count($1,$2,0)',[day,ves]);await scalar('select close_cash_day($1)',[day]);
  expect(await scalar('select count(*)::int from account_movements')).toBe(0);expect(await scalar("select count(*)::int from reconciliation_cases where kind='CASH_VARIANCE'")).toBe(1);
 });
 it('reviews only the first physical count after a backdated cash movement or corrected count',async()=>{
  await scalar('select finance_cash_activate($1,0,$2)',[usd,'Initial physical USD count']);
  await scalar('select finance_cash_activate($1,0,$2)',[ves,'Initial physical Bs count']);
  const days=await scalar<string[]>("select array_agg((timezone('America/Caracas',now())::date-n)::text order by n desc) from generate_series(1,3) n");
  await root();
  await db.query("update finance_cash_openings set effective_at=($1::date-1)::timestamp at time zone 'America/Caracas'",[days[0]]);
  await asUser();
  for (const day of days) {
   await scalar('select save_cash_count($1,$2,0)',[day,usd]);
   await scalar('select save_cash_count($1,$2,0)',[day,ves]);
   await scalar('select close_cash_day($1)',[day]);
  }
  await root();
  await db.query("insert into account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,occurred_at) values($1,'IN','ADJUSTMENT','USD',5,500,$2::date+interval '12 hours')",[usd,days[1]]);
  await asUser();
  const afterMovement=await db.query<{business_date:string;status:string}>("select business_date::text,status from cash_closings where finance_version=22 order by business_date");
  expect(afterMovement.rows.map(r=>r.status)).toEqual(['CLOSED','REVIEW','CLOSED']);
  await root();
  await db.query("update cash_closing_accounts set actual_native=1 where cash_closing_id=(select id from cash_closings where business_date=$1::date) and account_id=$2",[days[0],usd]);
  await asUser();
  const afterRecount=await db.query<{business_date:string;status:string}>("select business_date::text,status from cash_closings where finance_version=22 order by business_date");
  expect(afterRecount.rows.map(r=>r.status)).toEqual(['CLOSED','REVIEW','CLOSED']);
 });
 it('lists only active cash days without a closing, with stable paginated tasks',async()=>{
  expect((await scalar<{status:string}>('select finance_cash_due()')).status).toBe('NEEDS_OPENING');
  await scalar('select finance_cash_activate($1,0,$2)',[usd,'Initial physical USD count']);
  await scalar('select finance_cash_activate($1,0,$2)',[ves,'Initial physical Bs count']);
  await root();
  await db.exec("update finance_cash_openings set effective_at=(timezone('America/Caracas',now())::date-23)::timestamp at time zone 'America/Caracas'");
  await db.query(`insert into account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,occurred_at)
   select $1,'IN','ADJUSTMENT','USD',1,100,
    (timezone('America/Caracas',now())::date-n)::timestamp at time zone 'America/Caracas'+interval '12 hours'
   from generate_series(1,22) n`,[usd]);
  await asUser();
  const first=await scalar<{total:number;tasks:CashTaskFixture[]}>('select finance_cash_due()');
  expect(first.total).toBe(22);expect(first.tasks).toHaveLength(20);
  const second=await scalar<{total:number;tasks:CashTaskFixture[]}>('select finance_cash_due(20)');
  expect(second.total).toBe(22);expect(second.tasks).toHaveLength(2);
  expect(new Set([...first.tasks,...second.tasks].map(t=>t.task_key)).size).toBe(22);
  const auditBefore=await scalar('select count(*)::int from audit_events');
  expect((await scalar<{tasks:CashTaskFixture[]}>('select finance_cash_due()')).tasks[0].task_key).toBe(first.tasks[0].task_key);
  expect(await scalar('select count(*)::int from audit_events')).toBe(auditBefore);
  await asUser(operator);
  expect((await scalar<{total:number}>('select finance_cash_due()')).total).toBe(22);
  await rejects(()=>scalar('select finance_inbox()'),/administrador/);
 });
 it('nature distinguishes owner draws/assets from expense and prevents duplicate outflows',async()=>{
  const req=randomUUID();const args=[req,bank,'10','OWNER_DRAW',null,'Owner','Approved withdrawal','1234','2026-09-10'];
  const sql='select finance_outflow($1,$2,$3,$4,$5,$6,$7,$8,$9)';const id=await scalar(sql,args);expect(await scalar(sql,args)).toBe(id);expect(await scalar('select movement_type from account_movements')).toBe('ADJUSTMENT');
  await asUser(operator);await rejects(()=>scalar(sql,[randomUUID(),...args.slice(1)]),/administrador/);
 });
 it('reconciles the initial payment separately from installments without recording another collection',async()=>{
  const {sale}=await seedCashea('999111');await ingest([row(1,'16000',{external_order:'999111',amount_ref:'20',assigned_ref:'20',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[0]})],'CASHEA_TRANSACTIONS');
  await scalar('select finance_reconcile()');expect(await scalar('select cashea_sale_id from reconciliation_allocations')).toBe(sale);expect(await scalar('select count(*)::int from payments')).toBe(0);
 });
 it('preserves sub-cent Cashea report precision as explicit rounding, not hidden quota forgiveness',async()=>{const {installments}=await seedCashea('999444');await root();await db.query('update cashea_installments set amount_ref=9.7733 where id=$1',[installments[0]]);await asUser();await ingest([row(1,'7818.64',{external_order:'999444',amount_ref:'9.77',assigned_ref:'9.7733',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]})],'CASHEA_TRANSACTIONS');await scalar('select finance_reconcile()');expect(await scalar('select difference::text from reconciliation_allocations')).toBe('-0.00330000');expect(await scalar('select method from reconciliation_allocations')).toBe('ROUNDING');expect(await scalar('select paid_ref::text from cashea_installments where id=$1',[installments[0]])).toBe('0');});
 it('supports split/multiquota collections without overpaying installments or changing paid_ref',async()=>{
  const {installments}=await seedCashea('999222');await ingest([row(1,'16000',{external_order:'999222',amount_ref:'20',assigned_ref:'20',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1,2]})],'CASHEA_TRANSACTIONS');
  const x=await tx();await scalar('select finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(0);
  await allocate(x,null,installments[0],'10');await allocate(x,null,installments[1],'10');await rejects(()=>allocate(x,null,installments[2],'1'),/incompatible/);
  expect(await scalar('select sum(paid_ref)::text from cashea_installments')).toBe('0');
 });
 it('detects contradictory latest canceled snapshots even for a manual allocation',async()=>{
  const {installments}=await seedCashea('999333');await ingest([row(1,'8000',{external_order:'999333',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]})],'CASHEA_TRANSACTIONS');
  await root();await db.exec(`insert into cashea_order_snapshots(batch_id,external_order,purchased_on,status,total_ref,initial_ref,installments,raw) select id,'999333','2026-09-01','CANCELLED',50,20,'[]','{}' from external_import_batches limit 1`);await asUser();
  await rejects(()=>allocate(awaitNever(),null,installments[0],'10'));const x=await tx();await rejects(()=>allocate(x,null,installments[0],'10'),/cancelada/);
 });
 it('monthly stress: 168 orders, 84 bank expectations, split/ambiguous/late evidence and Cashea ownership',async()=>{
  const bankRows:ExternalRow[]=[];const targets:string[]=[];let balance=1000000;
  for(let n=0;n<84;n++){
   const amount=n<49?1000+n:n<74?42670+n:n<80?600+n:777;
   const reference=n===80||n===81?'8888':String(10000+n);
   const date=`2026-08-${String(3+Math.floor(n/4)).padStart(2,'0')}T12:${String(n%4).padStart(2,'0')}:00-04:00`;
   targets.push(await movement(String(amount),reference,date));
   if(n>=82)continue;
   const amounts=n>=74&&n<77?[amount/2,amount/2]:[amount+(n>=49&&n<74?5:0)];
   for(const [part,value] of amounts.entries()){
    balance+=value;bankRows.push(row(bankRows.length+1,String(value),{occurred_at:date,reference:n>=77&&n<80?String(90500+n):reference,balance:String(balance),raw:{part}}));
   }
  }
  for(let n=0;n<3;n++){balance+=50000;bankRows.push(row(bankRows.length+1,'50000',{occurred_at:`2026-08-25T12:0${n}:00-04:00`,reference:String(50000+n),balance:String(balance)}));}
  for(let n=0;n<54;n++){balance-=10+n;bankRows.push(row(bankRows.length+1,String(10+n),{occurred_at:`2026-08-${n<30?'26':'27'}T12:${String(n%30).padStart(2,'0')}:00-04:00`,reference:String(40000+n),balance:String(balance),direction:'OUT',description:n<12?'COMISION PAGOMOVILBDV':n<21?'MOVISTAR PREPAGO':n<25?'TRASPASO OTRAS CUENTAS':'EGRESO SIN IDENTIFICAR'}));}
  const p=preview(bankRows);const b=await scalar<string>('select finance_import($1,$2,$3,$4,$5)',[source,'Month stress','2026-08-01','2026-08-30',JSON.stringify(p)]);
  await scalar('select finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(74);
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(0);
  await scalar('select finance_verify_batch($1,$2)',[b,JSON.stringify({from:'2026-08-01',to:'2026-08-30',all_pages:true,evidence:'Independent month fixture controls',expected_count:bankRows.length,expected_total:bankRows.reduce((n,x)=>n+Number(x.amount),0),opening:1000000,closing:balance})]);
  await scalar('select finance_reconcile()');expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(10);
  for(let n=74;n<77;n++){const xs=(await db.query<{id:string,amount:string}>('select id,amount::text from external_transactions where reference=$1',[String(10000+n)])).rows;for(const x of xs)await allocate(x.id,targets[n],null,x.amount);}
  const saleRefs:string[]=[];for(let n=0;n<36;n++){await seedCashea(String(700000+n));saleRefs.push(String(700000+n));}
  const cr:ExternalRow[]=[];for(let n=0;n<48;n++)cr.push(row(n+1,n<3?'4000':'8000',{occurred_at:`2026-08-${String(1+Math.floor(n/2)).padStart(2,'0')}T13:${String(n%2).padStart(2,'0')}:00-04:00`,external_order:saleRefs[Math.floor(n/2)],installments:[1+n%2],provider_account:'Shared',amount_ref:n<3?'5':'10',assigned_ref:n<3?'5':'10',rate:'800',rate_date:'2026-08-01'}));
  for(let n=0;n<36;n++)cr.push(row(49+n,'8000',{occurred_at:`2026-08-28T13:${String(n).padStart(2,'0')}:00-04:00`,external_order:String(990000+n),installments:[1],provider_account:'Shared',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-08-01'}));
  await scalar('select finance_import($1,$2,$3,$4,$5)',[cashea,'Cashea month','2026-08-01','2026-08-30',JSON.stringify(preview(cr,'CASHEA_TRANSACTIONS'))]);
  const others=(await db.query<{id:string}>("select id from external_transactions where external_order::bigint>=990000 order by external_order limit 28")).rows;
  for(const x of others)await scalar("select finance_resolve('OWNERSHIP',$1,$2)",[x.id,JSON.stringify({status:'OTHER_LOCATION',reason:'Evidence for another location'})]);
  await scalar('select finance_reconcile()');
  expect(await scalar("select count(*)::int from external_transactions where ownership_status='UNRESOLVED'")).toBe(8);
  expect(await scalar('select count(*)::int from reconciliation_allocations where cashea_installment_id is not null')).toBe(48);
  await root();await db.exec("insert into orders(status,total_ref,total_ves,closed_at) select 'CLOSED',25,20000,'2026-08-15' from generate_series(1,132)");await asUser();
  expect(await scalar('select count(*)::int from orders')).toBe(168);
  const before=await scalar('select sum(total_ref)::text from orders');await scalar('select finance_reconcile()');await scalar('select finance_import($1,$2,$3,$4,$5)',[source,'Month stress','2026-08-01','2026-08-30',JSON.stringify(p)]);
  expect(await scalar('select sum(total_ref)::text from orders')).toBe(before);expect(await scalar('select count(*)::int from account_movements')).toBe(84);
  expect(await scalar('select count(*)::int from payments')).toBe(0);
  expect(await scalar('select count(*)::int from reconciliation_allocations where reversed_at is null')).toBe(128);
  await root();await db.exec(`insert into finance_cash_openings(account_id,effective_at,amount,reason) values('${usd}','2026-08-01T00:00:00-04:00',100,'Fixture opening count'),('${ves}','2026-08-01T00:00:00-04:00',10000,'Fixture opening count')`);await asUser();
  for(let n=1;n<=30;n++){
   if([5,17].includes(n))continue;const day=`2026-08-${String(n).padStart(2,'0')}`;
   const d=await scalar<{accounts:{id:string;expected_native:number}[]}>('select cash_close_dashboard($1)',[day]);
   for(const a of d.accounts)await scalar('select save_cash_count($1,$2,$3)',[day,a.id,Number(a.expected_native)-(a.id===usd&&[4,12,20,27].includes(n)?2:0)]);
   await scalar('select close_cash_day($1)',[day]);
  }
  expect(await scalar("select count(*)::int from cash_closings where status='CLOSED'")).toBe(28);
  expect(await scalar("select count(*)::int from reconciliation_cases where kind='CASH_VARIANCE' and status='OPEN'")).toBe(4);
  // A bank movement does not invalidate physical counts; a backdated cash movement invalidates later affected counts.
  await movement('1','8881','2026-08-10T12:00:00-04:00');expect(await scalar("select count(*)::int from cash_closings where status='REVIEW'")).toBe(0);
  await movement('1','8882','2026-08-10T12:00:00-04:00',usd);expect(Number(await scalar("select count(*)::int from cash_closings where status='REVIEW'"))).toBeGreaterThan(0);
 },120000);
});
function awaitNever(){return '00000000-0000-0000-0000-000000000000';}

describe('Cashea merchant balance',()=>{
 it('records the real 4% invoice without inventing a deduction, payment or cash movement',async()=>{
  const request=randomUUID();
  const args=[request,'2026-08-01','2026-08-31','TEST-FEE-001','10468.45','4','418.74','67','0','Factura de prueba y servicio prestado'];
  const statement=await scalar<string>('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args);
  expect(await scalar<string>('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args)).toBe(statement);
  expect(await scalar<string>('select total_deduct_ref::text from cashea_merchant_statements where id=$1',[statement])).toBe('485.74');
  expect(await scalar('select count(*)::int from cashea_balance_events')).toBe(0);
  expect(await scalar('select count(*)::int from payments')).toBe(0);
  expect(await scalar('select count(*)::int from account_movements')).toBe(0);
  const variance=await scalar<string>('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),'2026-07-01','2026-07-31','variance','10468.45','4','400','67','0','Reported fee mismatch']);
  expect(await scalar('select count(*)::int from reconciliation_cases where subject_id=$1 and kind=$2 and status=$3',[variance,'CASHEA_SERVICE_VARIANCE','OPEN'])).toBe(1);
  await scalar('select finance_cashea_reverse($1,$2,$3)',['STATEMENT',variance,'Replaced source invoice']);
  const deductionRequest=randomUUID();
  const deduction=[deductionRequest,'SERVICE_DEDUCTION','2026-09-07','485.74','TEST-FEE-001','Balance comercial de agosto',statement,null];
  const deductionId=await scalar<string>('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',deduction);
  expect(await scalar<string>('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',deduction)).toBe(deductionId);
  await rejects(()=>scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'SERVICE_DEDUCTION','2026-09-07','480','other','Wrong deduction',statement,null]),/factura/);
  expect(await scalar<string>('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'PAYOUT','2026-09-09','398.39','TEST-TRANSFER','Comprobante de pago agosto',null,null])).toBeTruthy();
  expect(await scalar('select count(*)::int from payments')).toBe(0);
  expect(await scalar('select count(*)::int from account_movements')).toBe(0);
  expect(await scalar('select count(*)::int from cashea_balance_events')).toBe(2);
  await rejects(()=>scalar('select finance_cashea_reverse($1,$2,$3)',['STATEMENT',statement,'Wrong invoice']),/Revierte primero/);
  await scalar('select finance_cashea_reverse($1,$2,$3)',['EVENT',deductionId,'Balance entry corrected']);
  await scalar('select finance_cashea_reverse($1,$2,$3)',['STATEMENT',statement,'Invoice correction']);
  expect(await scalar('select count(*)::int from cashea_merchant_statements where voided_at is null')).toBe(0);
  expect(await scalar('select count(*)::int from reconciliation_cases where kind=$1 and status=$2',['CASHEA_SERVICE_VARIANCE','OPEN'])).toBe(0);
  expect(await scalar('select count(*)::int from cashea_balance_events where reversed_at is null')).toBe(1);
 });
 it('keeps merchant balance private and requires owner for openings',async()=>{
  await asUser(operator);
  await rejects(()=>scalar('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),'2026-08-01','2026-08-31','TEST-FEE-001','10468.45','4','418.74','67','0','Verified invoice']),/administrador/);
  expect(await scalar('select count(*)::int from cashea_merchant_statements')).toBe(0);
  await asUser(admin);
  await rejects(()=>scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'OPENING_CREDIT','2026-08-01','10','opening','Documented opening',null,null]),/administrador/);
  await asUser(owner);
  expect(await scalar<string>('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'OPENING_CREDIT','2026-08-01','10','opening','Documented opening',null,null])).toBeTruthy();
 });
 it('calculates the full ledger after its opening and keeps earlier history outside the anchored balance',async()=>{
  await root();
  await db.exec("insert into cashea_balance_events(request_id,kind,occurred_on,amount_ref,reference,evidence,created_by) select gen_random_uuid(),'COVERAGE_CREDIT','2026-08-02',1,'credit-'||n,'Synthetic balance history','"+owner+"' from generate_series(1,250) n");
  await asUser();
  await scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'PAYOUT','2026-07-31','20','older-payout','Before opening evidence',null,null]);
  await scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'OPENING_CREDIT','2026-08-01','100','opening','Start of day opening',null,null]);
  const summary=await scalar<{recorded_net:string;events_total:number;opening_on:string}>('select finance_cashea_balance_summary()');
  expect(summary.recorded_net).toBe('350.00');expect(summary.events_total).toBe(252);expect(summary.opening_on).toBe('2026-08-01');
  await rejects(()=>scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'OPENING_DEBIT','2026-08-01','10','opening-two','Duplicate opening',null,null]),/registro activo/);
 });
 it('rejects altered retries and invalid amounts and preserves service/tax/ownership independently',async()=>{
  const request=randomUUID();const args=[request,'2026-08-01','2026-08-31','TEST-FEE-001','100','4','4','0.64','0','Synthetic service invoice'];
  const s=await scalar<string>('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args);
  await rejects(()=>scalar('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[...args.slice(0,7),'0.65',...args.slice(8)]),/otros datos/);
  await rejects(()=>scalar('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),'2026-07-01','2026-07-31','bad-vat','100','4','4','NaN','0','Invalid VAT']),/inválidos/);
  await rejects(()=>scalar('select finance_cashea_statement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),'2026-07-01','2026-07-31','bad-round','100','4','4.001','0.64','0','Invalid fraction']),/decimales/);
  const charges=await scalar<{service_ref:string;vat_ref:string;total_deduct_ref:string;unattributed:number}>('select finance_cashea_charges($1,$2)',['2026-08-01','2026-08-31']);
  expect(charges).toMatchObject({service_ref:'4.00',vat_ref:'0.64',total_deduct_ref:'4.64',unattributed:1});
  await scalar('select finance_cashea_ownership($1,$2,$3)',[s,'SHARED','Documented multiple locations']);
  expect(await scalar<string>('select ownership_status from cashea_merchant_statements where id=$1',[s])).toBe('SHARED');
  await scalar('select finance_cashea_ownership($1,$2,$3)',[s,'OWN','Confirmed single location statement']);
  expect((await scalar<{unattributed:number}>('select finance_cashea_charges($1,$2)',['2026-08-01','2026-08-31'])).unattributed).toBe(0);
  await asUser(operator);await rejects(()=>scalar('select finance_cashea_balance_summary()'),/administrador/);
 });
 it('does not accept a Cashea customer export as bank proof of a merchant payout',async()=>{
  await seedCashea('777777');
  await ingest([row(1,'8000',{external_order:'777777',amount_ref:'10',assigned_ref:'10',rate:'800',rate_date:'2026-09-10',provider_account:'Shared',installments:[1]})],'CASHEA_TRANSACTIONS');
  const x=await tx();
  await rejects(()=>scalar('select finance_cashea_balance_entry($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),'PAYOUT','2026-09-10','10','1001','Not actual bank evidence',null,x]),/ingreso bancario/);
  expect(await scalar('select count(*)::int from cashea_balance_events')).toBe(0);
 });
});

it('also applies the repository migration order on a fresh database',async()=>{
 const fresh=new PGlite();
 try {
  await fresh.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
  await fresh.exec('set check_function_bodies=on');
  for(const file of readdirSync('supabase/migrations').filter(f=>f.includes('v22')).sort()) await fresh.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260924145617_usd_pricing_payroll_review.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260925103000_finance_cashea_mixed_accounts_usd_quick_sale.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930143615_finance_integrity_residuals.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930151245_finance_report_navigation.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930153613_finance_conflict_visibility.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930154654_finance_allocation_guard.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930155832_finance_cash_anchor_review.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930160819_finance_cash_due_tasks.sql','utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260930175314_cashea_merchant_balance.sql','utf8'));
  expect((await fresh.query("select to_regclass('public.external_import_batches') as batch,to_regclass('public.payroll_work_items') as payroll")).rows[0]).toMatchObject({batch:'external_import_batches',payroll:'payroll_work_items'});
 } finally { await fresh.close(); }
},120000);


describe('Financial task follow-up without changing reconciliation',()=>{
 it('returns an honest empty task view without claiming reconciliation',async()=>{
  const result=await scalar<{total:number;counts:object;rows:unknown[]}>("select finance_tasks('READY',0)");
  expect(result.total).toBe(0);expect(result.counts).toEqual({});expect(result.rows).toEqual([]);
 });
 async function task(){await root();const id=await scalar<string>("insert into reconciliation_cases(case_key,kind,subject_type,subject_id,title,explanation) values('test-followup','SOURCE_CONFLICT','external_transaction',gen_random_uuid(),'Contradiction','Need evidence') returning id");await asUser();return id;}
 it('requires notes, future review and authorized assignee; optimistic versions prevent lost decisions',async()=>{
  const id=await task();await rejects(()=>scalar("select finance_followup($1,1,'WAITING',null,current_date+1,'')",[id]),/nota/);
  await rejects(()=>scalar("select finance_followup($1,1,'WAITING',null,null,'Esperar reporte')",[id]),/cuándo/);
  await rejects(()=>scalar("select finance_followup($1,1,'WAITING',$2,current_date+1,'Esperar reporte')",[id,operator]),/administrador/);
  await scalar("select finance_followup($1,1,'WAITING',$2,current_date+1,'Esperar el reporte completo')",[id,admin]);
  expect(await scalar('select status from reconciliation_cases where id=$1',[id])).toBe('OPEN');
  expect(Number(await scalar('select count(*) from account_movements'))).toBe(0);
  await rejects(()=>scalar("select finance_followup($1,1,'READY',null,null,'Segunda decisión')",[id]),/Otra persona/);
  const result=await scalar<{rows:{id:string;work_note:string}[];total:number}>("select finance_tasks('WAITING',0)");expect(result.total).toBe(1);expect(result.rows[0].work_note).toContain('reporte completo');
  const audit=await scalar<{actor_id:string;data:{after:{work_version:number;work_note:string}}}>("select to_jsonb(a) from audit_events a where entity_type='reconciliation_cases' and entity_id=$1 and data->'after'->>'work_note'='Esperar el reporte completo'",[id]);
  expect(audit.actor_id).toBe(owner);expect(audit.data.after.work_version).toBe(2);
  const before=await scalar('select count(*) from audit_events');await scalar("select finance_tasks('WAITING',0)");await scalar("select finance_tasks('WAITING',0)");expect(await scalar('select count(*) from audit_events')).toBe(before);
 });
 it('makes a deferred task actionable on its review day without falsely resolving it',async()=>{
  const id=await task();await scalar("select finance_followup($1,1,'NEEDS_INFO',null,timezone('America/Caracas',now())::date,'Buscar referencia real')",[id]);
  const result=await scalar<{rows:{id:string;work_status:string}[]}>("select finance_tasks('READY',0)");expect(result.rows[0].id).toBe(id);expect(result.rows[0].work_status).toBe('NEEDS_INFO');
  await asUser(operator);await rejects(()=>scalar("select finance_tasks('READY',0)"),/administrador|autorizado|permiso|Acceso/i);
 });
 it('preserves work notes on reopening the same stable case and distinguishes dismissal from reconciliation',async()=>{
  const id=await task();await scalar("select finance_followup($1,1,'READY',null,null,'Validar con el dueño')",[id]);
  await root();await db.query("update reconciliation_cases set status='RESOLVED' where id=$1",[id]);await asUser();
  await rejects(()=>scalar("select finance_followup($1,2,'READY',null,null,'Intentar sobre cerrado')",[id]),/resuelto/);
  await root();await scalar("select lubricenter_private.finance_case('test-followup','SOURCE_CONFLICT','external_transaction',$1,'Contradiction','New evidence','{}')",[randomUUID()]);await asUser();
  expect(await scalar('select work_note from reconciliation_cases where id=$1',[id])).toBe('Validar con el dueño');
  expect(await scalar('select status from reconciliation_cases where id=$1',[id])).toBe('OPEN');
 });
});

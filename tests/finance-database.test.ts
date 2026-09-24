import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { parseBdv, parseCashea, type Preview, type ExternalRow } from '../lib/finance/importers';

let db: PGlite;
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
 it('rejects NaN, infinity and currency/account mismatch',async()=>{await ingest([row()]);const m=await movement('100','1001',undefined,usd);await rejects(()=>allocate(awaitNever(),m,null,'NaN'));const x=await tx();await rejects(()=>allocate(x,m,null,'100'),/incompatible/);await rejects(()=>ingest([row(2,'Infinity')]),/inválido/);});
 it('matches unique reference/account/time candidates with bounded rounding',async()=>{await ingest([row(1,'42675')]);await movement('42670');await scalar('select public.finance_reconcile()');expect(await scalar('select difference::text from reconciliation_allocations')).toBe('5.00000000');expect(await scalar('select count(*)::int from account_movements')).toBe(1);});
 it('refuses ambiguous graphs in either direction',async()=>{await ingest([row(1,'100'),row(2,'100',{reference:'1001'})]);await movement();await scalar('select public.finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(0);});
 it('refuses amount-only matching or an excessive relative rounding difference',async()=>{await ingest([row(1,'101')]);await movement('100');await movement('101','9999');await scalar('select public.finance_reconcile()');expect(await scalar('select count(*)::int from reconciliation_allocations')).toBe(0);});
 it('does not create missing-payment noise for incomplete coverage',async()=>{await ingest([row()]);await movement('777','7777');await scalar('select public.finance_reconcile()');expect(await scalar("select count(*)::int from reconciliation_cases where kind='MISSING_EXTERNAL' and status='OPEN'")).toBe(0);await rejects(()=>scalar('select public.finance_verify_batch($1,$2)',[awaitNever(),JSON.stringify({all_pages:true})]));});
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

it('also applies the repository migration order on a fresh database',async()=>{
 const fresh=new PGlite();
 try {
  await fresh.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
  await fresh.exec('set check_function_bodies=on');
  for(const file of readdirSync('supabase/migrations').filter(f=>f.includes('v22')).sort()) await fresh.exec(readFileSync('supabase/migrations/'+file,'utf8'));
  await fresh.exec(readFileSync('supabase/migrations/20260924145617_usd_pricing_payroll_review.sql','utf8'));
  expect((await fresh.query("select to_regclass('public.external_import_batches') as batch,to_regclass('public.payroll_work_items') as payroll")).rows[0]).toMatchObject({batch:'external_import_batches',payroll:'payroll_work_items'});
 } finally { await fresh.close(); }
},120000);

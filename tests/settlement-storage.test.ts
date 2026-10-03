import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { quoteCollection } from '../lib/finance/settlement';
let db: PGlite;
const owner = '10000000-0000-0000-0000-000000000001';
const operator = '10000000-0000-0000-0000-000000000002';
async function scalar(sql: string, args: unknown[] = []): Promise<any> {
  return Object.values((await db.query(sql, args)).rows[0] as object)[0];
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
  await db.exec(readFileSync('supabase/migrations/20260924145617_usd_pricing_payroll_review.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260923145542_finance_core_v22.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261001132405_cash_change_phone_alerts.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261002143508_mixed_payment_storage.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261002151056_mixed_payment_quotes.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261002151902_mixed_payment_commit.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261002155430_mixed_payment_pricing.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261003141121_mixed_payment_closure_payroll.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261003144620_mixed_payment_change_bridge.sql', 'utf8'));
  await db.exec(`insert into auth.users values('${owner}','lubricenterc@gmail.com',now()),('${operator}','operator@example.test',now());
    select set_config('request.jwt.claim.sub','${owner}',false);
    insert into employees(code,name) values('CHEO','Cheo');
    insert into financial_accounts(code,name,currency,account_type) values('CASH_USD','Caja USD','USD','CASH'),('CASH_VES','Caja Bs','VES','CASH');
    insert into exchange_rates(rate_type,value,effective_at) values('BCV',100,'2026-01-01'),('OPERATIVE',120,'2026-01-01');`);
}, 120000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });
async function rejects(fn: () => Promise<unknown>, message: RegExp) {
  await db.exec('savepoint rejection');
  let error: any;
  try { await fn(); } catch (e) { error = e; }
  await db.exec('rollback to rejection');
  expect(error?.message).toMatch(message);
}
async function seed(principal = '400', received = '200', basis = 'USD_REF_BCV', method = 'CASH_USD') {
  const order = await scalar('insert into orders(is_walk_in) values(true) returning id');
  const item = await scalar("select add_service_priced($1,'WORKSHOP','Trabajo',400,400,null,false,'REF')", [order]);
  const employee = await scalar("select id from employees where code='CHEO'");
  const agreement = await scalar(`insert into order_price_agreements(order_id,item_id,version,basis,principal,ownership,commission_worker,commission_percent,reason,created_by)
    values($1,$2,1,$6,$3,'SELF',$4,40,'Acuerdo inicial',$5) returning id`, [order, item, principal, employee, owner, basis]);
  const payment = await scalar('select add_payment($1,$2,$3)', [order, method, received]);
  const quote = await scalar(`insert into collection_quotes(order_id,order_revision,effective_at,expires_at,request_payload,calculated_payload,digest,created_by)
    values($1,1,now(),now()+interval '5 minutes','{}','{}','fixture',$2) returning id`, [order, owner]);
  return { order, item, agreement, payment, quote };
}
async function apply(s: Awaited<ReturnType<typeof seed>>, native = '200', covered = '240', reverse?: string) {
  return scalar(`insert into order_payment_applications(order_id,agreement_id,payment_id,quote_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,
      exchange_mode,bcv_rate,acceptance_rate,reason,created_by,direction,reverses_id,commission_amount)
    values($1,$2,$3,$4,'USD',$5,$6,$5,$6::numeric-$5::numeric,'RATE',100,120,'Abono a mano de obra',$7,$8,$9,round($5::numeric*0.4,2)) returning id`,
    [s.order, s.agreement, s.payment, s.quote, native, covered, owner, reverse ? 'REVERSE' : 'APPLY', reverse ?? null]);
}
it('loads additively without migrating historical orders or inserting money', async () => {
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(0);
  expect(await scalar('select count(*)::integer from orders where settlement_version=3')).toBe(0);
  expect(await scalar("select count(*)::integer from pg_class where relname in ('order_price_agreements','collection_quotes','order_payment_applications','order_financing_applications') and relrowsecurity")).toBe(4);
});
it('prevents consuming more money or commercial principal', async () => {
  const s = await seed();
  await apply(s);
  await rejects(() => apply(s, '1', '1.2'), /dinero disponible/);
  const smaller = await seed('100');
  await rejects(() => apply(smaller), /saldo/);
});
it('keeps applications immutable and bounds partial compensation', async () => {
  const s = await seed();
  const original = await apply(s);
  await rejects(() => db.query('update order_payment_applications set native_amount=199 where id=$1', [original]), /inmutable/);
  await rejects(() => db.query('delete from order_payment_applications where id=$1', [original]), /original/);
  await apply(s, '50', '60', original);
  await rejects(() => db.query(`insert into order_payment_applications(order_id,agreement_id,payment_id,quote_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,
    exchange_mode,bcv_rate,acceptance_rate,reason,created_by,direction,reverses_id,commission_amount)
    values($1,$2,$3,$4,'USD',10,12,10,3,'RATE',100,120,'Reversión manipulada',$5,'REVERSE',$6,4)`, [s.order,s.agreement,s.payment,s.quote,owner,original]), /beneficio/);
  await rejects(() => apply(s, '1', '10', original), /proporción/);
  await rejects(() => apply(s, '151', '181.2', original), /original/);
  expect(Number(await scalar("select sum(case when direction='APPLY' then covered_amount else -covered_amount end) from order_payment_applications"))).toBe(180);
});
it('enforces Cheo 40 percent on real USD rather than nominal REF coverage', async () => {
  const s = await seed(); const id = await apply(s);
  expect(Number(await scalar('select commission_amount from order_payment_applications where id=$1',[id]))).toBe(80);
  expect(Number(await scalar('select covered_amount from order_payment_applications where id=$1',[id]))).toBe(240);
});
it('rejects money and quote links from another order', async () => {
  const a = await seed(); const b = await seed();
  await rejects(() => apply({ ...a, payment: b.payment }), /foreign key/);
  await rejects(() => apply({ ...a, quote: b.quote }), /foreign key/);
});
it('requires actual Cheo workshop assignment for his 40 percent rule', async () => {
  const s = await seed();
  await db.query("update order_items set business_area='STORE' where id=$1", [s.item]);
  await rejects(() => db.query("update order_price_agreements set state='SUPERSEDED' where id=$1", [s.agreement]), /mano de obra/);
});
it('does not let operators read private snapshots or write applications directly', async () => {
  const s = await seed(); await apply(s);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [operator]);
  await db.exec('set local role authenticated');
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(0);
  await rejects(() => db.query('delete from order_price_agreements where id=$1', [s.agreement]), /permission denied/);
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await db.exec('set local role authenticated');
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(1);
  expect(await scalar("select has_table_privilege('anon','order_payment_applications','SELECT')")).toBe(false);
});
it('returns an authoritative summary with native receipts and hides payroll from operators', async () => {
  const s = await seed(); await apply(s);
  const before = await scalar('select count(*)::integer from audit_events');
  const ownerSummary = await scalar('select get_order_financial_summary_v3($1)', [s.order]);
  expect(ownerSummary.components[0]).toMatchObject({ principal: '400.00000000', covered: '240.00000000', commission_accrued: { USD: '80.00' } });
  expect(ownerSummary.payments[0].currency).toBe('USD');
  expect(typeof ownerSummary.payments[0].amount).toBe('string');
  expect(Number(ownerSummary.payments[0].amount)).toBe(200);
  expect(await scalar('select count(*)::integer from audit_events')).toBe(before);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [operator]);
  await db.exec('set local role authenticated');
  const summary = await scalar('select get_order_financial_summary_v3($1)', [s.order]);
  expect(summary.components[0].commission).toBeNull();
  expect(summary.components[0].commission_accrued).toBeNull();
  expect(summary.components[0].covered).toBe('240.00000000');
  expect(await scalar("select has_function_privilege('anon','get_order_financial_summary_v3(uuid)','EXECUTE')")).toBe(false);
});
it('rejects invented coverage that fits both capacities but violates the actual rate', async () => {
  const s = await seed();
  await rejects(() => apply(s, '100', '200'), /cobertura/);
});
it('matches Decimal exact Bs collection, preserving residual outside benefit', async () => {
  const s = await seed('40','34407.01','USD_FIXED','CASH_VES');
  await db.query(`insert into order_payment_applications(order_id,agreement_id,payment_id,quote_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,
    rounding_native,exchange_mode,bcv_rate,commission_amount,reason,created_by)
    values($1,$2,$3,$4,'VES',34407.01,40,round(34407.01/860.1753,8),0,-0.002,'PAR',860.1753,13762.80,'Cobro exacto de cuarenta USD',$5)`,[s.order,s.agreement,s.payment,s.quote,owner]);
  const summary = await scalar('select get_order_financial_summary_v3($1)',[s.order]);
  expect(summary.components[0].covered).toBe('40.00000000');
  expect(summary.components[0].commission_accrued.VES).toBe('13762.80');
});
it('prevents reserving financed capacity again or financing an unrelated order', async () => {
  const s = await seed(); await apply(s);
  const sale=await scalar(`insert into cashea_sales(order_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference)
    values($1,'ACTIVE',40,4,65,6500,26,2600,39,2.60,260,100,'CASH_VES','100005') returning id`,[s.order]);
  const reserve=(amount:string,order=s.order,agreement=s.agreement)=>db.query(`insert into order_financing_applications(order_id,agreement_id,cashea_sale_id,amount,reason,created_by) values($1,$2,$3,$4,'Contrato confirmado de prueba',$5)`,[order,agreement,sale,amount,owner]);
  await rejects(()=>reserve('160'),/capacidad del contrato/);
  await reserve('39');
  await rejects(()=>reserve('1'),/capacidad del contrato/);
  await rejects(()=>reserve('122'),/saldo disponible/);
  const other=await seed();
  await rejects(()=>reserve('10',other.order,other.agreement),/ajeno/);
});

const uuid = () => crypto.randomUUID();
async function preview(s: Awaited<ReturnType<typeof seed>>, tenders: unknown[], request=uuid(), revision?:number, when=new Date().toISOString()) {
  const currentRevision=revision??await scalar('select settlement_revision from orders where id=$1',[s.order]);
  return scalar('select prepare_collection_v3($1,$2,$3,$4,$5)',[s.order,request,currentRevision,{tenders},when]);
}
async function enabled(s: Awaited<ReturnType<typeof seed>>) {
  await db.query('update orders set settlement_version=3 where id=$1',[s.order]);
  return s;
}
it('quotes negotiated USD using authoritative balance and calculates Cheo from actual money', async () => {
  const s=await enabled(await seed());
  const result=await preview(s,[{id:uuid(),method:'CASH_USD',received:'200',targets:[{component:s.agreement,amount:'200',exchange:{mode:'RATE',acceptance:'120'}}]}]);
  expect(result.applications[0]).toMatchObject({native:'200',covered:'240.00000000',benefit:'40.00000000',commission:'80.00',bcv:'100.000000'});
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(0);
  expect(await scalar('select count(*)::integer from payments')).toBe(1); // Seed only; preview creates no receipt.
});
it('quotes the confirmed USD 355 sale without converting it through the operative rate', async () => {
  const s=await enabled(await seed('300','1','USD_FIXED'));
  const store=await scalar("select add_service_priced($1,'STORE','Aceite y filtro',55,55,null,false,'USD')",[s.order]);
  const a=await scalar(`insert into order_price_agreements(order_id,item_id,version,basis,principal,ownership,reason,created_by) values($1,$2,1,'USD_FIXED',55,'SELF','Precio USD pactado',$3) returning id`,[s.order,store,owner]);
  const result=await preview(s,[{id:uuid(),method:'CASH_USD',received:'355',targets:[{component:s.agreement,amount:'EXACT_DUE'},{component:a,amount:'EXACT_DUE'}]}]);
  expect(result.tenders[0]).toMatchObject({received:'355',applied:'355.00',change:'0.00'});
  expect(result.applications.map((x:any)=>x.covered)).toEqual(['300.00000000','55.00000000']);
  expect(result.applications.map((x:any)=>x.commission)).toEqual(['120.00','0']);
});
it('selects full precision BCV at each payment date and preserves earlier previews', async () => {
  const s=await enabled(await seed('100'));
  await db.exec("insert into exchange_rates(rate_type,value,effective_at) values('BCV',120,'2026-02-01')");
  const old=await preview(s,[{id:uuid(),method:'CASH_VES',received:'10000',targets:[{component:s.agreement,amount:'EXACT_DUE'}]}],uuid(),1,'2026-01-31T18:00:00Z');
  const next=await preview(s,[{id:uuid(),method:'CASH_VES',received:'12000',targets:[{component:s.agreement,amount:'EXACT_DUE'}]}],uuid(),1,'2026-02-01T18:00:00Z');
  expect(Number(old.applications[0].bcv)).toBe(100);
  expect(Number(next.applications[0].bcv)).toBe(120);
  expect(old.applications[0].covered).toBe(next.applications[0].covered);
});
it('matches Decimal for exact Bs and preserves cash surplus outside service commissions', async () => {
  const s=await enabled(await seed('40','1','USD_FIXED'));
  await db.exec("insert into exchange_rates(rate_type,value,effective_at) values('BCV',860.1753,'2026-02-01')");
  const result=await preview(s,[{id:uuid(),method:'CASH_VES',received:'35000',targets:[{component:s.agreement,amount:'EXACT_DUE'}]}]);
  const decimal=quoteCollection([{id:s.agreement,basis:'USD_FIXED',principal:'40',covered:'0',financed:'0',ownership:'SELF',commission:{worker:'CHEO',mode:'CHEO_COLLECTION',percent:'40'}}],[{id:'receipt',currency:'VES',cash:true,received:'35000',bcv:'860.1753',targets:[{component:s.agreement,amount:'EXACT_DUE'}]}]);
  expect(Number(result.applications[0].rounding_native)).toBe(Number(decimal.applications[0].roundingNative));
  expect(Number(result.applications[0].commission)).toBe(Number(decimal.applications[0].commission!.amount));
  expect(Number(result.tenders[0].change)).toBe(Number(decimal.tenders[0].change));
});
it('rejects stale revisions, foreign concepts and digital surplus', async () => {
  const s=await enabled(await seed()); const foreign=await seed();
  const tender=(component=s.agreement)=>({id:uuid(),method:'ZELLE',received:'500',targets:[{component,amount:'EXACT_DUE'}]});
  await rejects(()=>preview(s,[tender()],uuid(),2),/orden cambió/);
  await rejects(()=>preview(s,[tender(foreign.agreement)]),/ajeno/);
  await rejects(()=>preview(s,[tender()]),/Exceso digital/);
});
it('retries identical quote requests without duplicates and rejects changed payload', async () => {
  const s=await enabled(await seed()); const request=uuid(); const when=new Date().toISOString();
  const t={id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]};
  expect(await preview(s,[t],request,1,when)).toEqual(await preview(s,[t],request,1,when));
  expect(await scalar('select count(*)::integer from collection_quotes')).toBe(2); // Fixture + real preview.
  await rejects(()=>preview(s,[{...t,received:'101'}],request,1,when),/reutilizado/);
});
it('does not trust browser principal, commissions, FX or metadata', async () => {
  const s=await enabled(await seed());
  const t={id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100',principal:'1'}]};
  await rejects(()=>preview(s,[t]),/aplicación/);
  await rejects(()=>preview(s,[{...t,targets:[{component:s.agreement,amount:'100',exchange:{mode:'PAR',bcv:'500'}}]}]),/1:1/);
});
it('redacts commissions from operator preview but retains protected calculated snapshot', async () => {
  const s=await enabled(await seed()); const request=uuid();
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[operator]);
  await db.exec('set local role authenticated');
  const result=await preview(s,[{id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]}],request);
  expect(result.applications[0]).not.toHaveProperty('commission');
  expect(await scalar('select count(*)::integer from collection_quotes')).toBe(0);
  await db.exec('reset role');
  const privateResult=await scalar('select calculated_payload from collection_quotes where id=$1',[request]);
  expect(privateResult.applications[0].commission).toBe('40.00');
});
async function commit(quote: string,request=uuid()) {
  return scalar('select commit_collection_v3($1,$2)',[quote,request]);
}
it('commits money once, preserving actual 200 USD independently of REF 240 coverage', async () => {
  const s=await enabled(await seed()); const pid=uuid();
  const q=await preview(s,[{id:pid,method:'CASH_USD',received:'200',targets:[{component:s.agreement,amount:'200',exchange:{mode:'RATE',acceptance:'120'}}]}]);
  const request=uuid(); const result=await commit(q.quote_id,request);
  expect(result).toEqual(await commit(q.quote_id,request));
  expect(Number(await scalar('select amount_original from payments where id=$1',[pid]))).toBe(200);
  expect(Number(await scalar('select covered_amount from order_payment_applications where payment_id=$1',[pid]))).toBe(240);
  expect(Number(await scalar('select commission_amount from order_payment_applications where payment_id=$1',[pid]))).toBe(80);
  expect(await scalar('select count(*)::integer from account_movements where source_payment_id=$1',[pid])).toBe(1);
  expect(Number(await scalar('select value_ves from account_movements where source_payment_id=$1',[pid]))).toBe(20000);
  await rejects(()=>commit(q.quote_id),/otro identificador/);
  await rejects(()=>db.query('delete from payments where id=$1',[pid]),/original/);
});
it('rolls back the whole batch if a second payment ID collides', async () => {
  const s=await enabled(await seed()); const before=await scalar('select count(*)::integer from account_movements'); const first=uuid();
  const q=await preview(s,[{id:first,method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]},{id:s.payment,method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]}]);
  await rejects(()=>commit(q.quote_id),/duplicate key/);
  expect(await scalar('select count(*)::integer from payments where id=$1',[first])).toBe(0);
  expect(await scalar('select count(*)::integer from account_movements')).toBe(before);
  expect(await scalar('select state from collection_quotes where id=$1',[q.quote_id])).toBe('PREVIEW');
});
it('rejects a second stale preview after another collection is committed', async () => {
  const s=await enabled(await seed());
  const t=()=>[{id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]}];
  const q1=await preview(s,t()); const q2=await preview(s,t());
  await commit(q1.quote_id);
  await rejects(()=>commit(q2.quote_id),/orden cambió/);
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(1);
});
it('accepts native USD without inventing a BCV valuation and marks it pending', async () => {
  const s=await enabled(await seed('40','1','USD_FIXED'));
  await db.exec("delete from exchange_rates where rate_type='BCV'");
  const pid=uuid(); const q=await preview(s,[{id:pid,method:'CASH_USD',received:'40',targets:[{component:s.agreement,amount:'EXACT_DUE'}]}]);
  await commit(q.quote_id);
  const p=await db.query('select currency,amount_original,value_ves,valuation_status from payments where id=$1',[pid]);
  expect(p.rows[0]).toMatchObject({currency:'USD',value_ves:null,valuation_status:'PENDING'});
  expect(Number(await scalar('select amount_original from account_movements where source_payment_id=$1',[pid]))).toBe(40);
  expect(await scalar('select valuation_status from account_movements where source_payment_id=$1',[pid])).toBe('PENDING');
});
it('prevents legacy payments and legacy close from bypassing component settlement', async () => {
  const s=await enabled(await seed());
  await rejects(()=>db.query("select add_payment($1,'CASH_USD',10)",[s.order]),/cotización/);
  await rejects(()=>db.query("update orders set status='CLOSED' where id=$1",[s.order]),/cierra por conceptos/i);
});
it('does not grant direct payment writes to the browser', async () => {
  expect(await scalar("select has_table_privilege('authenticated','payments','INSERT')")).toBe(false);
  expect(await scalar("select has_table_privilege('authenticated','payments','UPDATE')")).toBe(false);
  expect(await scalar("select has_table_privilege('authenticated','payments','DELETE')")).toBe(false);
});
it('rejects quote confirmation by another user, or after expiry', async () => {
  const s=await enabled(await seed());
  const q=await preview(s,[{id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]}]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[operator]);
  await rejects(()=>commit(q.quote_id),/ajena/);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
  await db.query("update collection_quotes set state='EXPIRED' where id=$1",[q.quote_id]);
  await rejects(()=>commit(q.quote_id),/vencida/);
  expect(await scalar('select count(*)::integer from order_payment_applications')).toBe(0);
});
it('preserves exact debt coverage with a repeating preferential conversion residual', async () => {
  const s=await enabled(await seed());
  const q=quoteCollection([{id:s.agreement,basis:'USD_REF_BCV',principal:'400',covered:'0',financed:'0',ownership:'SELF'}],[{id:'cash',currency:'USD',cash:true,received:'1000',bcv:'100',targets:[{component:s.agreement,amount:'EXACT_DUE',exchange:{mode:'RATE',bcv:'100',acceptance:'120.430001'}}]}]);
  const server=await preview(s,[{id:uuid(),method:'CASH_USD',received:q.tenders[0].applied,targets:[{component:s.agreement,amount:'EXACT_DUE',exchange:{mode:'RATE',acceptance:'120.430001'}}]}]);
  await commit(server.quote_id);
  expect(Number(await scalar('select covered_amount from order_payment_applications'))).toBe(400);
  expect(Number(server.applications[0].rounding_native)).toBe(Number(q.applications[0].roundingNative));
});
it('retains exact-agreement capacity and rejects changed conditions or double consumption', async () => {
  const s=await enabled(await seed()); const agreement=uuid();
  const t=(amount:string,covered='237.17')=>[{id:uuid(),method:'CASH_USD',received:amount,targets:[{component:s.agreement,amount,exchange:{mode:'EXACT',id:agreement,native:'200',covered}}]}];
  const first=await preview(s,t('100')); await commit(first.quote_id);
  const second=await preview(s,t('100')); await commit(second.quote_id);
  expect(Number(await scalar('select sum(covered_amount) from order_payment_applications'))).toBe(237.17);
  await rejects(()=>preview(s,t('1')),/consumido/);
  await rejects(()=>preview(s,t('1','240')),/otros datos/);
});
it('invalidates a preview after item changes and refuses a missing price agreement', async () => {
  const s=await enabled(await seed());
  const t=[{id:uuid(),method:'CASH_USD',received:'100',targets:[{component:s.agreement,amount:'100'}]}];
  const q=await preview(s,t);
  await db.query("update order_items set description='Trabajo con observación' where id=$1",[s.item]);
  await rejects(()=>commit(q.quote_id),/orden cambió/);
  await rejects(()=>db.query('update order_items set charged_ref_amount=300 where id=$1',[s.item]),/acuerdo/);
  await db.query("select add_service_priced($1,'STORE','Producto nuevo',10,10,null,false,'REF')",[s.order]);
  await rejects(()=>preview(s,t),/confirmar el precio/);
});
it('prevents authenticated clients from changing the engine version directly', async () => {
  const s=await seed();
  await db.exec('grant update(settlement_version) on orders to authenticated'); // Simulate an accidentally broad grant.
  await db.exec('create policy fixture_order_write on orders for all to authenticated using(true) with check(true)');
  await db.exec('set local role authenticated');
  await rejects(()=>db.query('update orders set settlement_version=3 where id=$1',[s.order]),/activación/);
});
it('keeps release off and refuses to prepare an already paid historical order', async () => {
  const s=await seed();
  await rejects(()=>db.query('select prepare_order_v3($1)',[s.order]),/no está habilitado/);
  await db.exec("update app_settings set value='true' where key='finance_settlement_v3_ready'");
  await rejects(()=>db.query('select prepare_order_v3($1)',[s.order]),/revisión individual/);
  expect(await scalar('select settlement_version from orders where id=$1',[s.order])).toBe(2);
});
it('creates strong default agreements for an unpaid mixed order and preserves USD denomination', async () => {
  const order=await scalar('insert into orders(is_walk_in) values(true) returning id');
  await db.query("select add_service_priced($1,'WORKSHOP','Mano de obra USD',300,300,null,false,'USD')",[order]);
  await db.query("select add_service_priced($1,'STORE','Productos BCV',65.5,65.5,null,false,'REF')",[order]);
  await db.exec("update app_settings set value='true' where key='finance_settlement_v3_ready'");
  const result=await scalar('select prepare_order_v3($1)',[order]);
  expect(result.version).toBe(3);
  expect(result.components.map((l:any)=>[l.basis,Number(l.principal)])).toEqual(expect.arrayContaining([['USD_FIXED',300],['USD_REF_BCV',65.5]]));
  expect(result.components.find((l:any)=>l.basis==='USD_FIXED').commission).toMatchObject({mode:'CHEO_COLLECTION',percent:'40'});
});
it('versions a negotiated price without losing its original agreement or creating cash', async () => {
  const s=await enabled(await seed('65.5','1','USD_REF_BCV'));
  const id=await scalar("select set_order_price_v3($1,1,'USD_FIXED','55','SELF','Rebaja pactada en divisas')",[s.item]);
  expect(await scalar('select state from order_price_agreements where id=$1',[s.agreement])).toBe('SUPERSEDED');
  expect(Number(await scalar('select principal from order_price_agreements where id=$1',[id]))).toBe(55);
  expect(await scalar('select supersedes_id from order_price_agreements where id=$1',[id])).toBe(s.agreement);
  expect(await scalar('select count(*)::integer from payments')).toBe(1);
  await rejects(()=>db.query("select set_order_price_v3($1,1,'USD_FIXED','50','SELF','Nuevo acuerdo')",[s.item]),/orden cambió/);
});
it('refuses changing price after money was applied instead of silently recalculating commission', async () => {
  const s=await enabled(await seed()); const q=await preview(s,[{id:uuid(),method:'CASH_USD',received:'200',targets:[{component:s.agreement,amount:'200'}]}]); await commit(q.quote_id);
  const revision=await scalar('select settlement_revision from orders where id=$1',[s.order]);
  await rejects(()=>db.query("select set_order_price_v3($1,$2,'USD_FIXED','300','SELF','Cambio después del abono')",[s.item,revision]),/reversión económica/);
  expect(await scalar('select state from order_price_agreements where id=$1',[s.agreement])).toBe('ACTIVE');
});
it('adds manual resale oil at USD 7 as own revenue with explicit price basis', async () => {
  const s=await enabled(await seed());
  const item=await scalar('select add_product_v3($1,$2)',[s.order,{kind:'MANUAL',description:'Aceite externo comprado y revendido',quantity:'1',unit:'7',basis:'USD_FIXED'}]);
  const result=await scalar('select get_order_financial_summary_v3($1)',[s.order]);
  expect(result.components.find((l:any)=>l.item_id===item)).toMatchObject({basis:'USD_FIXED',principal:'7.00000000',ownership:'SELF',commission:null});
});
it('creates Cheo service with 40 percent of collection even when the nominal base is higher', async () => {
  const s=await enabled(await seed());
  const item=await scalar("select add_service_v3($1,'WORKSHOP','Precio USD acordado','400','300','USD_FIXED',false)",[s.order]);
  const result=await scalar('select get_order_financial_summary_v3($1)',[s.order]);
  const line=result.components.find((l:any)=>l.item_id===item);
  expect(line).toMatchObject({basis:'USD_FIXED',principal:'300.00000000',commission:{mode:'CHEO_COLLECTION',percent:'40'}});
  await rejects(()=>db.query("select add_service_v3($1,'WORKSHOP','Base protegida inválida','400','300','USD_FIXED',false,'160')",[s.order]),/Cheo recibe 40/);
});

async function freshOrder() {
 const order=await scalar('insert into orders(is_walk_in,settlement_version) values(true,3) returning id');
 return order;
}
it('keeps Bs product prices out of a fictitious REF principal',async()=>{
 const order=await freshOrder();
 const item=await scalar('select add_product_v3($1,$2)',[order,{kind:'MANUAL',description:'Precio fijo Bs',quantity:'2',unit:'500',basis:'VES_FIXED'}]);
 expect(Number(await scalar('select charged_ref_amount from order_items where id=$1',[item]))).toBe(10);
 expect(Number(await scalar('select principal from order_price_agreements where item_id=$1',[item]))).toBe(1000);
});
it('keeps USD and Bs labor commissions in their received currencies',async()=>{
 const order=await freshOrder();
 const item=await scalar("select add_service_v3($1,'WORKSHOP','Abono mixto','100','100','USD_REF_BCV',false)",[order]);
 const agreement=await scalar('select id from order_price_agreements where item_id=$1',[item]);
 for(const [method,amount] of [['CASH_USD','40'],['CASH_VES','6000']]) {
  const revision=await scalar('select settlement_revision from orders where id=$1',[order]);
  const q=await scalar('select prepare_collection_v3($1,$2,$3,$4,$5)',[order,uuid(),revision,{tenders:[{id:uuid(),method,received:amount,targets:[{component:agreement,amount}]}]},new Date().toISOString()]);
  await commit(q.quote_id);
 }
 const revision=await scalar('select settlement_revision from orders where id=$1',[order]);
 await db.query('select close_order_v3($1,$2)',[order,revision]);await db.exec('select lubricenter_private.payroll_sync()');
 const rows=(await db.query('select currency,amount::text from payroll_work_items where order_id=$1 order by currency',[order])).rows;
 expect(rows).toEqual([{currency:'USD',amount:'16.00'},{currency:'VES',amount:'2400.00'}]);
});
it('closes real USD money with pending Bs valuation instead of inventing a rate',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo sin valoración Bs','40','40','USD_FIXED',false)",[order]);
 await db.exec("delete from exchange_rates where rate_type='BCV'");
 const revision=await collectAll(order,'40');const summary=await scalar('select close_order_v3($1,$2)',[order,revision]);
 expect(Number(summary.total_ref)).toBe(40);expect(summary.total_ves).toBeNull();expect(summary.valuation_status).toBe('PENDING');
 expect(await scalar('select total_ves from orders where id=$1',[order])).toBeNull();
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(Number(await scalar('select amount from payroll_work_items where order_id=$1',[order]))).toBe(16);
});
it('compensates a partial labor allocation reversal before payroll without duplicating cash',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo reversible','40','40','USD_FIXED',false)",[order]);
 const revision=await collectAll(order,'40');await db.query('select close_order_v3($1,$2)',[order,revision]);
 await db.exec('select lubricenter_private.payroll_sync()');
 await db.query(`insert into order_payment_applications(order_id,agreement_id,payment_id,quote_id,direction,reverses_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,exchange_mode,bcv_rate,bcv_rate_id,commission_amount,reason,created_by)
 select order_id,agreement_id,payment_id,quote_id,'REVERSE',id,currency,20,20,20,0,exchange_mode,bcv_rate,bcv_rate_id,8,'Corrección parcial de aplicación',created_by from order_payment_applications where order_id=$1 and direction='APPLY'`,[order]);
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(Number(await scalar('select amount from payroll_work_items where order_id=$1',[order]))).toBe(8);
 expect(await scalar('select count(*)::integer from account_movements where source_payment_id is not null')).toBe(1);
 await db.exec('select lubricenter_private.payroll_sync()');expect(await scalar('select count(*)::integer from payroll_work_items where order_id=$1',[order])).toBe(1);
});
it('preserves paid payroll and creates one source-bound correction per reversal',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo ya liquidado','40','40','USD_FIXED',false)",[order]);
 const revision=await collectAll(order,'40');await db.query('select close_order_v3($1,$2)',[order,revision]);
 await db.exec('select lubricenter_private.payroll_sync()');
 const worker=await scalar('select employee_id from payroll_work_items where order_id=$1',[order]);
 const expected=await scalar("select jsonb_build_object('fixed_ref',0,'adjustments','[]'::jsonb,'work',jsonb_agg(jsonb_build_object('id',id,'version',version) order by id)) from payroll_work_items where order_id=$1",[order]);
 await db.query('select payroll_settle($1,current_date-6,current_date,$2)',[worker,expected]);
 await db.query(`insert into order_payment_applications(order_id,agreement_id,payment_id,quote_id,direction,reverses_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,exchange_mode,bcv_rate,bcv_rate_id,commission_amount,reason,created_by)
 select order_id,agreement_id,payment_id,quote_id,'REVERSE',id,currency,20,20,20,0,exchange_mode,bcv_rate,bcv_rate_id,8,'Reversión posterior a liquidación',created_by from order_payment_applications where order_id=$1 and direction='APPLY'`,[order]);
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(Number(await scalar('select amount from payroll_work_items where order_id=$1 and payroll_run_id is not null',[order]))).toBe(16);
 expect(Number(await scalar('select amount from payroll_work_items where order_id=$1 and payroll_run_id is null',[order]))).toBe(-8);
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(await scalar('select count(*)::integer from payroll_work_items where order_id=$1',[order])).toBe(2);
});
async function collectAll(order:string,amount:string) {
 const summary=await scalar('select get_order_financial_summary_v3($1)',[order]);
 const q=await scalar('select prepare_collection_v3($1,$2,$3,$4,$5)',[order,uuid(),summary.revision,{tenders:[{id:uuid(),method:'CASH_USD',received:amount,targets:summary.components.map((l:any)=>({component:l.id,amount:'EXACT_DUE'}))}]},new Date().toISOString()]);
 await commit(q.quote_id);
 return scalar('select settlement_revision from orders where id=$1',[order]);
}
async function cashChangeQuote(method='CASH_USD',received='50'){
 const order=await freshOrder();
 const item=await scalar("select add_service_v3($1,'WORKSHOP','Trabajo con vuelto','40','40','USD_FIXED',false)",[order]);
 const agreement=await scalar('select id from order_price_agreements where item_id=$1',[item]);
 const revision=await scalar('select settlement_revision from orders where id=$1',[order]);
 const tender=uuid();
 const q=await scalar('select prepare_collection_v3($1,$2,$3,$4,$5)',[order,uuid(),revision,{tenders:[{id:tender,method,received,targets:[{component:agreement,amount:'EXACT_DUE'}]}]},new Date().toISOString()]);
 return {order,tender,q};
}
it('keeps immediate USD cash change outside revenue and Cheo commission',async()=>{
 const s=await cashChangeQuote();
 await rejects(()=>commit(s.q.quote_id),/Revisa la entrega/);
 expect(await scalar('select count(*)::integer from payments')).toBe(0);
 await scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,return_usd:'10',return_currency:'USD'}]]);
 const request=uuid();await commit(s.q.quote_id,request);await commit(s.q.quote_id,request);
 expect(Number(await scalar('select sum(amount_original) from payments'))).toBe(40);
 expect(Number(await scalar("select sum(case when direction='IN' then amount_original else -amount_original end) from account_movements where currency='USD'"))).toBe(40);
 expect(Number(await scalar('select sum(commission_amount) from order_payment_applications'))).toBe(16);
 expect(Number(await scalar('select returned_usd from order_tenders'))).toBe(10);
 expect(await scalar('select count(*)::integer from order_change_returns')).toBe(1);
});
it('requires identity for pending change and routes a later refund idempotently',async()=>{
 const s=await cashChangeQuote();
 await rejects(()=>scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,return_usd:'0',return_currency:'USD'}]]),/Identifica al cliente/);
 await scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,return_usd:'0',return_currency:'USD',customer_label:'Cliente identificado'}]]);
 await commit(s.q.quote_id);
 expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(10);
 const refund=uuid();
 await scalar("select return_order_change($1,$2,10,'USD',100,'Entrega al cliente')",[refund,s.tender]);
 await scalar("select return_order_change($1,$2,10,'USD',100,'Entrega al cliente')",[refund,s.tender]);
 expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(0);
 expect(await scalar('select count(*)::integer from order_change_returns')).toBe(1);
});
it('returns agreed-rate Bs change without valuing outgoing USD at that preferential rate',async()=>{
 const s=await cashChangeQuote('CASH_VES','5000');
 const plans=await scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,rate:'125',return_usd:'8',return_currency:'USD'}]]);
 expect(Number(plans[0].change_usd)).toBe(8);
 await commit(s.q.quote_id);
 expect(Number(await scalar("select sum(amount_original) from account_movements where direction='IN' and currency='VES'"))).toBe(5000);
 expect(Number(await scalar("select amount_original from account_movements where direction='OUT' and currency='USD'"))).toBe(8);
 expect(Number(await scalar("select value_ves from account_movements where direction='OUT' and currency='USD'"))).toBe(800);
});
it('freezes a reviewed change plan and rejects money above the surplus',async()=>{
 const s=await cashChangeQuote();
 await rejects(()=>scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,return_usd:'11',return_currency:'USD'}]]),/supera el sobrante/);
 const plan=[{tender:s.tender,return_usd:'10',return_currency:'USD'}];
 await scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,plan]);
 await rejects(()=>scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{...plan[0],return_usd:'9'}]]),/cotización nueva/);
});
it('returns USD change without BCV while keeping native money and valuation pending',async()=>{
 const order=await freshOrder();
 const item=await scalar("select add_service_v3($1,'WORKSHOP','USD sin tasa','40','40','USD_FIXED',false)",[order]);
 const agreement=await scalar('select id from order_price_agreements where item_id=$1',[item]);
 const revision=await scalar('select settlement_revision from orders where id=$1',[order]);
 await db.exec("delete from exchange_rates where rate_type='BCV'");
 const tender=uuid();const q=await scalar('select prepare_collection_v3($1,$2,$3,$4,$5)',[order,uuid(),revision,{tenders:[{id:tender,method:'CASH_USD',received:'50',targets:[{component:agreement,amount:'EXACT_DUE'}]}]},new Date().toISOString()]);
 await scalar('select prepare_change_v3($1,$2)',[q.quote_id,[{tender,return_usd:'10',return_currency:'USD'}]]);
 await commit(q.quote_id);
 expect(Number(await scalar("select sum(case when direction='IN' then amount_original else -amount_original end) from account_movements where currency='USD'"))).toBe(40);
 expect(await scalar("select value_ves from account_movements where direction='OUT'" )).toBeNull();
});
it('returns an exact Bs surplus below one USD cent without losing native money',async()=>{
 await db.exec("insert into exchange_rates(rate_type,value,effective_at) values('BCV',1000,now()-interval '1 minute')");
 const s=await cashChangeQuote('CASH_VES','40001');
 await scalar('select prepare_change_v3($1,$2)',[s.q.quote_id,[{tender:s.tender,return_usd:'0',return_currency:'VES'}]]);
 await commit(s.q.quote_id);
 expect(Number(await scalar("select sum(case when direction='IN' then amount_original else -amount_original end) from account_movements where currency='VES'"))).toBe(40000);
 expect(Number(await scalar('select amount_original from order_change_returns'))).toBe(1);
 expect(Number(await scalar('select amount_usd from order_change_returns'))).toBe(0);
 expect(Number(await scalar('select change_usd-returned_usd from order_tenders'))).toBe(0);
});
it('closes the real USD 355 example without operative inflation and pays only labor to Cheo', async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Mano de obra','300','300','USD_FIXED',false)",[order]);
 for(const [description,quantity,unit] of [['Aceite','5','9'],['Filtro','1','3'],['Aceite externo','1','7']])
  await db.query('select add_product_v3($1,$2)',[order,{kind:'MANUAL',description,quantity,unit,basis:'USD_FIXED'}]);
 const revision=await collectAll(order,'355');
 const summary=await scalar('select close_order_v3($1,$2)',[order,revision]);
 expect(Number(summary.total_ref)).toBe(355);
 expect(Number(summary.cash_usd)).toBe(355);
 expect(await scalar('select status from orders where id=$1',[order])).toBe('CLOSED');
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(Number(await scalar('select sum(amount) from payroll_work_items where order_id=$1',[order]))).toBe(120);
 expect(await scalar('select count(*)::integer from payroll_accruals')).toBe(0);
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(await scalar('select count(*)::integer from payroll_work_items where order_id=$1',[order])).toBe(1);
 expect(await scalar('select count(*)::integer from account_movements where source_payment_id is not null')).toBe(1);
 expect(await scalar('select close_order_v3($1,$2)',[order,revision])).toEqual(summary);
});
it('refuses closing an unpaid component and stale revisions with an actionable reason',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo pendiente','40','40','USD_FIXED',false)",[order]);
 const revision=await scalar('select settlement_revision from orders where id=$1',[order]);
 await rejects(()=>db.query('select close_order_v3($1,$2)',[order,revision]),/Falta cobrar.*Trabajo pendiente/);
 await rejects(()=>db.query('select close_order_v3($1,$2)',[order,revision-1]),/orden cambió/);
 expect(await scalar('select count(*)::integer from order_settlement_closures')).toBe(0);
});
it('redacts an owner-created closing snapshot when an operator retries closing',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo privado','40','40','USD_FIXED',false)",[order]);
 const revision=await collectAll(order,'40');
 const ownerSnapshot=await scalar('select close_order_v3($1,$2)',[order,revision]);
 expect(ownerSnapshot.components[0].commission_accrued.USD).toBe('16.00');
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[operator]);await db.exec('set local role authenticated');
 const snapshot=await scalar('select close_order_v3($1,$2)',[order,revision]);
 expect(snapshot.components[0].commission_accrued).toBeNull();
 expect(snapshot.components[0].commission_base).toBeNull();
 expect(snapshot.components[0].commission).toBeNull();
});
it('retains owner payroll decisions and logs adjustments for allocated labor',async()=>{
 const order=await freshOrder();
 await db.query("select add_service_v3($1,'WORKSHOP','Trabajo USD','40','40','USD_FIXED',false)",[order]);
 const revision=await collectAll(order,'40');
 await db.query('select close_order_v3($1,$2)',[order,revision]);
 await db.exec('select lubricenter_private.payroll_sync()');
 const work=await scalar('select id from payroll_work_items where order_id=$1',[order]);
 await db.query("select payroll_review_work($1,1,'PAY',15,'Ajuste acordado con el trabajador')",[work]);
 expect(Number(await scalar('select amount from payroll_work_items where id=$1',[work]))).toBe(15);
 expect(await scalar('select count(*)::integer from payroll_work_history where work_item_id=$1',[work])).toBeGreaterThan(0);
 await db.exec('select lubricenter_private.payroll_sync()');
 expect(Number(await scalar('select amount from payroll_work_items where id=$1',[work]))).toBe(15);
});

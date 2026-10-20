import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
const migration=readFileSync(new URL('../supabase/migrations/20261020142052_historical_sale_rates_reliable_checkout.sql',import.meta.url),'utf8');
function definition(name:string){
 const start=migration.indexOf('create or replace function public.'+name+'(');
 const end=migration.indexOf('end $$;',start);
 if(start<0||end<0)throw new Error('Missing SQL function '+name);
 return migration.slice(start,end+7);
}
describe('historical rates used by real order functions',()=>{
 let db:PGlite;
 beforeEach(async()=>{
  db=new PGlite();
  await db.exec(`create schema auth;
   create function public.require_auth() returns void language plpgsql as $$ begin return; end $$;
   create table public.exchange_rates(id uuid default gen_random_uuid(),rate_type text,value numeric,effective_at timestamptz,created_at timestamptz default now());
   create table public.orders(id uuid primary key,opened_at timestamptz default now(),business_at timestamptz,sale_bcv_rate numeric,sale_operative_rate numeric);
   create table public.order_items(id uuid default gen_random_uuid(),order_id uuid,created_at timestamptz default now(),bcv_rate_snapshot numeric,operative_rate_snapshot numeric);`);
  await db.exec(definition('get_exchange_rates_for_date')+definition('get_exchange_rate_history')+definition('get_order_rates'));
 });
 afterEach(async()=>{await db.close();});
 it('uses the sale day and never substitutes the later BCV',async()=>{
  await db.exec(`insert into exchange_rates(rate_type,value,effective_at) values
   ('BCV',881.0664,now()-interval '1 day'),('BCV',881.8769,now()-interval '1 minute'),('OPERATIVE',1000,now()-interval '7 days');`);
  const r=await db.query<{bcv_rate:string}>(`select * from get_exchange_rates_for_date(((now() at time zone 'America/Caracas')::date-1))`);
  expect(Number(r.rows[0].bcv_rate)).toBe(881.0664);
 });
 it('carries Friday into a weekend and reports its actual origin',async()=>{
  await db.exec(`insert into exchange_rates(rate_type,value,effective_at)
   select k,v,((d-extract(dow from d)::int-2)::timestamp+interval '8 hours') at time zone 'America/Caracas'
   from (select (now() at time zone 'America/Caracas')::date d) x
   cross join (values ('BCV',880.1159),('OPERATIVE',1000)) y(k,v);`);
  const r=await db.query<{bcv_rate:string;days:number}>(`select r.*, d-r.bcv_date as days from
   (select (now() at time zone 'America/Caracas')::date-extract(dow from now() at time zone 'America/Caracas')::int d) x
   cross join lateral get_exchange_rates_for_date(d) r`);
  expect(Number(r.rows[0].bcv_rate)).toBe(880.1159);
  expect(r.rows[0].days).toBe(2);
 });
 it('refuses missing history rather than using a future observation',async()=>{
  await db.exec(`insert into exchange_rates(rate_type,value,effective_at) values ('BCV',999,now()),('OPERATIVE',1000,now());`);
  await expect(db.query(`select * from get_exchange_rates_for_date((now() at time zone 'America/Caracas')::date-1)`)).rejects.toThrow('No hay historial completo');
 });
 it('keeps stored order rates even when later rates change',async()=>{
  await db.exec(`insert into orders(id,sale_bcv_rate,sale_operative_rate) values ('00000000-0000-4000-8000-000000000001',881.0664,1000);
   insert into exchange_rates(rate_type,value,effective_at) values ('BCV',999,now()),('OPERATIVE',2000,now());`);
  const r=await db.query<{bcv_rate:string;operative_rate:string}>(`select * from get_order_rates('00000000-0000-4000-8000-000000000001')`);
  expect(Number(r.rows[0].bcv_rate)).toBe(881.0664);
  expect(Number(r.rows[0].operative_rate)).toBe(1000);
 });
 it('preserves a legacy order valuation instead of rewriting it',async()=>{
  await db.exec(`insert into orders(id) values ('00000000-0000-4000-8000-000000000001');
   insert into order_items(order_id,bcv_rate_snapshot,operative_rate_snapshot) values ('00000000-0000-4000-8000-000000000001',800,950);`);
  const r=await db.query<{bcv_rate:string}>(`select * from get_order_rates('00000000-0000-4000-8000-000000000001')`);
  expect(Number(r.rows[0].bcv_rate)).toBe(800);
 });
});

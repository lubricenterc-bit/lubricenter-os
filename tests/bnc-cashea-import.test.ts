import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
 // The compact fixture predates Finance Core. Add only the dependency tables needed to compile the migration.
 await db.exec(`
  create table if not exists public.financial_accounts(id uuid primary key default gen_random_uuid(),code text,currency text,active boolean);
  create table if not exists public.external_sources(id uuid primary key default gen_random_uuid(),provider text, name text, account_id uuid, external_account text,currency text,active boolean);
  create table if not exists public.external_transactions(id uuid primary key default gen_random_uuid());
 `);
 await db.exec(readFileSync('supabase/migrations/20261012090000_finance_export_individual_sources.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261012100000_bnc_statement_cashea_links.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261012102000_finance_export_bnc_linked.sql','utf8'));
},120000);
afterAll(async()=>{await db?.close()});
describe('Bank/Cashea historical matching',()=>{
 it('supports BNC as an independently identified bank source',async()=>{
  const q=await db.query<{ok:boolean}>(`select exists(select 1 from pg_constraint where conrelid='public.external_sources'::regclass
   and conname='external_sources_provider_check' and pg_get_constraintdef(oid) ilike '%BNC%') ok`);
  expect(q.rows[0].ok).toBe(true);
 });
 it('requires one-to-one references and matching day/amount before links',async()=>{
  const q=await db.query<{fn:string}>(`select pg_get_functiondef(p.oid) fn from pg_proc p
   join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' and p.proname='finance_bnc_cashea_link'`);
  expect(q.rows[0].fn).toContain('bank_candidates');
  expect(q.rows[0].fn).toContain('cashea_candidates');
  expect(q.rows[0].fn).toContain('SUFFIX_AMOUNT_DATE');
 });
 it('keeps linkage table private to the privileged auditing function',async()=>{
  const q=await db.query<{anon:boolean;table_read:boolean;auth:boolean}>(`
   select has_function_privilege('anon','public.finance_bnc_cashea_link()','EXECUTE') anon,
          has_table_privilege('authenticated','public.finance_external_bank_links','SELECT') table_read,
          has_function_privilege('authenticated','public.finance_bnc_cashea_link()','EXECUTE') auth`);
  expect(q.rows[0]).toEqual({anon:false,table_read:false,auth:true});
 });
});

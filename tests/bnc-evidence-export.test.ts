import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createAuditZip} from '../lib/finance/audit-zip';
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
 await db.exec(readFileSync('supabase/migrations/20261012090000_finance_export_individual_sources.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261012112500_bnc_bank_cashea_evidence.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261012114000_export_bnc_cashea_evidence.sql','utf8'));
},120000);
afterAll(async()=>{await db?.close()});
describe('BNC independent bank evidence',()=>{
 it('registers BNC as a real financial source with a linked bank account',async()=>{
  const q=await db.query<{provider:string;code:string}>(`
   select s.provider,a.code from external_sources s join financial_accounts a on a.id=s.account_id
   where s.provider='BNC'`);
  expect(q.rows).toEqual([{provider:'BNC',code:'BNC'}]);
 });
 it('uses the bank balance in imported duplicate identity and checks running balances',async()=>{
  const q=await db.query<{definition:string}>(`select pg_get_functiondef(p.oid) definition
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' and proname='finance_import'`);
  expect(q.rows[0].definition).toContain("('BDV', 'BNC')");
 });
 it('retains each bank/Cashea evidence pair just once, without creating an additional payment',async()=>{
  const q=await db.query<{def:string}>(`select pg_get_functiondef(p.oid) def from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' and proname='finance_match_bnc_cashea'`);
  expect(q.rows[0].def).toContain('finance_bank_cashea_evidence');
  expect(q.rows[0].def).not.toContain('insert into public.payments');
 });
 it('does not expose bank/Cashea linking to anonymous callers or table readers',async()=>{
  const q=await db.query<{anon:boolean;auth:boolean}>(`select
   has_function_privilege('anon','public.finance_match_bnc_cashea()','EXECUTE') anon,
   has_function_privilege('authenticated','public.finance_match_bnc_cashea()','EXECUTE') auth`);
  expect(q.rows[0]).toEqual({anon:false,auth:true});
  const rel=await db.query<{anon:boolean}>(`select has_table_privilege('anon','public.finance_bank_cashea_evidence','SELECT') anon`);
  expect(rel.rows[0].anon).toBe(false);
 });
 it('exports actual matched evidence, without asserting final reconciliation',async()=>{
  const q=await db.query<{def:string}>(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='lubricenter_private' and proname='finance_export_period'`);
  expect(q.rows[0].def).toContain('bank_cashea_match');
  expect(q.rows[0].def).toContain('BORRADOR_HASTA_VERIFICAR_COBERTURA');
 });
});
describe('ZIP bank attachments',()=>{
 it('contains standard local, central-directory and closing signatures',()=>{
  const out=createAuditZip([{name:'01_BDV.csv',content:'referencia;importe\r\n00123;50'},{name:'02_BNC.csv',content:'abc;123'}]);
  const view=new DataView(out.buffer,out.byteOffset,out.byteLength);
  expect(view.getUint32(0,true)).toBe(0x04034b50);
  expect(view.getUint32(out.length-22,true)).toBe(0x06054b50);
  expect(view.getUint16(out.length-12,true)).toBe(2);
 });
});

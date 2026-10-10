import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';

let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
 await db.exec(readFileSync('supabase/migrations/20261010180000_finance_bank_outflow_queue.sql','utf8'));
},120000);
afterAll(async()=>{await db?.close();});
describe('BDV progressive expense classification',()=>{
 it('exposes an independently paginated, read-only review',async()=>{
  const q=await db.query<{fn:string}>(`select pg_get_functiondef(p.oid) fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='lubricenter_private' and p.proname='finance_bank_outflows_review'`);
  expect(q.rows).toHaveLength(1);
  const fn=q.rows[0].fn.toLowerCase();
  expect(fn).toMatch(/x\.direction\s*=\s*'out'/);
  expect(fn).toContain('finance_require');
  expect(fn).toMatch(/limit\s+100/);
 });
 it('does not expose bank data to anonymous users',async()=>{
  const signature='public.finance_bank_outflows_review(date,date,integer)';
  const q=await db.query<{anon:boolean;auth:boolean}>(`select has_function_privilege('anon',$1,'EXECUTE') anon,
    has_function_privilege('authenticated',$1,'EXECUTE') auth`,[signature]);
  expect(q.rows[0]).toEqual({anon:false,auth:true});
 });
});

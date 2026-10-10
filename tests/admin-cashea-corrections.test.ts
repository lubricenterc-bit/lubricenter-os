import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Structural smoke tests; these never touch production balances or orders.
let db: PGlite;
beforeAll(async () => {
 db = new PGlite();
 await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
 await db.exec(readFileSync('supabase/migrations/20261010173000_admin_cashea_corrections_v2.sql', 'utf8'));
 await db.exec(readFileSync('supabase/migrations/20261010180000_finance_bank_outflow_queue.sql', 'utf8'));
}, 120000);
afterAll(async () => { await db?.close(); });

describe('Audited administrative corrections v2', () => {
 it('exposes an opt-in replacement without replacing the existing RPC', async () => {
  const res = await db.query<{name:string}>(`select proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and proname in ('correct_closed_order','correct_closed_order_v2')
   order by proname`);
  expect(res.rows.map(x=>x.name)).toEqual(['correct_closed_order','correct_closed_order_v2']);
 });
 it('keeps the v2 correction restricted to authenticated users', async () => {
  const signature = 'public.correct_closed_order_v2(uuid,text,timestamptz,jsonb,jsonb,uuid,uuid,numeric)';
  const result = await db.query<{anon:boolean;auth:boolean}>(`select
     has_function_privilege('anon',$1,'EXECUTE') as anon,
     has_function_privilege('authenticated',$1,'EXECUTE') as auth`, [signature]);
  expect(result.rows[0]).toEqual({anon:false,auth:true});
 });
 it('includes explicit cash valuation and approval notes in the function', async () => {
  const q = await db.query<{fn:string}>(`select pg_get_functiondef(p.oid) fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' and proname='correct_closed_order_v2'`);
  expect(q.rows[0].fn).toContain('order.cash_usd_commercial_valuation');
  expect(q.rows[0].fn).toContain('ns.initial_percent:=p_initial_percent');
 });
});

describe('Bank outflow queue structure', () => {
 it('exposes a paginated, read-only outflow review endpoint', async () => {
  const q = await db.query<{fn:string}>(`select pg_get_functiondef(p.oid) fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='lubricenter_private' and p.proname='finance_bank_outflows_review'`);
  expect(q.rows[0].fn.toLowerCase()).toMatch(/x\.direction\s*=\s*'out'/);
  expect(q.rows[0].fn).toContain("finance_require");
  expect(q.rows[0].fn.toLowerCase()).toMatch(/limit\s+100/);
 });
 it('does not grant anonymous reading of bank statements', async () => {
  const signature='public.finance_bank_outflows_review(date,date,integer)';
  const q=await db.query<{anon:boolean;auth:boolean}>(`select
   has_function_privilege('anon',$1,'EXECUTE') as anon,
   has_function_privilege('authenticated',$1,'EXECUTE') as auth`,[signature]);
  expect(q.rows[0]).toEqual({anon:false,auth:true});
 });
});

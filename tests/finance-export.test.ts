import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
 await db.exec(readFileSync('supabase/migrations/20261012090000_finance_export_individual_sources.sql','utf8'));
},120000);
afterAll(async()=>{await db?.close()});
describe('Per-provider reconciliation export',()=>{
 it('exposes both the Cashea snapshot and the independent bank evidence',async()=>{
  const r=await db.query<{definition:string}>(`select pg_get_functiondef(p.oid) definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' and proname='finance_export_period'`);
  expect(r.rows[0].definition).toContain('cashea_order_snapshots');
  expect(r.rows[0].definition).toContain('reconciliation_allocations');
  expect(r.rows[0].definition).toContain('report_verified');
  expect(r.rows[0].definition).toContain('BORRADOR_HASTA_VERIFICAR_COBERTURA');
 });
 it('does not make customer banking data anonymously exportable',async()=>{
  const q=await db.query<{anon:boolean;auth:boolean}>(`select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') auth`,
    ['public.finance_export_period(date,date)']);
  expect(q.rows[0]).toEqual({anon:false,auth:true});
 });
});

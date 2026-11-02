import { PGlite } from '@electric-sql/pglite';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION = 'supabase/migrations/20261102120000_performance_fk_indexes_rls_initplan.sql';
const alice = '00000000-0000-0000-0000-00000000000a';
const bob = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;

async function asUser(id: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
  // Políticas tal como existen hoy en producción (auth.uid() evaluado por fila).
  await db.exec(`
    create table if not exists public.finance_push_subscriptions(id uuid primary key default gen_random_uuid(), user_id uuid not null, endpoint text unique, p256dh text, auth text, active boolean default true);
    create table if not exists public.finance_push_deliveries(id uuid primary key default gen_random_uuid(), subscription_id uuid references public.finance_push_subscriptions(id), business_date date, status text);
    alter table public.finance_push_subscriptions enable row level security;
    alter table public.finance_push_deliveries enable row level security;
    drop policy if exists own_push on public.finance_push_subscriptions;
    drop policy if exists own_push_status on public.finance_push_deliveries;
    create policy own_push on public.finance_push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy own_push_status on public.finance_push_deliveries for select to authenticated using (exists (select 1 from public.finance_push_subscriptions s where s.id = finance_push_deliveries.subscription_id and s.user_id = auth.uid()));
    grant select, insert, update, delete on public.finance_push_subscriptions, public.finance_push_deliveries to authenticated;
    insert into public.finance_push_subscriptions(id,user_id,endpoint) values
      ('10000000-0000-0000-0000-000000000001','${alice}','https://push/a'),
      ('10000000-0000-0000-0000-000000000002','${bob}','https://push/b');
    insert into public.finance_push_deliveries(subscription_id,business_date,status) values
      ('10000000-0000-0000-0000-000000000001','2026-11-02','SENT'),
      ('10000000-0000-0000-0000-000000000002','2026-11-02','SENT');
  `);
  const sql = readFileSync(MIGRATION, 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotente: aplicarla dos veces no falla
});

describe('performance migration', () => {
  it('rewrites auth.uid() as an initplan without changing who can read', async () => {
    await db.exec('reset role');
    const { rows } = await db.query<{ qual: string; with_check: string | null }>(
      "select qual, with_check from pg_policies where tablename='finance_push_subscriptions' and policyname='own_push'");
    expect(rows[0].qual).toMatch(/SELECT auth\.uid\(\)/);
    expect(rows[0].with_check).toMatch(/SELECT auth\.uid\(\)/);

    await asUser(alice);
    const subs = await db.query<{ endpoint: string }>('select endpoint from public.finance_push_subscriptions');
    expect(subs.rows.map(r => r.endpoint)).toEqual(['https://push/a']);
    const deliveries = await db.query('select * from public.finance_push_deliveries');
    expect(deliveries.rows).toHaveLength(1);

    // with check intacto: no puede registrar suscripciones a nombre de otro usuario
    let error: unknown;
    try { await db.query(`insert into public.finance_push_subscriptions(user_id,endpoint) values ('${bob}','https://push/x')`); }
    catch (e) { error = e; }
    expect(error).toBeTruthy();
    await db.exec('reset role');
  });

  it('creates covering indexes for hot foreign keys that exist in this schema', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname='public' and indexname like '%_fk_idx'");
    const names = rows.map(r => r.indexname);
    expect(names).toContain('finance_push_subscriptions_user_id_fk_idx');
    const orderTenders = await db.query("select 1 from information_schema.columns where table_name='order_tenders' and column_name='order_id'");
    if (orderTenders.rows.length) expect(names).toContain('order_tenders_order_id_fk_idx');
  });
});

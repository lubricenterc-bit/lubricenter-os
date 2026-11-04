import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshnessLine, paidSourceLabel, syncNotice, trackingWarnings } from '../lib/cashea-sync';

const base = readFileSync('supabase/migrations/20261029120000_cashea_branch_conciliation.sql', 'utf8');
const autofix = readFileSync('supabase/migrations/20261029180000_cashea_conciliation_autofix.sql', 'utf8');
const v2 = readFileSync('supabase/migrations/20261104160000_cashea_sync_verificada.sql', 'utf8');
let db: PGlite;
let src = '';
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

type Sync = { paid: number; partial: number; settled: number; by_rule: { A: number; B: number }; dry_run: boolean;
  unverified: { order_number: string; installment_no: number; reason: string; hint: string; verified_ref: number }[] };
const sync = async (dry = false) => (await one<{ r: Sync }>('select public.cashea_conc_sync_installments_v2($1) r', [dry])).r;

// Minimal stand-ins for the production objects the migrations read or update.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   create role anon; create role authenticated; create role service_role;
   create schema auth; create schema lubricenter_private;
   create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
   create function lubricenter_private.finance_role() returns text language sql stable as $$ select coalesce(current_setting('test.role',true),'OWNER') $$;
   create function lubricenter_private.staff_identity_allowed() returns boolean language sql stable as $$ select true $$;
   create function lubricenter_private.finance_require(p_role text default 'ADMIN') returns void language plpgsql as $$ begin
    if (p_role='OWNER' and lubricenter_private.finance_role()<>'OWNER') or (p_role='ADMIN' and lubricenter_private.finance_role() not in ('ADMIN','OWNER')) then raise exception 'Esta acción necesita un administrador financiero'; end if; end $$;
   create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,created_at timestamptz default clock_timestamp());
   create function lubricenter_private.finance_audit() returns trigger language plpgsql as $$ begin insert into public.audit_events(event_type,entity_type) values('finance.'||lower(tg_op),tg_table_name); return coalesce(new,old); end $$;
   create table public.orders(id uuid primary key default gen_random_uuid(),order_number text,status text,total_ref numeric,business_at timestamptz,closed_at timestamptz,opened_at timestamptz default now());
   create table public.cashea_sales(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),cashea_reference text,status text,ownership_status text default 'OWN',gross_ref numeric,initial_ref numeric,settled_at timestamptz,initial_payment_method text,created_at timestamptz default now());
   create table public.cashea_installments(id uuid primary key default gen_random_uuid(),cashea_sale_id uuid references public.cashea_sales(id),installment_no integer,due_date date,amount_ref numeric,paid_ref numeric default 0,paid_ves_actual numeric default 0,status text default 'PENDING',paid_at timestamptz,updated_at timestamptz);
   create table public.payments(id uuid primary key default gen_random_uuid(),order_id uuid,method text,currency text,amount_original numeric,reference text,paid_at timestamptz,receivable_id uuid,financial_account_id uuid);
   create table public.financial_accounts(id uuid primary key default gen_random_uuid(),code text unique,active boolean default true);
   insert into public.financial_accounts(code) values('BDV'),('BNC');
   create table public.account_movements(id uuid primary key default gen_random_uuid(),account_id uuid,source_payment_id uuid,reference text,amount_original numeric);
   create table public.reconciliation_allocations(id uuid primary key default gen_random_uuid(),account_movement_id uuid,external_transaction_id uuid,reversed_at timestamptz);
   create table public.reconciliation_cases(id uuid primary key default gen_random_uuid(),subject_type text,subject_id uuid,status text default 'OPEN',resolution text,resolved_at timestamptz,updated_at timestamptz);
   create table public.order_tenders(id uuid primary key default gen_random_uuid(),order_id uuid,payment_id uuid);
   create function lubricenter_private.require_order_admin() returns void language plpgsql as $$ begin if lubricenter_private.finance_role() not in ('ADMIN','OWNER') then raise exception 'Solo administradores'; end if; end $$;
   create table public.external_sources(id uuid primary key default gen_random_uuid(),provider text);
   create table public.external_import_batches(id uuid primary key default gen_random_uuid(),source_id uuid,row_count integer,observed_from date,observed_to date,created_at timestamptz default now());
   create table public.external_transactions(id uuid primary key default gen_random_uuid(),source_id uuid,first_batch_id uuid,occurred_at timestamptz,reference text,description text,direction text default 'IN',currency text,amount numeric,balance numeric,amount_ref numeric,assigned_ref numeric,exchange_rate numeric,rate_date date,external_order text,installments integer[],ownership_status text,ownership_reason text,ownership_evidence jsonb,raw jsonb,created_at timestamptz default clock_timestamp());
   create table public.reconciliation_transaction_exclusions(transaction_id uuid primary key references public.external_transactions(id),canonical_transaction_id uuid references public.external_transactions(id),reason text not null,evidence jsonb,created_at timestamptz default now(),created_by uuid,
     constraint reconciliation_transaction_exclusions_reason_check check (reason='EXACT_SOURCE_DUPLICATE'));
   create table public.cashea_order_snapshots(id uuid primary key default gen_random_uuid(),batch_id uuid,external_order text,purchased_on date,status text,total_ref numeric,initial_ref numeric,installments jsonb,raw jsonb,created_at timestamptz default now());
  `);
  await db.exec(base);
  await db.exec(autofix);
  await db.exec(v2);
  src = (await one<{ id: string }>("insert into public.external_sources(provider) values('CASHEA_TRANSACTIONS') returning id")).id;
  // Estado de cuenta BNC del 1 al 30 de octubre.
  const bnc = [['2026-10-01', '1', 0, 1, 1], ['2026-10-10', '12345', 0, 8900.5, 8901.5], ['2026-10-12', '22222', 0, 8010, 16911.5],
    ['2026-10-14', '33333', 0, 8000, 24911.5], ['2026-10-30', '9', 0, 1, 24912.5]] as const;
  await db.query('select public.cashea_conc_import_bnc($1,$2::jsonb,true)', ['Rpt.xls', JSON.stringify(bnc.map(([d, ref, debit, credit, balance], row) =>
    ({ row, line_date: d, day_index: row, reference: ref, debit, credit, balance, op_type: 'Abono Pago Movil BNC', description: 'x' })))]);
}, 120000);
afterAll(async () => { await db?.close(); });

async function sale(order: string, ref: string | null, amount: number, due = '2026-10-15') {
  const o = await one<{ id: string }>("insert into public.orders(order_number,status,total_ref) values($1,'CLOSED',100) returning id", [order]);
  const s = await one<{ id: string }>("insert into public.cashea_sales(order_id,cashea_reference,status,gross_ref,initial_ref) values($1,$2,'ACTIVE',100,40) returning id", [o.id, ref]);
  return (await one<{ id: string }>("insert into public.cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref) values($1,1,$2,$3) returning id", [s.id, due, amount])).id;
}
async function pay(ref: string, order: string, amount: number, assigned: number, at: string) {
  return (await one<{ id: string }>(`insert into public.external_transactions(source_id,occurred_at,reference,currency,amount,amount_ref,assigned_ref,external_order,installments,ownership_status,raw)
    values($1,$2,$3,'VES',$4,$5,$5,$6,'{1}','OWN','{}') returning id`, [src, at, ref, amount, assigned, order])).id;
}

describe('Cashea: sincronización verificada (v2)', () => {
  it('excluye el mismo pago importado dos veces con otro formato y no lo suma dos veces', async () => {
    await sale('OS-000086', '111', 10);
    const a = await pay('00012345', '111', 8900.5, 10, '2026-10-09T15:00:00Z');
    const b = await pay('12345', '111', 8900.50, 10, '2026-10-09T15:00:00Z');
    expect(await q('select transaction_id,canonical_transaction_id,reason from public.reconciliation_transaction_exclusions'))
      .toEqual([{ transaction_id: b, canonical_transaction_id: a, reason: 'NORMALIZED_SOURCE_DUPLICATE' }]);
  });

  it('modo prueba: calcula sin escribir nada', async () => {
    await sale('OS-000231', '222', 15.5);
    await pay('22222', '222', 8010, 9, '2026-10-11T15:00:00Z');
    await sale('OS-000300', '333', 10);
    await pay('33333', '333', 8050, 10, '2026-10-13T15:00:00Z');
    await sale('OS-000310', '444', 10);
    await pay('44444', '444', 8900, 10, '2026-11-02T15:00:00Z');
    await sale('OS-000057', null, 10.6, '2026-09-28');
    const before = await one<{ n: number }>("select count(*)::int n from public.cashea_installments where status='PENDING'");
    const dry = await sync(true);
    expect(dry).toMatchObject({ paid: 1, partial: 1, by_rule: { A: 0, B: 2 }, dry_run: true });
    expect((await one<{ n: number }>("select count(*)::int n from public.cashea_installments where status='PENDING'")).n).toBe(before.n);
    expect((await one<{ n: number }>("select count(*)::int n from public.audit_events where event_type='cashea.installment_synced_v2'")).n).toBe(0);
  });

  it('regla B: pago del export + línea del BNC (referencia sin ceros, ±1 Bs, ±3 días)', async () => {
    const r = await sync();
    expect(r).toMatchObject({ paid: 1, partial: 1, settled: 1, by_rule: { A: 0, B: 2 } });
    expect(await q(`select o.order_number,i.status,i.paid_ref::float paid,i.paid_ves_actual::float ves,i.paid_at::date::text at
      from public.cashea_installments i join public.cashea_sales s on s.id=i.cashea_sale_id join public.orders o on o.id=s.order_id
      where o.order_number in ('OS-000086','OS-000231') order by o.order_number`)).toEqual([
      { order_number: 'OS-000086', status: 'PAID', paid: 10, ves: 8900.5, at: '2026-10-09' },
      { order_number: 'OS-000231', status: 'PARTIAL', paid: 9, ves: 8010, at: null }]);
    const ev = await one<{ d: { rule: string; bnc_lines: unknown[]; payments: unknown[] } }>("select data d from public.audit_events where event_type='cashea.installment_synced_v2' and data->>'external_order'='111'");
    expect(ev.d.rule).toBe('B');
    expect(ev.d.bnc_lines).toHaveLength(1);
    expect(ev.d.payments).toHaveLength(1);
  });

  it('lo que no está verificado al 100 % queda por confirmar con su motivo', async () => {
    const r = await sync(true);
    const by = Object.fromEntries(r.unverified.map(x => [x.order_number, x]));
    expect(by['OS-000231'].reason).toBe('AMOUNT_SHORT');
    expect(by['OS-000300'].reason).toBe('BNC_AMOUNT_MISMATCH');
    expect(by['OS-000310'].reason).toBe('NO_BNC_LINE');
    expect(by['OS-000310'].hint).toBe('Pago en Cashea del 02/11, pero el estado del BNC que subiste llega hasta el 30/10. Sube uno más reciente.');
    expect(by['OS-000057'].reason).toBe('NO_SNAPSHOT_NO_PAYMENT');
    expect(await q("select o.order_number,i.status from public.cashea_installments i join public.cashea_sales s on s.id=i.cashea_sale_id join public.orders o on o.id=s.order_id where o.order_number in ('OS-000300','OS-000310','OS-000057') order by 1"))
      .toEqual([{ order_number: 'OS-000057', status: 'PENDING' }, { order_number: 'OS-000300', status: 'PENDING' }, { order_number: 'OS-000310', status: 'PENDING' }]);
  });

  it('regla A, cancelada en Cashea, repetible y nunca toca una cuota pagada', async () => {
    await sale('OS-000400', '666', 20);
    await db.query("insert into public.cashea_order_snapshots(external_order,purchased_on,status,total_ref,initial_ref,installments) values('666','2026-10-01','IN PROGRESS',100,40,$1::jsonb)",
      [JSON.stringify([{ number: 1, paid_ref: '20', status: 'DONE' }])]);
    await sale('OS-000401', '777', 20);
    await db.query("insert into public.cashea_order_snapshots(external_order,purchased_on,status,total_ref,initial_ref,installments) values('777','2026-10-01','CANCELLED',100,40,$1::jsonb)",
      [JSON.stringify([{ number: 1, paid_ref: '20', status: 'DONE' }])]);
    const paidBefore = await q("select id,paid_ref::text,paid_at::text from public.cashea_installments where status='PAID' order by id");
    const r = await sync();
    expect(r).toMatchObject({ paid: 1, partial: 0, by_rule: { A: 1, B: 0 } });
    expect(r.unverified.find(x => x.order_number === 'OS-000401')?.reason).toBe('ORDER_CANCELLED_IN_CASHEA');
    expect(await q("select id,paid_ref::text,paid_at::text from public.cashea_installments where id = any($1::uuid[]) order by id", [paidBefore.map(x => x.id)])).toEqual(paidBefore);
    expect(await sync()).toMatchObject({ paid: 0, partial: 0, settled: 0 });
    // La v1 sigue respondiendo con sus mismas claves.
    expect((await one<{ r: unknown }>('select public.cashea_conc_sync_installments() r')).r).toEqual({ paid: 0, partial: 0, settled: 0 });
  });

  it('pide un administrador financiero y muestra la fuente de cada cuota pagada', async () => {
    await db.query("set test.role='OPERATOR'");
    await expect(db.query('select public.cashea_conc_sync_installments_v2(true)')).rejects.toThrow(/administrador/);
    await db.query("set test.role='OWNER'");
    const t = (await one<{ t: { paid_sources: Record<string, string>; without_reference: number } }>('select public.cashea_tracking_status() t')).t;
    expect(Object.values(t.paid_sources).sort()).toEqual(['BNC', 'CASHEA']);
    expect(t.without_reference).toBe(1);
  });
});

describe('Cashea: textos', () => {
  it('aviso tras importar, fuentes y frescura', () => {
    expect(syncNotice({ paid: 32, partial: 1, settled: 2, unverified: new Array(30) })).toBe(
      'Se marcaron 32 cuotas pagadas (verificadas con el BNC o según Cashea), 1 parcial, 2 ventas saldadas. 30 quedan por confirmar.');
    expect(paidSourceLabel('BNC')).toBe('Pagada · verificada con BNC');
    expect(paidSourceLabel('CASHEA')).toBe('Pagada · según Cashea');
    expect(paidSourceLabel(undefined)).toBe('Pagada a mano');
    const t = { orders_to: '2026-10-29', payments_to: '2026-10-29', bnc_to: '2026-10-30', never_in_orders_export: 31, oldest_missing_since: '2026-09-14', without_reference: 3, paid_sources: {} };
    expect(freshnessLine(t)).toBe('Último export de órdenes: 29/10 · de pagos: 29/10 · BNC: 30/10');
    expect(trackingWarnings(t)).toEqual(['31 ventas nunca vinieron en el export de órdenes; pide uno desde el 14/09.', '3 ventas sin número de Cashea.']);
  });
});

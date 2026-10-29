import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261029120000_cashea_branch_conciliation.sql', 'utf8');
const autofix = readFileSync('supabase/migrations/20261029180000_cashea_conciliation_autofix.sql', 'utf8');
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

// Minimal stand-ins for the production objects this migration reads or updates.
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
   create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,created_at timestamptz default now());
   create function lubricenter_private.finance_audit() returns trigger language plpgsql as $$ begin insert into public.audit_events(event_type,entity_type) values('finance.'||lower(tg_op),tg_table_name); return coalesce(new,old); end $$;
   create table public.orders(id uuid primary key default gen_random_uuid(),order_number text,status text,total_ref numeric,business_at timestamptz,closed_at timestamptz,opened_at timestamptz default now());
   create table public.cashea_sales(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),cashea_reference text,status text,ownership_status text default 'OWN',gross_ref numeric,initial_ref numeric,settled_at timestamptz,initial_payment_method text);
   create table public.cashea_installments(id uuid primary key default gen_random_uuid(),cashea_sale_id uuid references public.cashea_sales(id),installment_no integer,due_date date,amount_ref numeric,paid_ref numeric default 0,paid_ves_actual numeric default 0,status text default 'PENDING',paid_at timestamptz,updated_at timestamptz);
   create table public.payments(id uuid primary key default gen_random_uuid(),order_id uuid,method text,currency text,amount_original numeric,reference text,paid_at timestamptz,receivable_id uuid,financial_account_id uuid);
   create table public.financial_accounts(id uuid primary key default gen_random_uuid(),code text unique,active boolean default true);
   insert into public.financial_accounts(code) values('BDV'),('BNC');
   create table public.account_movements(id uuid primary key default gen_random_uuid(),account_id uuid,source_payment_id uuid,reference text,amount_original numeric);
   create table public.reconciliation_allocations(id uuid primary key default gen_random_uuid(),account_movement_id uuid,reversed_at timestamptz);
   create table public.order_tenders(id uuid primary key default gen_random_uuid(),order_id uuid,payment_id uuid);
   create function lubricenter_private.require_order_admin() returns void language plpgsql as $$ begin if lubricenter_private.finance_role() not in ('ADMIN','OWNER') then raise exception 'Solo administradores'; end if; end $$;
   create table public.external_sources(id uuid primary key default gen_random_uuid(),provider text);
   create table public.external_import_batches(id uuid primary key default gen_random_uuid(),source_id uuid,row_count integer,observed_from date,observed_to date,created_at timestamptz default now());
   create table public.external_transactions(id uuid primary key default gen_random_uuid(),source_id uuid,occurred_at timestamptz,reference text,description text,direction text default 'IN',currency text,amount numeric,balance numeric,amount_ref numeric,exchange_rate numeric,rate_date date,external_order text,installments integer[],ownership_status text,ownership_reason text,ownership_evidence jsonb,raw jsonb);
   create table public.reconciliation_transaction_exclusions(transaction_id uuid);
   create table public.cashea_order_snapshots(id uuid primary key default gen_random_uuid(),batch_id uuid,external_order text,purchased_on date,status text,total_ref numeric,initial_ref numeric,installments jsonb,raw jsonb,created_at timestamptz default now());
  `);
  await db.exec(migration);
  await db.exec(autofix);
}, 120000);
afterAll(async () => { await db?.close(); });

const lines = (specs: [string, number, string, number, number, number][]) => JSON.stringify(specs.map(([date, idx, ref, debit, credit, balance], row) => ({ row, line_date: date, day_index: idx, reference: ref, debit, credit, balance, op_type: debit ? 'Crédito Inmediato Emitido' : 'Abono Pago Movil BNC', description: 'x' })));

describe('Cashea branch reconciliation database layer', () => {
  it('seeds branches, withdrawal destinations and the 21 Oct zero', async () => {
    expect((await q<{ code: string }>('select code from public.cashea_branches order by sort')).map(r => r.code)).toEqual(['CABUDARE', 'NORTE', 'LA_MORAN', 'AFUERA', 'AFUERA_SIN_ASIGNAR', 'POR_CONFIRMAR']);
    expect(await one('select cut_date::text,reference,balance_ves::text from public.cashea_cutoffs')).toEqual({ cut_date: '2026-10-21', reference: '34806', balance_ves: '1802.12' });
    expect(await q('select cedula,branch from public.cashea_withdrawal_destinations order by cedula')).toEqual([{ cedula: 'V12306298', branch: 'AFUERA_SIN_ASIGNAR' }, { cedula: 'V30881436', branch: 'CABUDARE' }]);
  });

  it('imports overlapping BNC statements once and attaches the saved zero to its line', async () => {
    const first = await one<{ r: { inserted: number } }>('select public.cashea_conc_import_bnc($1,$2::jsonb,true) r', ['Rpt1.xls', lines([
      ['2026-10-21', 0, '000034806', 268000, 0, 2606.12], ['2026-10-21', 1, '000034806', 804, 0, 1802.12], ['2026-10-22', 0, '001198693760', 0, 1000, 2802.12]])]);
    expect(first.r.inserted).toBe(3);
    const second = await one<{ r: { inserted: number; duplicates: number } }>('select public.cashea_conc_import_bnc($1,$2::jsonb,true) r', ['Rpt2.xls', lines([
      ['2026-10-22', 0, '1198693760', 0, 1000, 2802.12], ['2026-10-22', 1, '5', 0, 500, 3302.12]])]);
    expect(second.r).toMatchObject({ inserted: 1, duplicates: 1 });
    expect((await one<{ n: number }>('select count(*)::int n from public.cashea_bnc_lines')).n).toBe(4);
    const cut = await one<{ ref: string; bal: string }>('select l.reference ref,l.balance::text bal from public.cashea_cutoffs c join public.cashea_bnc_lines l on l.id=c.bank_line_id');
    expect(cut).toEqual({ ref: '000034806', bal: '1802.12' });
    await expect(db.query('select public.cashea_conc_import_bnc($1,$2::jsonb,true)', ['bad', JSON.stringify([{ line_date: '2026-10-23', day_index: 0, reference: '1', debit: 5, credit: 5, balance: 1 }])])).rejects.toThrow(/inválido/);
  });

  it('marks a new zero only after the previous one and under 10.000 Bs', async () => {
    const big = await one<{ id: string }>("select id from public.cashea_bnc_lines where reference='5'");
    await expect(db.query('select public.cashea_conc_mark_cutoff($1,null,null)', [big.id])).rejects.toThrow(/retiro/);
    await db.query('select public.cashea_conc_import_bnc($1,$2::jsonb,true)', ['Rpt3.xls', lines([['2026-10-24', 0, '777', 0, 20000, 23302.12], ['2026-10-24', 1, '778', 15000, 0, 8302.12]])]);
    const ok = await one<{ id: string }>("select id from public.cashea_bnc_lines where reference='778'");
    const id = await one<{ c: string }>('select public.cashea_conc_mark_cutoff($1,$2,$3::jsonb) c', [ok.id, 'Retiro Cabudare', JSON.stringify({ total: '8302.12' })]);
    expect(id.c).toBeTruthy();
    const old = await one<{ id: string }>("select id from public.cashea_bnc_lines where reference='000034806' and debit=804");
    await expect(db.query('select public.cashea_conc_mark_cutoff($1,null,null)', [old.id])).rejects.toThrow(/posterior/);
  });

  it('keeps manual decisions with history and validates adjustments', async () => {
    await db.query("select public.cashea_conc_set_override('ORDER','236300001','NORTE','Confirmado por Norte')");
    await db.query("select public.cashea_conc_set_override('ORDER','236300001','LA_MORAN','Corregido: era La Morán')");
    expect(await q("select branch,revoked_at is null active from public.cashea_ownership_overrides order by created_at,revoked_at nulls last")).toEqual([{ branch: 'NORTE', active: false }, { branch: 'LA_MORAN', active: true }]);
    await expect(db.query("select public.cashea_conc_set_override('ORDER','abc','NORTE','x x x')")).rejects.toThrow(/inválido/);
    await db.query("select public.cashea_conc_adjustment('2026-10-25',45000,'NORTE','CABUDARE','Traspaso BDV a Norte','0591326216508')");
    await expect(db.query("select public.cashea_conc_adjustment('2026-10-25',10,'NORTE','NORTE','x x x')")).rejects.toThrow(/distintas/);
    await db.query("set test.role='OPERATOR'");
    await expect(db.query('select public.cashea_conc_dataset(null)')).rejects.toThrow(/administrador/);
    await db.query("set test.role='ADMIN'");
    const adj = await one<{ id: string }>('select id from public.cashea_branch_adjustments');
    await db.query("select public.cashea_conc_void('ADJUSTMENT',$1,'Registrado dos veces')", [adj.id]);
    const cut = await one<{ id: string }>('select id from public.cashea_cutoffs where voided_at is null order by cut_date desc limit 1');
    await expect(db.query("select public.cashea_conc_void('CUTOFF',$1,'Prueba de permiso')", [cut.id])).rejects.toThrow(/administrador/);
    await db.query("set test.role='OWNER'");
  });

  it('applies branch ownership to Cashea collections without touching OS-linked ones', async () => {
    const src = await one<{ id: string }>("insert into public.external_sources(provider) values('CASHEA_TRANSACTIONS') returning id");
    await db.query(`insert into public.external_transactions(source_id,occurred_at,reference,currency,amount,external_order,installments,ownership_status,ownership_reason,raw) values
      ($1,'2026-10-23','1','VES',100,'236100001','{1}','UNRESOLVED','UNKNOWN','{}'),
      ($1,'2026-10-23','2','VES',100,'236000001','{1}','OWN','ORDER_MATCH','{}'),
      ($1,'2026-10-23','3','VES',100,'236999999','{1}','OTHER_LOCATION','BRANCH:AFUERA','{}')`, [src.id]);
    const r = await one<{ r: { other_location: number; returned: number } }>('select public.cashea_conc_apply_ownership($1::jsonb) r', [JSON.stringify([
      { external_order: '236100001', branch: 'NORTE' }, { external_order: '236000001', branch: 'NORTE' }, { external_order: '236999999', branch: 'CABUDARE' }])]);
    expect(r.r).toEqual({ other_location: 1, returned: 1 });
    expect(await q('select external_order,ownership_status,ownership_reason from public.external_transactions order by reference')).toEqual([
      { external_order: '236100001', ownership_status: 'OTHER_LOCATION', ownership_reason: 'BRANCH:NORTE' },
      { external_order: '236000001', ownership_status: 'OWN', ownership_reason: 'ORDER_MATCH' },
      { external_order: '236999999', ownership_status: 'UNRESOLVED', ownership_reason: 'UNKNOWN' }]);
  });

  it('syncs OS instalments from the latest Cashea orders export and settles completed sales', async () => {
    const o = await one<{ id: string }>("insert into public.orders(order_number,status,total_ref) values('OS-000300','CLOSED',100) returning id");
    const s = await one<{ id: string }>("insert into public.cashea_sales(order_id,cashea_reference,status,gross_ref,initial_ref) values($1,'236000001','ACTIVE',100,40) returning id", [o.id]);
    for (const n of [1, 2, 3]) await db.query("insert into public.cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref) values($1,$2,'2026-11-01',20)", [s.id, n]);
    const snap = (status: string[], paid: number[]) => JSON.stringify(status.map((st, i) => ({ number: i + 1, due_date: '2026-11-01', amount_ref: '20', paid_ref: String(paid[i]), status: st })));
    await db.query("insert into public.cashea_order_snapshots(external_order,purchased_on,status,total_ref,initial_ref,installments,created_at) values('236000001','2026-10-01','IN PROGRESS',100,40,$1::jsonb,'2026-10-20')", [snap(['SCHEDULED', 'SCHEDULED', 'SCHEDULED'], [0, 0, 0])]);
    await db.query("insert into public.cashea_order_snapshots(external_order,purchased_on,status,total_ref,initial_ref,installments,created_at) values('236000001','2026-10-01','IN PROGRESS',100,40,$1::jsonb,'2026-10-28')", [snap(['DONE', 'SCHEDULED', 'SCHEDULED'], [20, 5, 0])]);
    const first = await one<{ r: unknown }>('select public.cashea_conc_sync_installments() r');
    expect(first.r).toEqual({ paid: 1, partial: 1, settled: 0 });
    expect(await q('select installment_no,status,paid_ref::float paid,paid_ves_actual::float ves from public.cashea_installments order by installment_no')).toEqual([
      { installment_no: 1, status: 'PAID', paid: 20, ves: 100 }, { installment_no: 2, status: 'PARTIAL', paid: 5, ves: 0 }, { installment_no: 3, status: 'PENDING', paid: 0, ves: 0 }]);
    expect((await one<{ r: unknown }>('select public.cashea_conc_sync_installments() r')).r).toEqual({ paid: 0, partial: 0, settled: 0 });
    await db.query("insert into public.cashea_order_snapshots(external_order,purchased_on,status,total_ref,initial_ref,installments,created_at) values('236000001','2026-10-01','CLOSED',100,40,$1::jsonb,'2026-11-20')", [snap(['DONE', 'DONE', 'DONE'], [20, 20, 20])]);
    expect((await one<{ r: unknown }>('select public.cashea_conc_sync_installments() r')).r).toEqual({ paid: 2, partial: 0, settled: 1 });
    expect((await one<{ status: string }>('select status from public.cashea_sales where id=$1', [s.id])).status).toBe('SETTLED');
    expect((await one<{ n: number }>("select count(*)::int n from public.audit_events where event_type='cashea.installment_synced_from_export'")).n).toBe(4);
  });

  it('corrects a sale reference with audit and returns that order to the normal flow', async () => {
    const o = await one<{ id: string }>("insert into public.orders(order_number,status,total_ref) values('OS-000064','CLOSED',81) returning id");
    const s = await one<{ id: string }>("insert into public.cashea_sales(order_id,cashea_reference,status,gross_ref,initial_ref) values($1,'21606102','ACTIVE',81,32) returning id", [o.id]);
    const src = await one<{ id: string }>("select id from public.external_sources where provider='CASHEA_TRANSACTIONS'");
    await db.query("insert into public.external_transactions(source_id,occurred_at,reference,currency,amount,external_order,installments,ownership_status,ownership_reason,raw) values($1,'2026-10-23','9','VES',100,'216061026','{1}','OTHER_LOCATION','BRANCH:AFUERA','{}')", [src.id]);
    await expect(db.query("select public.cashea_conc_set_reference($1,'21606A','Falta un dígito')", [s.id])).rejects.toThrow(/números/);
    await db.query("select public.cashea_conc_set_reference($1,'216061026','Faltaba el último dígito')", [s.id]);
    expect((await one<{ r: string }>('select cashea_reference r from public.cashea_sales where id=$1', [s.id])).r).toBe('216061026');
    expect(await one("select ownership_status,ownership_reason from public.external_transactions where external_order='216061026'")).toEqual({ ownership_status: 'UNRESOLVED', ownership_reason: 'UNKNOWN' });
    expect((await one<{ d: { before: string } }>("select data d from public.audit_events where event_type='cashea.reference_corrected'")).d.before).toBe('21606102');
  });

  it('returns the dataset with the latest snapshot per order', async () => {
    const d = await one<{ d: { cashea_orders: { external_order: string; status: string }[]; bank_lines: unknown[]; cutoffs: unknown[]; os_sales: unknown[]; cashea_payments: unknown[] } }>("select public.cashea_conc_dataset('2026-10-01') d");
    expect(d.d.cashea_orders).toEqual([expect.objectContaining({ external_order: '236000001', status: 'CLOSED' })]);
    expect(d.d.bank_lines).toHaveLength(6);
    expect(d.d.cutoffs).toHaveLength(2);
    expect(d.d.os_sales).toHaveLength(2);
    expect(d.d.cashea_payments).toHaveLength(4);
  });

  it('moves an OS payment to BNC with the bank reference only after confirmation and with matching evidence', async () => {
    const o = await one<{ id: string }>("insert into public.orders(order_number,status,total_ref) values('OS-000321','CLOSED',82.5) returning id");
    await db.query("insert into public.cashea_sales(order_id,cashea_reference,status,gross_ref,initial_ref) values($1,'235385859','ACTIVE',82.5,33)", [o.id]);
    const bdv = await one<{ id: string }>("select id from public.financial_accounts where code='BDV'");
    const p = await one<{ id: string }>("insert into public.payments(order_id,method,currency,amount_original,reference,paid_at,financial_account_id) values($1,'TRANSFER_BDV','VES',29245.49,'2884','2026-10-24T17:09:13Z',$2) returning id", [o.id, bdv.id]);
    await db.query("insert into public.account_movements(account_id,source_payment_id,reference,amount_original) values($1,$2,'2884',29245.49)", [bdv.id, p.id]);
    await db.query('select public.cashea_conc_import_bnc($1,$2::jsonb,true)', ['Rpt4.xls', JSON.stringify([
      { row: 1, line_date: '2026-10-24', day_index: 5, reference: '001193082884', debit: 0, credit: 29245.49, balance: 52547.61 },
      { row: 2, line_date: '2026-10-27', day_index: 0, reference: '777700001111', debit: 0, credit: 29245.49, balance: 81793.10 }])]);
    const line = await one<{ id: string }>("select id from public.cashea_bnc_lines where reference='001193082884'");
    const late = await one<{ id: string }>("select id from public.cashea_bnc_lines where reference='777700001111'");
    await expect(db.query('select public.cashea_conc_fix_payment($1,$2,false)', [p.id, line.id])).rejects.toThrow(/Confirma/);
    await expect(db.query('select public.cashea_conc_fix_payment($1,$2,true)', [p.id, late.id])).rejects.toThrow(/fecha/);
    const r = await one<{ r: { reference: string } }>('select public.cashea_conc_fix_payment($1,$2,true) r', [p.id, line.id]);
    expect(r.r.reference).toBe('001193082884');
    expect(await one('select p.method,p.reference,a.code from public.payments p join public.financial_accounts a on a.id=p.financial_account_id where p.id=$1', [p.id])).toEqual({ method: 'TRANSFER_BNC', reference: '001193082884', code: 'BNC' });
    expect(await one('select a.code,m.reference,m.amount_original::float amt from public.account_movements m join public.financial_accounts a on a.id=m.account_id where m.source_payment_id=$1', [p.id])).toEqual({ code: 'BNC', reference: '001193082884', amt: 29245.49 });
    expect((await one<{ n: number }>("select count(*)::int n from public.audit_events where event_type='cashea.conciliation_payment_fixed'")).n).toBe(1);
    await expect(db.query('select public.cashea_conc_fix_payment($1,$2,true)', [p.id, line.id])).rejects.toThrow(/ya está registrado/);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceError } from '../lib/finance/money';

const migration = readFileSync('supabase/migrations/20261114154523_por_cobrar_y_notas.sql', 'utf8');
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
const fails = async (sql: string, params: unknown[] = []) => {
  try { await q(sql, params); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const STAFF = '00000000-0000-4000-8000-0000000000e2';
const OUTSIDER = '00000000-0000-4000-8000-0000000000ff';
const login = (uid: string) => db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false)`);

async function openOrder(totalVes = 1000) {
  const o = await one<{ id: string }>(`insert into public.orders(order_number, status) values ('OS-' || floor(random()*1e6)::text, 'OPEN') returning id`);
  await q(`insert into public.order_items(order_id, charged_ves_amount) values ($1, $2)`, [o.id, totalVes]);
  return o.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   create role anon; create role authenticated;
   create schema auth; create schema lubricenter_private;
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
   create function public.require_auth() returns void language plpgsql as $$ begin
     if auth.uid() is null then raise exception 'USUARIO_NO_AUTORIZADO'; end if; end $$;
   create function lubricenter_private.staff_can(p_key text) returns boolean language sql stable as $$ select auth.uid() <> '${OUTSIDER}' $$;
   create table public.audit_events(id uuid primary key default gen_random_uuid(), event_type text, entity_type text, entity_id uuid, data jsonb);
   create table public.financial_accounts(id uuid primary key default gen_random_uuid(), code text not null, name text not null,
     currency text not null, account_type text not null check (account_type in ('CASH','BANK','CLEARING','RELATED')), active boolean not null default true);
   insert into public.financial_accounts(code, name, currency, account_type) values ('BDV', 'Banco de Venezuela', 'VES', 'BANK');
   create table public.orders(id uuid primary key default gen_random_uuid(), order_number text, status text, total_ves numeric, total_ref numeric);
   create table public.order_items(id uuid primary key default gen_random_uuid(), order_id uuid, charged_ves_amount numeric);
   create table public.payments(id uuid primary key default gen_random_uuid(), order_id uuid, method text not null, currency text,
     amount_original numeric, bcv_rate_snapshot numeric, operative_rate_snapshot numeric, value_ves numeric, value_ref numeric,
     reference text, financial_account_id uuid,
     constraint payments_method_check check (method in ('CASH_USD','TRANSFER_BDV')));
   create table public.account_movements(id uuid primary key default gen_random_uuid(), account_id uuid, source_payment_id uuid, value_ves numeric);
   create table public.sale_operation_requests(id uuid primary key, actor_id uuid, kind text, payload jsonb, result jsonb, created_at timestamptz);
   create function public.get_order_rates(p_order_id uuid) returns table(bcv_rate numeric, operative_rate numeric) language sql as $$ select 100::numeric, 120::numeric $$;
   create function public.close_order(p_order_id uuid) returns void language plpgsql as $$ begin
     if (select coalesce(sum(charged_ves_amount),0) from public.order_items where order_id = p_order_id)
        - (select coalesce(sum(value_ves),0) from public.payments where order_id = p_order_id) > 1 then raise exception 'Falta cobrar'; end if;
     update public.orders set status = 'CLOSED', total_ves = (select sum(charged_ves_amount) from public.order_items where order_id = p_order_id) where id = p_order_id;
   end $$;
   create function public.build_quick_sale_order(p_items jsonb) returns table(order_id uuid, order_number text) language plpgsql as $$
   declare v uuid; begin
     insert into public.orders(order_number, status) values ('OS-QS', 'OPEN') returning id into v;
     insert into public.order_items(order_id, charged_ves_amount) select v, (x->>'ves')::numeric from jsonb_array_elements(p_items) x;
     order_id := v; order_number := 'OS-QS'; return next; end $$;
  `);
  await db.exec(migration);
  await db.exec(migration); // Reaplicable.
  // Mismos disparadores que producción: asignar cuenta y registrar el movimiento.
  await db.exec(`
   create trigger trg_assign_payment_account before insert on public.payments for each row execute function public.assign_payment_account();
   create function public.capture_payment_movement() returns trigger language plpgsql as $$ begin
     insert into public.account_movements(account_id, source_payment_id, value_ves) values (new.financial_account_id, new.id, new.value_ves); return new; end $$;
   create trigger trg_capture_payment_movement after insert on public.payments for each row execute function public.capture_payment_movement();
  `);
  await login(STAFF);
}, 120000);
afterAll(async () => { await db?.close(); });

describe('cuenta «Por cobrar»', () => {
  it('existe una sola vez y el método POR_COBRAR va a esa cuenta', async () => {
    expect(await one(`select count(*)::int n, min(account_type) t from public.financial_accounts where code = 'POR_COBRAR'`)).toEqual({ n: 1, t: 'CLEARING' });
  });

  it('cubre el saldo de la orden, guarda la nota y el movimiento entra a «Por cobrar», no al banco', async () => {
    const id = await openOrder(1000);
    await q(`insert into public.payments(order_id, method, currency, amount_original, bcv_rate_snapshot, operative_rate_snapshot, value_ves, value_ref)
      values ($1, 'TRANSFER_BDV', 'VES', 400, 100, 120, 400, 4)`, [id]);
    await one(`select public.order_add_por_cobrar($1, 'Lo cobró el vecino, abona a la deuda')`, [id]);
    const pay = await one<{ value_ves: string; code: string }>(`select p.value_ves::text, a.code from public.payments p
      join public.financial_accounts a on a.id = p.financial_account_id where p.order_id = $1 and p.method = 'POR_COBRAR'`, [id]);
    expect(pay).toEqual({ value_ves: '600.00', code: 'POR_COBRAR' });
    const mov = await one<{ code: string }>(`select a.code from public.account_movements m join public.payments p on p.id = m.source_payment_id
      join public.financial_accounts a on a.id = m.account_id where p.method = 'POR_COBRAR' and p.order_id = $1`, [id]);
    expect(mov.code).toBe('POR_COBRAR');
    expect(await one(`select note, kind from public.order_notes where order_id = $1`, [id]))
      .toEqual({ note: 'Lo cobró el vecino, abona a la deuda', kind: 'POR_COBRAR' });
  });

  it('sin nota no se puede, ni cuando la orden ya está cubierta', async () => {
    const id = await openOrder(500);
    expect(await fails(`select public.order_add_por_cobrar($1, '  ')`, [id])).toMatch(/POR_COBRAR_SIN_NOTA/);
    expect(await fails(`insert into public.payments(order_id, method, currency, amount_original, bcv_rate_snapshot, operative_rate_snapshot, value_ves, value_ref)
      values ($1, 'POR_COBRAR', 'VES', 500, 100, 120, 500, 5)`, [id])).toMatch(/POR_COBRAR_SIN_NOTA/);
    await one(`select public.order_add_por_cobrar($1, 'Pendiente con el vecino')`, [id]);
    expect(await fails(`select public.order_add_por_cobrar($1, 'Otra vez')`, [id])).toMatch(/ya está cubierta/);
  });

  it('un pago POR_COBRAR que llega por otro camino con referencia la guarda como nota', async () => {
    const id = await openOrder(300);
    await q(`insert into public.payments(order_id, method, currency, amount_original, bcv_rate_snapshot, operative_rate_snapshot, value_ves, value_ref, reference)
      values ($1, 'POR_COBRAR', 'VES', 300, 100, 120, 300, 3, 'Corrección: lo cobró el vecino')`, [id]);
    expect((await one<{ note: string }>(`select note from public.order_notes where order_id = $1`, [id])).note).toBe('Corrección: lo cobró el vecino');
  });

  it('Venta rápida «Por cobrar» crea, cobra y cierra la venta en un paso, y no se duplica al reintentar', async () => {
    const req = '00000000-0000-4000-8000-00000000aaaa';
    const items = JSON.stringify([{ ves: 891.11 }]);
    const first = await one<{ r: { order_id: string } }>(`select public.quick_sale_por_cobrar($1, $2::jsonb, 'Aceite cobrado por el vecino') r`, [req, items]);
    const again = await one<{ r: { order_id: string } }>(`select public.quick_sale_por_cobrar($1, $2::jsonb, 'Aceite cobrado por el vecino') r`, [req, items]);
    expect(again.r.order_id).toBe(first.r.order_id);
    expect((await one<{ status: string }>(`select status from public.orders where id = $1`, [first.r.order_id])).status).toBe('CLOSED');
    expect(await fails(`select public.quick_sale_por_cobrar($1, $2::jsonb, 'Otra nota distinta')`, [req, items])).toMatch(/reutilizada/);
    expect(await fails(`select public.quick_sale_por_cobrar(gen_random_uuid(), $1::jsonb, '')`, [items])).toMatch(/POR_COBRAR_SIN_NOTA/);
  });
});

describe('notas de orden', () => {
  it('se agregan en órdenes abiertas y cerradas, con autor', async () => {
    const id = await openOrder(100);
    await db.exec(`update public.orders set status = 'CLOSED' where id = '${id}'`);
    const note = await one<{ r: { note: string; created_by: string } }>(`select public.add_order_note($1, '  Cliente pidió factura a nombre de la empresa ') r`, [id]);
    expect(note.r).toMatchObject({ note: 'Cliente pidió factura a nombre de la empresa', created_by: STAFF });
  });

  it('no se aceptan vacías ni de quien no ve órdenes', async () => {
    const id = await openOrder(100);
    expect(await fails(`select public.add_order_note($1, '   ')`, [id])).toMatch(/Escribe la nota/);
    await login(OUTSIDER);
    expect(await fails(`select public.add_order_note($1, 'hola')`, [id])).toMatch(/PERMISO_DENEGADO/);
    await login(STAFF);
  });

  it('nadie del equipo puede escribir la tabla directamente', async () => {
    const grants = await q<{ privilege_type: string }>(`select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'order_notes' and grantee in ('anon', 'authenticated')`);
    expect(grants.map(g => g.privilege_type)).toEqual(['SELECT']);
  });

  it('en pantalla, «Por cobrar» exige una nota de al menos 5 letras', () => {
    expect(referenceError('POR_COBRAR', 'abc')).toMatch(/nota/);
    expect(referenceError('POR_COBRAR', 'Lo cobró el vecino')).toBeNull();
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Corre la migración real sobre stand-ins mínimos de producción.
const migration = readFileSync('supabase/migrations/20261114153946_quick_sale_server_pricing.sql', 'utf8');
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
const fails = async (sql: string, params: unknown[] = []) => {
  try { await q(sql, params); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const ENDER = '00000000-0000-4000-8000-0000000000e2';
const OIL = '00000000-0000-4000-8000-00000000a001';   // 10 USD → lista 10 × 60 / 50 = 12 REF
const FILTER = '00000000-0000-4000-8000-00000000a002'; // 5 USD → 6 REF
const CAT = '00000000-0000-4000-8000-00000000b001';    // producto de catálogo, 2 USD → 2,4 REF
const login = (uid: string | null) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`);

let seq = 0;
async function order(lines: Array<{ inv?: string; product?: string; ref: number; qty?: number; role?: string; mode?: string; type?: string }>) {
  seq += 1;
  const id = (await one<{ id: string }>(`insert into public.orders(order_number, status) values ($1, 'OPEN') returning id`, [`OS-T${seq}`])).id;
  for (const l of lines) {
    await q(`insert into public.order_items(order_id, item_type, inventory_item_id, product_id, quantity, charged_ref_amount, line_role, pricing_mode, bcv_rate_snapshot, operative_rate_snapshot)
      values ($1, $2, $3, $4, $5, $6, $7, $8, 50, 60)`, [id, l.type ?? 'PRODUCT', l.inv ?? null, l.product ?? null, l.qty ?? 1, l.ref, l.role ?? null, l.mode ?? 'STANDARD']);
  }
  return id;
}
const close = (id: string) => fails(`update public.orders set status = 'CLOSED' where id = $1`, [id]);
const status = async (id: string) => one<{ status: string; price_expected_ref: string; price_reduction_ref: string; price_override_approval_id: string | null }>(
  `select status, price_expected_ref::text, price_reduction_ref::text, price_override_approval_id from public.orders where id = $1`, [id]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   create role anon; create role authenticated; create role service_role;
   create schema auth; create schema lubricenter_private; create schema extensions;
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
   create table public.app_settings(key text primary key, value jsonb);
   insert into public.app_settings values ('price_rounding_step', '0.01'), ('price_rounding_mode', '"nearest"'), ('discount_free_limit_percent', '10');
   create function lubricenter_private.setting_number(p_key text, p_default numeric) returns numeric language sql stable as $$
     select coalesce((select (value #>> '{}')::numeric from public.app_settings where key = p_key), p_default) $$;
   create function public.round_to_step(p_value numeric, p_step numeric, p_mode text) returns numeric language plpgsql immutable as $$
   begin
     if p_step is null or p_step <= 0 then return p_value; end if;
     if p_mode = 'up' then return ceil(p_value / p_step) * p_step; end if;
     if p_mode = 'down' then return floor(p_value / p_step) * p_step; end if;
     return round(p_value / p_step) * p_step;
   end $$;
   create function lubricenter_private.finance_role() returns text language sql stable as $$
     select case when auth.uid() = '${OWNER}' then 'OWNER' else 'OPERATOR' end $$;
   create function public.require_auth() returns void language plpgsql as $$ begin
     if auth.uid() is null then raise exception 'USUARIO_NO_AUTORIZADO'; end if; end $$;
   create table lubricenter_private.owner_secrets(key text primary key, pin text, failed_attempts int default 0);
   insert into lubricenter_private.owner_secrets(key, pin) values ('discount_pin', '2468');
   create function lubricenter_private.owner_pin_check(p_pin text) returns text language plpgsql as $$
   begin
     if p_pin = (select pin from lubricenter_private.owner_secrets where key = 'discount_pin') then return 'OK'; end if;
     update lubricenter_private.owner_secrets set failed_attempts = failed_attempts + 1 where key = 'discount_pin';
     return 'WRONG';
   end $$;
   create table public.audit_events(id uuid primary key default gen_random_uuid(), event_type text, entity_type text, entity_id uuid, data jsonb, created_at timestamptz default now());
   create table public.inventory_items(id uuid primary key, sku text, price_usd numeric);
   insert into public.inventory_items values ('${OIL}', 'OIL', 10), ('${FILTER}', 'FIL', 5);
   create table public.products(id uuid primary key, cash_usd_base_price numeric);
   insert into public.products values ('${CAT}', 2);
   create table public.orders(id uuid primary key default gen_random_uuid(), order_number text, status text,
     adjust_discount_percent numeric default 0, adjust_rounding_ref numeric default 0, adjust_owner_approved boolean default false);
   create table public.order_items(id uuid primary key default gen_random_uuid(), order_id uuid, item_type text, business_area text,
     description text, product_id uuid, inventory_item_id uuid, quantity numeric, pricing_mode text, line_role text,
     charged_ref_amount numeric, list_ref_amount numeric, bcv_rate_snapshot numeric, operative_rate_snapshot numeric);
   create function lubricenter_private.effective_line_role(i public.order_items) returns text language sql immutable as $$
     select coalesce(i.line_role, case when i.item_type = 'SERVICE' then 'LABOR' else 'PRODUCT' end) $$;
  `);
  await db.exec(migration);
  await db.exec(migration); // Reaplicable.
}, 120000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await login(ENDER); await db.exec(`update lubricenter_private.price_override_approvals set expires_at = now() where used_order_id is null`); });

describe('precio de lista guardado en cada línea', () => {
  it('inventario y catálogo guardan la lista con las tasas de la línea; manuales, servicios y cortesías no', async () => {
    const id = await order([{ inv: OIL, ref: 12 }, { product: CAT, ref: 2.4, qty: 2 }, { ref: 7 }, { ref: 20, type: 'SERVICE' }, { inv: FILTER, ref: 0, mode: 'BONUS' }]);
    const rows = await q<{ list: string | null; entered: string }>(
      `select list_unit_ref_snapshot::text list, entered_ref_amount::text entered from public.order_items where order_id = $1 order by charged_ref_amount desc`, [id]);
    expect(rows.map(r => r.list === null ? null : Number(r.list))).toEqual([null, 12, null, 2.4, null]);
    expect(rows.map(r => Number(r.entered))).toEqual([20, 12, 7, 2.4, 0]);
  });
});

describe('cierre de una persona que no es el dueño', () => {
  it('cobra a precio de lista sin pedir nada y registra rebaja 0', async () => {
    const id = await order([{ inv: OIL, ref: 12 }, { inv: FILTER, ref: 6 }]);
    expect(await close(id)).toBe('');
    expect(await status(id)).toMatchObject({ status: 'CLOSED', price_expected_ref: '18.00', price_reduction_ref: '0.00' });
  });

  it('una rebaja de hasta 10% pasa y queda registrada con su evento', async () => {
    const id = await order([{ inv: OIL, ref: 11 }, { inv: FILTER, ref: 5.5 }]); // 18 → 16,5 (8,3%)
    expect(await close(id)).toBe('');
    expect(await status(id)).toMatchObject({ price_reduction_ref: '1.50' });
    const ev = await one<{ data: { reduction_ref: number; owner: boolean } }>(`select data from public.audit_events where event_type = 'order.price_reduction' and entity_id = $1`, [id]);
    expect(ev.data).toMatchObject({ reduction_ref: 1.5, owner: false });
  });

  it('en ventas pequeñas el margen libre es 1 REF (redondear 6 a 5)', async () => {
    const id = await order([{ inv: FILTER, ref: 5 }]);
    expect(await close(id)).toBe('');
  });

  it('una rebaja mayor a 10% sin PIN se rechaza y la orden sigue abierta', async () => {
    const id = await order([{ inv: OIL, ref: 1 }]);
    expect(await close(id)).toMatch(/REBAJA_SIN_AUTORIZACION: esta venta queda 11.00 REF por debajo del precio de lista \(91.7%\)/);
    expect((await status(id)).status).toBe('OPEN');
  });

  it('con el PIN del dueño validado en el servidor pasa una sola vez', async () => {
    expect(await one(`select public.authorize_price_override('0000') r`)).toEqual({ r: { ok: false, error: 'El PIN del dueño no coincide.' } });
    expect((await one<{ n: number }>(`select failed_attempts n from lubricenter_private.owner_secrets`)).n).toBe(1);
    const ok = await one<{ r: { ok: boolean } }>(`select public.authorize_price_override('2468') r`);
    expect(ok.r.ok).toBe(true);
    const first = await order([{ inv: OIL, ref: 1 }]);
    expect(await close(first)).toBe('');
    expect((await status(first)).price_override_approval_id).not.toBeNull();
    const second = await order([{ inv: OIL, ref: 1 }]);
    expect(await close(second)).toMatch(/REBAJA_SIN_AUTORIZACION/);
  });

  it('una autorización vencida no sirve, ni la de otra persona', async () => {
    await login(OWNER);
    await one(`select public.authorize_price_override('2468')`);
    await login(ENDER);
    const id = await order([{ inv: OIL, ref: 1 }]);
    expect(await close(id)).toMatch(/REBAJA_SIN_AUTORIZACION/);
    await one(`select public.authorize_price_override('2468')`);
    await db.exec(`update lubricenter_private.price_override_approvals set expires_at = now() - interval '1 minute' where used_order_id is null`);
    expect(await close(id)).toMatch(/REBAJA_SIN_AUTORIZACION/);
  });

  it('un descuento ya aprobado con PIN en la orden (15%) cubre su porcentaje', async () => {
    const id = await order([{ inv: OIL, ref: 10.2 }]); // 15% bajo lista
    await db.exec(`update public.orders set adjust_discount_percent = 15, adjust_owner_approved = true where id = '${id}'`);
    expect(await close(id)).toBe('');
  });

  it('el redondeo registrado no cuenta como rebaja y el recargo Cashea no entra a la base', async () => {
    const id = await order([{ inv: OIL, ref: 11 }, { ref: 3, role: 'CASHEA_SURCHARGE' }]);
    await db.exec(`update public.orders set adjust_rounding_ref = -1 where id = '${id}'`);
    expect(await close(id)).toBe('');
    expect(await status(id)).toMatchObject({ price_expected_ref: '12.00', price_reduction_ref: '0.00' });
  });

  it('las líneas manuales y los servicios tienen precio libre', async () => {
    const id = await order([{ ref: 1 }, { ref: 1, type: 'SERVICE' }]);
    expect(await close(id)).toBe('');
  });
});

describe('dueño y procesos internos', () => {
  it('el dueño no queda bloqueado, pero la rebaja queda registrada', async () => {
    await login(OWNER);
    const id = await order([{ inv: OIL, ref: 1 }]);
    expect(await close(id)).toBe('');
    expect(await status(id)).toMatchObject({ price_reduction_ref: '11.00' });
    const ev = await one<{ data: { owner: boolean } }>(`select data from public.audit_events where event_type = 'order.price_reduction' and entity_id = $1`, [id]);
    expect(ev.data.owner).toBe(true);
  });

  it('procesos sin usuario (servidor) no se bloquean', async () => {
    const id = await order([{ inv: OIL, ref: 1 }]);
    await login(null);
    expect(await close(id)).toBe('');
  });

  it('nadie del equipo puede leer ni escribir las autorizaciones directamente', async () => {
    const grants = await one<{ n: number }>(`select count(*)::int n from information_schema.role_table_grants
      where table_schema = 'lubricenter_private' and table_name = 'price_override_approvals' and grantee in ('anon', 'authenticated')`);
    expect(grants.n).toBe(0);
  });
});

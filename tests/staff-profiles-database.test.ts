import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canOpenPath, homeFor, isSensitivePath } from '../lib/profile';

const migration = readFileSync('supabase/migrations/20261114154736_staff_profiles.sql', 'utf8');
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const EDGAR = '00000000-0000-4000-8000-0000000000e1';
const ENDER = '00000000-0000-4000-8000-0000000000e2';
const CHEO = '00000000-0000-4000-8000-0000000000c1';
const ALEXIS = '00000000-0000-4000-8000-0000000000a1';
const login = (uid: string) => db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false)`);
const fails = async (sql: string, params: unknown[] = []) => {
  try { await q(sql, params); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

// Stand-ins mínimos de producción (mismas firmas que usan las funciones de la migración).
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   set check_function_bodies = off;
   create role anon; create role authenticated; create role service_role;
   create schema auth; create schema lubricenter_private;
   create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
   insert into auth.users(id, email, email_confirmed_at) values
     ('${OWNER}', 'lubricenterc@gmail.com', now()), ('${EDGAR}', 'edgar@x.com', now()),
     ('${ENDER}', 'ender@x.com', now()), ('${CHEO}', 'cheo@x.com', now()), ('${ALEXIS}', 'alexis@x.com', now());
   create table lubricenter_private.staff_existing_accounts(user_id uuid primary key);
   insert into lubricenter_private.staff_existing_accounts values ('${OWNER}');
   create table public.finance_memberships(user_id uuid primary key, role text);
   create table public.employees(id uuid primary key default gen_random_uuid(), code text, name text, active boolean default true);
   insert into public.employees(code, name) values ('SANTIAGO','Santiago'), ('CHEO','Cheo'), ('ALEXIS','Alexis');
   create table public.staff_users(id uuid primary key default gen_random_uuid(), auth_user_id uuid unique, full_name text not null,
     email text, job_title text, active boolean not null default false, created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now());
   insert into public.staff_users(full_name, job_title) values ('Edgar Jimenez', 'Gerente operativo');
   create table public.staff_permission_catalog(key text primary key, area text, label text, explanation text, recommended boolean, sort_order int);
   insert into public.staff_permission_catalog(key, sort_order) values ('orders.view',1),('orders.create',2),('orders.edit',3),
     ('payments.manage',4),('customers.view',5),('customers.manage',6),('crm.manage',7),('inventory.view',8),('payroll.view',9),
     ('tasks.view',10),('tasks.complete',11);
   create table public.staff_permissions(staff_user_id uuid, permission_key text, enabled boolean, updated_at timestamptz default now(), updated_by uuid,
     primary key (staff_user_id, permission_key));
   create table public.staff_activity_events(id uuid primary key default gen_random_uuid(), staff_user_id uuid, actor_user_id uuid,
     event_key text, entity_type text, entity_id text, details jsonb);
   create table public.audit_events(id uuid primary key default gen_random_uuid(), event_type text, entity_type text, entity_id uuid, data jsonb);
   create table lubricenter_private.owner_secrets(key text primary key);
   insert into lubricenter_private.owner_secrets values ('discount_pin');
   create function lubricenter_private.owner_pin_check(p_pin text) returns text language sql as $$ select case when p_pin = '2468' then 'OK' else 'WRONG' end $$;
   create function lubricenter_private.staff_can(p_key text) returns boolean language sql stable as $$
    select case when not lubricenter_private.staff_identity_allowed() then false
     when exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id=auth.uid()) then true
     else exists(select 1 from public.staff_users s join public.staff_permissions p on p.staff_user_id=s.id
       where s.auth_user_id=auth.uid() and s.active and p.permission_key=p_key and p.enabled) end $$;
   create function lubricenter_private.staff_identity_allowed() returns boolean language sql stable as $$ select true $$;
   create function lubricenter_private.finance_role() returns text language sql stable as $$ select 'OPERATOR' $$;
   create function lubricenter_private.staff_owner() returns boolean language sql stable as $$ select lubricenter_private.finance_role() = 'OWNER' $$;
   create function lubricenter_private.staff_require_owner() returns void language plpgsql as $$ begin
     if not lubricenter_private.staff_owner() then raise exception 'Solo el dueño'; end if; end $$;
   create function public.require_auth() returns void language plpgsql as $$ begin
     if not lubricenter_private.staff_identity_allowed() then raise exception 'USUARIO_NO_AUTORIZADO'; end if; end $$;
   create function lubricenter_private.staff_write_guard() returns trigger language plpgsql as $$ begin return new; end $$;
   create table public.customers(id uuid primary key default gen_random_uuid(), name text);
   create table public.vehicles(id uuid primary key default gen_random_uuid(), plate text, make text, model text, year int);
   create table public.orders(id uuid primary key default gen_random_uuid(), order_number text, status text, customer_id uuid, vehicle_id uuid,
     workflow_status text default 'RECEIVED', workflow_updated_at timestamptz, opened_at timestamptz default now(), closed_at timestamptz,
     business_at timestamptz, health_notes text, crm_observations text);
   create table public.order_items(id uuid primary key default gen_random_uuid(), order_id uuid, description text, quantity numeric default 1,
     worker_employee_id uuid, assistant_bonus_employee_id uuid, line_role text, charged_ref_amount numeric, created_at timestamptz default clock_timestamp());
   create trigger staff_write_guard before insert or update or delete on public.orders for each row execute function lubricenter_private.staff_write_guard();
  `);
  await db.exec(migration);
  // Cuentas enlazadas (lo que hace la ruta /api/staff/accounts al crear cada cuenta).
  await db.exec(`
   update public.staff_users set auth_user_id='${EDGAR}', active=true where profile='ADMIN';
   update public.staff_users set auth_user_id='${ENDER}', active=true where profile='RECEPTION';
   update public.staff_users set auth_user_id='${CHEO}', active=true where full_name='Cheo';
   update public.staff_users set auth_user_id='${ALEXIS}', active=true where full_name='Alexis';
   insert into public.customers(id, name) values ('00000000-0000-4000-8000-00000000c001', 'María Pérez');
   insert into public.vehicles(id, plate, make, model, year) values ('00000000-0000-4000-8000-00000000f001', 'AB123CD', 'Toyota', 'Corolla', 2015);
   insert into public.orders(id, order_number, status, customer_id, vehicle_id) values
     ('00000000-0000-4000-8000-0000000000f1', 'OS-000900', 'OPEN', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000f001'),
     ('00000000-0000-4000-8000-0000000000f2', 'OS-000901', 'OPEN', null, null),
     ('00000000-0000-4000-8000-0000000000f3', 'OS-000800', 'CLOSED', null, '00000000-0000-4000-8000-00000000f001');
   update public.orders set closed_at = now() - interval '3 days' where order_number = 'OS-000800';
   insert into public.order_items(order_id, description, worker_employee_id, charged_ref_amount) values
     ('00000000-0000-4000-8000-0000000000f1', 'Cambio de amortiguadores', (select id from public.employees where code='CHEO'), 80),
     ('00000000-0000-4000-8000-0000000000f2', 'Revisión de alternador', (select id from public.employees where code='ALEXIS'), 30),
     ('00000000-0000-4000-8000-0000000000f3', 'Cambio de correa', (select id from public.employees where code='CHEO'), 40);
   insert into public.order_items(order_id, description, quantity, charged_ref_amount) values
     ('00000000-0000-4000-8000-0000000000f1', 'Amortiguador delantero', 2, 120),
     ('00000000-0000-4000-8000-0000000000f1', 'Importe adicional de Cashea', 1, 9);
  `);
}, 120000);
afterAll(async () => { await db?.close(); });

describe('perfiles de usuario', () => {
  it('crea a Ender, Cheo y Alexis con su perfil y los permisos iniciales', async () => {
    const rows = await q<{ full_name: string; profile: string; n: number }>(`select s.full_name, s.profile,
      (select count(*)::int from public.staff_permissions p where p.staff_user_id=s.id and p.enabled) n
      from public.staff_users s order by s.full_name`);
    expect(rows).toEqual([
      { full_name: 'Alexis', profile: 'MECHANIC', n: 0 },
      { full_name: 'Cheo', profile: 'MECHANIC', n: 0 },
      { full_name: 'Edgar Jimenez', profile: 'ADMIN', n: 11 },
      { full_name: 'Ender', profile: 'RECEPTION', n: 9 },
    ]);
    // Reaplicar la migración no duplica a nadie.
    await db.exec(migration);
    expect((await one<{ n: number }>('select count(*)::int n from public.staff_users')).n).toBe(4);
  });

  it('los mecánicos no pasan la identidad general; Edgar y Ender sí', async () => {
    await login(CHEO);
    expect((await one<{ ok: boolean }>('select lubricenter_private.staff_identity_allowed() ok')).ok).toBe(false);
    expect(await fails(`select public.labor_proposals_list('PENDING')`)).toMatch(/USUARIO_NO_AUTORIZADO/);
    await login(ENDER);
    expect((await one<{ ok: boolean }>('select lubricenter_private.staff_identity_allowed() ok')).ok).toBe(true);
    expect((await one<{ ok: boolean }>(`select lubricenter_private.staff_can('payments.manage') ok`)).ok).toBe(false);
    expect((await one<{ ok: boolean }>(`select lubricenter_private.staff_can('orders.create') ok`)).ok).toBe(true);
  });

  it('my_profile devuelve la persona y sus permisos', async () => {
    await login(ENDER);
    const me = (await one<{ p: { profile: string; name: string; permissions: string[] } }>('select public.my_profile() p')).p;
    expect(me.profile).toBe('RECEPTION');
    expect(me.name).toBe('Ender');
    expect(me.permissions).toContain('crm.manage');
    expect(me.permissions).not.toContain('payments.manage');
    await login(CHEO);
    expect((await one<{ p: { profile: string } }>('select public.my_profile() p')).p.profile).toBe('MECHANIC');
  });
});

describe('app del mecánico', () => {
  it('Cheo ve solo sus vehículos, sin montos, y los repuestos sin líneas de Cashea', async () => {
    await login(CHEO);
    const jobs = (await one<{ r: any[] }>('select public.mechanic_my_jobs() r')).r;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ order_number: 'OS-000900', plate: 'AB123CD', vehicle: 'Toyota Corolla 2015', customer: 'María' });
    expect(jobs[0].my_jobs).toEqual([{ description: 'Cambio de amortiguadores', helper: false }]);
    expect(jobs[0].parts).toEqual([{ description: 'Amortiguador delantero', quantity: 2 }]);
    expect(JSON.stringify(jobs)).not.toMatch(/charged|amount|total|price/);
    const history = (await one<{ r: any[] }>('select public.mechanic_history(30) r')).r;
    expect(history.map(row => row.order_number)).toEqual(['OS-000800']);
  });

  it('marca el avance solo en sus órdenes', async () => {
    await login(CHEO);
    await q(`select public.mechanic_set_stage('00000000-0000-4000-8000-0000000000f1', 'IN_PROGRESS')`);
    expect((await one<{ w: string }>(`select workflow_status w from public.orders where order_number='OS-000900'`)).w).toBe('IN_PROGRESS');
    expect(await fails(`select public.mechanic_set_stage('00000000-0000-4000-8000-0000000000f2', 'READY')`)).toMatch(/no está asignada/);
    expect(await fails(`select public.mechanic_set_stage('00000000-0000-4000-8000-0000000000f1', 'DELIVERED')`)).toMatch(/inválido/);
    // Fuera de mechanic_set_stage el paso queda cerrado.
    expect((await one<{ s: string }>(`select coalesce(current_setting('lubricenter.mechanic_stage', true), '') s`)).s).toBe('');
  });

  it('Edgar y Ender no usan las RPC de mecánico', async () => {
    await login(EDGAR);
    expect(await fails('select public.mechanic_my_jobs()')).toMatch(/USUARIO_NO_AUTORIZADO/);
  });

  it('propuesta de mano de obra: el mecánico la manda y el mostrador la acepta', async () => {
    await login(ALEXIS);
    const id = (await one<{ id: string }>(`select public.mechanic_propose_labor('Cambiar escobillas del alternador', 35.5, '00000000-0000-4000-8000-0000000000f2') id`)).id;
    expect(await fails(`select public.mechanic_propose_labor('Algo', 10, '00000000-0000-4000-8000-0000000000f1')`)).toMatch(/no está asignada/);
    expect(await fails(`select public.mechanic_propose_labor('Algo', 10)`)).toMatch(/placa o el vehículo/);
    const free = (await one<{ id: string }>(`select public.mechanic_propose_labor('Revisar luces', 15, null, ' xy 99 zz ', 'Aveo') id`)).id;
    expect((await one<{ p: string }>('select vehicle_plate p from public.labor_quote_proposals where id=$1', [free])).p).toBe('XY99ZZ');
    await login(ENDER);
    const pending = (await one<{ r: any[] }>(`select public.labor_proposals_list('PENDING') r`)).r;
    expect(pending.map(row => row.mechanic)).toEqual(['Alexis', 'Alexis']);
    await q(`select public.labor_proposal_review($1, 'ACCEPTED', null)`, [id]);
    await login(ALEXIS);
    const mine = (await one<{ r: any[] }>('select public.mechanic_my_proposals() r')).r;
    expect(mine.find(row => row.id === id)).toMatchObject({ status: 'ACCEPTED', order_number: 'OS-000901', amount_ref: 35.5 });
  });
});

describe('PIN de los módulos del dueño', () => {
  it('Edgar abre la ventana con el PIN y el rol de finanzas cambia solo mientras dura', async () => {
    await login(EDGAR);
    expect((await one<{ r: string }>('select lubricenter_private.finance_role() r')).r).toBe('OPERATOR');
    expect(await fails(`select public.unlock_sensitive('1111')`)).toMatch(/PIN incorrecto/);
    await q(`select public.unlock_sensitive('2468')`);
    expect((await one<{ r: string }>('select lubricenter_private.finance_role() r')).r).toBe('ADMIN');
    expect((await one<{ o: boolean }>('select lubricenter_private.staff_owner() o')).o).toBe(false);
    expect((await one<{ p: { sensitive_until: string | null } }>('select public.my_profile() p')).p.sensitive_until).not.toBeNull();
    await q('select public.lock_sensitive()');
    expect((await one<{ r: string }>('select lubricenter_private.finance_role() r')).r).toBe('OPERATOR');
    await q(`select public.unlock_sensitive('2468')`);
    await db.exec(`update lubricenter_private.sensitive_unlocks set unlocked_until = now() - interval '1 minute'`);
    expect((await one<{ r: string }>('select lubricenter_private.finance_role() r')).r).toBe('OPERATOR');
  });

  it('Ender no puede abrir los módulos del dueño ni administrar usuarios', async () => {
    await login(ENDER);
    expect(await fails(`select public.unlock_sensitive('2468')`)).toMatch(/no tiene acceso/);
    expect(await fails('select public.staff_admin_users()')).toMatch(/dueño/);
  });

  it('el dueño sigue siendo OWNER y administra usuarios', async () => {
    await login(OWNER);
    expect((await one<{ r: string }>('select lubricenter_private.finance_role() r')).r).toBe('OWNER');
    expect((await one<{ p: { profile: string } }>('select public.my_profile() p')).p.profile).toBe('OWNER');
    const users = (await one<{ r: any[] }>('select public.staff_admin_users() r')).r;
    expect(users.map(u => u.profile)).toEqual(['ADMIN', 'RECEPTION', 'MECHANIC', 'MECHANIC']);
    expect(await fails(`select public.staff_admin_save(null, 'Nuevo', null, 'MECHANIC', null, null)`)).toMatch(/mecánico de nómina/);
  });
});

describe('rutas por perfil', () => {
  it('cada perfil abre solo lo suyo', () => {
    expect(canOpenPath('MECHANIC', '/mecanico/cotizar')).toBe(true);
    expect(canOpenPath('MECHANIC', '/')).toBe(false);
    expect(canOpenPath('MECHANIC', '/orders/123')).toBe(false);
    expect(homeFor('MECHANIC')).toBe('/mecanico');
    expect(canOpenPath('RECEPTION', '/orders/new')).toBe(true);
    expect(canOpenPath('RECEPTION', '/crm')).toBe(true);
    expect(canOpenPath('RECEPTION', '/quick-sale')).toBe(false);
    expect(canOpenPath('RECEPTION', '/cash-close')).toBe(false);
    expect(canOpenPath('RECEPTION', '/inventory')).toBe(false);
    expect(canOpenPath('RECEPTION', '/finance/profit')).toBe(false);
    expect(canOpenPath('ADMIN', '/finance/profit')).toBe(true);
    expect(canOpenPath('ADMIN', '/settings/usuarios')).toBe(false);
    expect(canOpenPath('ADMIN', '/mecanico')).toBe(false);
    expect(canOpenPath('OWNER', '/settings/usuarios')).toBe(true);
    expect(canOpenPath(undefined, '/quick-sale')).toBe(true);
    expect(isSensitivePath('/payroll')).toBe(true);
    expect(isSensitivePath('/cashea')).toBe(false);
    expect(isSensitivePath('/cashea/balance')).toBe(true);
  });
});

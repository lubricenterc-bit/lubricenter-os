-- Lubricenter OS: supervised employee accounts, per-action permissions and accountable work.
-- Existing sessions are preserved through an explicit legacy allowlist; all new accounts require enrollment.
create schema if not exists lubricenter_private;

create table if not exists public.staff_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null check (length(trim(full_name)) >= 3),
  email text,
  job_title text not null default 'Operador',
  active boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_users_email_format check(email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')
);
create unique index if not exists staff_users_email_unique on public.staff_users(lower(email)) where email is not null;
create index if not exists staff_users_auth on public.staff_users(auth_user_id);
create table if not exists public.staff_permission_catalog (
  key text primary key, area text not null, label text not null,
  explanation text not null default '', recommended boolean not null default false, sort_order integer not null default 0
);
insert into public.staff_permission_catalog(key,area,label,explanation,recommended,sort_order) values
 ('orders.view','Ventas y órdenes','Consultar órdenes','Ver órdenes abiertas y cerradas',true,10),
 ('orders.create','Ventas y órdenes','Crear órdenes','Recibir vehículos y registrar servicios',true,11),
 ('orders.edit','Ventas y órdenes','Editar órdenes','Modificar datos y avance de una orden',true,12),
 ('orders.cancel','Ventas y órdenes','Anular órdenes','Cancelar órdenes, con trazabilidad y motivo',false,13),
 ('payments.view','Ventas y órdenes','Consultar cobros','Ver métodos de pago y movimientos',true,14),
 ('payments.manage','Ventas y órdenes','Registrar cobros','Agregar o corregir movimientos de pago',false,15),
 ('customers.view','Clientes y CRM','Consultar clientes','Ver vehículos e historial del cliente',true,20),
 ('customers.manage','Clientes y CRM','Editar clientes','Registrar y modificar clientes y vehículos',true,21),
 ('crm.manage','Clientes y CRM','Gestionar CRM','Casos manuales y seguimientos',true,22),
 ('inventory.view','Inventario y compras','Consultar inventario','Consultar productos y existencias',true,30),
 ('inventory.count','Inventario y compras','Ajustar inventario','Registrar movimientos y conteos físicos',true,31),
 ('catalog.manage','Inventario y compras','Modificar catálogo','Crear y cambiar productos y precios',false,32),
 ('purchases.manage','Inventario y compras','Registrar compras','Recepciones y compras de proveedores',false,33),
 ('finance.view','Caja y finanzas','Consultar finanzas','Acceder a resultados y cuentas permitidos',true,40),
 ('cash.manage','Caja y finanzas','Movimientos de caja','Registrar movimientos bancarios y de efectivo',false,41),
 ('cash.close','Caja y finanzas','Cierre diario','Registrar y presentar arqueos de caja',true,42),
 ('finance.reconcile','Caja y finanzas','Conciliación bancaria','Revisar y conciliar extractos',false,43),
 ('cashea.manage','Caja y finanzas','Gestionar Cashea','Gestionar pagos y cuotas de Cashea',true,44),
 ('receivables.manage','Caja y finanzas','Cuentas por cobrar','Gestionar anticipos, abonos y créditos',false,45),
 ('payroll.view','Personal y control','Consultar nómina','Ver liquidaciones y compensación',false,50),
 ('payroll.manage','Personal y control','Modificar nómina','Ajustes, descuentos, bonos y pagos',false,51),
 ('settings.manage','Personal y control','Modificar configuración','Cambiar tasas y parámetros del negocio',false,52),
 ('tasks.view','Personal y control','Ver sus tareas','Consultar tareas asignadas y vencimientos',true,53),
 ('tasks.complete','Personal y control','Completar sus tareas','Marcar tareas asignadas como resueltas',true,54)
on conflict (key) do nothing;

create table if not exists public.staff_permissions(
  staff_user_id uuid not null references public.staff_users(id) on delete cascade,
  permission_key text not null references public.staff_permission_catalog(key),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key(staff_user_id,permission_key)
);
create table if not exists public.staff_tasks(
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references public.staff_users(id) on delete restrict,
  title text not null check(length(trim(title)) between 3 and 250),
  due_on date,
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint staff_tasks_completion_pair check ((completed_at is null)=(completed_by is null))
);
create index if not exists staff_tasks_user_due on public.staff_tasks(staff_user_id,due_on);
create table if not exists public.staff_activity_events(
  id bigint generated always as identity primary key,
  staff_user_id uuid not null references public.staff_users(id),
  actor_user_id uuid,
  event_key text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  happened_at timestamptz not null default clock_timestamp()
);
create index if not exists staff_activity_staff_at on public.staff_activity_events(staff_user_id,happened_at desc);

-- Frozen allowlist of the two accounts that already operate the system: no newly created auth account inherits access.
create table if not exists lubricenter_private.staff_existing_accounts(user_id uuid primary key);
insert into lubricenter_private.staff_existing_accounts(user_id)
select id from auth.users where lower(email) in ('lubricenterc@gmail.com','santiago@gmail.com')
on conflict do nothing;
revoke all on lubricenter_private.staff_existing_accounts from public,anon,authenticated;

create or replace function lubricenter_private.staff_owner()
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and lubricenter_private.finance_role()='OWNER'
$$;
create or replace function lubricenter_private.staff_identity_allowed()
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
   exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id=auth.uid())
   or exists(select 1 from public.staff_users s where s.auth_user_id=auth.uid() and s.active)
 )
$$;
create or replace function public.staff_auth_allowed()
returns boolean language sql stable security definer set search_path='' as $$
 select lubricenter_private.staff_identity_allowed()
$$;
create or replace function lubricenter_private.staff_can(p_key text)
returns boolean language sql stable security definer set search_path='' as $$
 select case
  when not lubricenter_private.staff_identity_allowed() then false
  when exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id=auth.uid()) then true
  else exists (
   select 1 from public.staff_users s join public.staff_permissions p on p.staff_user_id=s.id
   where s.auth_user_id=auth.uid() and s.active and p.permission_key=p_key and p.enabled
  )
 end
$$;
create or replace function public.staff_my_permissions()
returns text[] language sql stable security definer set search_path='' as $$
 select case when not lubricenter_private.staff_identity_allowed() then array[]::text[]
 when exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id=auth.uid())
 then array(select key from public.staff_permission_catalog order by sort_order)
 else array(select p.permission_key from public.staff_users s
 join public.staff_permissions p on p.staff_user_id=s.id
 where s.auth_user_id=auth.uid() and s.active and p.enabled order by p.permission_key) end
$$;
create or replace function lubricenter_private.staff_require_owner()
returns void language plpgsql security definer set search_path='' as $$
begin
 if not lubricenter_private.staff_owner() then raise exception 'Solo el propietario puede administrar usuarios'; end if;
end $$;

-- Close the historical loophole where any authenticated account could call require_auth/finance_require as operator.
create or replace function public.require_auth()
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if not lubricenter_private.staff_identity_allowed() then raise exception 'USUARIO_NO_AUTORIZADO'; end if;
end $$;
create or replace function lubricenter_private.finance_require(p_role text default 'ADMIN')
returns void language plpgsql security definer set search_path='' as $$
begin
 if not lubricenter_private.staff_identity_allowed() then raise exception 'Usuario no autorizado'; end if;
 if (p_role='OWNER' and lubricenter_private.finance_role()<>'OWNER')
 or (p_role='ADMIN' and lubricenter_private.finance_role() not in ('ADMIN','OWNER'))
 then raise exception 'Esta acción necesita un administrador financiero'; end if;
end $$;

create or replace function public.staff_admin_list()
returns jsonb language sql stable security definer set search_path='' as $$
 select case when lubricenter_private.staff_owner() then coalesce((
 select jsonb_agg(jsonb_build_object(
  'id',s.id,'full_name',s.full_name,'email',s.email,'job_title',s.job_title,
  'active',s.active,'auth_user_id',s.auth_user_id,'last_sign_in_at',a.last_sign_in_at,
  'created_at',s.created_at) order by s.created_at desc)
 from public.staff_users s left join auth.users a on a.id=s.auth_user_id
 ),'[]'::jsonb) else '[]'::jsonb end
$$;
create or replace function public.staff_admin_permission(p_staff_user_id uuid,p_key text,p_enabled boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.staff_require_owner();
 if not exists(select 1 from public.staff_users where id=p_staff_user_id) then raise exception 'Usuario no encontrado'; end if;
 insert into public.staff_permissions(staff_user_id,permission_key,enabled,updated_by)
 values(p_staff_user_id,p_key,p_enabled,auth.uid())
 on conflict(staff_user_id,permission_key) do update
 set enabled=excluded.enabled,updated_at=now(),updated_by=auth.uid();
 insert into public.staff_activity_events(staff_user_id,actor_user_id,event_key,entity_type,entity_id,details)
 values(p_staff_user_id,auth.uid(),'permission.changed','permission',p_key,
 jsonb_build_object('enabled',p_enabled));
end $$;
create or replace function public.staff_admin_status(p_staff_user_id uuid,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.staff_require_owner();
 update public.staff_users set active=p_active,updated_at=now() where id=p_staff_user_id;
 if not found then raise exception 'Usuario no encontrado'; end if;
 insert into public.staff_activity_events(staff_user_id,actor_user_id,event_key,entity_type,details)
 values(p_staff_user_id,auth.uid(),'access.changed','staff_user',jsonb_build_object('active',p_active));
end $$;
create or replace function public.staff_admin_add_task(p_staff_user_id uuid,p_title text,p_due_on date default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 perform lubricenter_private.staff_require_owner();
 insert into public.staff_tasks(staff_user_id,title,due_on,created_by)
 values(p_staff_user_id,trim(p_title),p_due_on,auth.uid()) returning id into v_id;
 insert into public.staff_activity_events(staff_user_id,actor_user_id,event_key,entity_type,entity_id,details)
 values(p_staff_user_id,auth.uid(),'task.assigned','staff_task',v_id::text,jsonb_build_object('title',trim(p_title),'due_on',p_due_on));
 return v_id;
end $$;
create or replace function public.staff_set_task_completed(p_task_id uuid,p_completed boolean)
returns void language plpgsql security definer set search_path='' as $$
declare v_task public.staff_tasks; v_profile uuid;
begin
 perform public.require_auth();
 select * into v_task from public.staff_tasks where id=p_task_id for update;
 if not found then raise exception 'Tarea no encontrada'; end if;
 select id into v_profile from public.staff_users where auth_user_id=auth.uid() and active;
 if not lubricenter_private.staff_owner() and
    (v_profile is distinct from v_task.staff_user_id or not lubricenter_private.staff_can('tasks.complete')) then
   raise exception 'No tienes permiso para completar esta tarea';
 end if;
 update public.staff_tasks set completed_at=case when p_completed then clock_timestamp() else null end,
 completed_by=case when p_completed then auth.uid() else null end where id=p_task_id;
 insert into public.staff_activity_events(staff_user_id,actor_user_id,event_key,entity_type,entity_id)
 values(v_task.staff_user_id,auth.uid(),case when p_completed then 'task.completed' else 'task.reopened' end,
 'staff_task',p_task_id::text);
end $$;

-- Management data is never openly writable by a logged-in employee.
alter table public.staff_users enable row level security;
alter table public.staff_permission_catalog enable row level security;
alter table public.staff_permissions enable row level security;
alter table public.staff_tasks enable row level security;
alter table public.staff_activity_events enable row level security;
revoke all on public.staff_users,public.staff_permission_catalog,public.staff_permissions,public.staff_tasks,public.staff_activity_events from anon,authenticated;
grant select on public.staff_users,public.staff_permission_catalog,public.staff_permissions,public.staff_tasks,public.staff_activity_events to authenticated;
create policy staff_users_owner_or_self on public.staff_users for select to authenticated
 using (lubricenter_private.staff_owner() or auth_user_id=auth.uid());
create policy staff_catalog_authorized on public.staff_permission_catalog for select to authenticated
 using (lubricenter_private.staff_identity_allowed());
create policy staff_permissions_owner_or_self on public.staff_permissions for select to authenticated
 using (lubricenter_private.staff_owner() or exists(select 1 from public.staff_users s where s.id=staff_user_id and s.auth_user_id=auth.uid()));
create policy staff_tasks_owner_or_self on public.staff_tasks for select to authenticated
 using (lubricenter_private.staff_owner() or exists(select 1 from public.staff_users s where s.id=staff_user_id and s.auth_user_id=auth.uid() and s.active and lubricenter_private.staff_can('tasks.view')));
create policy staff_activity_owner on public.staff_activity_events for select to authenticated using (lubricenter_private.staff_owner());
revoke all on function public.staff_admin_list(),public.staff_admin_permission(uuid,text,boolean),
 public.staff_admin_status(uuid,boolean),public.staff_admin_add_task(uuid,text,date),
 public.staff_set_task_completed(uuid,boolean),public.staff_my_permissions(),
 public.staff_auth_allowed() from public,anon;
grant execute on function public.staff_admin_list(),public.staff_admin_permission(uuid,text,boolean),
 public.staff_admin_status(uuid,boolean),public.staff_admin_add_task(uuid,text,date),
 public.staff_set_task_completed(uuid,boolean),public.staff_my_permissions(),
 public.staff_auth_allowed() to authenticated;

-- A restrictive policy leaves existing module rules intact but requires explicit enrollment for every new login.
do $$
declare rec record;
begin
 for rec in select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
 and table_name not like 'staff_%'
 loop
  execute format('create policy staff_identity_gate on public.%I as restrictive for all to authenticated using (lubricenter_private.staff_identity_allowed()) with check (lubricenter_private.staff_identity_allowed())',rec.table_name);
 end loop;
end $$;

-- Restrict staff reading across exposed core tables, in addition to each module's existing policies.
do $$
declare rec record;
begin
 for rec in select * from (values
  ('orders','orders.view'),('order_items','orders.view'),
  ('payments','payments.view'),('order_tenders','payments.view'),
  ('customers','customers.view'),('vehicles','customers.view'),('service_records','customers.view'),
  ('products','inventory.view'),('inventory_items','inventory.view'),('inventory_movements','inventory.view'),
  ('cash_closings','cash.close'),('account_movements','cash.manage'),
  ('crm_manual_cases','crm.manage'),('crm_manual_case_events','crm.manage'),
  ('payroll_runs','payroll.view'),('payroll_adjustments','payroll.view'),('payroll_payments','payroll.view')
 ) as t(table_name,permission_key)
 loop
  execute format('create policy staff_read_gate on public.%I as restrictive for select to authenticated using (lubricenter_private.staff_can(%L))',rec.table_name,rec.permission_key);
 end loop;
end $$;

-- Enforcement is in the database, not a checkbox that merely hides menu links.
create or replace function lubricenter_private.staff_write_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_permission text; v_record jsonb;
begin
 if auth.uid() is null then return coalesce(new,old); end if; -- Trusted internal jobs; exposed RPCs call require_auth.
 v_record:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 v_permission:=case tg_table_name
 when 'orders' then case when tg_op='INSERT' then 'orders.create'
   when tg_op='DELETE' or (tg_op='UPDATE' and coalesce(new.status,'')='CANCELLED' and old.status is distinct from new.status) then 'orders.cancel'
   else 'orders.edit' end
 when 'order_items' then 'orders.edit'
 when 'payments' then 'payments.manage'
 when 'order_tenders' then 'payments.manage'
 when 'customers' then 'customers.manage'
 when 'vehicles' then 'customers.manage'
 when 'inventory_movements' then 'inventory.count'
 when 'products' then 'catalog.manage'
 when 'account_movements' then 'cash.manage'
 when 'cash_closings' then 'cash.close'
 when 'crm_manual_cases' then 'crm.manage'
 when 'payroll_adjustments' then 'payroll.manage'
 else null end;
 if v_permission is not null and not lubricenter_private.staff_can(v_permission) then
  raise exception 'PERMISO_DENEGADO: %',v_permission using errcode='42501';
 end if;
 return coalesce(new,old);
end $$;
create or replace function lubricenter_private.staff_action_log()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_data jsonb;
begin
 if auth.uid() is null then return null; end if;
 select id into v_user from public.staff_users where auth_user_id=auth.uid();
 if v_user is null then return null; end if;
 v_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 insert into public.staff_activity_events(staff_user_id,actor_user_id,event_key,entity_type,entity_id,details)
 values(v_user,auth.uid(),lower(tg_op),tg_table_name,
 coalesce(v_data->>'id',v_data->>'order_id',v_data->>'cash_closing_id'),
 jsonb_build_object('action',tg_op));
 return null;
end $$;
do $$
declare t text;
begin
 foreach t in array array['orders','order_items','payments','order_tenders','customers',
 'vehicles','inventory_movements','products','account_movements','cash_closings',
 'crm_manual_cases','payroll_adjustments'] loop
  execute format('create trigger staff_write_guard before insert or update or delete on public.%I for each row execute function lubricenter_private.staff_write_guard()',t);
  execute format('create trigger staff_action_log after insert or update or delete on public.%I for each row execute function lubricenter_private.staff_action_log()',t);
 end loop;
end $$;

-- Staged employee record: no email or auth identity is guessed; an owner will send an invite later.
insert into public.staff_users(full_name,job_title,active)
select 'Edgar Jimenez','Gerente operativo',false
where not exists(select 1 from public.staff_users where lower(full_name)='edgar jimenez');
insert into public.staff_permissions(staff_user_id,permission_key,enabled)
select s.id,c.key,c.recommended from public.staff_users s cross join public.staff_permission_catalog c
where lower(s.full_name)='edgar jimenez' on conflict do nothing;

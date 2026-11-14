-- Usuarios por persona y por dispositivo (12 nov 2026).
--
-- Perfiles en staff_users.profile:
--   ADMIN      Edgar (computadora). Todo lo operativo. Los módulos que antes eran solo del
--              dueño (finanzas, ganancias, conciliaciones, nómina) piden el PIN del dueño
--              cada vez que entra: unlock_sensitive() abre una ventana corta durante la cual
--              finance_role() le devuelve 'ADMIN'. Fuera de esa ventana es 'OPERATOR'.
--   RECEPTION  Ender (tablet). Crear órdenes, clientes y CRM. Sin cobros ni caja.
--   MECHANIC   Cheo y Alexis (teléfono). NO pasan staff_identity_allowed(): no leen ni
--              escriben ninguna tabla general. Solo usan las RPC mechanic_* (sus vehículos,
--              su historial y proponer mano de obra), sin montos de órdenes ni ganancias.
--
-- Aditiva salvo tres create or replace con la misma firma:
--   lubricenter_private.staff_identity_allowed()  (+ excluye MECHANIC)
--   lubricenter_private.finance_role()             (+ ventana de PIN para ADMIN)
--   lubricenter_private.staff_write_guard()        (+ paso para mechanic_set_stage)
-- Las cuentas existentes (staff_existing_accounts) siguen exactamente igual.

-- 1. Perfil, empleado y dispositivo -------------------------------------------------------
alter table public.staff_users add column if not exists profile text not null default 'RECEPTION';
alter table public.staff_users add column if not exists employee_id uuid references public.employees(id);
alter table public.staff_users add column if not exists device text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'staff_users_profile_check') then
    alter table public.staff_users add constraint staff_users_profile_check
      check (profile in ('ADMIN','RECEPTION','MECHANIC'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_users_mechanic_employee_check') then
    alter table public.staff_users add constraint staff_users_mechanic_employee_check
      check (profile <> 'MECHANIC' or employee_id is not null);
  end if;
end $$;
create unique index if not exists staff_users_employee_unique on public.staff_users(employee_id) where employee_id is not null;

-- Personas (sin cuenta todavía: el dueño la crea en Administración → Usuarios).
update public.staff_users set profile = 'ADMIN', device = 'Computadora', updated_at = now()
 where full_name = 'Edgar Jimenez';
insert into public.staff_users(full_name, job_title, profile, device, active)
select 'Ender', 'Atención al cliente', 'RECEPTION', 'Tablet', false
 where not exists (select 1 from public.staff_users where profile = 'RECEPTION' and full_name ilike 'Ender%');
insert into public.staff_users(full_name, job_title, profile, device, employee_id, active)
select 'Cheo', 'Mecánico (taller)', 'MECHANIC', 'Teléfono', e.id, false
  from public.employees e where e.code = 'CHEO'
   and not exists (select 1 from public.staff_users s where s.employee_id = e.id);
insert into public.staff_users(full_name, job_title, profile, device, employee_id, active)
select 'Alexis', 'Electroauto', 'MECHANIC', 'Teléfono', e.id, false
  from public.employees e where e.code = 'ALEXIS'
   and not exists (select 1 from public.staff_users s where s.employee_id = e.id);

-- Permisos iniciales (el dueño los puede cambiar uno por uno).
insert into public.staff_permissions(staff_user_id, permission_key, enabled)
select s.id, c.key, true from public.staff_users s cross join public.staff_permission_catalog c
 where s.profile = 'ADMIN'
on conflict (staff_user_id, permission_key) do update set enabled = true, updated_at = now();
insert into public.staff_permissions(staff_user_id, permission_key, enabled)
select s.id, k, true from public.staff_users s
 cross join unnest(array['orders.view','orders.create','orders.edit','customers.view','customers.manage',
   'crm.manage','inventory.view','tasks.view','tasks.complete']) k
 where s.profile = 'RECEPTION'
on conflict (staff_user_id, permission_key) do nothing;

-- 2. Identidad: los mecánicos no entran a las tablas generales -----------------------------
create or replace function lubricenter_private.staff_identity_allowed()
returns boolean language sql stable security definer set search_path to '' as $$
 select auth.uid() is not null and (
   exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id=auth.uid())
   or exists(select 1 from public.staff_users s where s.auth_user_id=auth.uid() and s.active and s.profile <> 'MECHANIC')
 )
$$;

create or replace function lubricenter_private.current_mechanic()
returns uuid language sql stable security definer set search_path to '' as $$
 select s.employee_id from public.staff_users s
  where s.auth_user_id = auth.uid() and s.active and s.profile = 'MECHANIC'
$$;

-- 3. PIN para los módulos sensibles (Edgar) ----------------------------------------------
create table if not exists lubricenter_private.sensitive_unlocks(
  user_id uuid primary key,
  unlocked_until timestamptz not null,
  unlocked_at timestamptz not null default now()
);

create or replace function lubricenter_private.finance_role()
returns text language sql stable security definer set search_path to '' as $$
 select case
  when exists(select 1 from auth.users where id=auth.uid() and lower(email)='lubricenterc@gmail.com' and email_confirmed_at is not null) then 'OWNER'
  when exists(select 1 from public.staff_users s
               join lubricenter_private.sensitive_unlocks u on u.user_id = s.auth_user_id
              where s.auth_user_id = auth.uid() and s.active and s.profile = 'ADMIN'
                and u.unlocked_until > now()) then 'ADMIN'
  else coalesce((select role from public.finance_memberships where user_id=auth.uid()),'OPERATOR') end
$$;

create or replace function public.unlock_sensitive(p_pin text)
returns timestamptz language plpgsql security definer set search_path to '' as $$
declare v_check text; v_until timestamptz := now() + interval '30 minutes';
begin
  perform public.require_auth();
  if not exists(select 1 from public.staff_users s where s.auth_user_id = auth.uid() and s.active and s.profile = 'ADMIN') then
    raise exception 'Este usuario no tiene acceso a los módulos del dueño';
  end if;
  v_check := lubricenter_private.owner_pin_check(p_pin);
  if v_check = 'NOT_CONFIGURED' then raise exception 'El dueño todavía no ha configurado su PIN'; end if;
  if v_check = 'LOCKED' then raise exception 'PIN bloqueado por intentos fallidos. Espera 15 minutos.'; end if;
  if v_check <> 'OK' then raise exception 'PIN incorrecto'; end if;
  insert into lubricenter_private.sensitive_unlocks(user_id, unlocked_until, unlocked_at)
  values (auth.uid(), v_until, now())
  on conflict (user_id) do update set unlocked_until = excluded.unlocked_until, unlocked_at = now();
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('sensitive.unlocked', 'staff_user', null, jsonb_build_object('by', auth.uid(), 'until', v_until));
  return v_until;
end $$;

create or replace function public.lock_sensitive()
returns void language sql security definer set search_path to '' as $$
  delete from lubricenter_private.sensitive_unlocks where user_id = auth.uid()
$$;

-- 4. ¿Quién soy? ---------------------------------------------------------------------------
create or replace function public.my_profile()
returns jsonb language sql stable security definer set search_path to '' as $$
 select case
  when auth.uid() is null then null
  when exists(select 1 from lubricenter_private.staff_existing_accounts a where a.user_id = auth.uid()) then
    jsonb_build_object(
      'profile', case when lubricenter_private.finance_role() = 'OWNER' then 'OWNER' else 'SHARED' end,
      'name', case when lubricenter_private.finance_role() = 'OWNER' then 'Santiago' else 'Equipo' end,
      'permissions', to_jsonb(array(select key from public.staff_permission_catalog order by sort_order)))
  else (select jsonb_build_object(
      'profile', s.profile, 'name', s.full_name, 'staff_user_id', s.id, 'device', s.device,
      'employee_id', s.employee_id, 'job_title', s.job_title,
      'permissions', to_jsonb(array(select p.permission_key from public.staff_permissions p
                                     where p.staff_user_id = s.id and p.enabled order by 1)),
      'sensitive_until', (select u.unlocked_until from lubricenter_private.sensitive_unlocks u
                           where u.user_id = s.auth_user_id and u.unlocked_until > now()))
    from public.staff_users s where s.auth_user_id = auth.uid() and s.active)
 end
$$;

-- 5. Guardián de escritura: paso exclusivo para mechanic_set_stage -------------------------
create or replace function lubricenter_private.staff_write_guard()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
 v_permission text;
 v_new jsonb;
 v_old jsonb;
begin
 if auth.uid() is null then
  if tg_op = 'DELETE' then return old; end if;
  return new;
 end if;
 -- mechanic_set_stage ya comprobó que la orden es del mecánico y solo cambia workflow_status.
 if tg_table_name = 'orders' and tg_op = 'UPDATE'
    and current_setting('lubricenter.mechanic_stage', true) = 'on'
    and lubricenter_private.current_mechanic() is not null then
  return new;
 end if;
 if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
 if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
 v_permission := case tg_table_name
 when 'orders' then case
   when tg_op='INSERT' then 'orders.create'
   when tg_op='DELETE' then 'orders.cancel'
   when tg_op='UPDATE' and v_new->>'status' = 'CANCELLED'
        and (v_old->>'status') is distinct from (v_new->>'status') then 'orders.cancel'
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
 if tg_table_name='inventory_movements' and tg_op='INSERT' then
  if v_new->>'movement_type'='SALE' and current_setting('lubricenter.inventory_lifecycle',true)='SALE' then v_permission:='orders.edit';
  elsif v_new->>'movement_type'='RETURN' and current_setting('lubricenter.inventory_lifecycle',true)='RETURN' then v_permission:='orders.cancel'; end if;
 end if;
 if v_permission is not null and not lubricenter_private.staff_can(v_permission) then
  raise exception 'PERMISO_DENEGADO: %',v_permission using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;

-- 6. Mecánicos: sus vehículos, su historial, avance ----------------------------------------
create or replace function lubricenter_private.require_mechanic()
returns uuid language plpgsql stable security definer set search_path to '' as $$
declare v uuid := lubricenter_private.current_mechanic();
begin
  if v is null then raise exception 'USUARIO_NO_AUTORIZADO'; end if;
  return v;
end $$;

create or replace function lubricenter_private.mechanic_order_json(p_order_id uuid, p_emp uuid)
returns jsonb language sql stable security definer set search_path to '' as $$
 select jsonb_build_object(
  'order_id', o.id, 'order_number', o.order_number, 'status', o.status,
  'workflow_status', o.workflow_status, 'workflow_updated_at', o.workflow_updated_at,
  'opened_at', o.opened_at, 'closed_at', o.closed_at, 'date', coalesce(o.business_at, o.closed_at, o.opened_at),
  'plate', v.plate, 'vehicle', nullif(trim(concat_ws(' ', v.make, v.model, v.year::text)), ''),
  'customer', nullif(split_part(trim(coalesce(c.name,'')), ' ', 1), ''),
  'notes', nullif(trim(concat_ws(' · ', nullif(o.health_notes,''), nullif(o.crm_observations,''))), ''),
  'my_jobs', coalesce((select jsonb_agg(jsonb_build_object('description', i.description,
        'helper', i.worker_employee_id is distinct from p_emp) order by i.created_at)
      from public.order_items i where i.order_id = o.id
       and (i.worker_employee_id = p_emp or i.assistant_bonus_employee_id = p_emp)), '[]'::jsonb),
  'parts', coalesce((select jsonb_agg(jsonb_build_object('description', i.description, 'quantity', i.quantity) order by i.created_at)
      from public.order_items i where i.order_id = o.id
       and i.worker_employee_id is null and i.assistant_bonus_employee_id is null
       and coalesce(i.line_role,'') <> 'CASHEA_SURCHARGE'
       and i.description not ilike '%cashea%'), '[]'::jsonb))
 from public.orders o
 left join public.vehicles v on v.id = o.vehicle_id
 left join public.customers c on c.id = o.customer_id
 where o.id = p_order_id
$$;

create or replace function public.mechanic_my_jobs()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_emp uuid := lubricenter_private.require_mechanic();
begin
  return coalesce((select jsonb_agg(lubricenter_private.mechanic_order_json(o.id, v_emp)
                     order by case o.workflow_status when 'READY' then 1 else 0 end, o.opened_at)
    from public.orders o
   where o.status = 'OPEN'
     and exists(select 1 from public.order_items i where i.order_id = o.id
                 and (i.worker_employee_id = v_emp or i.assistant_bonus_employee_id = v_emp))), '[]'::jsonb);
end $$;

create or replace function public.mechanic_history(p_days integer default 60)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_emp uuid := lubricenter_private.require_mechanic();
        v_days integer := least(greatest(coalesce(p_days, 60), 1), 400);
begin
  return coalesce((select jsonb_agg(lubricenter_private.mechanic_order_json(x.id, v_emp) order by x.d desc)
    from (select o.id, coalesce(o.business_at, o.closed_at) d from public.orders o
           where o.status = 'CLOSED'
             and coalesce(o.business_at, o.closed_at) >= now() - make_interval(days => v_days)
             and exists(select 1 from public.order_items i where i.order_id = o.id
                         and (i.worker_employee_id = v_emp or i.assistant_bonus_employee_id = v_emp))
           order by 2 desc limit 300) x), '[]'::jsonb);
end $$;

create or replace function public.mechanic_set_stage(p_order_id uuid, p_status text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_emp uuid := lubricenter_private.require_mechanic();
        v_status text := upper(coalesce(p_status,''));
begin
  if v_status not in ('DIAGNOSIS','IN_PROGRESS','WAITING_PART','READY') then
    raise exception 'Estado inválido';
  end if;
  if not exists(select 1 from public.orders o where o.id = p_order_id and o.status = 'OPEN'
                  and exists(select 1 from public.order_items i where i.order_id = o.id
                              and (i.worker_employee_id = v_emp or i.assistant_bonus_employee_id = v_emp))) then
    raise exception 'Esta orden no está asignada a ti o ya se cerró';
  end if;
  perform set_config('lubricenter.mechanic_stage', 'on', true);
  update public.orders set workflow_status = v_status, workflow_updated_at = now() where id = p_order_id;
  perform set_config('lubricenter.mechanic_stage', '', true);
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.workflow_changed', 'order', p_order_id,
          jsonb_build_object('workflow_status', v_status, 'by_mechanic', v_emp));
end $$;

-- 7. Propuestas de mano de obra ------------------------------------------------------------
create table if not exists public.labor_quote_proposals(
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  order_id uuid references public.orders(id),
  vehicle_plate text,
  vehicle_label text,
  description text not null check (char_length(trim(description)) between 3 and 500),
  amount_ref numeric(12,2) not null check (amount_ref > 0 and amount_ref < 100000),
  notes text,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','REJECTED')),
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists labor_quote_proposals_status_idx on public.labor_quote_proposals(status, created_at desc);
create index if not exists labor_quote_proposals_employee_idx on public.labor_quote_proposals(employee_id, created_at desc);
create index if not exists labor_quote_proposals_order_idx on public.labor_quote_proposals(order_id);
alter table public.labor_quote_proposals enable row level security;
drop policy if exists labor_quote_proposals_staff_read on public.labor_quote_proposals;
create policy labor_quote_proposals_staff_read on public.labor_quote_proposals for select to authenticated
  using ((select lubricenter_private.staff_can('orders.view')));

create or replace function public.mechanic_propose_labor(p_description text, p_amount_ref numeric,
  p_order_id uuid default null, p_plate text default null, p_vehicle text default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_emp uuid := lubricenter_private.require_mechanic(); v_id uuid;
        v_plate text := nullif(upper(regexp_replace(coalesce(p_plate,''), '\s', '', 'g')), '');
        v_vehicle text := nullif(trim(coalesce(p_vehicle,'')), '');
begin
  if p_order_id is not null then
    if not exists(select 1 from public.orders o where o.id = p_order_id and o.status = 'OPEN'
                    and exists(select 1 from public.order_items i where i.order_id = o.id
                                and (i.worker_employee_id = v_emp or i.assistant_bonus_employee_id = v_emp))) then
      raise exception 'Esa orden no está asignada a ti';
    end if;
    select coalesce(v_plate, v.plate), coalesce(v_vehicle, nullif(trim(concat_ws(' ', v.make, v.model)), ''))
      into v_plate, v_vehicle
      from public.orders o left join public.vehicles v on v.id = o.vehicle_id where o.id = p_order_id;
  elsif v_plate is null and v_vehicle is null then
    raise exception 'Escribe la placa o el vehículo';
  end if;
  insert into public.labor_quote_proposals(employee_id, order_id, vehicle_plate, vehicle_label, description, amount_ref, notes)
  values (v_emp, p_order_id, v_plate, v_vehicle, trim(p_description), round(p_amount_ref, 2), nullif(trim(coalesce(p_notes,'')), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.mechanic_my_proposals()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_emp uuid := lubricenter_private.require_mechanic();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'order_number', o.order_number,
      'plate', p.vehicle_plate, 'vehicle', p.vehicle_label, 'description', p.description,
      'amount_ref', p.amount_ref, 'notes', p.notes, 'status', p.status, 'review_note', p.review_note,
      'created_at', p.created_at, 'reviewed_at', p.reviewed_at) order by p.created_at desc)
    from (select * from public.labor_quote_proposals where employee_id = v_emp order by created_at desc limit 60) p
    left join public.orders o on o.id = p.order_id), '[]'::jsonb);
end $$;

create or replace function public.labor_proposals_list(p_status text default 'PENDING')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if not lubricenter_private.staff_can('orders.view') then raise exception 'PERMISO_DENEGADO: orders.view'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'mechanic', e.name, 'order_id', p.order_id,
      'order_number', o.order_number, 'plate', p.vehicle_plate, 'vehicle', p.vehicle_label,
      'description', p.description, 'amount_ref', p.amount_ref, 'notes', p.notes, 'status', p.status,
      'review_note', p.review_note, 'created_at', p.created_at, 'reviewed_at', p.reviewed_at) order by p.created_at desc)
    from (select * from public.labor_quote_proposals
           where p_status is null or status = upper(p_status) order by created_at desc limit 100) p
    join public.employees e on e.id = p.employee_id
    left join public.orders o on o.id = p.order_id), '[]'::jsonb);
end $$;

create or replace function public.labor_proposal_review(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $$
declare v_status text := upper(coalesce(p_status,''));
begin
  perform public.require_auth();
  if not lubricenter_private.staff_can('orders.edit') then raise exception 'PERMISO_DENEGADO: orders.edit'; end if;
  if v_status not in ('ACCEPTED','REJECTED','PENDING') then raise exception 'Estado inválido'; end if;
  update public.labor_quote_proposals
     set status = v_status, review_note = nullif(trim(coalesce(p_note,'')), ''),
         reviewed_by = case when v_status = 'PENDING' then null else auth.uid() end,
         reviewed_at = case when v_status = 'PENDING' then null else now() end
   where id = p_id;
  if not found then raise exception 'Propuesta no encontrada'; end if;
end $$;

-- 8. Administración de usuarios (solo el dueño) -------------------------------------------
create or replace function public.staff_admin_users()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform lubricenter_private.staff_require_owner();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'full_name', s.full_name, 'email', s.email, 'job_title', s.job_title,
      'profile', s.profile, 'device', s.device, 'employee_id', s.employee_id, 'employee', e.name,
      'active', s.active, 'has_account', s.auth_user_id is not null, 'last_sign_in_at', a.last_sign_in_at,
      'permissions', to_jsonb(array(select p.permission_key from public.staff_permissions p
                                     where p.staff_user_id = s.id and p.enabled order by 1)),
      'created_at', s.created_at)
     order by case s.profile when 'ADMIN' then 0 when 'RECEPTION' then 1 else 2 end, s.full_name)
    from public.staff_users s
    left join auth.users a on a.id = s.auth_user_id
    left join public.employees e on e.id = s.employee_id), '[]'::jsonb);
end $$;

create or replace function public.staff_admin_save(p_id uuid, p_full_name text, p_job_title text,
  p_profile text, p_device text, p_employee_id uuid default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_profile text := upper(coalesce(p_profile,''));
begin
  perform lubricenter_private.staff_require_owner();
  if v_profile not in ('ADMIN','RECEPTION','MECHANIC') then raise exception 'Perfil inválido'; end if;
  if nullif(trim(coalesce(p_full_name,'')),'') is null then raise exception 'Escribe el nombre'; end if;
  if v_profile = 'MECHANIC' and p_employee_id is null then raise exception 'Elige el mecánico de nómina'; end if;
  if p_id is null then
    insert into public.staff_users(full_name, job_title, profile, device, employee_id, active, created_by)
    values (trim(p_full_name), nullif(trim(coalesce(p_job_title,'')),''), v_profile, nullif(trim(coalesce(p_device,'')),''),
            case when v_profile = 'MECHANIC' then p_employee_id end, false, auth.uid())
    returning id into v_id;
  else
    update public.staff_users set full_name = trim(p_full_name), job_title = nullif(trim(coalesce(p_job_title,'')),''),
      profile = v_profile, device = nullif(trim(coalesce(p_device,'')),''),
      employee_id = case when v_profile = 'MECHANIC' then p_employee_id end, updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Usuario no encontrado'; end if;
  end if;
  insert into public.staff_activity_events(staff_user_id, actor_user_id, event_key, entity_type, details)
  values (v_id, auth.uid(), 'profile.saved', 'staff_user', jsonb_build_object('profile', v_profile));
  return v_id;
end $$;

-- 9. Permisos de ejecución ----------------------------------------------------------------
revoke all on function public.unlock_sensitive(text), public.lock_sensitive(), public.my_profile(),
  public.mechanic_my_jobs(), public.mechanic_history(integer), public.mechanic_set_stage(uuid, text),
  public.mechanic_propose_labor(text, numeric, uuid, text, text, text), public.mechanic_my_proposals(),
  public.labor_proposals_list(text), public.labor_proposal_review(uuid, text, text),
  public.staff_admin_users(), public.staff_admin_save(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.unlock_sensitive(text), public.lock_sensitive(), public.my_profile(),
  public.mechanic_my_jobs(), public.mechanic_history(integer), public.mechanic_set_stage(uuid, text),
  public.mechanic_propose_labor(text, numeric, uuid, text, text, text), public.mechanic_my_proposals(),
  public.labor_proposals_list(text), public.labor_proposal_review(uuid, text, text),
  public.staff_admin_users(), public.staff_admin_save(uuid, text, text, text, text, uuid) to authenticated;
revoke all on function lubricenter_private.current_mechanic(), lubricenter_private.require_mechanic(),
  lubricenter_private.mechanic_order_json(uuid, uuid) from public, anon, authenticated;

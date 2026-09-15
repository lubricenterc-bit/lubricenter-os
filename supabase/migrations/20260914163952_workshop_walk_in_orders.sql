-- Explicit walk-in mode for small workshop jobs that do not need a customer,
-- vehicle history, maintenance reminders, or CRM follow-up.
alter table public.orders
  add column if not exists is_walk_in boolean not null default false;

comment on column public.orders.is_walk_in is
  'True only when the operator explicitly marks a quick workshop/electroauto service as having no customer or vehicle record.';

create or replace function lubricenter_private.normalize_order_walk_in()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Corrections inherit walk-in status from the original order when no party is
  -- supplied. This keeps old quick services editable by the authorized account.
  if tg_op = 'INSERT'
     and new.corrects_order_id is not null
     and new.customer_id is null
     and new.vehicle_id is null then
    select o.is_walk_in into new.is_walk_in
    from public.orders o
    where o.id = new.corrects_order_id;
  end if;

  -- Any real customer or vehicle turns the order back into a tracked service.
  if new.customer_id is not null or new.vehicle_id is not null then
    new.is_walk_in := false;
  end if;

  return new;
end;
$$;

drop trigger if exists ab_normalize_order_walk_in on public.orders;
create trigger ab_normalize_order_walk_in
before insert or update of customer_id, vehicle_id, corrects_order_id, is_walk_in
on public.orders
for each row execute function lubricenter_private.normalize_order_walk_in();

create or replace function public.set_order_walk_in(p_order_id uuid, p_is_walk_in boolean default true)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  if coalesce(p_is_walk_in, false) and exists (
    select 1
    from public.order_items
    where order_id = p_order_id
      and item_type = 'SERVICE'
      and business_area = 'OIL_CHANGE'
  ) then
    raise exception 'Un cambio de aceite necesita cliente y vehículo para guardar kilometraje y próximo servicio';
  end if;

  update public.orders
  set is_walk_in = coalesce(p_is_walk_in, false),
      customer_id = case when coalesce(p_is_walk_in, false) then null else customer_id end,
      vehicle_id = case when coalesce(p_is_walk_in, false) then null else vehicle_id end
  where id = p_order_id;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values (
    'order.walk_in_changed',
    'order',
    p_order_id,
    jsonb_build_object('is_walk_in', coalesce(p_is_walk_in, false))
  );
end;
$$;

revoke all on function public.set_order_walk_in(uuid, boolean) from public, anon;
grant execute on function public.set_order_walk_in(uuid, boolean) to authenticated;

-- Selecting a customer or vehicle always disables walk-in mode atomically.
create or replace function public.set_order_party(p_order_id uuid, p_customer_id uuid default null, p_vehicle_id uuid default null)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_vehicle_customer uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  if p_customer_id is not null and not exists(select 1 from public.customers where id=p_customer_id) then
    raise exception 'Cliente no encontrado';
  end if;
  if p_vehicle_id is not null then
    select customer_id into v_vehicle_customer from public.vehicles where id=p_vehicle_id;
    if not found then raise exception 'Vehículo no encontrado'; end if;
    if p_customer_id is not null and v_vehicle_customer is not null and v_vehicle_customer <> p_customer_id then
      raise exception 'El vehículo pertenece a otro cliente';
    end if;
    if p_customer_id is not null and v_vehicle_customer is null then
      update public.vehicles set customer_id=p_customer_id where id=p_vehicle_id;
    end if;
  end if;

  update public.orders
  set customer_id=p_customer_id,
      vehicle_id=p_vehicle_id,
      is_walk_in=false
  where id=p_order_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('order.party_changed','order',p_order_id,jsonb_build_object('customer_id',p_customer_id,'vehicle_id',p_vehicle_id,'is_walk_in',false));
end;
$$;

revoke all on function public.set_order_party(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_order_party(uuid, uuid, uuid) to authenticated;

create or replace function public.validate_order_ready_to_close(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_order public.orders;
  v_has_vehicle_service boolean;
  v_has_oil boolean;
  v_bad_oil boolean;
begin
  perform public.require_auth();
  select * into v_order from public.orders where id=p_order_id;
  if v_order.id is null then raise exception 'Orden no encontrada'; end if;

  select exists(
    select 1 from public.order_items
    where order_id=p_order_id
      and business_area in ('WORKSHOP','ELECTROAUTO','OIL_CHANGE')
      and item_type='SERVICE'
  ) into v_has_vehicle_service;

  select exists(
    select 1 from public.order_items
    where order_id=p_order_id and business_area='OIL_CHANGE' and item_type='SERVICE'
  ) into v_has_oil;

  if v_order.is_walk_in and v_has_oil then
    raise exception 'El cambio de aceite necesita cliente y vehículo. Desactiva “servicio rápido sin cliente” y asócialos antes de cerrar';
  end if;

  if v_has_vehicle_service and not v_order.is_walk_in then
    if v_order.customer_id is null then
      raise exception 'Antes de cerrar un servicio debes asociar el cliente o marcarlo como servicio rápido sin cliente';
    end if;
    if v_order.vehicle_id is null then
      raise exception 'Antes de cerrar un servicio debes asociar el vehículo o marcarlo como servicio rápido sin cliente';
    end if;
    if v_order.health_status in ('YELLOW','RED') and nullif(trim(coalesce(v_order.health_notes,'')),'') is null then
      raise exception 'La observación preventiva/seguridad necesita una descripción';
    end if;
  end if;

  if v_has_oil then
    select exists(
      select 1 from public.order_items
      where order_id=p_order_id
        and business_area='OIL_CHANGE'
        and item_type='SERVICE'
        and (
          service_odometer is null
          or nullif(trim(coalesce(oil_brand,'')),'') is null
          or (next_service_odometer is null and next_service_date is null)
        )
    ) into v_bad_oil;
    if v_bad_oil then
      raise exception 'El cambio de aceite está incompleto. Regístralo desde “+ Cambio de aceite” con kilometraje, aceite y próximo servicio';
    end if;
  end if;
end;
$$;

revoke all on function public.validate_order_ready_to_close(uuid) from public, anon;
grant execute on function public.validate_order_ready_to_close(uuid) to authenticated;

-- Keep the workshop board explicit about quick services instead of displaying
-- invented customer/vehicle names.
create or replace view public.workshop_board_current
with (security_invoker = true)
as
select
  o.id,
  o.order_number,
  o.workflow_status,
  o.workflow_updated_at,
  o.opened_at,
  o.health_status,
  o.customer_id,
  o.vehicle_id,
  c.name as customer_name,
  c.phone as customer_phone,
  v.plate,
  v.make,
  v.model,
  v.year,
  v.current_odometer,
  coalesce((select count(*) from public.order_items oi where oi.order_id=o.id),0)::integer as item_count,
  coalesce((select sum(oi.charged_ref_amount) from public.order_items oi where oi.order_id=o.id),0) as current_total_ref,
  coalesce((select string_agg(distinct oi.business_area,' · ') from public.order_items oi where oi.order_id=o.id and oi.item_type='SERVICE'),'') as service_areas,
  o.is_walk_in
from public.orders o
left join public.customers c on c.id=o.customer_id
left join public.vehicles v on v.id=o.vehicle_id
where o.status='OPEN'
  and (
    o.vehicle_id is not null
    or exists (
      select 1 from public.order_items oi
      where oi.order_id=o.id
        and oi.business_area in ('WORKSHOP','ELECTROAUTO','OIL_CHANGE')
    )
  );

revoke all on table public.workshop_board_current from anon;
grant select on table public.workshop_board_current to authenticated;


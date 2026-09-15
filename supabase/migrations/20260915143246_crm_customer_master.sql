create or replace function public.search_customer_master(
  p_query text default null,
  p_limit integer default 100
)
returns table(
  customer_id uuid,
  name text,
  phone text,
  document_id text,
  created_at timestamptz,
  vehicle_count bigint,
  order_count bigint,
  total_ref numeric,
  last_visit_at timestamptz,
  vehicles_text text
)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_query text := nullif(trim(p_query), '');
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
begin
  perform public.require_auth();

  return query
  select
    c.id,
    c.name,
    c.phone,
    c.document_id,
    c.created_at,
    coalesce(vs.vehicle_count, 0),
    coalesce(os.order_count, 0),
    coalesce(os.total_ref, 0),
    os.last_visit_at,
    vs.vehicles_text
  from public.customers c
  left join lateral (
    select count(*) as vehicle_count,
           string_agg(trim(concat_ws(' ', v.plate, v.make, v.model, v.year::text)), ' · ' order by v.updated_at desc) as vehicles_text
    from public.vehicles v where v.customer_id = c.id
  ) vs on true
  left join lateral (
    select count(*) as order_count,
           sum(o.total_ref) as total_ref,
           max(coalesce(o.closed_at, o.opened_at)) as last_visit_at
    from public.orders o where o.customer_id = c.id
  ) os on true
  where v_query is null
     or concat_ws(' ', c.name, c.phone, c.document_id) ilike '%' || v_query || '%'
     or exists (
       select 1 from public.vehicles sv
       where sv.customer_id = c.id
         and concat_ws(' ', sv.plate, sv.make, sv.model, sv.year::text) ilike '%' || v_query || '%'
     )
  order by os.last_visit_at desc nulls last, c.updated_at desc
  limit v_limit;
end;
$function$;

create or replace function public.update_customer_profile(
  p_customer_id uuid,
  p_name text default null,
  p_phone text default null,
  p_document_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_before jsonb;
  v_name text := nullif(trim(p_name), '');
  v_phone text := nullif(trim(p_phone), '');
  v_document text := nullif(trim(p_document_id), '');
begin
  perform public.require_auth();
  if p_customer_id is null then raise exception 'Cliente inválido'; end if;
  if v_name is null and v_phone is null and v_document is null then
    raise exception 'Debes indicar nombre, teléfono o documento';
  end if;

  select to_jsonb(c) - 'created_at' - 'updated_at' into v_before
  from public.customers c where c.id = p_customer_id for update;
  if not found then raise exception 'Cliente no encontrado'; end if;

  update public.customers
  set name = v_name, phone = v_phone, document_id = v_document
  where id = p_customer_id;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('customer.profile_updated', 'customer', p_customer_id,
    jsonb_build_object('before', v_before, 'after', jsonb_build_object('name', v_name, 'phone', v_phone, 'document_id', v_document)));
end;
$function$;

create or replace function public.reassign_vehicle_customer(
  p_vehicle_id uuid,
  p_customer_id uuid default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_previous uuid;
  v_reason text := nullif(trim(p_reason), '');
begin
  perform public.require_auth();
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Indica el motivo del cambio';
  end if;

  select customer_id into v_previous from public.vehicles where id = p_vehicle_id for update;
  if not found then raise exception 'Vehículo no encontrado'; end if;
  if p_customer_id is not null and not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception 'Cliente no encontrado';
  end if;
  if v_previous is not distinct from p_customer_id then
    raise exception 'El vehículo ya tiene esa asociación';
  end if;

  update public.vehicles set customer_id = p_customer_id where id = p_vehicle_id;

  if v_previous is not null then
    update public.vehicle_customer_history
    set last_seen_at = now()
    where vehicle_id = p_vehicle_id and customer_id = v_previous and source_system = 'LUBRICENTER_OS';
  end if;
  if p_customer_id is not null then
    insert into public.vehicle_customer_history(vehicle_id, customer_id, source_system, first_seen_at, last_seen_at)
    values (p_vehicle_id, p_customer_id, 'LUBRICENTER_OS', now(), now())
    on conflict (vehicle_id, customer_id, source_system)
    do update set last_seen_at = excluded.last_seen_at;
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values (
    case when p_customer_id is null then 'vehicle.customer_unlinked' else 'vehicle.customer_reassigned' end,
    'vehicle', p_vehicle_id,
    jsonb_build_object('previous_customer_id', v_previous, 'customer_id', p_customer_id, 'reason', v_reason)
  );
end;
$function$;

revoke all on function public.search_customer_master(text, integer) from public, anon;
revoke all on function public.update_customer_profile(uuid, text, text, text) from public, anon;
revoke all on function public.reassign_vehicle_customer(uuid, uuid, text) from public, anon;
grant execute on function public.search_customer_master(text, integer) to authenticated;
grant execute on function public.update_customer_profile(uuid, text, text, text) to authenticated;
grant execute on function public.reassign_vehicle_customer(uuid, uuid, text) to authenticated;


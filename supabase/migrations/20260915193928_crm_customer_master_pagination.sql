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
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
begin
  perform public.require_auth();
  return query
  select c.id, c.name, c.phone, c.document_id, c.created_at,
    coalesce(vs.vehicle_count, 0), coalesce(os.order_count, 0), coalesce(os.total_ref, 0), os.last_visit_at, vs.vehicles_text
  from public.customers c
  left join lateral (
    select count(*) as vehicle_count,
      string_agg(trim(concat_ws(' ', v.plate, v.make, v.model, v.year::text)), ' · ' order by v.updated_at desc) as vehicles_text
    from public.vehicles v where v.customer_id = c.id
  ) vs on true
  left join lateral (
    select count(*) as order_count, sum(o.total_ref) as total_ref,
      max(coalesce(o.closed_at, o.opened_at)) as last_visit_at
    from public.orders o where o.customer_id = c.id
  ) os on true
  where v_query is null
     or concat_ws(' ', c.name, c.phone, c.document_id) ilike '%' || v_query || '%'
     or exists (select 1 from public.vehicles sv where sv.customer_id = c.id
       and concat_ws(' ', sv.plate, sv.make, sv.model, sv.year::text) ilike '%' || v_query || '%')
  order by os.last_visit_at desc nulls last, c.updated_at desc
  limit v_limit;
end;
$function$;

create or replace function public.search_vehicles_for_customer(
  p_customer_id uuid,
  p_query text,
  p_limit integer default 12
)
returns table(
  id uuid,
  customer_id uuid,
  plate text,
  make text,
  model text,
  year integer,
  engine text,
  current_odometer integer,
  customer_name text
)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_query text := nullif(trim(p_query), '');
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 50);
begin
  perform public.require_auth();
  if v_query is null then return; end if;
  return query
  select v.id, v.customer_id, v.plate, v.make, v.model, v.year, v.engine, v.current_odometer, c.name
  from public.vehicles v
  left join public.customers c on c.id = v.customer_id
  where v.customer_id is distinct from p_customer_id
    and concat_ws(' ', v.plate, v.make, v.model, v.year::text, c.name) ilike '%' || v_query || '%'
  order by case when upper(coalesce(v.plate,'')) = upper(v_query) then 0 else 1 end, v.updated_at desc
  limit v_limit;
end;
$function$;

revoke all on function public.search_vehicles_for_customer(uuid, text, integer) from public, anon;
grant execute on function public.search_vehicles_for_customer(uuid, text, integer) to authenticated;


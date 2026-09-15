create or replace function public.create_customer_vehicle(
  p_customer_id uuid,
  p_plate text default null,
  p_make text default null,
  p_model text default null,
  p_year integer default null,
  p_engine text default null,
  p_current_odometer integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
  v_plate text := nullif(upper(trim(p_plate)), '');
  v_make text := nullif(trim(p_make), '');
  v_model text := nullif(trim(p_model), '');
  v_engine text := nullif(trim(p_engine), '');
begin
  perform public.require_auth();
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception 'Cliente no encontrado';
  end if;
  if v_plate is null and v_make is null and v_model is null then
    raise exception 'Debes indicar placa, marca o modelo';
  end if;
  if v_plate is not null and exists(select 1 from public.vehicles where upper(plate) = v_plate) then
    raise exception 'Esa placa ya existe. Usa Asociar existente para conservar el historial.';
  end if;
  if p_year is not null and (p_year < 1900 or p_year > extract(year from current_date)::integer + 1) then
    raise exception 'Año de vehículo inválido';
  end if;
  if p_current_odometer is not null and p_current_odometer < 0 then
    raise exception 'Kilometraje inválido';
  end if;

  insert into public.vehicles(customer_id, plate, make, model, year, engine, current_odometer)
  values (p_customer_id, v_plate, v_make, v_model, p_year, v_engine, p_current_odometer)
  returning id into v_id;

  insert into public.vehicle_customer_history(vehicle_id, customer_id, source_system, first_seen_at, last_seen_at)
  values (v_id, p_customer_id, 'LUBRICENTER_OS', now(), now())
  on conflict (vehicle_id, customer_id, source_system) do update set last_seen_at = excluded.last_seen_at;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('vehicle.created', 'vehicle', v_id, jsonb_build_object('customer_id', p_customer_id, 'plate', v_plate));
  return v_id;
end;
$function$;

revoke all on function public.create_customer_vehicle(uuid, text, text, text, integer, text, integer) from public, anon;
grant execute on function public.create_customer_vehicle(uuid, text, text, text, integer, text, integer) to authenticated;


-- La captura de placa en Venta rápida no modifica la venta cerrada (protegida por
-- guard_closed_edits). El carro y el cambio de aceite quedan en service_records,
-- que es de donde salen los recordatorios.

create or replace function lubricenter_private.crm_order_captured(p_order_id uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.service_records s
                 where s.order_id = p_order_id and s.service_type = 'OIL_CHANGE')
$$;

create or replace function public.crm_capture_status(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare o record; v_oil text; v_captured boolean;
begin
  perform public.require_auth();
  select id, status, customer_id, vehicle_id into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  v_oil := lubricenter_private.crm_order_oil_line(p_order_id);
  v_captured := o.vehicle_id is not null or lubricenter_private.crm_order_captured(p_order_id);
  return jsonb_build_object(
    'has_oil', v_oil is not null,
    'oil', v_oil,
    'has_vehicle', v_captured,
    'skipped', exists (select 1 from public.crm_capture_skips s where s.order_id = p_order_id),
    'needs', v_oil is not null and not v_captured and o.status <> 'CANCELLED'
      and not exists (select 1 from public.crm_capture_skips s where s.order_id = p_order_id));
end $$;

create or replace function public.crm_capture_sale(
  p_order_id uuid, p_plate text, p_phone text, p_name text default null,
  p_make text default null, p_model text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  o record; v_plate text; v_phone text; v_vehicle uuid; v_customer uuid; v_oil text;
  v_visc text; v_at timestamptz; v_cust_phone text;
begin
  perform public.require_auth();
  select id, status, business_at, closed_at, created_at into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  if o.status = 'CANCELLED' then raise exception 'La orden está anulada'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 1));
  v_plate := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g');
  if v_plate !~ '^[A-Z0-9]{5,8}$' then raise exception 'Escribe la placa completa (5 a 8 letras y números)'; end if;
  v_phone := lubricenter_private.crm_wa_phone(p_phone);
  if v_phone is null then raise exception 'Escribe un celular venezolano válido, por ejemplo 0414 123 4567'; end if;

  select v.id, v.customer_id into v_vehicle, v_customer from public.vehicles v
   where regexp_replace(upper(coalesce(v.plate, '')), '[^A-Z0-9]', '', 'g') = v_plate
   order by v.updated_at desc nulls last limit 1;

  if v_customer is null then
    select c.id into v_customer from public.customers c
     where lubricenter_private.crm_wa_phone(c.phone) = v_phone
     order by c.updated_at desc nulls last limit 1;
  end if;
  if v_customer is null then
    insert into public.customers(name, phone)
    values (coalesce(nullif(btrim(p_name), ''), 'Cliente ' || v_plate), '0' || substr(v_phone, 3))
    returning id into v_customer;
  else
    select c.phone into v_cust_phone from public.customers c where c.id = v_customer;
    if lubricenter_private.crm_wa_phone(v_cust_phone) is null then
      update public.customers set phone = '0' || substr(v_phone, 3), updated_at = now() where id = v_customer;
    end if;
    if nullif(btrim(p_name), '') is not null then
      update public.customers set name = btrim(p_name), updated_at = now()
       where id = v_customer and (name is null or btrim(name) = '' or name ~* '^cliente ');
    end if;
  end if;

  if v_vehicle is null then
    insert into public.vehicles(customer_id, plate, make, model)
    values (v_customer, v_plate, nullif(btrim(upper(coalesce(p_make, ''))), ''), nullif(btrim(upper(coalesce(p_model, ''))), ''))
    returning id into v_vehicle;
  elsif not exists (select 1 from public.vehicles v where v.id = v_vehicle and v.customer_id is not null) then
    update public.vehicles set customer_id = v_customer, updated_at = now() where id = v_vehicle;
  end if;

  delete from public.crm_capture_skips where order_id = p_order_id;

  v_oil := lubricenter_private.crm_order_oil_line(p_order_id);
  if v_oil is not null and not lubricenter_private.crm_order_captured(p_order_id) then
    v_visc := upper(replace(substring(v_oil from '([0-9]{1,2}[[:space:]]*[Ww][[:space:]]*[-/]?[[:space:]]*[0-9]{2})'), ' ', ''));
    v_at := coalesce(o.business_at, o.closed_at, o.created_at, now());
    insert into public.service_records(order_id, customer_id, vehicle_id, service_type, description,
      oil_brand, oil_viscosity, next_service_date, performed_at, created_by, source_system)
    values (p_order_id, v_customer, v_vehicle, 'OIL_CHANGE', 'Aceite comprado en mostrador (venta rápida)',
      v_oil, v_visc, ((v_at at time zone 'America/Caracas')::date + 90), v_at, auth.uid(), 'quick_sale_capture');
  end if;
  return jsonb_build_object('customer_id', v_customer, 'vehicle_id', v_vehicle);
end $$;

create or replace function public.crm_results(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  v jsonb;
begin
  perform public.require_auth();
  with sent as (
    select e.vehicle_id, e.recorded_at from public.crm_maintenance_events e
    where e.event_type = 'SENT' and e.recorded_at >= v_from - interval '45 days'
  ), returned as (
    select distinct on (s.id) s.id, s.order_id, s.vehicle_id
    from public.service_records s
    join sent x on x.vehicle_id = s.vehicle_id
      and s.performed_at > x.recorded_at and s.performed_at <= x.recorded_at + interval '45 days'
    where s.service_type = 'OIL_CHANGE' and s.performed_at >= v_from
      and not exists (select 1 from public.orders o where o.id = s.order_id and o.status = 'CANCELLED')
  ), oil_orders as (
    select o.id, (o.vehicle_id is not null or lubricenter_private.crm_order_captured(o.id)) as has_vehicle
    from public.orders o
    where o.status = 'CLOSED' and coalesce(o.closed_at, o.created_at) >= v_from
      and exists (select 1 from public.order_items oi where oi.order_id = o.id
        and (oi.business_area = 'OIL_CHANGE' or oi.oil_viscosity is not null
             or oi.description ~* '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}'))
  )
  select jsonb_build_object(
    'days', p_days,
    'reminders_sent', (select count(*) from public.crm_maintenance_events e where e.event_type = 'SENT' and e.recorded_at >= v_from),
    'post_service_sent', (select count(*) from public.customer_followups f where f.status = 'SENT' and f.sent_at >= v_from),
    'answered', (select count(*) from public.crm_maintenance_events e where e.recorded_at >= v_from
                  and e.event_type in ('BOOKED','POSTPONED','OTHER_SHOP','DECLINED','SOLD_VEHICLE','REPLIED')),
    'booked', (select count(*) from public.crm_maintenance_events e where e.recorded_at >= v_from and e.event_type = 'BOOKED'),
    'opted_out', (select count(*) from public.crm_contact_permissions p where p.status = 'OPT_OUT' and p.updated_at >= v_from),
    'returned', (select count(*) from returned),
    'returned_ref', (select coalesce(round(sum(o.total_ref), 2), 0) from public.orders o
                     where o.id in (select r.order_id from returned r)),
    'oil_orders', (select count(*) from oil_orders),
    'oil_orders_with_vehicle', (select count(*) from oil_orders where has_vehicle),
    'oil_orders_skipped', (select count(*) from oil_orders x where exists (select 1 from public.crm_capture_skips k where k.order_id = x.id))
  ) into v;
  return v;
end $$;

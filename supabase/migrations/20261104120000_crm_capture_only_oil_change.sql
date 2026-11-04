-- Venta rápida: la placa solo se exige cuando hubo cambio de aceite.
-- Litros sueltos o ventas sin cambio quedan como captura opcional (no bloquean).
-- Cambio de aceite = servicio OIL_CHANGE (o línea manual «cambio de aceite»),
-- o al menos 4 L de aceite de motor + filtro de aceite.

create or replace function lubricenter_private.crm_order_needs_capture(p_order_id uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  with l as (
    select oi.item_type, oi.business_area, oi.quantity, oi.pricing_mode, oi.description,
      oi.oil_viscosity, oi.inventory_item_id, ii.category, ii.unit
    from public.order_items oi
    left join public.inventory_items ii on ii.id = oi.inventory_item_id
    where oi.order_id = p_order_id
  )
  select exists (select 1 from l where l.item_type = 'SERVICE' and l.business_area = 'OIL_CHANGE')
    -- Línea manual de mano de obra escrita a mano («Servicio de cambio de aceite»).
    or exists (select 1 from l where l.inventory_item_id is null
      and l.description ~* 'cambio[[:space:]]+(de[[:space:]]+)?aceite')
    or (
      coalesce((
        select sum(l.quantity * case
            when l.unit = 'GAL' then 4
            when l.inventory_item_id is null and l.description ~* 'gal[oó]n' then 4
            else 1 end)
        from l
        where l.item_type = 'PRODUCT' and coalesce(l.pricing_mode, '') <> 'BONUS'
          and (l.category = 'Aceite Motor'
            or (l.inventory_item_id is null and (l.oil_viscosity is not null
              or l.description ~* '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}')))
          and l.description !~* 'hidr[aá]ulic|transmisi|caja|atf|2t|dos tiempos|motosierra|moto|4t|4 tiempos|filtro'
      ), 0) >= 4
      and exists (
        select 1 from l
        where l.item_type = 'PRODUCT'
          and (l.category = 'Filtro Aceite'
            or l.description ~* 'filtro[[:space:]]+(de[[:space:]]+)?aceite'
            or (l.inventory_item_id is null and l.description ~* 'filtro'
                and l.description !~* 'aire|gasolina|combustible|cabina|polen'))
      )
    )
$$;

revoke all on function lubricenter_private.crm_order_needs_capture(uuid) from public, anon;

create or replace function public.crm_capture_status(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare o record; v_oil text; v_captured boolean; v_skipped boolean; v_needs boolean;
begin
  perform public.require_auth();
  select id, status, customer_id, vehicle_id into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  v_oil := lubricenter_private.crm_order_oil_line(p_order_id);
  v_captured := o.vehicle_id is not null or lubricenter_private.crm_order_captured(p_order_id);
  v_skipped := exists (select 1 from public.crm_capture_skips s where s.order_id = p_order_id);
  v_needs := lubricenter_private.crm_order_needs_capture(p_order_id)
    and not v_captured and o.status <> 'CANCELLED' and not v_skipped;
  return jsonb_build_object(
    'has_oil', v_oil is not null,
    'oil', v_oil,
    'has_vehicle', v_captured,
    'skipped', v_skipped,
    'needs', v_needs,
    'optional', v_oil is not null and not v_needs and not v_captured and not v_skipped
      and o.status <> 'CANCELLED');
end $$;

revoke all on function public.crm_capture_status(uuid) from public, anon;
grant execute on function public.crm_capture_status(uuid) to authenticated;

-- Métrica de captura: el denominador son las ventas que sí exigen placa.
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
      and lubricenter_private.crm_order_needs_capture(o.id)
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

revoke all on function public.crm_results(int) from public, anon;
grant execute on function public.crm_results(int) to authenticated;

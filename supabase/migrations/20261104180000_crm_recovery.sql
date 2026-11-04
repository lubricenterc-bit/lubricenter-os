-- CRM: pestaña «Recuperar». Vencidos por tramo y desde cuándo, con el valor
-- histórico del cliente y un túnel por tramo que respeta el tope diario.
-- Resultado nuevo «Ya volvió» (RETURNED): cierra el ciclo del vehículo.
-- Hasta ahora el ciclo solo se cerraba al registrarse un cambio nuevo (el
-- service_record nuevo reemplaza al anterior en maintenance_reminders_current).

-- 1. «Ya volvió» (se amplía el CHECK, no se quita nada).
alter table public.crm_maintenance_events
  drop constraint if exists crm_maintenance_events_event_type_check;
alter table public.crm_maintenance_events
  add constraint crm_maintenance_events_event_type_check check (event_type = any (array[
    'SENT','REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','REACTIVATED',
    'POSTPONED','OTHER_SHOP','SOLD_VEHICLE','WRONG_NUMBER','RETURNED']));

-- 2. La vista reconoce «Ya volvió» como estado propio (mismas columnas).
create or replace view public.crm_vehicle_journeys with (security_invoker = true) as
with base as (
  select r.service_record_id, r.vehicle_id, r.customer_id, r.customer_name, r.customer_phone,
    r.plate, r.make, r.model, r.year, r.performed_at, r.oil_brand, r.oil_viscosity,
    r.next_service_odometer, r.next_service_date, r.forecast_confidence, r.due_reason,
    r.typical_visit_days,
    (now() at time zone 'America/Caracas')::date as today,
    lubricenter_private.crm_wa_phone(r.customer_phone) as wa_phone,
    p.status as permission,
    (fl.wrong_phone is not null and fl.wrong_phone = lubricenter_private.crm_wa_phone(r.customer_phone)) as phone_flagged,
    a.status as action_status, a.sent_at as action_sent_at, a.snoozed_until as action_snoozed_until,
    rs.reset_at, rs.reset_due,
    coalesce(s.n, 0) as n_sent, s.last_at as event_last_sent, s.first_stage,
    o.event_type as outcome, o.follow_up_on as outcome_on, o.recorded_at as outcome_at,
    cs.last_at as customer_last_sent,
    lubricenter_private.crm_setting_date('crm_legacy_bulk_date', date '2026-09-10') as bulk_day
  from public.maintenance_reminders_current r
  left join public.maintenance_reminder_actions a on a.service_record_id = r.service_record_id
  left join public.crm_contact_permissions p on p.customer_id = r.customer_id
  left join public.crm_customer_flags fl on fl.customer_id = r.customer_id
  left join lateral (
    select e.recorded_at as reset_at, e.follow_up_on as reset_due
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id and e.event_type = 'OTHER_SHOP'
    order by e.recorded_at desc limit 1) rs on true
  left join lateral (
    select count(*)::int as n, max(e.recorded_at) as last_at,
      (array_agg(e.stage order by e.recorded_at))[1] as first_stage
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id and e.event_type = 'SENT'
      and (rs.reset_at is null or e.recorded_at > rs.reset_at)) s on true
  left join lateral (
    select e.event_type, e.follow_up_on, e.recorded_at
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id
      and e.event_type in ('REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','POSTPONED','SOLD_VEHICLE','RETURNED')
      and (rs.reset_at is null or e.recorded_at > rs.reset_at)
    order by e.recorded_at desc limit 1) o on true
  left join lateral (
    select max(e.recorded_at) as last_at
    from public.crm_maintenance_events e
    where e.customer_id = r.customer_id and e.event_type = 'SENT' and e.vehicle_id <> r.vehicle_id) cs on true
), seq as (
  select b.*,
    -- Un envío del sistema viejo cuenta como 1 contacto, salvo el marcado en bloque del corte.
    case when b.reset_at is null and b.n_sent = 0 and b.action_status = 'SENT' and b.action_sent_at is not null
      and (b.action_sent_at at time zone 'America/Caracas')::date <> b.bulk_day then 1 else 0 end as legacy_sent,
    coalesce(b.reset_due, b.next_service_date) as cycle_due
  from base b
), seq2 as (
  select s.*,
    s.n_sent + s.legacy_sent as sent_count,
    coalesce(s.event_last_sent, case when s.legacy_sent = 1 then s.action_sent_at end) as last_sent_at,
    case when s.n_sent = 0 and s.legacy_sent = 1 then 'DUE'
      else case s.first_stage when 'PREVENTIVE' then 'PRE' when 'WINBACK' then 'RECONNECT'
        when 'RECOVERY' then 'RECOVERY' else 'DUE' end end as first_kind,
    s.today - s.cycle_due as days_from_due,
    -- El resultado solo cuenta si es posterior al último envío.
    (s.outcome is not null and (s.event_last_sent is null or s.outcome_at >= s.event_last_sent)) as outcome_current
  from seq s
), plan as (
  select q.*,
    case when q.sent_count = 0 then null
      when q.first_kind = 'PRE' then 3 when q.first_kind = 'RECONNECT' then 1 else 2 end as max_msgs,
    case
      when q.sent_count = 0 then case
        when q.days_from_due < -7 then null
        when q.days_from_due < 0 then 'PRE'
        when q.days_from_due <= 30 then 'DUE'
        when q.days_from_due <= 365 then 'RECOVERY'
        else 'RECONNECT' end
      when q.sent_count >= (case when q.first_kind = 'PRE' then 3 when q.first_kind = 'RECONNECT' then 1 else 2 end) then null
      when q.sent_count = 1 and q.first_kind = 'PRE' then 'DUE'
      else 'FINAL' end as next_kind,
    greatest(
      case when q.sent_count = 0 then q.cycle_due - 7
        else (q.last_sent_at at time zone 'America/Caracas')::date + case when q.sent_count = 1 then 10 else 14 end end,
      (q.customer_last_sent at time zone 'America/Caracas')::date + 14,
      case when q.outcome_current and q.outcome in ('POSTPONED','REPLIED')
        then coalesce(q.outcome_on, (q.outcome_at at time zone 'America/Caracas')::date + 30) end,
      case when q.outcome_current and q.outcome = 'BOOKED' then q.outcome_on + 4 end,
      case when q.action_status = 'SNOOZED' then q.action_snoozed_until end
    ) as eligible_on
  from seq2 q
)
select p.service_record_id, p.vehicle_id, p.customer_id, p.customer_name, p.customer_phone, p.wa_phone,
  p.plate, p.make, p.model, p.year, p.performed_at, p.oil_brand, p.oil_viscosity,
  p.next_service_odometer, p.cycle_due, p.days_from_due, p.forecast_confidence, p.due_reason,
  p.permission, p.sent_count, p.max_msgs, p.last_sent_at, p.next_kind, p.eligible_on,
  case when p.outcome_current then p.outcome end as last_outcome,
  case when p.outcome_current then p.outcome_on end as last_outcome_on,
  (p.last_sent_at is not null and not p.outcome_current) as awaiting_reply,
  case
    when p.permission = 'OPT_OUT' then 'OPTED_OUT'
    when p.outcome_current and p.outcome = 'RETURNED' then 'RETURNED'
    when p.outcome_current and p.outcome in ('DECLINED','SOLD_VEHICLE','CLOSED_NO_REPLY') then 'CLOSED'
    when p.wa_phone is null or p.phone_flagged then 'NO_PHONE'
    when p.outcome_current and p.outcome = 'BOOKED' and p.today <= p.outcome_on + 3 then 'BOOKED'
    when p.next_kind is null and p.sent_count = 0 then 'UPCOMING'
    when p.next_kind is null and (p.last_sent_at at time zone 'America/Caracas')::date + 14 <= p.today then 'CLOSED_NO_REPLY'
    when p.next_kind is null then 'WAITING_REPLY'
    when p.eligible_on <= p.today then 'READY'
    when p.last_sent_at is not null and not p.outcome_current then 'WAITING_REPLY'
    else 'SCHEDULED'
  end as status,
  case
    when p.next_kind in ('PRE','DUE') or (p.next_kind = 'FINAL' and p.days_from_due <= 7) then 2
    when p.days_from_due <= 90 then 3
    when p.days_from_due <= 365 then 4
    else 5 end as bucket
from plan p;


grant select on public.crm_vehicle_journeys to authenticated;

create or replace function public.crm_record_outcome(
  p_service_record_id uuid, p_outcome text, p_date date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  j record; v_id uuid; v_on date;
  v_today date := (now() at time zone 'America/Caracas')::date;
begin
  perform public.require_auth();
  if p_outcome not in ('BOOKED','POSTPONED','OTHER_SHOP','DECLINED','SOLD_VEHICLE','WRONG_NUMBER','OPT_OUT','SNOOZE','RETURNED') then
    raise exception 'Resultado no válido';
  end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'La nota es muy larga'; end if;
  select * into j from public.crm_vehicle_journeys where service_record_id = p_service_record_id;
  if not found then raise exception 'Este vehículo ya tiene un cambio de aceite más reciente'; end if;

  if p_outcome = 'OPT_OUT' then
    insert into public.crm_contact_permissions(customer_id, status, evidence, recorded_by, updated_at)
    values (j.customer_id, 'OPT_OUT', coalesce(nullif(btrim(p_notes), ''), 'El cliente pidió no recibir mensajes'), auth.uid(), now())
    on conflict (customer_id) do update set status = 'OPT_OUT', evidence = excluded.evidence,
      recorded_by = auth.uid(), updated_at = now();
    return null;
  end if;

  if p_outcome = 'SNOOZE' then
    v_on := coalesce(p_date, v_today + 7);
    if v_on <= v_today then raise exception 'La fecha tiene que ser futura'; end if;
    perform public.set_maintenance_reminder_status(p_service_record_id, 'SNOOZED', v_on);
    return null;
  end if;

  v_on := case p_outcome
    when 'BOOKED' then p_date
    when 'POSTPONED' then coalesce(p_date, v_today + 30)
    when 'OTHER_SHOP' then coalesce(p_date, v_today + 90)
    else null end;
  if p_outcome = 'BOOKED' and (v_on is null or v_on < v_today) then
    raise exception 'Indica el día de la cita (hoy o después)';
  end if;
  if p_outcome = 'POSTPONED' and v_on <= v_today then raise exception 'La fecha tiene que ser futura'; end if;

  if p_outcome = 'WRONG_NUMBER' then
    insert into public.crm_customer_flags(customer_id, wrong_phone, wrong_phone_at, recorded_by)
    values (j.customer_id, j.wa_phone, now(), auth.uid())
    on conflict (customer_id) do update set wrong_phone = excluded.wrong_phone,
      wrong_phone_at = now(), recorded_by = auth.uid();
  end if;

  insert into public.crm_maintenance_events
    (service_record_id, vehicle_id, customer_id, event_type, notes, follow_up_on, recorded_by)
  values (p_service_record_id, j.vehicle_id, j.customer_id, p_outcome,
    nullif(btrim(coalesce(p_notes, '')), ''), v_on, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.crm_record_outcome(uuid, text, date, text) from public, anon;
grant execute on function public.crm_record_outcome(uuid, text, date, text) to authenticated;

-- 3. Tramos de recuperación ------------------------------------------------------
create or replace function lubricenter_private.crm_recovery_bucket(p_days int)
returns text language sql immutable set search_path to '' as $$
  select case
    when p_days between -15 and -1 then 'SOON'
    when p_days between 0 and 30 then 'D0_30'
    when p_days between 31 and 90 then 'D31_90'
    when p_days between 91 and 180 then 'D91_180'
    when p_days between 181 and 365 then 'D181_365'
    when p_days > 365 then 'D365P'
  end
$$;
revoke all on function lubricenter_private.crm_recovery_bucket(int) from public, anon;
grant execute on function lubricenter_private.crm_recovery_bucket(int) to authenticated;

create or replace function lubricenter_private.crm_fold(p text)
returns text language sql immutable set search_path to '' as $$
  select lower(translate(coalesce(p, ''), 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))
$$;
revoke all on function lubricenter_private.crm_fold(text) from public, anon;
grant execute on function lubricenter_private.crm_fold(text) to authenticated;

-- Resumen por tramo. Fuera: no contactar, ciclo cerrado y «ya volvió».
-- «Sin teléfono» se cuenta aparte.
create or replace function public.crm_recovery_summary()
returns jsonb language sql stable security invoker set search_path to '' as $$
  with j as materialized (
    select v.customer_id, v.status, v.sent_count, v.awaiting_reply, v.forecast_confidence,
      lubricenter_private.crm_recovery_bucket(v.days_from_due) as bucket
    from public.crm_vehicle_journeys v
    where v.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED')
  ), val as materialized (
    select x.customer_id, sum(x.amount) as lifetime_ref
    from (
      select o.customer_id, o.total_ref as amount from public.orders o
      where o.status = 'CLOSED' and o.customer_id in (select customer_id from j)
      union all
      select s.customer_id, coalesce(s.charged_ref_amount, 0) from public.service_records s
      where s.order_id is null and s.customer_id in (select customer_id from j)
    ) x group by x.customer_id
  ), b(code, label, sort) as (values
    ('SOON', 'Vencen pronto', 1), ('D0_30', 'Vencidos hace 0–30 días', 2), ('D31_90', 'Hace 31–90 días', 3),
    ('D91_180', 'Hace 91–180 días', 4), ('D181_365', 'Hace 181–365 días', 5), ('D365P', 'Hace más de 1 año', 6))
  select coalesce(jsonb_agg(jsonb_build_object(
      'bucket', b.code, 'label', b.label,
      'vehicles', (select count(*) from j where j.bucket = b.code and j.status <> 'NO_PHONE'),
      'customers', (select count(distinct j.customer_id) from j where j.bucket = b.code and j.status <> 'NO_PHONE'),
      'contacted', (select count(*) from j where j.bucket = b.code and j.status <> 'NO_PHONE' and j.sent_count > 0),
      'awaiting_reply', (select count(*) from j where j.bucket = b.code and j.status <> 'NO_PHONE' and j.awaiting_reply),
      'lifetime_ref', (select coalesce(round(sum(val.lifetime_ref), 2), 0) from val
                       where val.customer_id in (select j.customer_id from j where j.bucket = b.code and j.status <> 'NO_PHONE')),
      'estimated', (select count(*) from j where j.bucket = b.code and j.status <> 'NO_PHONE'
                    and coalesce(j.forecast_confidence, 'INSUFFICIENT') in ('INSUFFICIENT', 'LOW')),
      'no_phone', (select count(*) from j where j.bucket = b.code and j.status = 'NO_PHONE')
    ) order by b.sort), '[]'::jsonb)
  from b
$$;
revoke all on function public.crm_recovery_summary() from public, anon;
grant execute on function public.crm_recovery_summary() to authenticated;

-- Lista de un tramo, con valor histórico y visitas del cliente.
create or replace function public.crm_recovery_list(
  p_bucket text, p_sort text default 'PRIORITY', p_query text default null,
  p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security invoker set search_path to '' as $$
declare v_q text := nullif(btrim(lubricenter_private.crm_fold(p_query)), ''); v jsonb;
begin
  if p_bucket not in ('SOON', 'D0_30', 'D31_90', 'D91_180', 'D181_365', 'D365P') then raise exception 'Tramo no válido'; end if;
  if coalesce(p_sort, 'PRIORITY') not in ('PRIORITY', 'RECENT', 'OLDEST') then raise exception 'Orden no válido'; end if;
  with j as materialized (
    select v.* from public.crm_vehicle_journeys v
    where v.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED', 'NO_PHONE')
      and lubricenter_private.crm_recovery_bucket(v.days_from_due) = p_bucket
      and (v_q is null or (
        select bool_and(lubricenter_private.crm_fold(concat_ws(' ', v.customer_name, v.plate, v.customer_phone, v.wa_phone, v.make, v.model))
                        like '%' || w || '%')
        from unnest(regexp_split_to_array(v_q, '[[:space:]]+')) w))
  ), val as materialized (
    select x.customer_id, round(sum(x.amount), 2) as lifetime_ref
    from (
      select o.customer_id, o.total_ref as amount from public.orders o
      where o.status = 'CLOSED' and o.customer_id in (select customer_id from j)
      union all
      select s.customer_id, coalesce(s.charged_ref_amount, 0) from public.service_records s
      where s.order_id is null and s.customer_id in (select customer_id from j)
    ) x group by x.customer_id
  ), visits as materialized (
    select s.customer_id, count(distinct (s.performed_at at time zone 'America/Caracas')::date) as n
    from public.service_records s where s.customer_id in (select customer_id from j)
    group by s.customer_id
  ), rows as (
    select j.*, coalesce(val.lifetime_ref, 0) as lifetime_ref, coalesce(visits.n, 0) as visits
    from j left join val on val.customer_id = j.customer_id left join visits on visits.customer_id = j.customer_id
  )
  select jsonb_build_object(
    'total', (select count(*) from rows),
    'rows', coalesce((select jsonb_agg(x.r order by x.rn) from (
      select row_number() over (order by
          case when coalesce(p_sort, 'PRIORITY') = 'PRIORITY' then rows.lifetime_ref end desc nulls last,
          case when coalesce(p_sort, 'PRIORITY') in ('PRIORITY', 'RECENT') then rows.days_from_due end asc,
          case when p_sort = 'OLDEST' then rows.days_from_due end desc,
          rows.service_record_id) as rn,
        jsonb_build_object(
          'service_record_id', rows.service_record_id, 'vehicle_id', rows.vehicle_id, 'customer_id', rows.customer_id,
          'customer_name', rows.customer_name, 'wa_phone', rows.wa_phone, 'plate', rows.plate,
          'make', rows.make, 'model', rows.model, 'performed_at', rows.performed_at,
          'cycle_due', rows.cycle_due, 'days_from_due', rows.days_from_due,
          'estimated', coalesce(rows.forecast_confidence, 'INSUFFICIENT') in ('INSUFFICIENT', 'LOW'),
          'oil_brand', rows.oil_brand, 'oil_viscosity', rows.oil_viscosity,
          'sent_count', rows.sent_count, 'last_sent_at', rows.last_sent_at, 'last_outcome', rows.last_outcome,
          'status', rows.status, 'eligible_on', rows.eligible_on,
          'lifetime_ref', rows.lifetime_ref, 'visits', rows.visits) as r
      from rows
      order by 1
      limit greatest(least(coalesce(p_limit, 50), 200), 1) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb)
  ) into v;
  return v;
end $$;
revoke all on function public.crm_recovery_list(text, text, text, int, int) from public, anon;
grant execute on function public.crm_recovery_list(text, text, text, int, int) to authenticated;

-- Cola del túnel para un tramo: mismas reglas y forma que crm_board (solo
-- vehículos listos hoy, una persona una sola vez y el tope diario restante).
create or replace function public.crm_bucket_queue(p_bucket text, p_limit int default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_sent int; v_remaining int; v_ready int; v_queue jsonb;
begin
  perform public.require_auth();
  if p_bucket not in ('SOON', 'D0_30', 'D31_90', 'D91_180', 'D181_365', 'D365P') then raise exception 'Tramo no válido'; end if;
  select (select count(*) from public.crm_maintenance_events e
           where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = v_today)
       + (select count(*) from public.customer_followups f
           where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = v_today)
  into v_sent;
  v_remaining := greatest(v_cap - v_sent, 0);
  if p_limit is not null then v_remaining := least(v_remaining, greatest(p_limit, 0)); end if;

  with ready as materialized (
    select j.* from public.crm_vehicle_journeys j
    where j.status = 'READY' and lubricenter_private.crm_recovery_bucket(j.days_from_due) = p_bucket
  ), val as materialized (
    select o.customer_id, sum(o.total_ref) as lifetime_ref from public.orders o
    where o.status = 'CLOSED' and o.customer_id in (select customer_id from ready) group by o.customer_id
  ), one_per_person as (
    select distinct on (r.customer_id) r.*, coalesce(val.lifetime_ref, 0) as lifetime_ref
    from ready r left join val on val.customer_id = r.customer_id
    order by r.customer_id, r.days_from_due desc
  ), picked as (
    select * from one_per_person order by lifetime_ref desc, days_from_due asc limit v_remaining
  )
  select (select count(*) from one_per_person),
    coalesce(jsonb_agg(jsonb_build_object(
      'type','REMINDER','id',r.service_record_id,'vehicle_id',r.vehicle_id,
      'customer_id',r.customer_id,'customer_name',r.customer_name,'phone',r.customer_phone,'wa_phone',r.wa_phone,
      'vehicle',nullif(btrim(concat_ws(' ',r.make,r.model,r.year)),''),'plate',r.plate,
      'kind',r.next_kind,'step',r.sent_count + 1,
      'max_steps',case when r.sent_count = 0 then case r.next_kind when 'PRE' then 3 when 'RECONNECT' then 1 else 2 end else r.max_msgs end,
      'why',case
        when r.next_kind = 'PRE' then 'Le toca el cambio el ' || to_char(r.cycle_due,'DD/MM') || ' (en ' || (-r.days_from_due) || ' días)'
        when r.next_kind = 'DUE' and r.days_from_due = 0 then 'Le toca el cambio hoy'
        when r.next_kind = 'DUE' then 'Le tocaba el cambio el ' || to_char(r.cycle_due,'DD/MM') || ' (hace ' || r.days_from_due || ' días)'
        when r.next_kind = 'RECOVERY' then 'No vuelve desde el ' || to_char(r.performed_at at time zone 'America/Caracas','DD/MM/YYYY') || '; le tocaba hace ' || r.days_from_due || ' días'
        when r.next_kind = 'RECONNECT' then 'Último cambio hace más de un año (' || to_char(r.performed_at at time zone 'America/Caracas','DD/MM/YYYY') || ')'
        else 'Último mensaje. Sin respuesta desde el ' || to_char(r.last_sent_at at time zone 'America/Caracas','DD/MM') end,
      'warning',null,
      'message',lubricenter_private.crm_render(
        r.next_kind, r.customer_name, nullif(btrim(concat_ws(' ', r.make, r.model)), ''), r.plate,
        (r.performed_at at time zone 'America/Caracas')::date, r.cycle_due,
        nullif(btrim(concat_ws(' ', r.oil_brand, r.oil_viscosity)), ''), r.next_service_odometer)
    ) order by r.lifetime_ref desc, r.days_from_due asc), '[]'::jsonb)
  into v_ready, v_queue
  from picked r;

  return jsonb_build_object('bucket', p_bucket, 'cap', v_cap, 'sent_today', v_sent,
    'remaining', greatest(v_cap - v_sent, 0), 'eligible', v_ready, 'queue', v_queue);
end $$;
revoke all on function public.crm_bucket_queue(text, int) from public, anon;
grant execute on function public.crm_bucket_queue(text, int) to authenticated;

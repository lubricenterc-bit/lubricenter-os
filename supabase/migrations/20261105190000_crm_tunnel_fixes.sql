-- CRM: correcciones del túnel y del ciclo (5 nov 2026, decisiones del dueño A/B/C).
-- 1. El envío no se pierde: al abrir WhatsApp queda un «intento» en la base
--    (crm_send_attempts) que se confirma después, aunque la página se recargue.
--    Antes de abrir WhatsApp se valida que siga tocando (evita duplicados).
-- 2. «No enviar» con motivo (DISMISSED): «No hace falta» cierra el ciclo (A);
--    «Pasó mucho tiempo» lo pasa a la cartera de reenganche.
-- 3. Posponer ya no borra el historial del sistema anterior.
-- 4. Una persona por día en la cola y el postservicio cuenta para los 14 días.
-- 5. «Más adelante» agenda un mensaje propio (AGREED) a los 30 días.
-- 6. Segunda oportunidad (SECOND) 120 días después del último mensaje sin
--    respuesta; si tampoco responde queda «En cartera» (DORMANT) para promociones (B).
-- 7. «Ya volvió» arranca un ciclo nuevo desde ese día (C).
-- 8. El túnel por tramo reserva el cupo de los postservicios pendientes.
-- Aditiva: tabla nueva, CHECK ampliados (sin quitar valores) y funciones recreadas
-- con el mismo contrato (más claves en el JSON).

insert into public.app_settings(key, value) values ('crm_second_chance_days', '120'::jsonb)
on conflict (key) do nothing;

-- 1. Valores nuevos -----------------------------------------------------------------
alter table public.crm_maintenance_events drop constraint if exists crm_maintenance_events_event_type_check;
alter table public.crm_maintenance_events add constraint crm_maintenance_events_event_type_check
  check (event_type = any (array['SENT','REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','REACTIVATED',
    'POSTPONED','OTHER_SHOP','SOLD_VEHICLE','WRONG_NUMBER','RETURNED','DISMISSED']));
alter table public.crm_maintenance_events drop constraint if exists crm_maintenance_events_stage_check;
alter table public.crm_maintenance_events add constraint crm_maintenance_events_stage_check
  check (stage is null or stage = any (array['PREVENTIVE','DUE','LATE','RECOVERY','WINBACK','AGREED','SECOND']));
alter table public.crm_message_templates drop constraint if exists crm_message_templates_kind_check;
alter table public.crm_message_templates add constraint crm_message_templates_kind_check
  check (kind = any (array['PRE','DUE','FINAL','RECOVERY','RECONNECT','AGREED','SECOND']));

insert into public.crm_message_templates(kind, body) values
('AGREED', E'¡Hola, {{nombre}}! 👋 Te escribimos de *Lubricenter Cabudare*, como quedamos.\n\n¿Ya le toca el cambio de aceite a tu *{{vehiculo}}* ({{placa}})? Si quieres, te apartamos un día que te quede bien.\n\nSi no quieres recibir estos recordatorios, respóndenos NO.'),
('SECOND', E'¡Hola, {{nombre}}! 👋 Somos *Lubricenter Cabudare*. Hace unos meses te escribimos por el cambio de aceite de tu *{{vehiculo}}* ({{placa}}).\n\nSi todavía no lo has hecho o quieres revisar el carro, con gusto te atendemos. ¿Te apartamos un día?\n\nSi no quieres recibir estos recordatorios, respóndenos NO.')
on conflict (kind) do nothing;

create or replace function lubricenter_private.crm_kind_to_stage(p_kind text)
returns text language sql immutable set search_path to '' as $$
  select case p_kind when 'PRE' then 'PREVENTIVE' when 'DUE' then 'DUE' when 'FINAL' then 'LATE'
    when 'RECOVERY' then 'RECOVERY' when 'RECONNECT' then 'WINBACK'
    when 'AGREED' then 'AGREED' when 'SECOND' then 'SECOND' end
$$;

-- 2. Intentos de envío (abrir WhatsApp → confirmar) ------------------------------------
create table if not exists public.crm_send_attempts (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('REMINDER', 'POST_SERVICE')),
  service_record_id uuid references public.service_records(id) on delete cascade,
  followup_id uuid references public.customer_followups(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  vehicle_id uuid,
  kind text not null,
  message text not null check (length(message) between 1 and 4000),
  opened_by uuid,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('SENT', 'NOT_SENT')),
  check ((target_type = 'REMINDER' and service_record_id is not null and followup_id is null)
      or (target_type = 'POST_SERVICE' and followup_id is not null and service_record_id is null))
);
alter table public.crm_send_attempts enable row level security;
drop policy if exists crm_send_attempts_staff_read on public.crm_send_attempts;
create policy crm_send_attempts_staff_read on public.crm_send_attempts
  for select to authenticated using ((select lubricenter_private.staff_identity_allowed()));
revoke all on public.crm_send_attempts from anon;
create unique index if not exists crm_send_attempts_open_target
  on public.crm_send_attempts (coalesce(service_record_id, followup_id)) where resolved_at is null;
create index if not exists crm_send_attempts_open_customer
  on public.crm_send_attempts (customer_id) where resolved_at is null;

-- Enviados hoy (lo que cuenta para el tope): registrados + abiertos sin confirmar.
create or replace function lubricenter_private.crm_sent_today()
returns int language sql stable security definer set search_path to '' as $$
  with d as (select (now() at time zone 'America/Caracas')::date as today)
  select ((select count(*) from public.crm_maintenance_events e, d
            where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = d.today)
        + (select count(*) from public.customer_followups f, d
            where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = d.today)
        + (select count(*) from public.crm_send_attempts a, d
            where a.resolved_at is null and (a.opened_at at time zone 'America/Caracas')::date = d.today))::int
$$;
revoke all on function lubricenter_private.crm_sent_today() from public, anon;
grant execute on function lubricenter_private.crm_sent_today() to authenticated;

-- 3. Recorrido por vehículo -----------------------------------------------------------
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
    coalesce(s.n, 0) as n_sent, coalesce(s.n_second, 0) as n_second, s.last_at as event_last_sent, s.first_stage,
    o.event_type as outcome, o.follow_up_on as outcome_on, o.recorded_at as outcome_at, o.notes as outcome_notes,
    cs.last_at as customer_last_sent,
    lubricenter_private.crm_setting_date('crm_legacy_bulk_date', date '2026-09-10') as bulk_day,
    lubricenter_private.crm_setting_int('crm_second_chance_days', 120) as second_days
  from public.maintenance_reminders_current r
  left join public.maintenance_reminder_actions a on a.service_record_id = r.service_record_id
  left join public.crm_contact_permissions p on p.customer_id = r.customer_id
  left join public.crm_customer_flags fl on fl.customer_id = r.customer_id
  -- «Lo hizo en otro lado» y «Ya volvió» reinician el ciclo desde su fecha.
  left join lateral (
    select e.recorded_at as reset_at, e.follow_up_on as reset_due
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id and e.event_type in ('OTHER_SHOP', 'RETURNED')
    order by e.recorded_at desc limit 1) rs on true
  left join lateral (
    select count(*) filter (where coalesce(e.stage, '') <> 'SECOND')::int as n,
      count(*) filter (where e.stage = 'SECOND')::int as n_second,
      max(e.recorded_at) as last_at,
      (array_agg(e.stage order by e.recorded_at) filter (where coalesce(e.stage, '') <> 'SECOND'))[1] as first_stage
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id and e.event_type = 'SENT'
      and (rs.reset_at is null or e.recorded_at > rs.reset_at)) s on true
  left join lateral (
    select e.event_type, e.follow_up_on, e.recorded_at, e.notes
    from public.crm_maintenance_events e
    where e.service_record_id = r.service_record_id
      and e.event_type in ('REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','POSTPONED','SOLD_VEHICLE','RETURNED','DISMISSED')
      and (rs.reset_at is null or e.recorded_at > rs.reset_at)
    order by e.recorded_at desc limit 1) o on true
  -- Último mensaje a esta persona por otro carro o por un postservicio.
  left join lateral (
    select max(x.at) as last_at from (
      select e.recorded_at as at from public.crm_maintenance_events e
      where e.customer_id = r.customer_id and e.event_type = 'SENT' and e.vehicle_id <> r.vehicle_id
      union all
      select f.sent_at from public.customer_followups f
      where f.customer_id = r.customer_id and f.status = 'SENT' and f.sent_at is not null) x) cs on true
), seq as (
  select b.*,
    -- Un envío del sistema anterior cuenta como 1 contacto (salvo el marcado en
    -- bloque del corte). Se mira la fecha y no el estado: posponer ya no lo borra.
    case when b.reset_at is null and b.n_sent = 0 and b.action_sent_at is not null
      and (b.action_sent_at at time zone 'America/Caracas')::date <> b.bulk_day then 1 else 0 end as legacy_sent,
    coalesce(b.reset_due, b.next_service_date) as cycle_due
  from base b
), seq2 as (
  select s.*,
    s.n_sent + s.legacy_sent as regular_sent,
    s.n_sent + s.legacy_sent + s.n_second as sent_count,
    coalesce(s.event_last_sent, case when s.legacy_sent = 1 then s.action_sent_at end) as last_sent_at,
    case when s.n_sent = 0 and s.legacy_sent = 1 then 'DUE'
      else case s.first_stage when 'PREVENTIVE' then 'PRE' when 'WINBACK' then 'RECONNECT'
        when 'RECOVERY' then 'RECOVERY' else 'DUE' end end as first_kind,
    s.today - s.cycle_due as days_from_due,
    (s.outcome is not null and (s.event_last_sent is null or s.outcome_at >= s.event_last_sent)) as outcome_current
  from seq s
), plan0 as (
  select q.*,
    case when q.regular_sent = 0 then null
      when q.first_kind = 'PRE' then 3 when q.first_kind = 'RECONNECT' then 1 else 2 end as max_msgs,
    case
      when q.outcome_current and q.outcome = 'POSTPONED' then 'AGREED'
      when q.regular_sent = 0 then case
        when q.days_from_due < -7 then null
        when q.days_from_due < 0 then 'PRE'
        when q.days_from_due <= 30 then 'DUE'
        when q.days_from_due <= 365 then 'RECOVERY'
        else 'RECONNECT' end
      when q.regular_sent >= (case when q.first_kind = 'PRE' then 3 when q.first_kind = 'RECONNECT' then 1 else 2 end)
        then case when q.n_second = 0 then 'SECOND' end
      when q.regular_sent = 1 and q.first_kind = 'PRE' then 'DUE'
      else 'FINAL' end as next_kind
  from seq2 q
), plan as (
  select q.*,
    greatest(
      case
        when q.next_kind = 'AGREED' then coalesce(q.outcome_on, (q.outcome_at at time zone 'America/Caracas')::date + 30)
        when q.next_kind = 'SECOND' then (q.last_sent_at at time zone 'America/Caracas')::date + q.second_days
        when q.regular_sent = 0 then q.cycle_due - 7
        else (q.last_sent_at at time zone 'America/Caracas')::date + case when q.regular_sent = 1 then 10 else 14 end end,
      (q.customer_last_sent at time zone 'America/Caracas')::date + 14,
      case when q.outcome_current and q.outcome = 'REPLIED'
        then coalesce(q.outcome_on, (q.outcome_at at time zone 'America/Caracas')::date + 30) end,
      case when q.outcome_current and q.outcome = 'BOOKED' then q.outcome_on + 4 end,
      case when q.action_status = 'SNOOZED' then q.action_snoozed_until end
    ) as eligible_on
  from plan0 q
), st as (
  select p.*,
    case
      when p.permission = 'OPT_OUT' then 'OPTED_OUT'
      when p.outcome_current and p.outcome = 'RETURNED' then 'RETURNED'
      when p.outcome_current and p.outcome = 'DISMISSED' and p.outcome_notes = 'TOO_LATE' then 'DORMANT'
      when p.outcome_current and p.outcome in ('DECLINED','SOLD_VEHICLE','CLOSED_NO_REPLY','DISMISSED') then 'CLOSED'
      when p.wa_phone is null or p.phone_flagged then 'NO_PHONE'
      when p.outcome_current and p.outcome = 'BOOKED' and p.today <= p.outcome_on + 3 then 'BOOKED'
      when p.next_kind is null and p.regular_sent = 0 then 'UPCOMING'
      -- Recibió también la segunda oportunidad y no respondió: queda en la cartera.
      when p.next_kind is null and (p.last_sent_at at time zone 'America/Caracas')::date + 14 <= p.today then 'DORMANT'
      when p.next_kind is null then 'WAITING_REPLY'
      when p.next_kind = 'SECOND' and p.eligible_on > p.today then
        case when (p.last_sent_at at time zone 'America/Caracas')::date + 14 > p.today and not p.outcome_current
          then 'WAITING_REPLY' else 'CLOSED_NO_REPLY' end
      when p.eligible_on <= p.today then 'READY'
      when p.last_sent_at is not null and not p.outcome_current then 'WAITING_REPLY'
      else 'SCHEDULED'
    end as status
  from plan p
)
select p.service_record_id, p.vehicle_id, p.customer_id, p.customer_name, p.customer_phone, p.wa_phone,
  p.plate, p.make, p.model, p.year, p.performed_at, p.oil_brand, p.oil_viscosity,
  p.next_service_odometer, p.cycle_due, p.days_from_due, p.forecast_confidence, p.due_reason,
  p.permission, p.sent_count, p.max_msgs, p.last_sent_at, p.next_kind, p.eligible_on,
  case when p.outcome_current then p.outcome end as last_outcome,
  case when p.outcome_current then p.outcome_on end as last_outcome_on,
  (p.last_sent_at is not null and not p.outcome_current and p.status in ('WAITING_REPLY','SCHEDULED','READY')) as awaiting_reply,
  p.status,
  case
    when p.next_kind in ('PRE','DUE','AGREED') or (p.next_kind = 'FINAL' and p.days_from_due <= 7) then 2
    when p.next_kind = 'SECOND' then 4
    when p.days_from_due <= 90 then 3
    when p.days_from_due <= 365 then 4
    else 5 end as bucket
from st p;
grant select on public.crm_vehicle_journeys to authenticated;

-- 4. Un elemento de la cola (mismo JSON en Hoy, Recuperar y «Escribir») ----------------
create or replace function lubricenter_private.crm_item_json(r public.crm_vehicle_journeys)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'type','REMINDER','id',r.service_record_id,'vehicle_id',r.vehicle_id,
    'customer_id',r.customer_id,'customer_name',r.customer_name,'phone',r.customer_phone,'wa_phone',r.wa_phone,
    'vehicle',nullif(btrim(concat_ws(' ',r.make,r.model,r.year)),''),'plate',r.plate,
    'kind',r.next_kind,'step',r.sent_count + 1,
    'max_steps',case when r.next_kind in ('AGREED','SECOND') then null
      when r.sent_count = 0 then case r.next_kind when 'PRE' then 3 when 'RECONNECT' then 1 else 2 end else r.max_msgs end,
    'last_sent_at', r.last_sent_at,
    'why',case
      when r.next_kind = 'PRE' then 'Le toca el cambio el ' || to_char(r.cycle_due,'DD/MM') || ' (en ' || (-r.days_from_due) || ' días)'
      when r.next_kind = 'DUE' and r.days_from_due = 0 then 'Le toca el cambio hoy'
      when r.next_kind = 'DUE' then 'Le tocaba el cambio el ' || to_char(r.cycle_due,'DD/MM') || ' (hace ' || r.days_from_due || ' días)'
      when r.next_kind = 'RECOVERY' then 'No vuelve desde el ' || to_char(r.performed_at at time zone 'America/Caracas','DD/MM/YYYY') || '; le tocaba hace ' || r.days_from_due || ' días'
      when r.next_kind = 'RECONNECT' then 'Último cambio hace más de un año (' || to_char(r.performed_at at time zone 'America/Caracas','DD/MM/YYYY') || ')'
      when r.next_kind = 'AGREED' then 'Pidió que le escribiéramos más adelante; quedamos en el ' || to_char(r.eligible_on,'DD/MM')
      when r.next_kind = 'SECOND' then 'Segunda oportunidad: no respondió desde el ' || to_char(r.last_sent_at at time zone 'America/Caracas','DD/MM/YYYY')
      else 'Último mensaje. Sin respuesta desde el ' || to_char(r.last_sent_at at time zone 'America/Caracas','DD/MM') end,
    'warning',null,
    'message',lubricenter_private.crm_render(
      r.next_kind, r.customer_name, nullif(btrim(concat_ws(' ', r.make, r.model)), ''), r.plate,
      (r.performed_at at time zone 'America/Caracas')::date, r.cycle_due,
      nullif(btrim(concat_ws(' ', r.oil_brand, r.oil_viscosity)), ''), r.next_service_odometer))
$$;
revoke all on function lubricenter_private.crm_item_json(public.crm_vehicle_journeys) from public, anon;
grant execute on function lubricenter_private.crm_item_json(public.crm_vehicle_journeys) to authenticated;

-- Pendientes de confirmar (abrieron WhatsApp y falta decir si se envió).
create or replace function lubricenter_private.crm_pending_json()
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'type', a.target_type, 'id', coalesce(a.service_record_id, a.followup_id), 'attempt_id', a.id,
      'customer_id', a.customer_id, 'customer_name', c.name, 'phone', c.phone,
      'wa_phone', lubricenter_private.crm_wa_phone(c.phone),
      'vehicle', nullif(btrim(concat_ws(' ', v.make, v.model, v.year)), ''), 'plate', v.plate,
      'kind', a.kind, 'step', null, 'max_steps', null, 'last_sent_at', null,
      'why', 'Se abrió WhatsApp el ' || to_char(a.opened_at at time zone 'America/Caracas', 'DD/MM "a las" HH24:MI'),
      'warning', null, 'message', a.message,
      'opened_at', a.opened_at, 'mine', a.opened_by is not distinct from auth.uid())
    order by a.opened_at), '[]'::jsonb)
  from public.crm_send_attempts a
  join public.customers c on c.id = a.customer_id
  left join public.vehicles v on v.id = a.vehicle_id
  where a.resolved_at is null and a.opened_at > now() - interval '7 days'
$$;
revoke all on function lubricenter_private.crm_pending_json() from public, anon;
grant execute on function lubricenter_private.crm_pending_json() to authenticated;

-- 5. Tablero del día ------------------------------------------------------------------
create or replace function public.crm_board()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent_today int := lubricenter_private.crm_sent_today();
  v_remaining int;
  v_post jsonb; v_rem jsonb; v_post_n int; v_ready_n int;
begin
  perform public.require_auth();
  v_remaining := greatest(v_cap - v_sent_today, 0);

  with p as (
    select f.id, f.order_id, f.order_number, f.customer_id, f.customer_name, f.customer_phone,
      lubricenter_private.crm_wa_phone(f.customer_phone) as wa_phone,
      f.plate, f.make, f.model, f.message, f.closed_at, f.followup_type,
      (select string_agg(distinct vm.mk, ', ') from (
         select upper(btrim(v2.make)) as mk from public.vehicles v2
         where length(btrim(coalesce(v2.make,''))) >= 4) vm
       where upper(coalesce(f.make,'')) <> vm.mk
         and exists (select 1 from public.order_items oi where oi.order_id = f.order_id
                     and upper(oi.description) ~ ('(^|[^A-Z])' || regexp_replace(vm.mk, '([^A-Z0-9 ])', '\\\1', 'g') || '([^A-Z]|$)'))) as other_make
    from public.customer_followups_current f
    left join public.crm_contact_permissions cp on cp.customer_id = f.customer_id
    where f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
      and (f.status = 'PENDING' or (f.status = 'SNOOZED' and coalesce(f.snoozed_until, v_today) <= v_today))
      and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid)
      and coalesce(cp.status, '') <> 'OPT_OUT'
      and lubricenter_private.crm_wa_phone(f.customer_phone) is not null
      and not exists (select 1 from public.crm_send_attempts a where a.followup_id = f.id and a.resolved_at is null)
  ), p1 as (
    -- Una persona por día también en el postservicio.
    select distinct on (p.customer_id) p.* from p order by p.customer_id, coalesce(p.closed_at, now())
  )
  select count(*)::int,
    coalesce(jsonb_agg(jsonb_build_object(
      'type','POST_SERVICE','id',p.id,'order_id',p.order_id,'order_number',p.order_number,
      'customer_id',p.customer_id,'customer_name',p.customer_name,'phone',p.customer_phone,'wa_phone',p.wa_phone,
      'vehicle',nullif(btrim(concat_ws(' ',p.make,p.model)),''),'plate',p.plate,
      'why','Visita del ' || to_char((coalesce(p.closed_at, now()) at time zone 'America/Caracas'), 'DD/MM') || ' · ' || coalesce(p.order_number,''),
      'kind','POST_SERVICE','step',null,'max_steps',null,'last_sent_at',null,
      'warning',case when p.other_make is not null then 'Un trabajo menciona otra marca de carro (' || p.other_make || '). Revisa el texto antes de enviarlo.' end,
      'message',p.message) order by p.closed_at), '[]'::jsonb)
  into v_post_n, v_post from p1 p;

  with ready as materialized (
    select j as jr, j.customer_id, j.bucket, j.days_from_due, j.cycle_due from public.crm_vehicle_journeys j
    where j.status = 'READY'
      and not exists (select 1 from public.crm_send_attempts a where a.customer_id = j.customer_id and a.resolved_at is null)
      and not exists (select 1 from jsonb_array_elements(v_post) x where (x->>'customer_id')::uuid = j.customer_id)
  ), one as (
    -- Una persona por día: si tiene varios carros listos, va el más urgente.
    select distinct on (r.customer_id) r.* from ready r
    order by r.customer_id, r.bucket, case when r.bucket = 2 then abs(r.days_from_due) else r.days_from_due end, r.cycle_due
  ), picked as (
    select * from one
    order by bucket, case when bucket = 2 then abs(days_from_due) else days_from_due end, cycle_due
    limit greatest(v_remaining - least(v_post_n, v_remaining), 0)
  )
  select coalesce(jsonb_agg(lubricenter_private.crm_item_json(r.jr)
      order by r.bucket, case when r.bucket = 2 then abs(r.days_from_due) else r.days_from_due end, r.cycle_due), '[]'::jsonb)
  into v_rem from picked r;

  select count(distinct customer_id)::int into v_ready_n from public.crm_vehicle_journeys where status = 'READY';

  return jsonb_build_object(
    'today', v_today, 'cap', v_cap, 'sent_today', v_sent_today, 'remaining', v_remaining,
    'ready_total', v_ready_n + v_post_n,
    'pending', lubricenter_private.crm_pending_json(),
    'queue', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select x from jsonb_array_elements(v_post) x limit v_remaining) a) || v_rem,
    'waiting', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',w.service_record_id,'customer_id',w.customer_id,'customer_name',w.customer_name,'phone',w.customer_phone,
        'wa_phone',w.wa_phone,'vehicle',nullif(btrim(concat_ws(' ',w.make,w.model)),''),'plate',w.plate,
        'sent_count',w.sent_count,'last_sent_at',w.last_sent_at,'eligible_on',w.eligible_on,'status',w.status)
        order by w.last_sent_at desc), '[]'::jsonb)
      from public.crm_vehicle_journeys w where w.awaiting_reply),
    'booked', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',b.service_record_id,'customer_name',b.customer_name,'phone',b.customer_phone,'wa_phone',b.wa_phone,
        'vehicle',nullif(btrim(concat_ws(' ',b.make,b.model)),''),'plate',b.plate,'date',b.last_outcome_on)
        order by b.last_outcome_on), '[]'::jsonb)
      from public.crm_vehicle_journeys b where b.status = 'BOOKED'),
    'fix', (select coalesce(jsonb_agg(jsonb_build_object(
        'customer_id',x.customer_id,'customer_name',x.customer_name,'phone',x.customer_phone,
        'vehicles',x.vehicles,'flagged',x.flagged) order by x.customer_name), '[]'::jsonb)
      from (select f.customer_id, max(f.customer_name) as customer_name, max(f.customer_phone) as customer_phone,
              string_agg(distinct coalesce(nullif(f.plate,''), concat_ws(' ', f.make, f.model)), ', ') as vehicles,
              bool_or(f.wa_phone is not null) as flagged
            from public.crm_vehicle_journeys f
            where f.status = 'NO_PHONE' and f.days_from_due between -30 and 730
            group by f.customer_id) x)
  );
end $$;
revoke all on function public.crm_board() from public, anon;
grant execute on function public.crm_board() to authenticated;

-- 6. Abrir WhatsApp (valida antes) y confirmar ------------------------------------------
create or replace function public.crm_open_send(p_type text, p_id uuid, p_kind text, p_message text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  j record; f record; a record; v_id uuid; v_customer uuid; v_vehicle uuid;
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_max int := case when p_type = 'POST_SERVICE' then 4000 else 1800 end;
begin
  perform public.require_auth();
  if p_type not in ('REMINDER', 'POST_SERVICE') then raise exception 'Tipo de mensaje no válido'; end if;
  if length(btrim(coalesce(p_message, ''))) < 20 or length(p_message) > v_max then
    raise exception 'El mensaje debe tener entre 20 y % caracteres', v_max;
  end if;

  if p_type = 'REMINDER' then
    select customer_id into v_customer from public.maintenance_reminders_current where service_record_id = p_id;
    if not found then raise exception 'Este carro ya tiene un cambio de aceite más reciente. No hace falta escribirle.'; end if;
  else
    select customer_id into v_customer from public.customer_followups where id = p_id;
    if not found then raise exception 'Este postservicio ya no existe. Actualiza la lista.'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_customer::text, 0));

  -- ¿Ya está abierto? Si es tuyo o de hace más de 30 min, se reutiliza.
  select * into a from public.crm_send_attempts
   where coalesce(service_record_id, followup_id) = p_id and resolved_at is null for update;
  if found then
    if a.opened_by is distinct from auth.uid() and a.opened_at > now() - interval '30 minutes' then
      raise exception 'Alguien más abrió WhatsApp para este cliente hace % min. Espera a que confirme si lo envió.',
        greatest(1, extract(epoch from now() - a.opened_at)::int / 60);
    end if;
    update public.crm_send_attempts set message = btrim(p_message), opened_by = auth.uid(), opened_at = now()
     where id = a.id;
    return jsonb_build_object('attempt_id', a.id);
  end if;
  if exists (select 1 from public.crm_send_attempts x where x.customer_id = v_customer and x.resolved_at is null) then
    raise exception 'Ya hay un mensaje abierto para este cliente por otro carro. Confirma ese primero.';
  end if;
  if lubricenter_private.crm_sent_today() >= v_cap then
    raise exception 'Llegaste al máximo de hoy (%). Mañana siguen.', v_cap;
  end if;

  if p_type = 'REMINDER' then
    select * into j from public.crm_vehicle_journeys where service_record_id = p_id;
    if not found then raise exception 'Este carro ya no está en el seguimiento. Actualiza la lista.'; end if;
    if j.status <> 'READY' then
      raise exception 'Ya no hace falta escribirle hoy (%). Pasa al siguiente.', case j.status
        when 'WAITING_REPLY' then 'está esperando respuesta'
        when 'SCHEDULED' then 'le toca el ' || to_char(j.eligible_on, 'DD/MM')
        when 'UPCOMING' then 'todavía no le toca'
        when 'BOOKED' then 'tiene cita'
        when 'NO_PHONE' then 'falta un WhatsApp válido'
        when 'OPTED_OUT' then 'no quiere mensajes'
        when 'CLOSED' then 'su ciclo está cerrado'
        when 'DORMANT' then 'está en la cartera'
        else 'ya recibió los mensajes de este ciclo' end;
    end if;
    if j.next_kind is distinct from p_kind then raise exception 'El paso del seguimiento cambió. Actualiza la lista.'; end if;
    v_vehicle := j.vehicle_id;
    insert into public.crm_send_attempts(target_type, service_record_id, customer_id, vehicle_id, kind, message, opened_by)
    values ('REMINDER', p_id, v_customer, v_vehicle, p_kind, btrim(p_message), auth.uid()) returning id into v_id;
  else
    select fl.*, o.closed_at, o.created_at as order_created into f
    from public.customer_followups fl join public.orders o on o.id = fl.order_id where fl.id = p_id;
    if f.status not in ('PENDING', 'SNOOZED')
       or coalesce(f.closed_at, f.order_created) < now() - make_interval(days => v_valid) then
      raise exception 'Este postservicio ya se envió o venció. Pasa al siguiente.';
    end if;
    insert into public.crm_send_attempts(target_type, followup_id, customer_id, vehicle_id, kind, message, opened_by)
    values ('POST_SERVICE', p_id, v_customer, f.vehicle_id, 'POST_SERVICE', btrim(p_message), auth.uid()) returning id into v_id;
  end if;
  return jsonb_build_object('attempt_id', v_id);
end $$;
revoke all on function public.crm_open_send(text, uuid, text, text) from public, anon;
grant execute on function public.crm_open_send(text, uuid, text, text) to authenticated;

-- Confirma lo que pasó con un intento. Si se envió, se registra aunque el estado haya
-- cambiado entretanto: el mensaje ya llegó al cliente.
create or replace function public.crm_confirm_send(p_attempt_id uuid, p_sent boolean)
returns text language plpgsql security definer set search_path to '' as $$
declare a record;
begin
  perform public.require_auth();
  select * into a from public.crm_send_attempts where id = p_attempt_id for update;
  if not found then raise exception 'No encontré ese mensaje. Actualiza la lista.'; end if;
  if a.resolved_at is not null then
    if a.resolution = 'SENT' and p_sent then return 'SENT'; end if;
    if a.resolution = 'NOT_SENT' and not p_sent then return 'NOT_SENT'; end if;
    raise exception 'Este mensaje ya se marcó como %.', case a.resolution when 'SENT' then 'enviado' else 'no enviado' end;
  end if;
  if p_sent then
    if a.target_type = 'REMINDER' then
      insert into public.crm_maintenance_events
        (service_record_id, vehicle_id, customer_id, event_type, stage, message_text, recorded_by)
      select a.service_record_id, coalesce(a.vehicle_id, s.vehicle_id), a.customer_id, 'SENT',
        lubricenter_private.crm_kind_to_stage(a.kind), a.message, auth.uid()
      from public.service_records s where s.id = a.service_record_id;
    else
      update public.customer_followups
         set status = 'SENT', sent_at = now(), message = a.message, snoozed_until = null, updated_at = now()
       where id = a.followup_id;
    end if;
  end if;
  update public.crm_send_attempts set resolved_at = now(), resolution = case when p_sent then 'SENT' else 'NOT_SENT' end
   where id = a.id;
  return case when p_sent then 'SENT' else 'NOT_SENT' end;
end $$;
revoke all on function public.crm_confirm_send(uuid, boolean) from public, anon;
grant execute on function public.crm_confirm_send(uuid, boolean) to authenticated;

-- 7. Resultados ------------------------------------------------------------------------
create or replace function public.crm_record_outcome(
  p_service_record_id uuid, p_outcome text, p_date date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  j record; v_id uuid; v_on date;
  v_today date := (now() at time zone 'America/Caracas')::date;
begin
  perform public.require_auth();
  if p_outcome not in ('BOOKED','POSTPONED','OTHER_SHOP','DECLINED','SOLD_VEHICLE','WRONG_NUMBER','OPT_OUT','SNOOZE','RETURNED','DISMISSED') then
    raise exception 'Resultado no válido';
  end if;
  if p_outcome = 'DISMISSED' and coalesce(p_notes, '') not in ('NOT_NEEDED', 'TOO_LATE') then
    raise exception 'Indica por qué no se envía';
  end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'La nota es muy larga'; end if;
  select * into j from public.crm_vehicle_journeys where service_record_id = p_service_record_id;
  if not found then raise exception 'Este vehículo ya tiene un cambio de aceite más reciente'; end if;

  -- Cualquier resultado cierra un WhatsApp abierto sin confirmar de este carro.
  update public.crm_send_attempts set resolved_at = now(), resolution = 'NOT_SENT'
   where service_record_id = p_service_record_id and resolved_at is null;

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
    when 'RETURNED' then coalesce(p_date, v_today + 90)
    else null end;
  if p_outcome = 'BOOKED' and (v_on is null or v_on < v_today) then
    raise exception 'Indica el día de la cita (hoy o después)';
  end if;
  if p_outcome in ('POSTPONED', 'RETURNED', 'OTHER_SHOP') and v_on <= v_today then raise exception 'La fecha tiene que ser futura'; end if;

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

-- «No enviar» desde el túnel: recordatorio o postservicio, con su motivo.
create or replace function public.crm_dismiss(p_type text, p_id uuid, p_reason text)
returns text language plpgsql security definer set search_path to '' as $$
declare v_customer uuid; v_phone text;
begin
  perform public.require_auth();
  if p_reason not in ('NOT_NEEDED', 'TOO_LATE', 'ALREADY_DONE', 'NO_WHATSAPP') then raise exception 'Motivo no válido'; end if;
  if p_type = 'REMINDER' then
    perform public.crm_record_outcome(p_id,
      case p_reason when 'ALREADY_DONE' then 'RETURNED' when 'NO_WHATSAPP' then 'WRONG_NUMBER' else 'DISMISSED' end,
      null, case when p_reason in ('NOT_NEEDED', 'TOO_LATE') then p_reason end);
  elsif p_type = 'POST_SERVICE' then
    select f.customer_id, c.phone into v_customer, v_phone
    from public.customer_followups f join public.customers c on c.id = f.customer_id where f.id = p_id;
    if not found then raise exception 'Este postservicio ya no existe'; end if;
    update public.crm_send_attempts set resolved_at = now(), resolution = 'NOT_SENT'
     where followup_id = p_id and resolved_at is null;
    if p_reason = 'NO_WHATSAPP' and lubricenter_private.crm_wa_phone(v_phone) is not null then
      insert into public.crm_customer_flags(customer_id, wrong_phone, wrong_phone_at, recorded_by)
      values (v_customer, lubricenter_private.crm_wa_phone(v_phone), now(), auth.uid())
      on conflict (customer_id) do update set wrong_phone = excluded.wrong_phone, wrong_phone_at = now(), recorded_by = auth.uid();
    end if;
    update public.customer_followups set status = 'EXPIRED', snoozed_until = null, updated_at = now()
     where id = p_id and status in ('PENDING', 'SNOOZED');
  else
    raise exception 'Tipo de mensaje no válido';
  end if;
  return p_reason;
end $$;
revoke all on function public.crm_dismiss(text, uuid, text) from public, anon;
grant execute on function public.crm_dismiss(text, uuid, text) to authenticated;

create or replace function public.crm_save_template(p_kind text, p_body text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if p_kind not in ('PRE','DUE','FINAL','RECOVERY','RECONNECT','AGREED','SECOND') then raise exception 'Plantilla no válida'; end if;
  if length(btrim(coalesce(p_body, ''))) < 20 or length(p_body) > 1500 then
    raise exception 'La plantilla debe tener entre 20 y 1500 caracteres';
  end if;
  if position('{{nombre}}' in p_body) = 0 then raise exception 'La plantilla debe incluir {{nombre}}'; end if;
  insert into public.crm_message_templates(kind, body, updated_at, updated_by)
  values (p_kind, btrim(p_body), now(), auth.uid())
  on conflict (kind) do update set body = excluded.body, updated_at = now(), updated_by = auth.uid();
end $$;
revoke all on function public.crm_save_template(text, text) from public, anon;
grant execute on function public.crm_save_template(text, text) to authenticated;

-- 8. Recuperar: tramos sin los «sin respuesta», que van a su propia celda -----------------
create or replace function public.crm_recovery_summary()
returns jsonb language sql stable security invoker set search_path to '' as $$
  with j as materialized (
    select v.customer_id, v.status, v.sent_count, v.awaiting_reply, v.forecast_confidence,
      case when v.status in ('CLOSED_NO_REPLY', 'DORMANT') then 'POOL'
        else lubricenter_private.crm_recovery_bucket(v.days_from_due) end as bucket
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
    ('D91_180', 'Hace 91–180 días', 4), ('D181_365', 'Hace 181–365 días', 5), ('D365P', 'Hace más de 1 año', 6),
    ('POOL', 'Sin respuesta y cartera', 7))
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
      'no_phone', (select count(*) from j where j.bucket = b.code and j.status = 'NO_PHONE'),
      'dormant', (select count(*) from j where j.bucket = b.code and j.status = 'DORMANT'),
      'second_pending', (select count(*) from j where j.bucket = b.code and j.status = 'CLOSED_NO_REPLY')
    ) order by b.sort), '[]'::jsonb)
  from b
$$;
revoke all on function public.crm_recovery_summary() from public, anon;
grant execute on function public.crm_recovery_summary() to authenticated;

create or replace function public.crm_recovery_list(
  p_bucket text, p_sort text default 'PRIORITY', p_query text default null,
  p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security invoker set search_path to '' as $$
declare v_q text := nullif(btrim(lubricenter_private.crm_fold(p_query)), ''); v jsonb;
begin
  if p_bucket not in ('SOON', 'D0_30', 'D31_90', 'D91_180', 'D181_365', 'D365P', 'POOL') then raise exception 'Tramo no válido'; end if;
  if coalesce(p_sort, 'PRIORITY') not in ('PRIORITY', 'RECENT', 'OLDEST') then raise exception 'Orden no válido'; end if;
  with j as materialized (
    select v.* from public.crm_vehicle_journeys v
    where v.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED', 'NO_PHONE')
      and case when p_bucket = 'POOL' then v.status in ('CLOSED_NO_REPLY', 'DORMANT')
        else v.status not in ('CLOSED_NO_REPLY', 'DORMANT')
          and lubricenter_private.crm_recovery_bucket(v.days_from_due) = p_bucket end
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

-- Túnel por tramo: reserva el cupo de los postservicios pendientes y no repite persona.
create or replace function public.crm_bucket_queue(p_bucket text, p_limit int default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent int := lubricenter_private.crm_sent_today();
  v_post int; v_remaining int; v_ready int; v_queue jsonb;
begin
  perform public.require_auth();
  if p_bucket not in ('SOON', 'D0_30', 'D31_90', 'D91_180', 'D181_365', 'D365P', 'POOL') then raise exception 'Tramo no válido'; end if;
  select count(distinct f.customer_id) into v_post from public.customer_followups_current f
   left join public.crm_contact_permissions cp on cp.customer_id = f.customer_id
   where f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
     and (f.status = 'PENDING' or (f.status = 'SNOOZED' and coalesce(f.snoozed_until, v_today) <= v_today))
     and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid)
     and coalesce(cp.status, '') <> 'OPT_OUT'
     and lubricenter_private.crm_wa_phone(f.customer_phone) is not null;
  v_remaining := greatest(v_cap - v_sent - v_post, 0);
  if p_limit is not null then v_remaining := least(v_remaining, greatest(p_limit, 0)); end if;
  with ready as materialized (
    select j as jr, j.customer_id, j.days_from_due from public.crm_vehicle_journeys j
    where j.status = 'READY'
      and case when p_bucket = 'POOL' then false
        else lubricenter_private.crm_recovery_bucket(j.days_from_due) = p_bucket end
      and not exists (select 1 from public.crm_send_attempts a where a.customer_id = j.customer_id and a.resolved_at is null)
      and not exists (select 1 from public.customer_followups_current f
        where f.customer_id = j.customer_id and f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
          and f.status in ('PENDING','SNOOZED') and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid))
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
    coalesce(jsonb_agg(lubricenter_private.crm_item_json(r.jr) order by r.lifetime_ref desc, r.days_from_due asc), '[]'::jsonb)
  into v_ready, v_queue
  from picked r;
  return jsonb_build_object('bucket', p_bucket, 'cap', v_cap, 'sent_today', v_sent,
    'remaining', greatest(v_cap - v_sent, 0), 'reserved_post_service', v_post,
    'eligible', v_ready, 'queue', v_queue);
end $$;
revoke all on function public.crm_bucket_queue(text, int) from public, anon;
grant execute on function public.crm_bucket_queue(text, int) to authenticated;

create or replace function public.crm_queue_item(p_service_record_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_sent int := lubricenter_private.crm_sent_today(); r public.crm_vehicle_journeys;
begin
  perform public.require_auth();
  if v_sent >= v_cap then raise exception 'Llegaste al máximo de hoy (%). Mañana siguen.', v_cap; end if;
  select * into r from public.crm_vehicle_journeys where service_record_id = p_service_record_id;
  if not found then raise exception 'Este vehículo ya tiene un cambio de aceite más reciente'; end if;
  if r.status <> 'READY' then
    raise exception 'Este cliente no está para escribirle hoy: %.', case r.status
      when 'WAITING_REPLY' then 'está esperando respuesta'
      when 'SCHEDULED' then 'le toca el ' || to_char(r.eligible_on, 'DD/MM')
      when 'UPCOMING' then 'todavía no le toca'
      when 'BOOKED' then 'tiene cita'
      when 'NO_PHONE' then 'falta un WhatsApp válido'
      when 'CLOSED_NO_REPLY' then 'le toca la segunda oportunidad el ' || to_char(r.eligible_on, 'DD/MM')
      when 'DORMANT' then 'está en la cartera para promociones'
      else lower(r.status) end;
  end if;
  return lubricenter_private.crm_item_json(r) || jsonb_build_object('sent_today', v_sent, 'cap', v_cap);
end $$;
revoke all on function public.crm_queue_item(uuid) from public, anon;
grant execute on function public.crm_queue_item(uuid) to authenticated;

create or replace function public.crm_today_count()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent int := lubricenter_private.crm_sent_today(); v_ready int; v_post int; v_booked int; v_recover int; v_pending int;
begin
  perform public.require_auth();
  select count(distinct j.customer_id) filter (where j.status = 'READY'),
         count(*) filter (where j.status = 'BOOKED' and j.last_outcome_on = v_today),
         count(*) filter (where j.days_from_due >= 0
                          and j.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED', 'NO_PHONE', 'CLOSED_NO_REPLY', 'DORMANT'))
    into v_ready, v_booked, v_recover
  from public.crm_vehicle_journeys j;
  select count(*) into v_post from public.customer_followups_current f
   where f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
     and (f.status = 'PENDING' or (f.status = 'SNOOZED' and coalesce(f.snoozed_until, v_today) <= v_today))
     and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid)
     and lubricenter_private.crm_wa_phone(f.customer_phone) is not null;
  select count(*) into v_pending from public.crm_send_attempts a
   where a.resolved_at is null and a.opened_at > now() - interval '7 days';
  return jsonb_build_object('to_send', least(greatest(v_cap - v_sent, 0), v_ready + v_post) + v_pending,
    'sent_today', v_sent, 'cap', v_cap, 'booked_today', v_booked, 'to_recover', v_recover,
    'to_confirm', v_pending);
end $$;
revoke all on function public.crm_today_count() from public, anon;
grant execute on function public.crm_today_count() to authenticated;

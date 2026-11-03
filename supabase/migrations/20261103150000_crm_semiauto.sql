-- CRM semiautomático (3 nov 2026). Aditiva salvo dos CHECK ampliados y dos
-- funciones de mensaje recreadas con el mismo contrato.
-- El sistema decide a quién, cuándo y qué escribir; la persona envía por wa.me
-- y registra el resultado. Nada se envía solo.

-- 1. Ajustes y datos nuevos -------------------------------------------------
insert into public.app_settings(key, value) values
  ('crm_daily_cap', '15'::jsonb),
  ('crm_consent_mode', '"IMPLIED"'::jsonb),
  ('crm_legacy_bulk_date', '"2026-09-10"'::jsonb),
  ('crm_post_service_valid_days', '5'::jsonb)
on conflict (key) do nothing;

alter table public.crm_maintenance_events
  add column if not exists follow_up_on date;

alter table public.crm_maintenance_events
  drop constraint if exists crm_maintenance_events_event_type_check;
alter table public.crm_maintenance_events
  add constraint crm_maintenance_events_event_type_check check (event_type = any (array[
    'SENT','REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','REACTIVATED',
    'POSTPONED','OTHER_SHOP','SOLD_VEHICLE','WRONG_NUMBER']));

alter table public.customer_followups
  drop constraint if exists customer_followups_status_check;
alter table public.customer_followups
  add constraint customer_followups_status_check
  check (status = any (array['PENDING','SENT','SNOOZED','EXPIRED']));

create index if not exists crm_maintenance_events_service_idx
  on public.crm_maintenance_events(service_record_id, recorded_at desc);
create index if not exists crm_maintenance_events_customer_sent_idx
  on public.crm_maintenance_events(customer_id, recorded_at desc) where event_type = 'SENT';

create table if not exists public.crm_message_templates (
  kind text primary key check (kind in ('PRE','DUE','FINAL','RECOVERY','RECONNECT')),
  body text not null check (length(body) between 20 and 1500),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.crm_message_templates enable row level security;
drop policy if exists crm_templates_staff_read on public.crm_message_templates;
create policy crm_templates_staff_read on public.crm_message_templates
  for select to authenticated using ((select lubricenter_private.staff_identity_allowed()));

create table if not exists public.crm_customer_flags (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  wrong_phone text,
  wrong_phone_at timestamptz,
  recorded_by uuid
);
alter table public.crm_customer_flags enable row level security;
drop policy if exists crm_flags_staff_read on public.crm_customer_flags;
create policy crm_flags_staff_read on public.crm_customer_flags
  for select to authenticated using ((select lubricenter_private.staff_identity_allowed()));

insert into public.crm_message_templates(kind, body) values
('PRE', E'¡Hola, {{nombre}}! 👋 Te escribimos de *Lubricenter Cabudare*.\n\nA tu *{{vehiculo}}* ({{placa}}) le toca el próximo cambio de aceite alrededor del *{{fecha}}*. El último lo hicimos el {{ultimo_cambio}}.\n\n¿Quieres que te apartemos un día? Solo dinos cuál te queda bien. 🚗\n\nSi no quieres recibir estos recordatorios, respóndenos NO.'),
('DUE', E'¡Hola, {{nombre}}! 👋 Te escribimos de *Lubricenter Cabudare*.\n\nYa le toca el cambio de aceite a tu *{{vehiculo}}* ({{placa}}). El último lo hicimos el {{ultimo_cambio}}.\n\n¿Cuánto marca hoy el kilometraje? Con eso te decimos si conviene hacerlo ya, y si quieres te apartamos un día.\n\nSi no quieres recibir estos recordatorios, respóndenos NO.'),
('FINAL', E'¡Hola, {{nombre}}! Te escribimos por última vez sobre el cambio de aceite de tu *{{vehiculo}}* ({{placa}}); no queremos molestarte. 🙂\n\nSi ya lo hiciste, ¡perfecto! Y si te podemos ayudar, aquí estamos.\n\nSi no quieres recibir estos recordatorios, respóndenos NO.'),
('RECOVERY', E'¡Hola, {{nombre}}! 👋 Te escribimos de *Lubricenter Cabudare*.\n\nHace un tiempo que no vemos tu *{{vehiculo}}* ({{placa}}); el último cambio de aceite fue el {{ultimo_cambio}}. ¿Cómo te ha ido con el carro?\n\nSi ya le toca, con gusto te atendemos. ¿Qué día te queda bien?\n\nSi no quieres recibir estos recordatorios, respóndenos NO.'),
('RECONNECT', E'¡Hola, {{nombre}}! 👋 Somos *Lubricenter Cabudare*. Hace más de un año atendimos tu *{{vehiculo}}* ({{placa}}) y queríamos saludarte.\n\n¿Todavía lo tienes? Si quieres retomar el mantenimiento con nosotros, aquí estamos para ayudarte.\n\nSi no quieres recibir estos recordatorios, respóndenos NO.')
on conflict (kind) do nothing;

-- 2. Utilidades --------------------------------------------------------------
create or replace function lubricenter_private.crm_wa_phone(p_phone text)
returns text language sql immutable set search_path to '' as $$
  select case
    when d ~ '^584[0-9]{9}$' then d
    when d ~ '^04[0-9]{9}$' then '58' || substr(d, 2)
    when d ~ '^4[0-9]{9}$' then '58' || d
    else null end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x
$$;

create or replace function lubricenter_private.crm_setting_int(p_key text, p_default int)
returns int language sql stable security definer set search_path to '' as $$
  select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = p_key), p_default)
$$;

create or replace function lubricenter_private.crm_setting_date(p_key text, p_default date)
returns date language sql stable security definer set search_path to '' as $$
  select coalesce((select (s.value #>> '{}')::date from public.app_settings s where s.key = p_key), p_default)
$$;

-- Líneas que nunca se le muestran al cliente en el postservicio.
create or replace function lubricenter_private.crm_line_visible(p_line_role text, p_description text)
returns boolean language sql immutable set search_path to '' as $$
  select coalesce(p_line_role, '') not in ('CASHEA_SURCHARGE', 'PASS_THROUGH')
     and coalesce(p_description, '') !~* 'cashea'
     and coalesce(p_description, '') !~* '^compra para el trabajo'
$$;

create or replace function lubricenter_private.crm_km(p_km int)
returns text language sql immutable set search_path to '' as $$
  select case when p_km is null then null else replace(to_char(p_km, 'FM999,999,999'), ',', '.') end
$$;

create or replace function lubricenter_private.crm_day(p_day date)
returns text language sql immutable set search_path to '' as $$
  select case when p_day is null then null else to_char(p_day, 'DD/MM/YYYY') end
$$;

create or replace function lubricenter_private.crm_kind_to_stage(p_kind text)
returns text language sql immutable set search_path to '' as $$
  select case p_kind when 'PRE' then 'PREVENTIVE' when 'DUE' then 'DUE' when 'FINAL' then 'LATE'
    when 'RECOVERY' then 'RECOVERY' when 'RECONNECT' then 'WINBACK' end
$$;

create or replace function lubricenter_private.crm_render(
  p_kind text, p_name text, p_vehicle text, p_plate text,
  p_last date, p_due date, p_oil text, p_km int)
returns text language plpgsql stable security definer set search_path to '' as $$
declare v text; v_first text;
begin
  select t.body into v from public.crm_message_templates t where t.kind = p_kind;
  if v is null then return null; end if;
  v_first := nullif(regexp_replace(split_part(btrim(coalesce(p_name, '')), ' ', 1), '[^[:alpha:]''-]', '', 'g'), '');
  v_first := coalesce(initcap(lower(v_first)), 'amigo');
  v := replace(v, '{{nombre}}', v_first);
  v := replace(v, '{{vehiculo}}', coalesce(nullif(btrim(p_vehicle), ''), 'vehículo'));
  v := replace(v, '{{placa}}', coalesce(nullif(btrim(upper(p_plate)), ''), ''));
  v := replace(v, '{{ultimo_cambio}}', coalesce(lubricenter_private.crm_day(p_last), 'tu última visita'));
  v := replace(v, '{{fecha}}', coalesce(lubricenter_private.crm_day(p_due), 'estos días'));
  v := replace(v, '{{aceite}}', coalesce(nullif(btrim(p_oil), ''), ''));
  v := replace(v, '{{km}}', coalesce(lubricenter_private.crm_km(p_km), ''));
  v := replace(v, ' ()', '');
  v := regexp_replace(v, '[ ]{2,}', ' ', 'g');
  return btrim(v);
end $$;

-- 3. Recorrido por vehículo (reglas en SQL) ----------------------------------
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
      and e.event_type in ('REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','POSTPONED','SOLD_VEHICLE')
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

-- 4. Postservicio: sin líneas internas y km en formato venezolano -------------
create or replace function public.build_post_service_message(p_order_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order public.orders%rowtype;
  v_oil public.order_items%rowtype;
  v_name text;
  v_vehicle text;
  v_plate text;
  v_main text := '';
  v_extra text := '';
  v_bonus text := '';
  v_notes text := '';
  v_health text := '';
  v_next text := '';
  v_oil_type text := '';
  v_oil_brand_display text := '';
  v_oil_label text;
  v_services text;
  v_products text;
  v_paid_extras text;
  v_oil_product_description text;
  v_included text;
  v_bonus_lines text;
  v_physical_bonuses text;
  v_template text;
  v_message text;
  v_next_km integer;
  v_next_date date;
  nl text := chr(10);
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  select coalesce(nullif(trim(name), ''), 'cliente') into v_name from public.customers where id = v_order.customer_id;
  select nullif(trim(concat_ws(' ', make, model)), ''), plate into v_vehicle, v_plate
  from public.vehicles where id = v_order.vehicle_id;
  if v_vehicle is not null and nullif(trim(coalesce(v_plate, '')), '') is not null then
    v_vehicle := v_vehicle || ' (' || trim(v_plate) || ')';
  elsif v_vehicle is null then
    v_vehicle := nullif(trim(coalesce(v_plate, '')), '');
  end if;

  select * into v_oil from public.order_items
  where order_id = p_order_id and business_area = 'OIL_CHANGE' and item_type = 'SERVICE'
  order by created_at desc limit 1;

  select string_agg('• ' || description, nl order by charged_ves_amount desc, created_at)
  into v_services from (
    select description, charged_ves_amount, created_at from public.order_items
    where order_id = p_order_id and item_type = 'SERVICE'
      and (v_oil.id is null or id <> v_oil.id)
      and lubricenter_private.crm_line_visible(line_role, description)
    order by charged_ves_amount desc, created_at limit 3
  ) s;

  select string_agg('• ' || description || case when quantity <> 1 then ' ×' || trim(to_char(quantity, 'FM999999990.##')) else '' end, nl order by charged_ves_amount desc, created_at)
  into v_products from (
    select description, quantity, charged_ves_amount, created_at from public.order_items
    where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode <> 'BONUS'
      and lubricenter_private.crm_line_visible(line_role, description)
    order by charged_ves_amount desc, created_at limit 3
  ) p;

  if v_oil.id is not null then
    select description into v_oil_product_description from public.order_items
    where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode <> 'BONUS'
      and description ~* '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}'
    order by charged_ves_amount desc, created_at limit 1;
    v_oil_type := case v_oil.oil_base_type
      when 'MINERAL' then 'mineral'
      when 'SEMISYNTHETIC' then 'semisintético'
      when 'SYNTHETIC' then 'full sintético'
      else case
        when concat_ws(' ', v_oil.oil_brand, v_oil_product_description) ~* 'semi[[:space:]-]*s[yi]nt' then 'semisintético'
        when concat_ws(' ', v_oil.oil_brand, v_oil_product_description) ~* 'sint[eé]tico|synthetic' then 'full sintético'
        when concat_ws(' ', v_oil.oil_brand, v_oil_product_description) ~* 'mineral' then 'mineral'
        else '' end end;
    v_oil_brand_display := trim(regexp_replace(regexp_replace(
      coalesce(v_oil.oil_brand, ''),
      '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}', ' ', 'gi'),
      'semi[[:space:]-]*s[yi]nt[eé]tico|full[[:space:]-]*sint[eé]tico|sint[eé]tico|synthetic|mineral|gal[oó]n|granel', ' ', 'gi'));
    v_oil_brand_display := trim(regexp_replace(v_oil_brand_display, '[[:space:]]+', ' ', 'g'));
    v_oil_label := nullif(trim(concat_ws(' · ',
      case when nullif(v_oil_brand_display, '') is not null then '*' || v_oil_brand_display || '*' end,
      case when nullif(trim(coalesce(v_oil.oil_viscosity, '')), '') is not null then '*' || trim(v_oil.oil_viscosity) || '*' end,
      case when nullif(v_oil_type, '') is not null then '*' || v_oil_type || '*' end
    )), '');
    v_main := '🛢️ *Cambio de aceite*' || nl || '• *Aceite:*' ||
      case when v_oil_label is not null then ' ' || v_oil_label else ' registrado' end;
    if nullif(trim(coalesce(v_oil.oil_filter_code, '')), '') is not null then
      v_main := v_main || nl || '• *Filtro de aceite:* ' || trim(v_oil.oil_filter_code);
    end if;
    select string_agg('• ' || description || case when quantity <> 1 then ' ×' || trim(to_char(quantity, 'FM999999990.##')) else '' end, nl order by charged_ves_amount desc, created_at)
    into v_paid_extras from (
      select description, quantity, charged_ves_amount, created_at from public.order_items
      where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode <> 'BONUS'
        and lubricenter_private.crm_line_visible(line_role, description)
        and description !~* '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}'
        and (nullif(trim(coalesce(v_oil.oil_filter_code, '')), '') is null
          or description not ilike '%' || trim(v_oil.oil_filter_code) || '%')
      order by charged_ves_amount desc, created_at limit 3
    ) p;
    v_extra := concat_ws(nl, v_services, v_paid_extras);
  else
    v_main := case when v_services is null and v_products is not null then '🧾 *Productos entregados*'
      else '🛠️ *Trabajos realizados*' end || nl || coalesce(v_services, v_products, '• Atendimos tu vehículo');
    if v_services is not null then v_extra := coalesce(v_products, ''); end if;
  end if;

  select string_agg('• ' || trim(x), nl order by ord) into v_included
  from unnest(coalesce(v_order.crm_additional_services, '{}'::text[])) with ordinality as a(x, ord)
  where nullif(trim(x), '') is not null;
  if v_included is not null then
    v_extra := concat_ws(nl, nullif(v_extra, ''), v_included);
  end if;
  if nullif(v_extra, '') is not null then v_extra := '🔧 *También hicimos*' || nl || v_extra; end if;

  select string_agg('• ' || trim(x), nl order by ord) into v_bonus_lines
  from unnest(coalesce(v_order.crm_bonuses, '{}'::text[])) with ordinality as a(x, ord)
  where nullif(trim(x), '') is not null;
  select string_agg('• ' || regexp_replace(description, '^🎁 Cortesía · ', ''), nl order by created_at)
  into v_physical_bonuses from public.order_items
  where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode = 'BONUS';
  v_bonus_lines := concat_ws(nl, v_bonus_lines, v_physical_bonuses);
  if nullif(v_bonus_lines, '') is not null then v_bonus := '🎁 *De cortesía*' || nl || v_bonus_lines; end if;

  if nullif(trim(coalesce(v_order.crm_observations, '')), '') is not null then
    v_notes := '📌 *Para tener en cuenta:* ' || trim(v_order.crm_observations);
  end if;
  if v_order.health_status in ('YELLOW', 'RED') then
    v_health := case when v_order.health_status = 'RED' then '⚠️ *Requiere atención:* ' else '⚠️ *Recomendación:* ' end ||
      coalesce(nullif(trim(coalesce(v_order.health_notes, '')), ''), 'Hay una observación pendiente para tu vehículo.');
  end if;

  if v_oil.id is not null then
    v_next_km := v_oil.next_service_odometer;
    v_next_date := v_oil.next_service_date;
  else
    select next_service_odometer, next_service_date into v_next_km, v_next_date
    from public.order_items where order_id = p_order_id and item_type = 'SERVICE'
      and (next_service_odometer is not null or next_service_date is not null)
    order by created_at desc limit 1;
  end if;
  if v_next_km is not null or v_next_date is not null then
    v_next := '📅 *Próxima revisión:* ' ||
      concat_ws(' o ',
        case when v_next_km is not null then 'los ' || lubricenter_private.crm_km(v_next_km) || ' km' end,
        case when v_next_date is not null then 'el ' || to_char(v_next_date, 'DD/MM/YYYY') end
      ) || '.';
  end if;

  select value #>> '{}' into v_template from public.app_settings where key = 'crm_post_service_template';
  if nullif(v_template, '') is null then
    v_template := 'Hola *{{nombre}}* 👋' || nl || nl ||
      'Gracias por confiar en *Lubricenter*. Te compartimos un resumen de tu visita:' || nl || nl ||
      '{{vehiculo_bloque}}' || nl || nl || '{{resumen_bloque}}' || nl || nl || '{{adicionales_bloque}}' || nl || nl ||
      '{{bonificaciones_bloque}}' || nl || nl || '{{observaciones_bloque}}' || nl || nl ||
      '{{estado_bloque}}' || nl || nl || '{{proximo_servicio_bloque}}' || nl || nl ||
      '💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.' || nl || nl || '*Lubricenter*';
  end if;

  v_message := replace(v_template, '{{nombre}}', coalesce(v_name, 'cliente'));
  v_message := replace(v_message, '{{orden}}', coalesce(v_order.order_number, ''));
  v_message := replace(v_message, '{{vehiculo}}', coalesce(v_vehicle, ''));
  v_message := replace(v_message, '{{placa}}', coalesce(v_plate, ''));
  v_message := replace(v_message, '{{vehiculo_bloque}}', case when v_vehicle is not null then '🚘 *Vehículo:* ' || v_vehicle else '' end);
  v_message := replace(v_message, '{{resumen_bloque}}', v_main);
  v_message := replace(v_message, '{{adicionales_bloque}}', coalesce(v_extra, ''));
  v_message := replace(v_message, '{{bonificaciones_bloque}}', coalesce(v_bonus, ''));
  v_message := replace(v_message, '{{observaciones_bloque}}', coalesce(v_notes, ''));
  v_message := replace(v_message, '{{estado_bloque}}', coalesce(v_health, ''));
  v_message := replace(v_message, '{{proximo_servicio_bloque}}', coalesce(v_next, ''));
  v_message := replace(v_message, '{{servicios_bloque}}', coalesce(v_services, ''));
  v_message := replace(v_message, '{{productos_bloque}}', coalesce(v_products, ''));
  v_message := replace(v_message, '{{cambio_aceite_bloque}}', case when v_oil.id is not null then v_main else '' end);
  v_message := replace(v_message, '{{servicios_adicionales_bloque}}', coalesce(v_extra, ''));
  v_message := replace(v_message, '{{servicios_lista}}', coalesce(v_services, ''));
  v_message := replace(v_message, '{{productos_lista}}', coalesce(v_products, ''));
  v_message := replace(v_message, '{{servicios_adicionales_lista}}', coalesce(v_included, ''));
  v_message := replace(v_message, '{{bonificaciones_lista}}', coalesce(v_bonus_lines, ''));
  v_message := replace(v_message, '{{observaciones}}', coalesce(v_order.crm_observations, ''));
  v_message := replace(v_message, '{{kilometraje}}', coalesce(lubricenter_private.crm_km(v_oil.service_odometer), ''));
  v_message := regexp_replace(v_message, nl || '[[:blank:]]+' || nl, nl || nl, 'g');
  v_message := regexp_replace(v_message, '(' || nl || '){3,}', nl || nl, 'g');
  return trim(v_message);
end;
$function$;

create or replace function public.build_post_service_message_for_vehicle(p_order_id uuid, p_vehicle_id uuid)
 returns text
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
 v_o public.orders%rowtype;v_v public.vehicles%rowtype;
 v_item public.order_items%rowtype;v_name text;v_body text;v_due text;
 v_is_single boolean;
begin
 select * into v_o from public.orders where id=p_order_id;
 if not found then raise exception 'Orden no encontrada'; end if;
 select * into v_v from public.vehicles where id=p_vehicle_id;
 if not found then raise exception 'Vehículo no encontrado'; end if;
 select count(distinct coalesce(oi.service_vehicle_id,v_o.vehicle_id))<=1
 into v_is_single from public.order_items oi
 where oi.order_id=p_order_id and oi.item_type='SERVICE';
 if v_is_single and v_o.vehicle_id=p_vehicle_id and v_o.customer_id=v_v.customer_id then
    return public.build_post_service_message(p_order_id);
 end if;
 select coalesce(nullif(btrim(c.name),''),'cliente') into v_name from public.customers c
 where c.id=coalesce(v_v.customer_id,v_o.customer_id);
 select * into v_item from public.order_items oi
 where oi.order_id=p_order_id and oi.item_type='SERVICE'
  and oi.business_area='OIL_CHANGE'
  and coalesce(oi.service_vehicle_id,v_o.vehicle_id)=p_vehicle_id
 order by oi.created_at desc,oi.id desc limit 1;
 v_body:='Hola *'||coalesce(v_name,'cliente')||'* 👋'||chr(10)||chr(10)
  ||'Gracias por confiar en *Lubricenter*.'||chr(10)
  ||'🚘 *Vehículo:* '||btrim(concat_ws(' ',v_v.make,v_v.model))
  ||coalesce(' · '||nullif(v_v.plate,''),'');
 if v_item.id is not null then
   v_body:=v_body||chr(10)||chr(10)||'🛢️ *Cambio de aceite realizado*'
    ||chr(10)||'• Aceite: '||coalesce(nullif(btrim(concat_ws(' ',v_item.oil_brand,v_item.oil_viscosity)),''),'registrado')
    ||case when v_item.oil_filter_code is not null then chr(10)||'• Filtro: '||v_item.oil_filter_code else '' end
    ||case when v_item.service_odometer is not null then chr(10)||'• Kilometraje: '||lubricenter_private.crm_km(v_item.service_odometer)||' km' else '' end;
   v_due:=concat_ws(' o ',
     case when v_item.next_service_odometer is not null then lubricenter_private.crm_km(v_item.next_service_odometer)||' km' end,
     case when v_item.next_service_date is not null then to_char(v_item.next_service_date,'DD/MM/YYYY') end);
   if v_due<>'' then v_body:=v_body||chr(10)||chr(10)||'📅 *Próximo mantenimiento:* '||v_due; end if;
 else
   v_body:=v_body||chr(10)||chr(10)||'🔧 *Servicio realizado*';
 end if;
 return v_body||chr(10)||chr(10)||'💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.'||chr(10)||'*Lubricenter*';
end $function$;

-- Vencimiento del postservicio (no se manda tarde).
create or replace function lubricenter_private.crm_expire_post_service()
returns int language plpgsql security definer set search_path to '' as $$
declare v_n int;
begin
  update public.customer_followups f set status = 'EXPIRED', updated_at = now()
  from public.orders o
  where o.id = f.order_id and f.status in ('PENDING','SNOOZED')
    and coalesce(o.closed_at, o.created_at) < now()
      - make_interval(days => lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 5. Tablero del día -----------------------------------------------------------
create or replace function public.crm_board()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent_today int;
  v_remaining int;
  v_post jsonb;
  v_rem jsonb;
  v_post_n int;
  v_ready_n int;
begin
  perform public.require_auth();
  select (select count(*) from public.crm_maintenance_events e
           where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = v_today)
       + (select count(*) from public.customer_followups f
           where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = v_today)
  into v_sent_today;
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
    order by coalesce(f.closed_at, f.created_at)
  )
  select count(*)::int,
    coalesce(jsonb_agg(jsonb_build_object(
      'type','POST_SERVICE','id',p.id,'order_id',p.order_id,'order_number',p.order_number,
      'customer_id',p.customer_id,'customer_name',p.customer_name,'phone',p.customer_phone,'wa_phone',p.wa_phone,
      'vehicle',nullif(btrim(concat_ws(' ',p.make,p.model)),''),'plate',p.plate,
      'why','Visita del ' || to_char((coalesce(p.closed_at, now()) at time zone 'America/Caracas'), 'DD/MM') || ' · ' || coalesce(p.order_number,''),
      'kind','POST_SERVICE','step',null,'max_steps',null,
      'warning',case when p.other_make is not null then 'Un trabajo menciona otra marca de carro (' || p.other_make || '). Revisa el texto antes de enviarlo.' end,
      'message',p.message) order by p.closed_at), '[]'::jsonb)
  into v_post_n, v_post from p;

  with j as (
    select j.*, case when j.status = 'READY' then lubricenter_private.crm_render(
        j.next_kind, j.customer_name, nullif(btrim(concat_ws(' ', j.make, j.model)), ''), j.plate,
        (j.performed_at at time zone 'America/Caracas')::date, j.cycle_due,
        nullif(btrim(concat_ws(' ', j.oil_brand, j.oil_viscosity)), ''), j.next_service_odometer) end as message
    from public.crm_vehicle_journeys j
  ), ready as (
    select * from j where j.status = 'READY'
    order by j.bucket, case when j.bucket = 2 then abs(j.days_from_due) else j.days_from_due end, j.cycle_due
  )
  select count(*)::int,
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
      'message',r.message) order by r.bucket, case when r.bucket = 2 then abs(r.days_from_due) else r.days_from_due end, r.cycle_due), '[]'::jsonb)
  into v_ready_n, v_rem
  from (select * from ready limit greatest(v_remaining - least(v_post_n, v_remaining), 0)) r;

  select count(*)::int into v_ready_n from public.crm_vehicle_journeys where status = 'READY';

  return jsonb_build_object(
    'today', v_today,
    'cap', v_cap,
    'sent_today', v_sent_today,
    'remaining', v_remaining,
    'ready_total', v_ready_n + v_post_n,
    'queue', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select x from jsonb_array_elements(v_post) x limit v_remaining) a)
      || v_rem,
    'waiting', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',w.service_record_id,'customer_id',w.customer_id,'customer_name',w.customer_name,'phone',w.customer_phone,
        'wa_phone',w.wa_phone,'vehicle',nullif(btrim(concat_ws(' ',w.make,w.model)),''),'plate',w.plate,
        'sent_count',w.sent_count,'last_sent_at',w.last_sent_at,'eligible_on',w.eligible_on,'status',w.status)
        order by w.last_sent_at desc), '[]'::jsonb)
      from public.crm_vehicle_journeys w
      where w.awaiting_reply and w.status in ('WAITING_REPLY','SCHEDULED','READY')),
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

-- 6. Registrar lo que pasó ------------------------------------------------------
create or replace function public.crm_record_send(p_service_record_id uuid, p_kind text, p_message text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare j record; v_id uuid;
begin
  perform public.require_auth();
  if length(btrim(coalesce(p_message, ''))) < 20 or length(p_message) > 1800 then
    raise exception 'El mensaje debe tener entre 20 y 1800 caracteres';
  end if;
  select customer_id into j from public.maintenance_reminders_current where service_record_id = p_service_record_id;
  if not found then raise exception 'Este vehículo ya tiene un cambio de aceite más reciente'; end if;
  perform pg_advisory_xact_lock(hashtextextended(j.customer_id::text, 0));
  select * into j from public.crm_vehicle_journeys where service_record_id = p_service_record_id;
  if not found then raise exception 'Vehículo no encontrado en el seguimiento'; end if;
  if j.status <> 'READY' then
    raise exception 'Este cliente ya no está para contactar hoy (estado %). Actualiza la lista.', j.status;
  end if;
  if j.next_kind is distinct from p_kind then
    raise exception 'El paso del seguimiento cambió. Actualiza la lista.';
  end if;
  insert into public.crm_maintenance_events
    (service_record_id, vehicle_id, customer_id, event_type, stage, message_text, recorded_by)
  values (p_service_record_id, j.vehicle_id, j.customer_id, 'SENT',
    lubricenter_private.crm_kind_to_stage(p_kind), btrim(p_message), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.crm_record_post_service_sent(p_followup_id uuid, p_message text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if length(btrim(coalesce(p_message, ''))) < 20 or length(p_message) > 4000 then
    raise exception 'El mensaje debe tener entre 20 y 4000 caracteres';
  end if;
  update public.customer_followups
     set status = 'SENT', sent_at = now(), message = btrim(p_message), snoozed_until = null, updated_at = now()
   where id = p_followup_id and status in ('PENDING','SNOOZED');
  if not found then raise exception 'Este mensaje ya fue enviado o venció. Actualiza la lista.'; end if;
end $$;

create or replace function public.crm_skip_post_service(p_followup_id uuid, p_until date)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  update public.customer_followups
     set status = case when p_until is null then 'EXPIRED' else 'SNOOZED' end,
         snoozed_until = p_until, updated_at = now()
   where id = p_followup_id and status in ('PENDING','SNOOZED');
end $$;

create or replace function public.crm_record_outcome(
  p_service_record_id uuid, p_outcome text, p_date date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  j record; v_id uuid; v_on date;
  v_today date := (now() at time zone 'America/Caracas')::date;
begin
  perform public.require_auth();
  if p_outcome not in ('BOOKED','POSTPONED','OTHER_SHOP','DECLINED','SOLD_VEHICLE','WRONG_NUMBER','OPT_OUT','SNOOZE') then
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

-- Deshacer el último registro propio de los últimos 15 minutos.
create or replace function public.crm_undo_last(p_service_record_id uuid)
returns text language plpgsql security definer set search_path to '' as $$
declare v record;
begin
  perform public.require_auth();
  select e.id, e.event_type, e.customer_id into v from public.crm_maintenance_events e
   where e.service_record_id = p_service_record_id
     and e.recorded_at > now() - interval '15 minutes'
     and e.recorded_by is not distinct from auth.uid()
   order by e.recorded_at desc limit 1;
  if not found then raise exception 'No hay nada reciente que deshacer en este vehículo'; end if;
  delete from public.crm_maintenance_events where id = v.id;
  if v.event_type = 'WRONG_NUMBER' then
    delete from public.crm_customer_flags where customer_id = v.customer_id;
  end if;
  return v.event_type;
end $$;

create or replace function public.crm_undo_post_service(p_followup_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  update public.customer_followups set status = 'PENDING', sent_at = null, snoozed_until = null, updated_at = now()
   where id = p_followup_id and status in ('SENT','SNOOZED','EXPIRED')
     and updated_at > now() - interval '15 minutes';
  if not found then raise exception 'Ya no se puede deshacer este mensaje'; end if;
end $$;

create or replace function public.crm_fix_phone(p_customer_id uuid, p_phone text)
returns text language plpgsql security definer set search_path to '' as $$
declare v text := lubricenter_private.crm_wa_phone(p_phone);
begin
  perform public.require_auth();
  if v is null then raise exception 'Escribe un celular venezolano válido, por ejemplo 0414 123 4567'; end if;
  update public.customers set phone = '0' || substr(v, 3), updated_at = now() where id = p_customer_id;
  if not found then raise exception 'Cliente no encontrado'; end if;
  delete from public.crm_customer_flags where customer_id = p_customer_id;
  return '0' || substr(v, 3);
end $$;

create or replace function public.crm_save_template(p_kind text, p_body text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if p_kind not in ('PRE','DUE','FINAL','RECOVERY','RECONNECT') then raise exception 'Plantilla no válida'; end if;
  if length(btrim(coalesce(p_body, ''))) < 20 or length(p_body) > 1500 then
    raise exception 'La plantilla debe tener entre 20 y 1500 caracteres';
  end if;
  if position('{{nombre}}' in p_body) = 0 then raise exception 'La plantilla debe incluir {{nombre}}'; end if;
  insert into public.crm_message_templates(kind, body, updated_at, updated_by)
  values (p_kind, btrim(p_body), now(), auth.uid())
  on conflict (kind) do update set body = excluded.body, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.crm_set_daily_cap(p_cap int)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if p_cap is null or p_cap < 1 or p_cap > 60 then raise exception 'El máximo diario debe estar entre 1 y 60'; end if;
  insert into public.app_settings(key, value) values ('crm_daily_cap', to_jsonb(p_cap))
  on conflict (key) do update set value = excluded.value;
end $$;

-- 7. Resultados -----------------------------------------------------------------
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
    select o.id, o.vehicle_id from public.orders o
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
    'oil_orders_with_vehicle', (select count(*) from oil_orders where vehicle_id is not null),
    'oil_orders_skipped', (select count(*) from oil_orders x where exists (select 1 from public.crm_capture_skips k where k.order_id = x.id))
  ) into v;
  return v;
end $$;


-- 7b. Contador para Inicio --------------------------------------------------------
create or replace function public.crm_today_count()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent int; v_ready int; v_post int; v_booked int;
begin
  perform public.require_auth();
  select (select count(*) from public.crm_maintenance_events e
           where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = v_today)
       + (select count(*) from public.customer_followups f
           where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = v_today)
  into v_sent;
  select count(*) into v_ready from public.crm_vehicle_journeys where status = 'READY';
  select count(*) into v_booked from public.crm_vehicle_journeys where status = 'BOOKED' and last_outcome_on = v_today;
  select count(*) into v_post from public.customer_followups_current f
   where f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
     and (f.status = 'PENDING' or (f.status = 'SNOOZED' and coalesce(f.snoozed_until, v_today) <= v_today))
     and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid)
     and lubricenter_private.crm_wa_phone(f.customer_phone) is not null;
  return jsonb_build_object('to_send', least(greatest(v_cap - v_sent, 0), v_ready + v_post),
    'sent_today', v_sent, 'cap', v_cap, 'booked_today', v_booked);
end $$;

-- 7c. Captura en Venta rápida: placa y teléfono cuando la venta lleva aceite ---------
create table if not exists public.crm_capture_skips (
  order_id uuid primary key references public.orders(id) on delete cascade,
  reason text not null,
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
alter table public.crm_capture_skips enable row level security;
drop policy if exists crm_capture_skips_staff_read on public.crm_capture_skips;
create policy crm_capture_skips_staff_read on public.crm_capture_skips
  for select to authenticated using ((select lubricenter_private.staff_identity_allowed()));

create or replace function lubricenter_private.crm_order_oil_line(p_order_id uuid)
returns text language sql stable security definer set search_path to '' as $$
  select oi.description from public.order_items oi
  where oi.order_id = p_order_id and oi.item_type = 'PRODUCT' and coalesce(oi.pricing_mode, '') <> 'BONUS'
    and (oi.oil_viscosity is not null
      or oi.description ~* '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}'
      or oi.description ~* '(^|[^a-z])aceite([^a-z]|$)')
    and oi.description !~* 'hidr[aá]ulic|transmisi|caja|atf|2t|dos tiempos|motosierra'
  order by oi.charged_ref_amount desc nulls last, oi.created_at limit 1
$$;

create or replace function public.crm_capture_status(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare o record; v_oil text;
begin
  perform public.require_auth();
  select id, status, customer_id, vehicle_id into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  v_oil := lubricenter_private.crm_order_oil_line(p_order_id);
  return jsonb_build_object(
    'has_oil', v_oil is not null,
    'oil', v_oil,
    'has_vehicle', o.vehicle_id is not null,
    'skipped', exists (select 1 from public.crm_capture_skips s where s.order_id = p_order_id),
    'needs', v_oil is not null and o.vehicle_id is null and o.status <> 'CANCELLED'
      and not exists (select 1 from public.crm_capture_skips s where s.order_id = p_order_id));
end $$;

create or replace function public.crm_capture_lookup(p_plate text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_plate text := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g'); r record;
begin
  perform public.require_auth();
  if length(v_plate) < 5 then return null; end if;
  select v.id, v.plate, v.make, v.model, c.name, c.phone into r
  from public.vehicles v left join public.customers c on c.id = v.customer_id
  where regexp_replace(upper(coalesce(v.plate, '')), '[^A-Z0-9]', '', 'g') = v_plate
  order by v.updated_at desc nulls last limit 1;
  if not found then return null; end if;
  return jsonb_build_object('vehicle_id', r.id, 'plate', r.plate, 'make', r.make, 'model', r.model,
    'customer_name', r.name, 'phone', r.phone);
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
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Orden no encontrada'; end if;
  if o.status = 'CANCELLED' then raise exception 'La orden está anulada'; end if;
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

  update public.orders set customer_id = coalesce(customer_id, v_customer), vehicle_id = v_vehicle
   where id = p_order_id;
  delete from public.crm_capture_skips where order_id = p_order_id;

  v_oil := lubricenter_private.crm_order_oil_line(p_order_id);
  if v_oil is not null and not exists (
    select 1 from public.service_records s where s.order_id = p_order_id and s.service_type = 'OIL_CHANGE') then
    v_visc := upper(replace(substring(v_oil from '([0-9]{1,2}[[:space:]]*[Ww][[:space:]]*[-/]?[[:space:]]*[0-9]{2})'), ' ', ''));
    v_at := coalesce(o.business_at, o.closed_at, o.created_at, now());
    insert into public.service_records(order_id, customer_id, vehicle_id, service_type, description,
      oil_brand, oil_viscosity, next_service_date, performed_at, created_by, source_system)
    values (p_order_id, v_customer, v_vehicle, 'OIL_CHANGE', 'Aceite comprado en mostrador (venta rápida)',
      v_oil, v_visc, ((v_at at time zone 'America/Caracas')::date + 90), v_at, auth.uid(), 'quick_sale_capture');
  end if;
  return jsonb_build_object('customer_id', v_customer, 'vehicle_id', v_vehicle);
end $$;

create or replace function public.crm_capture_skip(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if not exists (select 1 from public.orders where id = p_order_id) then raise exception 'Orden no encontrada'; end if;
  insert into public.crm_capture_skips(order_id, reason, recorded_by)
  values (p_order_id, coalesce(nullif(btrim(p_reason), ''), 'El cliente no quiso dar datos'), auth.uid())
  on conflict (order_id) do update set reason = excluded.reason, recorded_by = auth.uid(), recorded_at = now();
end $$;

-- 8. Permisos y tareas ----------------------------------------------------------
revoke all on function public.crm_board() from public, anon;
revoke all on function public.crm_record_send(uuid, text, text) from public, anon;
revoke all on function public.crm_record_post_service_sent(uuid, text) from public, anon;
revoke all on function public.crm_skip_post_service(uuid, date) from public, anon;
revoke all on function public.crm_record_outcome(uuid, text, date, text) from public, anon;
revoke all on function public.crm_undo_last(uuid) from public, anon;
revoke all on function public.crm_undo_post_service(uuid) from public, anon;
revoke all on function public.crm_fix_phone(uuid, text) from public, anon;
revoke all on function public.crm_save_template(text, text) from public, anon;
revoke all on function public.crm_set_daily_cap(int) from public, anon;
revoke all on function public.crm_results(int) from public, anon;
grant execute on function public.crm_board() to authenticated;
grant execute on function public.crm_record_send(uuid, text, text) to authenticated;
grant execute on function public.crm_record_post_service_sent(uuid, text) to authenticated;
grant execute on function public.crm_skip_post_service(uuid, date) to authenticated;
grant execute on function public.crm_record_outcome(uuid, text, date, text) to authenticated;
grant execute on function public.crm_undo_last(uuid) to authenticated;
grant execute on function public.crm_undo_post_service(uuid) to authenticated;
grant execute on function public.crm_fix_phone(uuid, text) to authenticated;
grant execute on function public.crm_save_template(text, text) to authenticated;
grant execute on function public.crm_set_daily_cap(int) to authenticated;
grant execute on function public.crm_results(int) to authenticated;
revoke all on function public.crm_today_count() from public, anon;
revoke all on function public.crm_capture_status(uuid) from public, anon;
revoke all on function public.crm_capture_lookup(text) from public, anon;
revoke all on function public.crm_capture_sale(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.crm_capture_skip(uuid, text) from public, anon;
grant execute on function public.crm_today_count() to authenticated;
grant execute on function public.crm_capture_status(uuid) to authenticated;
grant execute on function public.crm_capture_lookup(text) to authenticated;
grant execute on function public.crm_capture_sale(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.crm_capture_skip(uuid, text) to authenticated;
revoke all on public.crm_capture_skips from anon;
grant select on public.crm_capture_skips to authenticated;
revoke all on public.crm_vehicle_journeys from anon;
grant select on public.crm_vehicle_journeys to authenticated;
revoke all on public.crm_message_templates, public.crm_customer_flags from anon;
grant select on public.crm_message_templates, public.crm_customer_flags to authenticated;

-- Mensajes pendientes recientes con el texto nuevo; los atrasados vencen.
select lubricenter_private.crm_expire_post_service();
update public.customer_followups f
   set message = case when f.followup_type = 'POST_SERVICE_CORRECTION'
        then '📝 *Corrección del historial de mantenimiento*' || chr(10) || chr(10)
             || public.build_post_service_message_for_vehicle(f.order_id, f.vehicle_id)
        when f.vehicle_id is not null then public.build_post_service_message_for_vehicle(f.order_id, f.vehicle_id)
        else public.build_post_service_message(f.order_id) end,
       updated_at = now()
 where f.status in ('PENDING','SNOOZED');

do $$ begin
  if exists (select 1 from cron.job where jobname = 'crm-expire-post-service') then
    perform cron.unschedule('crm-expire-post-service');
  end if;
  perform cron.schedule('crm-expire-post-service', '10 9 * * *', 'select lubricenter_private.crm_expire_post_service()');
end $$;

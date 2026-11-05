-- CRM «Recuperar»: escribirle a un vehículo puntual del tramo con las mismas
-- reglas del túnel, y el conteo de clientes por recuperar para Inicio.

create or replace function public.crm_queue_item(p_service_record_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_sent int; r record;
begin
  perform public.require_auth();
  select (select count(*) from public.crm_maintenance_events e
           where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = v_today)
       + (select count(*) from public.customer_followups f
           where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = v_today)
  into v_sent;
  if v_sent >= v_cap then
    raise exception 'Llegaste al máximo de hoy (%). Mañana siguen.', v_cap;
  end if;
  select * into r from public.crm_vehicle_journeys where service_record_id = p_service_record_id;
  if not found then raise exception 'Este vehículo ya tiene un cambio de aceite más reciente'; end if;
  if r.status <> 'READY' then
    raise exception 'Este cliente no está para escribirle hoy: %.', case r.status
      when 'WAITING_REPLY' then 'está esperando respuesta'
      when 'SCHEDULED' then 'le toca el ' || to_char(r.eligible_on, 'DD/MM')
      when 'UPCOMING' then 'todavía no le toca'
      when 'BOOKED' then 'tiene cita'
      when 'NO_PHONE' then 'falta un WhatsApp válido'
      when 'CLOSED_NO_REPLY' then 'ya recibió todos los mensajes del ciclo'
      else lower(r.status) end;
  end if;
  return jsonb_build_object(
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
      nullif(btrim(concat_ws(' ', r.oil_brand, r.oil_viscosity)), ''), r.next_service_odometer),
    'sent_today', v_sent, 'cap', v_cap);
end $$;
revoke all on function public.crm_queue_item(uuid) from public, anon;
grant execute on function public.crm_queue_item(uuid) to authenticated;

-- Inicio: se agrega «to_recover» (vencidos que se pueden contactar).
create or replace function public.crm_today_count()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_cap int := lubricenter_private.crm_setting_int('crm_daily_cap', 15);
  v_valid int := lubricenter_private.crm_setting_int('crm_post_service_valid_days', 5);
  v_sent int; v_ready int; v_post int; v_booked int; v_recover int;
begin
  perform public.require_auth();
  select (select count(*) from public.crm_maintenance_events e
           where e.event_type = 'SENT' and (e.recorded_at at time zone 'America/Caracas')::date = v_today)
       + (select count(*) from public.customer_followups f
           where f.status = 'SENT' and (f.sent_at at time zone 'America/Caracas')::date = v_today)
  into v_sent;
  select count(*) filter (where j.status = 'READY'),
         count(*) filter (where j.status = 'BOOKED' and j.last_outcome_on = v_today),
         count(*) filter (where j.days_from_due >= 0
                          and j.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED', 'NO_PHONE'))
    into v_ready, v_booked, v_recover
  from public.crm_vehicle_journeys j;
  select count(*) into v_post from public.customer_followups_current f
   where f.followup_type in ('POST_SERVICE','POST_SERVICE_CORRECTION')
     and (f.status = 'PENDING' or (f.status = 'SNOOZED' and coalesce(f.snoozed_until, v_today) <= v_today))
     and coalesce(f.closed_at, f.created_at) >= now() - make_interval(days => v_valid)
     and lubricenter_private.crm_wa_phone(f.customer_phone) is not null;
  return jsonb_build_object('to_send', least(greatest(v_cap - v_sent, 0), v_ready + v_post),
    'sent_today', v_sent, 'cap', v_cap, 'booked_today', v_booked, 'to_recover', v_recover);
end $$;
revoke all on function public.crm_today_count() from public, anon;
grant execute on function public.crm_today_count() to authenticated;

create or replace function lubricenter_private.crm_attribute_oil_campaign_conversion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_status text;
  v_order_customer_id uuid;
  v_order_vehicle_id uuid;
  v_location_code text;
begin
  if new.order_id is null then
    return new;
  end if;

  select o.status, o.customer_id, o.vehicle_id, l.code
    into v_order_status, v_order_customer_id, v_order_vehicle_id, v_location_code
  from public.orders o
  left join public.locations l on l.id = o.location_id
  where o.id = new.order_id;

  if not found
     or v_order_status <> 'CLOSED'
     or v_location_code <> 'CABUDARE' then
    return new;
  end if;

  update public.crm_campaign_contacts cc
  set status = 'CONVERTED',
      visited_at = coalesce(cc.visited_at, new.performed_at),
      converted_at = coalesce(cc.converted_at, new.performed_at),
      converted_order_id = coalesce(cc.converted_order_id, new.order_id),
      outcome_note = coalesce(
        cc.outcome_note,
        'Conversión detectada automáticamente por regreso del vehículo a Lubricenter Cabudare.'
      ),
      updated_at = now()
  from public.crm_campaigns c
  where c.id = cc.campaign_id
    and c.slug = 'aceite-inyectores-oct-2026'
    and cc.sent_at is not null
    and new.performed_at >= cc.sent_at
    and (
      c.ends_on is null
      or new.performed_at < ((c.ends_on + 1)::timestamp at time zone 'America/Caracas')
    )
    and (
      (cc.vehicle_id is not null and cc.vehicle_id = coalesce(new.vehicle_id, v_order_vehicle_id))
      or
      (cc.vehicle_id is null and cc.customer_id = coalesce(new.customer_id, v_order_customer_id))
    )
    and cc.status <> 'CONVERTED';

  return new;
end;
$$;

revoke all on function lubricenter_private.crm_attribute_oil_campaign_conversion() from public, anon, authenticated;

drop trigger if exists crm_campaign_conversion_from_service_record on public.service_records;
create trigger crm_campaign_conversion_from_service_record
after insert on public.service_records
for each row execute function lubricenter_private.crm_attribute_oil_campaign_conversion();

with first_match as (
  select distinct on (cc.id)
    cc.id as contact_id,
    sr.performed_at,
    sr.order_id
  from public.crm_campaign_contacts cc
  join public.crm_campaigns c on c.id = cc.campaign_id
  join public.service_records sr
    on (
      (cc.vehicle_id is not null and sr.vehicle_id = cc.vehicle_id)
      or
      (cc.vehicle_id is null and sr.customer_id is not null and sr.customer_id = cc.customer_id)
    )
  join public.orders o on o.id = sr.order_id and o.status = 'CLOSED'
  join public.locations l on l.id = o.location_id and l.code = 'CABUDARE'
  where c.slug = 'aceite-inyectores-oct-2026'
    and cc.sent_at is not null
    and sr.performed_at >= cc.sent_at
    and (
      c.ends_on is null
      or sr.performed_at < ((c.ends_on + 1)::timestamp at time zone 'America/Caracas')
    )
  order by cc.id, sr.performed_at asc
)
update public.crm_campaign_contacts cc
set status = 'CONVERTED',
    visited_at = coalesce(cc.visited_at, fm.performed_at),
    converted_at = coalesce(cc.converted_at, fm.performed_at),
    converted_order_id = coalesce(cc.converted_order_id, fm.order_id),
    outcome_note = coalesce(
      cc.outcome_note,
      'Conversión detectada automáticamente por regreso del vehículo a Lubricenter Cabudare.'
    ),
    updated_at = now()
from first_match fm
where cc.id = fm.contact_id
  and cc.status <> 'CONVERTED';

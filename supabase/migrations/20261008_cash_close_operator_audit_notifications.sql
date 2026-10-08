-- Cash close corrections with audit + owner alerts.
-- Additive migration: does not modify historic cash movements or closing balances.

create table if not exists public.finance_cash_owner_locations (
  location_id uuid not null references public.locations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (location_id, user_id)
);

-- Preserve Cabudare's existing administrator as its first owner.
insert into public.finance_cash_owner_locations(location_id, user_id)
select l.id, u.id from public.locations l cross join auth.users u
where l.code = 'CABUDARE' and lower(u.email) = 'lubricenterc@gmail.com'
  and u.email_confirmed_at is not null
on conflict do nothing;

create table if not exists public.finance_cash_close_revisions (
  id uuid primary key default gen_random_uuid(),
  cash_closing_id uuid not null references public.cash_closings(id),
  account_id uuid references public.financial_accounts(id),
  actor_id uuid not null references auth.users(id),
  revision_type text not null check (revision_type in ('COUNT_CORRECTION', 'REOPEN_REQUEST')),
  reason text not null check (char_length(trim(reason)) >= 8),
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz not null default now()
);
create index if not exists finance_cash_close_revisions_lookup
  on public.finance_cash_close_revisions(cash_closing_id, created_at desc);

create table if not exists public.finance_cash_close_alerts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  cash_closing_id uuid not null references public.cash_closings(id),
  recipient_id uuid not null references auth.users(id),
  actor_id uuid references auth.users(id),
  revision_id uuid references public.finance_cash_close_revisions(id),
  event_type text not null,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists finance_cash_close_alerts_inbox
  on public.finance_cash_close_alerts(recipient_id, read_at, created_at desc);

alter table public.finance_cash_owner_locations enable row level security;
alter table public.finance_cash_close_revisions enable row level security;
alter table public.finance_cash_close_alerts enable row level security;
-- Alert inbox is recipient-scoped; records are inserted only by server-side RPC/trigger.
revoke all on public.finance_cash_owner_locations from anon, authenticated;
revoke all on public.finance_cash_close_revisions from anon, authenticated;
revoke all on public.finance_cash_close_alerts from anon, authenticated;
grant select on public.finance_cash_close_alerts to authenticated;
grant update (read_at) on public.finance_cash_close_alerts to authenticated;
create policy finance_cash_alert_read_own on public.finance_cash_close_alerts
 for select to authenticated using (recipient_id = (select auth.uid()));
create policy finance_cash_alert_ack_own on public.finance_cash_close_alerts
 for update to authenticated using (recipient_id = (select auth.uid()))
 with check (recipient_id = (select auth.uid()));

-- Internal sender: writes one durable in-app notification per owner.
create or replace function lubricenter_private.finance_cash_notify_owners(
 p_location_id uuid, p_closing_id uuid, p_event text, p_message text,
 p_revision_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $fn$
begin
 insert into public.finance_cash_close_alerts
  (location_id,cash_closing_id,recipient_id,actor_id,revision_id,event_type,message)
 select p_location_id,p_closing_id,o.user_id,auth.uid(),p_revision_id,p_event,p_message
 from public.finance_cash_owner_locations o where o.location_id=p_location_id;
end $fn$;

-- A late cash movement can change a closed day into REVIEW without touching the
-- count itself. Notify the owner even when the change happened outside cash-close.
create or replace function lubricenter_private.finance_cash_status_alert()
 returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
 if new.status = 'REVIEW' and old.status is distinct from 'REVIEW' then
   perform lubricenter_private.finance_cash_notify_owners(
     new.location_id,new.id,'CASH_REVIEW',
     'El cierre del ' || new.business_date::text ||
       ' cambió a revisión: ' || coalesce(new.review_reason,'verificar movimientos'),null);
 end if;
 return new;
end $fn$;
drop trigger if exists finance_cash_status_alert on public.cash_closings;
create trigger finance_cash_status_alert after update of status on public.cash_closings
 for each row execute function lubricenter_private.finance_cash_status_alert();

-- Changes are always backed by an actual counted amount, never by artificial
-- cash movements. This cannot edit a closed reconciliation period.
create or replace function public.finance_cash_correct_closed(
 p_business_date date, p_account_id uuid, p_actual_native numeric,
 p_reason text, p_explanation text default null
) returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
 v_location uuid;
 v_close public.cash_closings;
 v_old public.cash_closing_accounts;
 v_new public.cash_closing_accounts;
 v_totals record;
 v_revision uuid;
 v_period_status text;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 perform pg_advisory_xact_lock(220033);
 if p_business_date is null or p_business_date > timezone('America/Caracas',now())::date
 then raise exception 'Fecha inválida'; end if;
 if p_actual_native is null or p_actual_native < 0 or p_actual_native >= 'Infinity'::numeric
 then raise exception 'Escribe un conteo válido'; end if;
 if length(trim(coalesce(p_reason,''))) < 8 then
   raise exception 'Explica el motivo de la corrección (mínimo 8 caracteres)'; end if;

 -- Existing cash-close API uses the first active location; stay compatible
 -- until account/location ownership is rolled out across all locations.
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into v_close from public.cash_closings
  where business_date=p_business_date and location_id=v_location for update;
 if v_close.id is null or v_close.finance_version is distinct from 22
 then raise exception 'No existe un cierre editable para esta fecha'; end if;
 if v_close.status not in ('CLOSED','REVIEW')
 then raise exception 'El cierre no está presentado; usa el conteo normal'; end if;

 select rp.status into v_period_status
 from public.finance_reconciliation_periods rp
 where rp.location_id=v_location
   and p_business_date between rp.period_start and rp.period_end
   and rp.status in ('CLOSED','CLOSED_WITH_EXCEPTION')
 limit 1;
 if v_period_status is not null then
   raise exception 'La semana ya fue conciliada. Solicita al propietario la reapertura';
 end if;

 select * into v_old from public.cash_closing_accounts
 where cash_closing_id=v_close.id and account_id=p_account_id for update;
 if v_old.account_id is null or v_old.actual_native is null
 then raise exception 'Primero debe existir un conteo físico registrado'; end if;
 select * into v_totals from lubricenter_private.finance_cash_totals(p_business_date)
  where id=p_account_id and activated=true;
 if not found then raise exception 'La caja no está activa'; end if;

 update public.cash_closing_accounts
  set opening_native=v_totals.opening_native,
      system_in_native=v_totals.system_in_native,
      system_out_native=v_totals.system_out_native,
      expected_native=v_totals.expected_native,
      actual_native=p_actual_native,
      difference_native=p_actual_native-v_totals.expected_native,
      explanation=coalesce(nullif(trim(p_explanation),''),v_old.explanation),
      updated_by=auth.uid(), updated_at=now()
 where cash_closing_id=v_close.id and account_id=p_account_id
 returning * into v_new;

 insert into public.finance_cash_close_revisions
  (cash_closing_id,account_id,actor_id,revision_type,reason,before_snapshot,after_snapshot)
 values(v_close.id,p_account_id,auth.uid(),'COUNT_CORRECTION',trim(p_reason),
        to_jsonb(v_old),to_jsonb(v_new)) returning id into v_revision;

 update public.cash_closings
 set status='REVIEW',review_reason='Conteo corregido después del cierre: '||left(trim(p_reason),180),
     updated_at=now()
 where id=v_close.id;

 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('finance.cash_count_corrected','cash_closing',v_close.id,
  jsonb_build_object('revision_id',v_revision,'account_id',p_account_id,
   'old_actual',v_old.actual_native,'new_actual',v_new.actual_native,
   'reason',trim(p_reason)));

 -- First correction CLOSED -> REVIEW already notified via status trigger.
 -- Repeated corrections while REVIEW must also be notified individually.
 if v_close.status = 'REVIEW' then
   perform lubricenter_private.finance_cash_notify_owners(
     v_location,v_close.id,'COUNT_CORRECTION',
     'Se volvió a corregir el cierre del '||p_business_date::text||': '||left(trim(p_reason),120),v_revision);
 end if;
 return v_revision;
end $fn$;
revoke all on function public.finance_cash_correct_closed(date,uuid,numeric,text,text) from public, anon;
grant execute on function public.finance_cash_correct_closed(date,uuid,numeric,text,text) to authenticated;

-- Employees can request reopening a reconciled period, but cannot alter it.
create or replace function public.finance_cash_request_reopen(
 p_business_date date, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $fn$
declare v_location uuid; v_close public.cash_closings; v_revision uuid;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if length(trim(coalesce(p_reason,''))) < 8 then raise exception 'Indica el motivo (mínimo 8 caracteres)'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into v_close from public.cash_closings where location_id=v_location
   and business_date=p_business_date;
 if v_close.id is null or v_close.status not in ('CLOSED','REVIEW') then
   raise exception 'No existe un cierre presentado para solicitar reapertura'; end if;
 insert into public.finance_cash_close_revisions
   (cash_closing_id,account_id,actor_id,revision_type,reason,before_snapshot,after_snapshot)
 values(v_close.id,null,auth.uid(),'REOPEN_REQUEST',trim(p_reason),to_jsonb(v_close),null)
 returning id into v_revision;
 perform lubricenter_private.finance_cash_notify_owners(
   v_location,v_close.id,'REOPEN_REQUEST',
   'Solicitaron reabrir el cierre del '||p_business_date::text||': '||left(trim(p_reason),120),
   v_revision);
 return v_revision;
end $fn$;
revoke all on function public.finance_cash_request_reopen(date,text) from public, anon;
grant execute on function public.finance_cash_request_reopen(date,text) to authenticated;

create or replace function public.finance_cash_revision_history(p_business_date date)
 returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_location uuid; v_close uuid; v_result jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 select id into v_location from public.locations where active order by created_at limit 1;
 select id into v_close from public.cash_closings
 where location_id=v_location and business_date=p_business_date;
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_result
 from (
  select r.id,r.revision_type,r.reason,r.actor_id,r.account_id,r.created_at,
   r.before_snapshot->>'actual_native' as before_actual,
   r.after_snapshot->>'actual_native' as after_actual
  from public.finance_cash_close_revisions r where r.cash_closing_id=v_close
  order by r.created_at desc limit 50
 ) q;
 return v_result;
end $fn$;
revoke all on function public.finance_cash_revision_history(date) from public, anon;
grant execute on function public.finance_cash_revision_history(date) to authenticated;

-- Owner approval of REVIEW/REOPENED returns through the existing close_cash_day
-- workflow. Prevent owners from silently reopening already reconciled weeks.
create or replace function public.reopen_cash_day(p_business_date date,p_reason text)
 returns uuid language plpgsql security definer set search_path = '' as $fn$
declare v_location uuid; v_id uuid;
begin
 perform public.require_auth();
 if not lubricenter_private.is_order_admin() then
   raise exception 'Solo el propietario puede reabrir este cierre'; end if;
 if length(trim(coalesce(p_reason,''))) < 8 then raise exception 'Indica el motivo de reapertura'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 if exists (
  select 1 from public.finance_reconciliation_periods rp
   where rp.location_id=v_location and p_business_date between rp.period_start and rp.period_end
     and rp.status in ('CLOSED','CLOSED_WITH_EXCEPTION')
 ) then raise exception 'La semana está conciliada. Primero debe reabrirse la conciliación semanal'; end if;
 update public.cash_closings
 set status='REOPENED',reopened_by=auth.uid(),reopened_at=now(),
     reopen_reason=trim(p_reason),updated_at=now()
 where business_date=p_business_date and location_id=v_location and status in ('CLOSED','REVIEW')
 returning id into v_id;
 if v_id is null then raise exception 'No hay un cierre presentado para reabrir'; end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('cash_close.reopened','cash_closing',v_id,
  jsonb_build_object('business_date',p_business_date,'reason',trim(p_reason)));
 return v_id;
end $fn$;
revoke all on function public.reopen_cash_day(date,text) from public, anon;
grant execute on function public.reopen_cash_day(date,text) to authenticated;

comment on table public.finance_cash_close_revisions is
 'Append-only log of corrections and requests after the original cash closing.';
comment on table public.finance_cash_close_alerts is
 'Owner inbox: correction/review alerts, separately acknowledged by each recipient.';

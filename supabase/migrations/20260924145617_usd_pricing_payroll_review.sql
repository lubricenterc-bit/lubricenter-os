-- Additive: settled historical payroll and historical prices are not rewritten.
alter table public.order_items add column price_denomination text not null default 'REF'
 check(price_denomination in ('REF','USD'));
alter table public.order_items add column agreed_usd numeric(18,4);

create function lubricenter_private.add_service_priced(
 p_order_id uuid,p_business_area text,p_description text,p_base_ref numeric,p_customer_ref numeric,
 p_worker_share_override_ref numeric default null,p_alexis_bonus_enabled boolean default false,
 p_denomination text default 'REF') returns uuid language plpgsql security definer set search_path='' as $$
declare b numeric; op numeric; factor numeric:=1; item uuid;
begin
 perform public.require_auth();
 perform 1 from public.orders where id=p_order_id for update;
 perform public.assert_order_open(p_order_id);
 if p_denomination not in ('REF','USD') or p_denomination is null then raise exception 'Selecciona REF BCV o USD pactado'; end if;
 if p_base_ref is null or p_customer_ref is null or p_base_ref::text in ('NaN','Infinity','-Infinity') or p_customer_ref::text in ('NaN','Infinity','-Infinity') or p_worker_share_override_ref::text in ('NaN','Infinity','-Infinity') then raise exception 'Monto inválido'; end if;
 select bcv_rate,operative_rate into b,op from public.current_exchange_rates;
 if b is null or op is null or b<=0 or op<=0 then raise exception 'Faltan tasas válidas'; end if;
 if p_denomination='USD' then factor:=op/b; end if;
 item:=public.add_service_item(p_order_id,p_business_area,p_description,p_base_ref*factor,p_customer_ref*factor,p_worker_share_override_ref*factor,p_alexis_bonus_enabled);
 if p_denomination='USD' then
  update public.order_items set price_denomination='USD',agreed_usd=p_customer_ref,
   charged_ves_amount=round(p_customer_ref*op,2),charged_ref_amount=round(p_customer_ref*factor,4)
  where id=item;
 end if;
 return item;
end $$;
create function public.add_service_priced(p_order_id uuid,p_business_area text,p_description text,p_base_ref numeric,p_customer_ref numeric,p_worker_share_override_ref numeric default null,p_alexis_bonus_enabled boolean default false,p_denomination text default 'REF') returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.add_service_priced(p_order_id,p_business_area,p_description,p_base_ref,p_customer_ref,p_worker_share_override_ref,p_alexis_bonus_enabled,p_denomination)
$$;

-- Individual collection shares; UUID provenance remains readable after an order correction.
create table public.payroll_work_items (
 id uuid primary key default gen_random_uuid(), accrual_id uuid not null, payment_id uuid not null,
 employee_id uuid not null references public.employees(id), order_id uuid not null,
 order_number text not null, description text not null, source_type text not null,
 currency text not null check(currency in ('USD','VES')), original_amount numeric(18,2) not null,
 amount numeric(18,2) not null, ref_per_unit numeric(24,12) not null check(ref_per_unit>0),
 decision text not null default 'PAY' check(decision in ('PAY','HOLD','EXCLUDE')),
 reason text, version integer not null default 1, earned_at timestamptz not null,
 payroll_run_id uuid references public.payroll_runs(id) on delete restrict,
 reversal_of uuid references public.payroll_work_items(id), created_at timestamptz not null default now(),
 unique(accrual_id,payment_id,reversal_of), check(amount::text not in ('NaN','Infinity','-Infinity'))
);
create unique index payroll_work_source on public.payroll_work_items(accrual_id,payment_id) where reversal_of is null;
create unique index payroll_work_reversal on public.payroll_work_items(reversal_of) where reversal_of is not null;
create index payroll_work_pending on public.payroll_work_items(employee_id,earned_at) where payroll_run_id is null;
create table public.payroll_work_history (
 id uuid primary key default gen_random_uuid(), work_item_id uuid not null references public.payroll_work_items(id),
 actor_id uuid not null default auth.uid(), occurred_at timestamptz not null default now(),
 reason text not null, before_data jsonb not null, after_data jsonb not null
);
alter table public.payroll_work_items enable row level security;
alter table public.payroll_work_history enable row level security;
create policy owner_read on public.payroll_work_items for select to authenticated using(lubricenter_private.is_order_admin());
create policy owner_read on public.payroll_work_history for select to authenticated using(lubricenter_private.is_order_admin());
grant select on public.payroll_work_items,public.payroll_work_history to authenticated;
alter table public.payroll_runs add column commission_usd numeric(18,2);
alter table public.payroll_runs add column commission_ves numeric(18,2);
alter table public.payroll_runs add column payroll_version integer not null default 1;

create function lubricenter_private.payroll_sync() returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 perform 1 from public.orders o where exists(select 1 from public.payroll_work_items w where w.order_id=o.id) or exists(select 1 from public.order_items i join public.payroll_accruals a on a.source_order_item_id=i.id where i.order_id=o.id and a.payroll_run_id is null) order by o.id for update;
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,original_amount,amount,ref_per_unit,earned_at)
 select a.id,p.id,a.employee_id,o.id,o.order_number,coalesce(a.description,i.description),a.source_type,p.currency,
  round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
  round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
  p.value_ref/p.amount_original,greatest(a.occurred_at,p.paid_at)
 from public.payroll_accruals a join public.order_items i on i.id=a.source_order_item_id
 join public.orders o on o.id=i.order_id join public.payments p on p.order_id=o.id
 where a.payroll_run_id is null and o.status='CLOSED' and o.total_ves>0 and p.amount_original>0 and p.value_ref>0
 on conflict(accrual_id,payment_id) where reversal_of is null do nothing;

 -- Reversals preserve already settled receipts. No legacy REF deduction is created:
 -- new work items deliberately do not mark the original accrual as legacy-settled.
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,original_amount,amount,ref_per_unit,earned_at,reversal_of,reason)
 select w.accrual_id,w.payment_id,w.employee_id,w.order_id,w.order_number,'Reversión · '||w.description,w.source_type,w.currency,
  -w.amount,-w.amount,w.ref_per_unit,now(),w.id,'Orden anulada o cobro/trabajo corregido'
 from public.payroll_work_items w
 where w.payroll_run_id is not null and w.reversal_of is null and w.decision='PAY' and w.amount<>0
 and (not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
  or not exists(select 1 from public.payments p where p.id=w.payment_id)
  or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED'))
 on conflict(reversal_of) where reversal_of is not null do nothing;
 update public.payroll_work_items w set decision='EXCLUDE',reason='Orden anulada o cobro/trabajo corregido',version=version+1
 where payroll_run_id is null and reversal_of is null and decision<>'EXCLUDE'
 and (not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
  or not exists(select 1 from public.payments p where p.id=w.payment_id)
  or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED'));
end $$;

create function lubricenter_private.payroll_review(p_end date) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform lubricenter_private.payroll_sync();
 if p_end is null then raise exception 'Indica la fecha de corte'; end if;
 select coalesce(jsonb_agg(to_jsonb(w) order by w.earned_at,w.id),'[]') into result
 from public.payroll_work_items w where w.payroll_run_id is null and (w.earned_at at time zone 'America/Caracas')::date<=p_end;
 return result;
end $$;
create function public.payroll_review(p_end date) returns jsonb language sql security invoker set search_path='' as $$select lubricenter_private.payroll_review(p_end)$$;

create function lubricenter_private.payroll_review_work(p_id uuid,p_version integer,p_decision text,p_amount numeric,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare w public.payroll_work_items; updated public.payroll_work_items;
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 select * into w from public.payroll_work_items where id=p_id for update;
 if not found then raise exception 'Trabajo no encontrado'; end if;
 if w.payroll_run_id is not null then raise exception 'Este trabajo ya está liquidado; su recibo no se puede reescribir'; end if;
 if w.version<>p_version then raise exception 'El trabajo cambió. Recarga la revisión antes de guardar'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo del cambio (mínimo 5 caracteres)'; end if;
 if p_decision is null or p_decision not in ('PAY','HOLD','EXCLUDE') or p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Decisión o monto inválido'; end if;
 if w.reversal_of is null and p_amount<0 then raise exception 'La comisión no puede ser negativa'; end if;
 if w.reversal_of is null and (not exists(select 1 from public.payroll_accruals where id=w.accrual_id) or not exists(select 1 from public.payments where id=w.payment_id) or not exists(select 1 from public.orders where id=w.order_id and status='CLOSED')) then raise exception 'Este trabajo fue anulado o corregido y no puede pagarse'; end if;
 if w.reversal_of is not null and p_amount<>w.amount then raise exception 'La reversión conserva el monto originalmente liquidado'; end if;
 update public.payroll_work_items set decision=p_decision,amount=round(p_amount,2),reason=trim(p_reason),version=version+1 where id=p_id returning * into updated;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('payroll.work_reviewed','payroll_work_item',p_id,jsonb_build_object('reason',p_reason,'before',to_jsonb(w),'after',to_jsonb(updated),'actor',auth.uid()));
end $$;
create function public.payroll_review_work(p_id uuid,p_version integer,p_decision text,p_amount numeric,p_reason text) returns void language sql security invoker set search_path='' as $$select lubricenter_private.payroll_review_work(p_id,p_version,p_decision,p_amount,p_reason)$$;

create function lubricenter_private.payroll_settle(p_employee_id uuid,p_period_start date,p_period_end date,p_expected jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare run_id uuid; fixed numeric:=0; variable numeric:=0; adjustments numeric:=0; usd numeric:=0; ves numeric:=0; actual jsonb;
begin
 perform lubricenter_private.payroll_sync();
 if p_period_start is null or p_period_end is null or p_period_end<p_period_start or p_period_end-p_period_start<>6 then raise exception 'Selecciona una semana de 7 días'; end if;
 perform 1 from public.employees where id=p_employee_id and active for update;
 if not found then raise exception 'Empleado no disponible'; end if;
 if exists(select 1 from public.payroll_runs where employee_id=p_employee_id and status='SETTLED' and daterange(period_start,period_end,'[]')&&daterange(p_period_start,p_period_end,'[]')) then raise exception 'Este empleado ya tiene una liquidación para ese período'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]') into actual from public.payroll_work_items where employee_id=p_employee_id and payroll_run_id is null and decision in ('PAY','EXCLUDE') and (earned_at at time zone 'America/Caracas')::date<=p_period_end;
 if p_expected->'work' is distinct from actual then raise exception 'Cambió el detalle de trabajos. Revisa el resumen actualizado antes de liquidar'; end if;
 select coalesce(value,0) into fixed from public.compensation_rules where employee_id=p_employee_id and rule_type='FIXED_WEEKLY' and valid_from<=p_period_end and (valid_to is null or valid_to>=p_period_end) order by valid_from desc limit 1;
 fixed:=coalesce(fixed,0);
 if p_expected->'fixed_ref' is distinct from to_jsonb(fixed) then raise exception 'Cambió el sueldo fijo. Recarga y revisa el resumen'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'amount_ref',amount_ref) order by id),'[]') into actual from public.payroll_adjustments where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;
 if p_expected->'adjustments' is distinct from actual then raise exception 'Cambiaron los ajustes. Recarga y revisa el resumen'; end if;
 select coalesce(sum(amount*ref_per_unit),0),coalesce(sum(amount) filter(where currency='USD'),0),coalesce(sum(amount) filter(where currency='VES'),0) into variable,usd,ves from public.payroll_work_items where employee_id=p_employee_id and payroll_run_id is null and decision='PAY' and (earned_at at time zone 'America/Caracas')::date<=p_period_end;
 select coalesce(sum(amount_ref),0) into adjustments from public.payroll_adjustments where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;
 if fixed+variable+adjustments<0 then raise exception 'El saldo a favor del negocio supera esta liquidación; deja los descuentos pendientes y revisa el detalle'; end if;
 insert into public.payroll_runs(employee_id,period_start,period_end,fixed_ref,variable_ref,adjustments_ref,total_ref,commission_usd,commission_ves,payroll_version)
 values(p_employee_id,p_period_start,p_period_end,fixed,variable,adjustments,fixed+variable+adjustments,usd,ves,2) returning id into run_id;
 update public.payroll_work_items set payroll_run_id=run_id where employee_id=p_employee_id and payroll_run_id is null and decision in ('PAY','EXCLUDE') and (earned_at at time zone 'America/Caracas')::date<=p_period_end;
 update public.payroll_adjustments set payroll_run_id=run_id where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('payroll.settled_v2','payroll_run',run_id,jsonb_build_object('actor',auth.uid(),'commission_usd',usd,'commission_ves',ves,'fixed_ref',fixed,'adjustments_ref',adjustments,'work_items',actual));
 return run_id;
end $$;
create function public.payroll_settle(p_employee_id uuid,p_period_start date,p_period_end date,p_expected jsonb) returns uuid language sql security invoker set search_path='' as $$select lubricenter_private.payroll_settle(p_employee_id,p_period_start,p_period_end,p_expected)$$;

-- Old clients must refresh rather than settle all legacy accruals a second time.
create or replace function public.create_weekly_payroll_run(p_employee_id uuid,p_period_start date,p_period_end date)
 returns table(id uuid,total_ref numeric,fixed_ref numeric,variable_ref numeric,adjustments_ref numeric)
 language plpgsql security invoker set search_path='' as $$begin raise exception 'Actualiza la página y revisa los trabajos antes de liquidar la nómina'; end $$;

do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','lubricenter_private') and p.proname in ('add_service_priced','payroll_sync','payroll_review','payroll_review_work','payroll_settle') loop
  execute format('revoke all on function %s from public, anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

alter table public.payments drop constraint payments_method_check;
alter table public.payments add constraint payments_method_check check(method in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE'));
insert into public.financial_accounts(code,name,currency,account_type) values ('ZELLE','Zelle','USD','BANK'),('BINANCE','Binance · USD','USD','CLEARING') on conflict(code) do nothing;
create function public.order_usd_rate(p_order_id uuid) returns numeric language sql stable security invoker set search_path='' as $$
 select coalesce((select sum(charged_ves_amount)/nullif(sum(agreed_usd),0) from public.order_items where order_id=p_order_id having bool_and(price_denomination='USD')),(select operative_rate from public.current_exchange_rates))
$$;
revoke all on function public.order_usd_rate(uuid) from public,anon;
grant execute on function public.order_usd_rate(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.add_payment(p_order_id uuid, p_method text, p_amount_original numeric, p_reference text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bcv numeric; v_op numeric; v_currency text; v_value_ves numeric; v_id uuid;
  v_method text := upper(p_method);
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then raise exception 'Método de pago inválido'; end if;
  if p_amount_original is null or p_amount_original::text in ('NaN','Infinity','-Infinity') or p_amount_original <= 0 then raise exception 'Monto de pago inválido'; end if;
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_op from public.current_exchange_rates;
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  v_currency := case when v_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
  v_value_ves := case when v_currency='USD' then p_amount_original * v_op else p_amount_original end;
  insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference)
  values(p_order_id,v_method,v_currency,p_amount_original,v_bcv,v_op,round(v_value_ves,2),round(v_value_ves/v_bcv,4),nullif(trim(p_reference),''))
  returning id into v_id;
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_payment_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_code text;
begin
  if new.financial_account_id is not null then return new; end if;
  v_code := case new.method
    when 'CASH_VES' then 'CASH_VES'
    when 'CASH_USD' then 'CASH_USD'
    when 'ZELLE' then 'ZELLE'
    when 'BINANCE' then 'BINANCE'
    when 'TRANSFER_BDV' then 'BDV'
    when 'TRANSFER_BNC' then 'BNC'
    when 'MOBILE_PAYMENT' then 'MOBILE'
    else null end;
  if v_code is null then raise exception 'No existe cuenta configurada para el método %',new.method; end if;
  select id into new.financial_account_id from public.financial_accounts where code=v_code and active=true;
  if new.financial_account_id is null then raise exception 'Cuenta financiera % no disponible',v_code; end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.close_order_with_full_payment(p_order_id uuid, p_method text, p_reference text DEFAULT NULL::text)
 RETURNS TABLE(order_number text, total_ves numeric, total_ref numeric, payment_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total_ves numeric;
  v_total_ref numeric;
  v_paid_ves numeric;
  v_remaining numeric;
  v_method text := upper(coalesce(p_method,''));
  v_op numeric;
  v_amount numeric;
  v_payment_id uuid;
  v_closed record;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then raise exception 'Método de pago inválido'; end if;

  select coalesce(sum(oi.charged_ves_amount),0),coalesce(sum(oi.charged_ref_amount),0)
  into v_total_ves,v_total_ref from public.order_items oi where oi.order_id=p_order_id;
  if v_total_ves<=0 then raise exception 'La orden no tiene items'; end if;
  select coalesce(sum(p.value_ves),0) into v_paid_ves from public.payments p where p.order_id=p_order_id;
  v_remaining := greatest(v_total_ves-v_paid_ves,0);
  if v_remaining>1 then
    if v_method in ('CASH_USD','ZELLE','BINANCE') then
      select public.order_usd_rate(p_order_id) into v_op;
      if v_op is null or v_op<=0 then raise exception 'No hay tasa operativa disponible'; end if;
      v_amount := v_remaining/v_op;
    else
      v_amount := v_remaining;
    end if;
    v_payment_id := public.add_payment(p_order_id,v_method,v_amount,p_reference);
  end if;
  select * into v_closed from public.close_order(p_order_id);
  order_number:=v_closed.order_number;
  total_ves:=v_closed.total_ves;
  total_ref:=v_closed.total_ref;
  payment_id:=v_payment_id;
  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.close_order_with_partial_credit(p_order_id uuid, p_method text, p_amount_original numeric, p_reference text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date)
 RETURNS TABLE(order_number text, total_ves numeric, total_ref numeric, payment_id uuid, receivable_id uuid, outstanding_ves numeric, outstanding_ref numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders;
  v_total_ves numeric;
  v_paid_ves numeric;
  v_bcv numeric;
  v_operative numeric;
  v_method text := upper(coalesce(p_method, ''));
  v_new_payment_ves numeric;
  v_payment_id uuid;
  v_credit record;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
    raise exception 'Selecciona una forma de pago válida para el abono';
  end if;
  if p_amount_original is null or p_amount_original <= 0 then
    raise exception 'Indica un abono mayor que cero';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.customer_id is null then
    raise exception 'Crédito LC requiere un cliente asociado a la orden';
  end if;
  if exists(select 1 from public.receivables where order_id = p_order_id) then
    raise exception 'La orden ya tiene una cuenta por cobrar';
  end if;

  select coalesce(sum(charged_ves_amount), 0) into v_total_ves
  from public.order_items where order_id = p_order_id;
  select coalesce(sum(value_ves), 0) into v_paid_ves
  from public.payments where order_id = p_order_id;
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_operative from public.current_exchange_rates;

  if v_total_ves <= 0 then raise exception 'Agrega productos o trabajos antes de cobrar'; end if;
  if v_bcv is null or v_operative is null then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  v_new_payment_ves := case when v_method in ('CASH_USD','ZELLE','BINANCE') then p_amount_original * v_operative else p_amount_original end;
  if v_paid_ves + v_new_payment_ves >= v_total_ves - 1 then
    raise exception 'El abono cubre toda la orden. Usa “Cobro directo” para cerrarla como pagada';
  end if;

  v_payment_id := public.add_payment(p_order_id, v_method, p_amount_original, p_reference);
  select * into v_credit from public.close_order_with_credit(p_order_id, p_due_date);

  return query select
    v_credit.order_number,
    v_credit.total_ves,
    v_credit.total_ref,
    v_payment_id,
    v_credit.receivable_id,
    v_credit.outstanding_ves,
    v_credit.outstanding_ref;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_credit_payment(p_receivable_id uuid, p_method text, p_amount_original numeric, p_reference text DEFAULT NULL::text)
 RETURNS TABLE(payment_id uuid, outstanding_ves numeric, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_receivable public.receivables;
  v_method text := upper(p_method);
  v_currency text;
  v_bcv numeric;
  v_op numeric;
  v_value_ves numeric;
  v_value_ref numeric;
  v_new_outstanding numeric;
  v_payment_id uuid;
  v_new_status text;
begin
  perform public.require_auth();

  select * into v_receivable
  from public.receivables
  where id = p_receivable_id
  for update;

  if not found then
    raise exception 'Cuenta por cobrar no encontrada';
  end if;

  if v_receivable.status <> 'OPEN' then
    raise exception 'La cuenta por cobrar no está abierta';
  end if;

  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
    raise exception 'Método de pago inválido';
  end if;

  if p_amount_original <= 0 then
    raise exception 'Monto de pago inválido';
  end if;

  select bcv_rate, public.order_usd_rate(v_receivable.order_id)
    into v_bcv, v_op
  from public.current_exchange_rates;

  if v_bcv is null or v_op is null then
    raise exception 'Debes registrar tasas antes de cobrar';
  end if;

  v_currency := case when v_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
  v_value_ves := case when v_currency='USD' then p_amount_original * v_op else p_amount_original end;
  v_value_ref := v_value_ves / v_bcv;

  if v_value_ves > v_receivable.outstanding_ves + 1 then
    raise exception 'El abono excede el saldo pendiente en Bs %', round(v_value_ves - v_receivable.outstanding_ves,2);
  end if;

  insert into public.payments(
    order_id, receivable_id, method, currency, amount_original,
    bcv_rate_snapshot, operative_rate_snapshot,
    value_ves, value_ref, reference, paid_at
  )
  values(
    v_receivable.order_id, p_receivable_id, v_method, v_currency, p_amount_original,
    v_bcv, v_op,
    round(v_value_ves,2), round(v_value_ref,4), nullif(trim(p_reference),''), now()
  )
  returning id into v_payment_id;

  v_new_outstanding := greatest(v_receivable.outstanding_ves - v_value_ves, 0);
  v_new_status := case when v_new_outstanding <= 1 then 'PAID' else 'OPEN' end;

  update public.receivables
  set outstanding_ves = case when v_new_status='PAID' then 0 else round(v_new_outstanding,2) end,
      status = v_new_status,
      closed_at = case when v_new_status='PAID' then now() else null end
  where id = p_receivable_id;

  insert into public.integration_events(event_type,aggregate_type,aggregate_id,payload)
  values(
    case when v_new_status='PAID' then 'receivable.paid' else 'receivable.payment_recorded' end,
    'receivable',p_receivable_id,
    jsonb_build_object(
      'order_id',v_receivable.order_id,
      'payment_id',v_payment_id,
      'method',v_method,
      'currency',v_currency,
      'amount_original',p_amount_original,
      'value_ves',v_value_ves,
      'outstanding_ves',greatest(v_new_outstanding,0),
      'status',v_new_status
    )
  );

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values(
    'receivable.payment_recorded','receivable',p_receivable_id,
    jsonb_build_object(
      'payment_id',v_payment_id,
      'method',v_method,
      'amount_original',p_amount_original,
      'value_ves',v_value_ves,
      'new_outstanding_ves',greatest(v_new_outstanding,0),
      'status',v_new_status
    )
  );

  return query
  select v_payment_id,
         case when v_new_status='PAID' then 0::numeric else round(v_new_outstanding,2) end,
         v_new_status;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.add_payroll_adjustment(p_employee_id uuid, p_adjustment_type text, p_amount_ref numeric, p_note text DEFAULT NULL::text, p_occurred_on date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_type text := upper(p_adjustment_type);
begin
  perform lubricenter_private.require_order_admin();
  if length(trim(coalesce(p_note,'')))<5 then raise exception 'Explica el motivo del ajuste'; end if;
  if v_type not in ('SUPPLIES','ADVANCE','DEBT','BONUS','OTHER') then raise exception 'Tipo de ajuste inválido'; end if;
  if p_amount_ref is null or p_amount_ref::text in ('NaN','Infinity','-Infinity') or p_amount_ref=0 then raise exception 'Monto inválido'; end if;
  insert into public.payroll_adjustments(employee_id,adjustment_type,amount_ref,note,occurred_on)
  values(p_employee_id,v_type,p_amount_ref,nullif(trim(p_note),''),p_occurred_on) returning id into v_id;
  return v_id;
end;
$function$
;
create policy payroll_review_audit_visibility on public.audit_events as restrictive for select to authenticated using(event_type not in ('payroll.work_reviewed','payroll.settled_v2') or lubricenter_private.is_order_admin());

create function lubricenter_private.payroll_work_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.payroll_run_id is not null then raise exception 'Una comisión liquidada conserva su historial; registra una reversión'; end if;
 insert into public.payroll_work_history(work_item_id,reason,before_data,after_data)
 values(new.id,case when new.payroll_run_id is not null then 'Incluido en liquidación '||new.payroll_run_id::text else coalesce(new.reason,'Actualización de revisión') end,to_jsonb(old),to_jsonb(new));
 return new;
end $$;
create trigger payroll_work_audit before update on public.payroll_work_items for each row execute function lubricenter_private.payroll_work_audit();
revoke all on function lubricenter_private.payroll_work_audit() from public,anon,authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.correct_closed_order(p_order_id uuid, p_reason text, p_business_at timestamp with time zone, p_items jsonb, p_payments jsonb, p_customer_id uuid, p_vehicle_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.orders; n uuid; i public.order_items; ni public.order_items; p public.payments; np public.payments;
 x jsonb; q numeric; u numeric; ratio numeric; tv numeric; tr numeric; pv numeric; initial_paid numeric;
 cs public.cashea_sales; ns public.cashea_sales; ci public.cashea_installments; ci_id uuid; instmap jsonb:='{}';
 lc public.receivables; new_lc uuid; inst_id uuid; new_sale uuid; part numeric; amount numeric; fin numeric; paidinst numeric;
begin
 perform lubricenter_private.require_order_admin();
 select * into o from public.orders where id=p_order_id for update;
 if not found then raise exception 'Orden no encontrada'; end if;
 if o.status='CANCELLED' then
  select id into n from public.orders where corrects_order_id=p_order_id;
  if n is not null then return n; end if;
 end if;
 if o.status<>'CLOSED' then raise exception 'Solo se corrigen ventas cerradas'; end if;
 if p_business_at is null or p_business_at>now()+interval '5 minutes' then raise exception 'Indica la fecha real de la venta'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'La corrección necesita al menos una línea. Si no hubo venta, usa Anular'; end if;
 if jsonb_typeof(p_payments)<>'array' then raise exception 'Revisa los pagos'; end if;
 if p_vehicle_id is not null and not exists(select 1 from public.vehicles where id=p_vehicle_id and customer_id=p_customer_id) then raise exception 'El vehículo no pertenece al cliente seleccionado'; end if;
 perform 1 from public.cashea_installments where cashea_sale_id in(select id from public.cashea_sales where order_id=p_order_id) order by id for update;
 select * into cs from public.cashea_sales where order_id=p_order_id for update;
 select * into lc from public.receivables where order_id=p_order_id for update;
 perform lubricenter_private.cancel_order(p_order_id,p_reason);
 perform set_config('lubricenter.revision','yes',true);
 insert into public.orders(customer_id,vehicle_id,location_id,is_walk_in,business_at,corrects_order_id,health_status,health_notes,health_reviewed_at,crm_additional_services,crm_bonuses,crm_observations)
 values(p_customer_id,p_vehicle_id,o.location_id,o.is_walk_in,p_business_at,o.id,o.health_status,o.health_notes,o.health_reviewed_at,o.crm_additional_services,o.crm_bonuses,o.crm_observations) returning id into n;
 perform set_config('lubricenter.order_id',n::text,true);
 if (select count(*) from jsonb_array_elements(p_items))<>(select count(distinct value->>'source_id') from jsonb_array_elements(p_items)) then raise exception 'Hay líneas duplicadas en la corrección'; end if;
 for x in select value from jsonb_array_elements(p_items) loop
  select * into i from public.order_items where id=(x->>'source_id')::uuid and order_id=o.id;
  if not found then raise exception 'Una línea no pertenece a la venta original'; end if;
  q:=(x->>'quantity')::numeric; u:=(x->>'unit_ref')::numeric;
  if q is null or q<=0 or u is null or u<0 or q::text in ('NaN','Infinity','-Infinity') or u::text in ('NaN','Infinity','-Infinity') then raise exception 'Cantidad o precio inválido'; end if;
  ni:=i; ni.id:=gen_random_uuid(); ni.order_id:=n; ni.created_at:=now(); ni.quantity:=q; ni.description:=trim(x->>'description');
  if coalesce(ni.description,'')='' then raise exception 'Escribe la descripción de cada línea'; end if;
  if abs(q-i.quantity)>0.000001 or abs(u-i.charged_ref_amount/i.quantity)>0.000001 then
   ni.charged_ref_amount:=round(q*u,4); ni.charged_ves_amount:=round(ni.charged_ref_amount*i.bcv_rate_snapshot,2);
   ni.customer_ref_amount:=ni.charged_ref_amount; ni.base_ref_amount:=ni.charged_ref_amount;
   ni.pricing_mode:=case when i.pricing_mode='MANUAL_NO_STOCK' then i.pricing_mode else 'MANUAL_OVERRIDE' end;
   ni.cash_usd_special_total:=null; ni.cash_price_revealed:=false;
   ratio:=case when i.charged_ref_amount>0 then ni.charged_ref_amount/i.charged_ref_amount else q/i.quantity end;
   ni.worker_share_ref_snapshot:=round(i.worker_share_ref_snapshot*ratio,4); ni.assistant_bonus_ref_snapshot:=round(i.assistant_bonus_ref_snapshot*ratio,4);
  end if;
  if ni.price_denomination='USD' then ni.agreed_usd:=round(ni.charged_ves_amount/ni.operative_rate_snapshot,4); end if;
  insert into public.order_items select ni.*;
 end loop;
 select sum(charged_ves_amount),sum(charged_ref_amount) into tv,tr from public.order_items where order_id=n;
 if tv<=0 then raise exception 'El total debe ser mayor que cero'; end if;
 if cs.id is not null then
  ns:=cs; ns.id:=gen_random_uuid(); ns.order_id:=n; ns.created_at:=now(); ns.created_by:=auth.uid(); ns.receivable_id:=null;
  ns.gross_ref:=tr; ns.gross_ves_snapshot:=tv; ns.initial_ref:=round(tr*cs.initial_percent/100,4); ns.initial_ves_snapshot:=round(ns.initial_ref*cs.bcv_rate_snapshot,2);
  ns.financed_ref:=tr-ns.initial_ref; ns.commission_ref:=round(tr*cs.commission_percent/100,4); ns.commission_ves_snapshot:=round(ns.commission_ref*cs.bcv_rate_snapshot,2);
  ns.status:='ACTIVE'; ns.settled_at:=null; insert into public.cashea_sales select ns.*; new_sale:=ns.id;
  part:=round(ns.financed_ref/3,4);
  for ci in select * from public.cashea_installments where cashea_sale_id=cs.id order by installment_no loop
   amount:=case when ci.installment_no=3 then ns.financed_ref-2*part else part end;
   if amount+0.0001<ci.paid_ref then raise exception 'La cuota % ya recibió REF %. No puedes reducirla por debajo de ese pago',ci.installment_no,ci.paid_ref; end if;
   ci_id:=gen_random_uuid(); instmap:=instmap||jsonb_build_object(ci.id::text,ci_id);
   insert into public.cashea_installments(id,cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot,paid_ref,paid_ves_actual,status,paid_at)
   values(ci_id,new_sale,ci.installment_no,(p_business_at at time zone 'America/Caracas')::date+ci.installment_no*14,amount,round(amount*cs.bcv_rate_snapshot,2),ci.paid_ref,ci.paid_ves_actual,case when amount-ci.paid_ref<=0.05 then 'PAID' when ci.paid_ref>0 then 'PARTIAL' else 'PENDING' end,ci.paid_at);
  end loop;
 end if;
 if (select count(*) from jsonb_array_elements(p_payments))<>(select count(distinct value->>'source_id') from jsonb_array_elements(p_payments)) then raise exception 'Hay pagos duplicados'; end if;
 initial_paid:=0;
 for x in select value from jsonb_array_elements(p_payments) loop
  select * into p from public.payments where id=(x->>'source_id')::uuid and order_id=o.id;
  if not found then raise exception 'Un pago no pertenece a la venta original'; end if;
  select entity_id into inst_id from public.audit_events where event_type='cashea.installment_payment_recorded' and data->>'payment_id'=p.id::text limit 1;
  if inst_id is not null and ((x->>'method') is distinct from p.method or (x->>'amount_original')::numeric<>p.amount_original) then raise exception 'Los pagos de cuotas Cashea se conservan: corrige la inicial, no una cuota ya recibida'; end if;
  np:=p; np.id:=gen_random_uuid(); np.order_id:=n; np.receivable_id:=null; np.created_at:=now(); np.created_by:=auth.uid();
  np.method:=x->>'method'; np.amount_original:=(x->>'amount_original')::numeric; np.reference:=nullif(trim(x->>'reference'),'');
  if np.amount_original is null or np.amount_original<=0 or np.amount_original::text in ('NaN','Infinity','-Infinity') then raise exception 'Monto de pago inválido'; end if;
  if np.method<>p.method or np.amount_original<>p.amount_original then
   np.currency:=case when np.method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
   np.financial_account_id:=null;
   np.value_ves:=case when np.currency='USD' then round(np.amount_original*case when cs.id is not null then p.bcv_rate_snapshot else p.operative_rate_snapshot end,2) else np.amount_original end;
   np.value_ref:=round(np.value_ves/p.bcv_rate_snapshot,4);
  end if;
  if inst_id is null and p.receivable_id is null then np.paid_at:=p_business_at; end if;
  insert into public.payments select np.*;
  if inst_id is not null then
   if instmap->>inst_id::text is null then raise exception 'No se encontró la cuota original del pago'; end if;
   insert into public.audit_events(event_type,entity_type,entity_id,data) values('cashea.installment_payment_recorded','cashea_installment',(instmap->>inst_id::text)::uuid,jsonb_build_object('payment_id',np.id,'copied_from_payment_id',p.id,'value_ref',np.value_ref));
  else initial_paid:=initial_paid+np.value_ves; end if;
 end loop;
 if exists(select 1 from public.payments pay join public.audit_events a on a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=pay.id::text where pay.order_id=o.id and not exists(select 1 from jsonb_array_elements(p_payments) element where element.value->>'source_id'=pay.id::text)) then raise exception 'Conserva todos los pagos de cuotas Cashea ya recibidas'; end if;
 select coalesce(sum(value_ves),0) into pv from public.payments where order_id=n;
 if cs.id is null then
  if lc.id is not null then perform public.close_order_with_credit(n,lc.due_date); else perform public.close_order(n); end if;
 else
  if abs(initial_paid-ns.initial_ves_snapshot)>1 then raise exception 'Ajusta los pagos de la inicial a Bs % (inicial original de % por ciento)',ns.initial_ves_snapshot,cs.initial_percent; end if;
  perform public.validate_order_ready_to_close(n);
  update public.orders set status='CLOSED',closed_at=p_business_at,total_ves=tv,total_ref=tr,total_cash_usd_equivalent=(select sum(charged_ves_amount/operative_rate_snapshot) from public.order_items where order_id=n) where id=n;
  for i in select * from public.order_items where order_id=n loop
   if i.business_area in ('WORKSHOP','ELECTROAUTO') and coalesce(i.worker_share_ref_snapshot,0)>0 then insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description) values(i.worker_employee_id,i.id,case when i.business_area='WORKSHOP' then 'WORKSHOP_COMMISSION' else 'ELECTROAUTO_COMMISSION' end,i.worker_share_ref_snapshot,'Corrección · '||i.description); end if;
   if i.business_area='WORKSHOP' and coalesce(i.assistant_bonus_ref_snapshot,0)>0 then insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description) values(i.assistant_bonus_employee_id,i.id,'ASSISTANT_BONUS',i.assistant_bonus_ref_snapshot,'Corrección · '||i.description); end if;
  end loop;
  select coalesce(sum(greatest(amount_ref-paid_ref,0)),0) into fin from public.cashea_installments where cashea_sale_id=new_sale;
  update public.cashea_sales set status=case when fin<=0.05 then 'SETTLED' else 'ACTIVE' end,settled_at=case when fin<=0.05 then now() end where id=new_sale;
 end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('order.corrected','order',o.id,jsonb_build_object('replacement_order_id',n,'reason',p_reason));
 return n;
end $function$
;

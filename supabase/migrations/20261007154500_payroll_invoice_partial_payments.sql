alter table public.payroll_adjustments
  add column if not exists decision text not null default 'PAY',
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.payroll_adjustments'::regclass
      and conname='payroll_adjustments_decision_check'
  ) then
    alter table public.payroll_adjustments
      add constraint payroll_adjustments_decision_check
      check (decision in ('PAY','HOLD','EXCLUDE'));
  end if;
end $$;

create table if not exists public.payroll_payments (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id),
  account_id uuid references public.financial_accounts(id),
  account_movement_id uuid references public.account_movements(id),
  paid_on date not null,
  currency text not null check (currency in ('USD','VES','MANUAL')),
  amount_original numeric(18,2) not null check (amount_original > 0),
  usd_equivalent numeric(18,2) not null check (usd_equivalent > 0),
  bcv_rate numeric(18,6),
  bcv_effective_at timestamptz,
  reference text,
  note text,
  payment_mode text not null default 'ACTUAL' check (payment_mode in ('ACTUAL','HISTORICAL_MANUAL')),
  component text check (component in ('HARD_USD','BCV_VES','MANUAL')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

alter table public.payroll_payments add column if not exists component text;
do $
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.payroll_payments'::regclass
      and conname='payroll_payments_component_check'
  ) then
    alter table public.payroll_payments
      add constraint payroll_payments_component_check
      check (component is null or component in ('HARD_USD','BCV_VES','MANUAL'));
  end if;
end $;
update public.payroll_payments set component='MANUAL'
where payment_mode='HISTORICAL_MANUAL' and component is null;

create index if not exists payroll_payments_run_idx on public.payroll_payments(payroll_run_id,paid_on);
alter table public.payroll_payments enable row level security;
revoke all on public.payroll_payments from anon;
grant select,insert on public.payroll_payments to authenticated;

drop policy if exists payroll_payments_owner_admin_select on public.payroll_payments;
create policy payroll_payments_owner_admin_select
on public.payroll_payments for select to authenticated
using ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists payroll_payments_owner_admin_insert on public.payroll_payments;
create policy payroll_payments_owner_admin_insert
on public.payroll_payments for insert to authenticated
with check ((select public.finance_role()) in ('OWNER','ADMIN'));

create or replace function lubricenter_private.payroll_review_adjustment(
  p_id uuid,p_version integer,p_decision text,p_amount_ref numeric,p_note text
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  a public.payroll_adjustments;
  v_decision text := upper(coalesce(p_decision,''));
begin
  perform lubricenter_private.require_order_admin();
  select * into a from public.payroll_adjustments where id=p_id for update;
  if not found then raise exception 'Ajuste no encontrado'; end if;
  if a.payroll_run_id is not null then raise exception 'Este ajuste ya fue liquidado'; end if;
  if a.version<>p_version then raise exception 'El ajuste cambió. Recarga antes de guardar'; end if;
  if v_decision not in ('PAY','HOLD','EXCLUDE') then raise exception 'Decisión inválida'; end if;
  if p_amount_ref is null or p_amount_ref=0 then raise exception 'Monto inválido'; end if;
  if length(trim(coalesce(p_note,'')))<5 then raise exception 'Explica el motivo del ajuste'; end if;

  update public.payroll_adjustments
  set decision=v_decision, amount_ref=p_amount_ref, note=trim(p_note),
      version=version+1, updated_at=now()
  where id=p_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('payroll.adjustment_reviewed','payroll_adjustment',p_id,
    jsonb_build_object(
      'actor',auth.uid(),
      'before',jsonb_build_object('decision',a.decision,'amount_ref',a.amount_ref,'note',a.note,'version',a.version),
      'after',jsonb_build_object('decision',v_decision,'amount_ref',p_amount_ref,'note',trim(p_note),'version',a.version+1)
    ));
  return p_id;
end
$$;

revoke all on function lubricenter_private.payroll_review_adjustment(uuid,integer,text,numeric,text) from public,anon,authenticated;

create or replace function public.payroll_review_adjustment(
  p_id uuid,p_version integer,p_decision text,p_amount_ref numeric,p_note text
) returns uuid
language sql
set search_path=''
as $$select lubricenter_private.payroll_review_adjustment(p_id,p_version,p_decision,p_amount_ref,p_note)$$;
revoke all on function public.payroll_review_adjustment(uuid,integer,text,numeric,text) from public,anon;
grant execute on function public.payroll_review_adjustment(uuid,integer,text,numeric,text) to authenticated;

create or replace function lubricenter_private.payroll_settle(
  p_employee_id uuid,p_period_start date,p_period_end date,p_expected jsonb
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  run_id uuid; fixed numeric:=0; variable numeric:=0; adjustments numeric:=0;
  hard_usd numeric:=0; bcv_usd numeric:=0; actual_work jsonb; actual_adjustments jsonb;
begin
  perform lubricenter_private.payroll_sync();
  if p_period_start is null or p_period_end is null or p_period_end<p_period_start or p_period_end-p_period_start<>6 then
    raise exception 'Selecciona una semana de 7 días';
  end if;
  if p_period_end>timezone('America/Caracas',now())::date then
    raise exception 'No puedes liquidar una semana que todavía no ha terminado';
  end if;
  perform 1 from public.employees where id=p_employee_id and active for update;
  if not found then raise exception 'Empleado no disponible'; end if;
  if exists(
    select 1 from public.payroll_runs
    where employee_id=p_employee_id and status='SETTLED'
      and daterange(period_start,period_end,'[]')&&daterange(p_period_start,p_period_end,'[]')
  ) then raise exception 'Este empleado ya tiene una liquidación para ese período'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]')
  into actual_work
  from public.payroll_work_items
  where employee_id=p_employee_id and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and (earned_at at time zone 'America/Caracas')::date between p_period_start and p_period_end;
  if p_expected->'work' is distinct from actual_work then
    raise exception 'Cambió el detalle de trabajos. Revisa el resumen actualizado antes de liquidar';
  end if;

  select coalesce(value,0) into fixed
  from public.compensation_rules
  where employee_id=p_employee_id and rule_type='FIXED_WEEKLY'
    and valid_from<=p_period_end and (valid_to is null or valid_to>=p_period_end)
  order by valid_from desc limit 1;
  fixed:=coalesce(fixed,0);
  if p_expected->'fixed_ref' is distinct from to_jsonb(fixed) then
    raise exception 'Cambió el sueldo fijo. Recarga y revisa el resumen';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('id',id,'version',version,'decision',decision,'amount_ref',amount_ref)
    order by id
  ),'[]')
  into actual_adjustments
  from public.payroll_adjustments
  where employee_id=p_employee_id and payroll_run_id is null
    and decision in ('PAY','EXCLUDE') and occurred_on<=p_period_end;
  if p_expected->'adjustments' is distinct from actual_adjustments then
    raise exception 'Cambiaron los ajustes. Recarga y revisa el resumen';
  end if;

  select coalesce(sum(obligation_usd),0),
         coalesce(sum(obligation_usd) filter(where payout_mode='HARD_USD'),0),
         coalesce(sum(obligation_usd) filter(where payout_mode='BCV_VES'),0)
  into variable,hard_usd,bcv_usd
  from public.payroll_work_items
  where employee_id=p_employee_id and payroll_run_id is null
    and decision='PAY'
    and (earned_at at time zone 'America/Caracas')::date between p_period_start and p_period_end;

  select coalesce(sum(amount_ref),0) into adjustments
  from public.payroll_adjustments
  where employee_id=p_employee_id and payroll_run_id is null
    and decision='PAY' and occurred_on<=p_period_end;

  if fixed+variable+adjustments<0 then
    raise exception 'El saldo a favor del negocio supera esta liquidación; prorroga parte de los descuentos y revisa el detalle';
  end if;

  insert into public.payroll_runs(
    employee_id,period_start,period_end,fixed_ref,variable_ref,adjustments_ref,total_ref,
    commission_usd,commission_ves,commission_hard_usd,commission_bcv_usd,payroll_version
  ) values(
    p_employee_id,p_period_start,p_period_end,fixed,variable,adjustments,fixed+variable+adjustments,
    hard_usd,null,hard_usd,bcv_usd,3
  ) returning id into run_id;

  update public.payroll_work_items
  set payroll_run_id=run_id
  where employee_id=p_employee_id and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and (earned_at at time zone 'America/Caracas')::date between p_period_start and p_period_end;

  update public.payroll_adjustments
  set payroll_run_id=run_id, updated_at=now()
  where employee_id=p_employee_id and payroll_run_id is null
    and decision in ('PAY','EXCLUDE') and occurred_on<=p_period_end;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('payroll.settled_v4','payroll_run',run_id,
    jsonb_build_object(
      'actor',auth.uid(),'commission_hard_usd',hard_usd,'commission_bcv_usd',bcv_usd,
      'fixed_ref',fixed,'adjustments_ref',adjustments,'work_items',actual_work,'adjustments',actual_adjustments
    ));
  return run_id;
end
$$;

create or replace function lubricenter_private.payroll_record_payment(
  p_run_id uuid,p_account_id uuid,p_paid_on date,p_amount_original numeric,
  p_reference text default null,p_note text default null
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  r public.payroll_runs; a public.financial_accounts; v_bcv public.exchange_rates; v_op public.exchange_rates;
  v_usd numeric(18,2); v_total_paid numeric(18,2); v_outstanding numeric(18,2); v_value_ves numeric(18,2);
  v_hard_due numeric(18,2); v_bcv_due numeric(18,2); v_hard_paid numeric(18,2); v_bcv_paid numeric(18,2);
  v_component text; v_component_outstanding numeric(18,2);
  v_movement uuid; v_id uuid; v_name text;
begin
  perform lubricenter_private.require_order_admin();
  perform pg_advisory_xact_lock(220034);
  if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then
    raise exception 'Selecciona una fecha de pago válida';
  end if;
  if p_amount_original is null or p_amount_original<=0 then raise exception 'Monto inválido'; end if;

  select * into r from public.payroll_runs where id=p_run_id and status='SETTLED' for update;
  if not found then raise exception 'Liquidación no disponible'; end if;

  select * into a from public.financial_accounts
  where id=p_account_id and active and currency in ('USD','VES') and account_type in ('BANK','CASH','CLEARING')
  for update;
  if not found then raise exception 'Selecciona una cuenta activa USD o Bs'; end if;
  if a.account_type='BANK' and length(regexp_replace(coalesce(p_reference,''),'\D','','g'))<4 then
    raise exception 'Indica al menos los últimos 4 dígitos de la referencia bancaria';
  end if;

  select
    coalesce(sum(usd_equivalent),0),
    coalesce(sum(usd_equivalent) filter(where component='HARD_USD'),0),
    coalesce(sum(usd_equivalent) filter(where component='BCV_VES'),0)
  into v_total_paid,v_hard_paid,v_bcv_paid
  from public.payroll_payments
  where payroll_run_id=p_run_id;

  v_outstanding:=round(r.total_ref-v_total_paid,2);
  if v_outstanding<=0 then raise exception 'Esta liquidación ya está pagada'; end if;

  v_hard_due:=round(least(coalesce(r.commission_hard_usd,0),r.total_ref),2);
  v_bcv_due:=round(r.total_ref-v_hard_due,2);

  if a.currency='VES' then
    v_component:='BCV_VES';
    v_component_outstanding:=round(v_bcv_due-v_bcv_paid,2);
    if v_component_outstanding<=0 then
      raise exception 'La parte pagadera en Bs ya está saldada. Queda únicamente USD real';
    end if;
    select * into v_bcv from public.exchange_rates
    where rate_type='BCV' and effective_at<((p_paid_on+1)::timestamp at time zone 'America/Caracas')
    order by effective_at desc limit 1;
    if not found or v_bcv.value<=0 then raise exception 'No hay tasa BCV para esa fecha'; end if;
    v_usd:=round(p_amount_original/v_bcv.value,2);
    v_value_ves:=round(p_amount_original,2);
  else
    if round(v_hard_due-v_hard_paid,2)>0 then
      v_component:='HARD_USD';
      v_component_outstanding:=round(v_hard_due-v_hard_paid,2);
    else
      v_component:='BCV_VES';
      v_component_outstanding:=round(v_bcv_due-v_bcv_paid,2);
    end if;
    v_usd:=round(p_amount_original,2);
    select * into v_op from public.exchange_rates
    where rate_type='OPERATIVE' and effective_at<((p_paid_on+1)::timestamp at time zone 'America/Caracas')
    order by effective_at desc limit 1;
    if not found or v_op.value<=0 then raise exception 'No hay tasa operativa para esa fecha'; end if;
    v_value_ves:=round(p_amount_original*v_op.value,2);
  end if;

  if v_usd>v_component_outstanding+0.01 then
    if v_component='HARD_USD' then
      raise exception 'USD real pendiente: $%. Registra primero ese monto; luego puedes hacer otro pago para la parte BCV',v_component_outstanding;
    end if;
    raise exception 'El pago supera la parte BCV pendiente de $%',v_component_outstanding;
  end if;

  select name into v_name from public.employees where id=r.employee_id;

  insert into public.account_movements(
    account_id,direction,movement_type,currency,amount_original,value_ves,category,payee,note,reference,occurred_at,finance_nature
  ) values(
    a.id,'OUT','EXPENSE',a.currency,round(p_amount_original,2),v_value_ves,'Nómina',v_name,
    coalesce(nullif(trim(p_note),''),'Pago nómina '||r.period_start||' al '||r.period_end),
    nullif(trim(p_reference),''),(p_paid_on::timestamp+time '12:00') at time zone 'America/Caracas','PAYROLL'
  ) returning id into v_movement;

  insert into public.payroll_payments(
    payroll_run_id,account_id,account_movement_id,paid_on,currency,amount_original,usd_equivalent,
    bcv_rate,bcv_effective_at,reference,note,payment_mode,component
  ) values(
    r.id,a.id,v_movement,p_paid_on,a.currency,round(p_amount_original,2),v_usd,
    case when a.currency='VES' then v_bcv.value end,
    case when a.currency='VES' then v_bcv.effective_at end,
    nullif(trim(p_reference),''),nullif(trim(p_note),''),'ACTUAL',v_component
  ) returning id into v_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('payroll.payment_recorded','payroll_payment',v_id,
    jsonb_build_object(
      'run_id',r.id,'movement_id',v_movement,'paid_on',p_paid_on,'currency',a.currency,
      'component',v_component,'amount_original',round(p_amount_original,2),
      'usd_equivalent',v_usd,'account_id',a.id,'actor',auth.uid()
    ));
  return v_id;
end
$$;

revoke all on function lubricenter_private.payroll_record_payment(uuid,uuid,date,numeric,text,text) from public,anon,authenticated;

create or replace function public.payroll_record_payment(
  p_run_id uuid,p_account_id uuid,p_paid_on date,p_amount_original numeric,
  p_reference text default null,p_note text default null
) returns uuid
language sql
set search_path=''
as $$select lubricenter_private.payroll_record_payment(p_run_id,p_account_id,p_paid_on,p_amount_original,p_reference,p_note)$$;
revoke all on function public.payroll_record_payment(uuid,uuid,date,numeric,text,text) from public,anon;
grant execute on function public.payroll_record_payment(uuid,uuid,date,numeric,text,text) to authenticated;

create or replace function lubricenter_private.payroll_mark_historical_paid(
  p_run_id uuid,p_paid_on date,p_note text
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  r public.payroll_runs; v_paid numeric(18,2); v_outstanding numeric(18,2); v_id uuid;
begin
  perform lubricenter_private.require_order_admin();
  if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then raise exception 'Fecha inválida'; end if;
  if length(trim(coalesce(p_note,'')))<8 then raise exception 'Explica la regularización histórica'; end if;
  select * into r from public.payroll_runs where id=p_run_id and status='SETTLED' for update;
  if not found then raise exception 'Liquidación no disponible'; end if;
  select coalesce(sum(usd_equivalent),0) into v_paid from public.payroll_payments where payroll_run_id=p_run_id;
  v_outstanding:=round(r.total_ref-v_paid,2);
  if v_outstanding<=0 then raise exception 'Esta liquidación ya está pagada'; end if;

  insert into public.payroll_payments(
    payroll_run_id,paid_on,currency,amount_original,usd_equivalent,note,payment_mode,component
  ) values(r.id,p_paid_on,'MANUAL',v_outstanding,v_outstanding,trim(p_note),'HISTORICAL_MANUAL','MANUAL')
  returning id into v_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('payroll.historical_payment_regularized','payroll_payment',v_id,
    jsonb_build_object('run_id',r.id,'paid_on',p_paid_on,'usd_equivalent',v_outstanding,'note',trim(p_note),'actor',auth.uid()));
  return v_id;
end
$$;

revoke all on function lubricenter_private.payroll_mark_historical_paid(uuid,date,text) from public,anon,authenticated;

create or replace function public.payroll_mark_historical_paid(
  p_run_id uuid,p_paid_on date,p_note text
) returns uuid
language sql
set search_path=''
as $$select lubricenter_private.payroll_mark_historical_paid(p_run_id,p_paid_on,p_note)$$;
revoke all on function public.payroll_mark_historical_paid(uuid,date,text) from public,anon;
grant execute on function public.payroll_mark_historical_paid(uuid,date,text) to authenticated;

create or replace function public.payroll_employee_open_balance(p_employee_id uuid)
returns numeric
language sql
security invoker
set search_path=''
as $$
  select coalesce(sum(greatest(pr.total_ref-coalesce(pp.paid,0),0)),0)
  from public.payroll_runs pr
  left join (
    select payroll_run_id,sum(usd_equivalent) paid
    from public.payroll_payments group by payroll_run_id
  ) pp on pp.payroll_run_id=pr.id
  where pr.employee_id=p_employee_id
    and pr.status='SETTLED'
    and pr.payroll_version>=3
$;
grant execute on function public.payroll_employee_open_balance(uuid) to authenticated;

create or replace function lubricenter_private.payroll_review(p_end date)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  result jsonb;
  p_start date;
begin
  perform lubricenter_private.payroll_sync();
  if p_end is null then raise exception 'Indica el sábado de cierre'; end if;
  if extract(isodow from p_end)<>6 then raise exception 'La fecha de cierre de nómina debe ser sábado'; end if;
  p_start:=p_end-5;
  select coalesce(jsonb_agg(to_jsonb(w) order by w.earned_at,w.id),'[]')
  into result
  from public.payroll_work_items w
  where w.payroll_run_id is null
    and (w.earned_at at time zone 'America/Caracas')::date between p_start and p_end;
  return result;
end
$$;

create or replace function public.payroll_review(p_end date)
returns jsonb
language sql
set search_path=''
as $$select lubricenter_private.payroll_review(p_end)$$;
revoke all on function public.payroll_review(date) from public,anon;
grant execute on function public.payroll_review(date) to authenticated;

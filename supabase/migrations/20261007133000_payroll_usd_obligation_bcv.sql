-- Payroll v3: commissions are obligations denominated in USD.
-- Existing settled payroll runs remain unchanged. Pending work is recalculated additively.

alter table public.payroll_work_items
  add column if not exists obligation_usd numeric(18,2),
  add column if not exists payout_mode text;

alter table public.payroll_work_items
  drop constraint if exists payroll_work_items_payout_mode_check;
alter table public.payroll_work_items
  add constraint payroll_work_items_payout_mode_check
  check (payout_mode is null or payout_mode in ('HARD_USD','BCV_VES'));

alter table public.payroll_runs
  add column if not exists commission_hard_usd numeric(18,2),
  add column if not exists commission_bcv_usd numeric(18,2);

-- Recalculate only work that has not been settled yet.
update public.payroll_work_items w
set obligation_usd = x.obligation_usd,
    payout_mode = x.payout_mode
from (
  select
    w2.id,
    round(
      (
        case
          when i.price_denomination='USD'
            then a.amount_ref * i.bcv_rate_snapshot / nullif(i.operative_rate_snapshot,0)
          else a.amount_ref
        end
      ) * p.value_ves / nullif(o.total_ves,0)
    ,2) as obligation_usd,
    case when p.currency='USD' then 'HARD_USD' else 'BCV_VES' end as payout_mode
  from public.payroll_work_items w2
  join public.payroll_accruals a on a.id=w2.accrual_id
  join public.order_items i on i.id=a.source_order_item_id
  join public.orders o on o.id=w2.order_id
  join public.payments p on p.id=w2.payment_id
  where w2.payroll_run_id is null
    and w2.reversal_of is null
    and o.total_ves>0
    and p.value_ves>0
) x
where w.id=x.id;

update public.payroll_work_items w
set obligation_usd = -abs(coalesce(src.obligation_usd,
  case when src.currency='USD' then src.amount else src.amount*src.ref_per_unit end)),
    payout_mode = coalesce(src.payout_mode,case when src.currency='USD' then 'HARD_USD' else 'BCV_VES' end)
from public.payroll_work_items src
where w.payroll_run_id is null
  and w.reversal_of=src.id;

create or replace function lubricenter_private.payroll_sync()
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 perform 1
 from public.orders o
 where exists(select 1 from public.payroll_work_items w where w.order_id=o.id)
    or exists(
      select 1
      from public.order_items i
      join public.payroll_accruals a on a.source_order_item_id=i.id
      where i.order_id=o.id and a.payroll_run_id is null
    )
 order by o.id for update;

 insert into public.payroll_work_items(
   accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,
   currency,original_amount,amount,ref_per_unit,obligation_usd,payout_mode,earned_at
 )
 select
   a.id,p.id,a.employee_id,o.id,o.order_number,coalesce(a.description,i.description),a.source_type,p.currency,
   round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
   round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
   p.value_ref/p.amount_original,
   round(
     (
       case
         when i.price_denomination='USD'
           then a.amount_ref*i.bcv_rate_snapshot/nullif(i.operative_rate_snapshot,0)
         else a.amount_ref
       end
     ) * p.value_ves/nullif(o.total_ves,0)
   ,2),
   case when p.currency='USD' then 'HARD_USD' else 'BCV_VES' end,
   greatest(a.occurred_at,p.paid_at)
 from public.payroll_accruals a
 join public.order_items i on i.id=a.source_order_item_id
 join public.orders o on o.id=i.order_id
 join public.payments p on p.order_id=o.id
 where a.payroll_run_id is null
   and o.status='CLOSED'
   and o.total_ves>0
   and p.amount_original>0
   and p.value_ref>0
   and p.value_ves>0
 on conflict(accrual_id,payment_id) where reversal_of is null do nothing;

 insert into public.payroll_work_items(
   accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,
   currency,original_amount,amount,ref_per_unit,obligation_usd,payout_mode,earned_at,reversal_of,reason
 )
 select
   w.accrual_id,w.payment_id,w.employee_id,w.order_id,w.order_number,
   'Reversión · '||w.description,w.source_type,w.currency,
   -w.amount,-w.amount,w.ref_per_unit,
   -abs(coalesce(w.obligation_usd,case when w.currency='USD' then w.amount else w.amount*w.ref_per_unit end)),
   coalesce(w.payout_mode,case when w.currency='USD' then 'HARD_USD' else 'BCV_VES' end),
   now(),w.id,'Orden anulada o cobro/trabajo corregido'
 from public.payroll_work_items w
 where w.payroll_run_id is not null
   and w.reversal_of is null
   and w.decision='PAY'
   and w.amount<>0
   and (
     not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
     or not exists(select 1 from public.payments p where p.id=w.payment_id)
     or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED')
   )
 on conflict(reversal_of) where reversal_of is not null do nothing;

 update public.payroll_work_items w
 set decision='EXCLUDE',
     reason='Orden anulada o cobro/trabajo corregido',
     version=version+1
 where payroll_run_id is null
   and reversal_of is null
   and decision<>'EXCLUDE'
   and (
     not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
     or not exists(select 1 from public.payments p where p.id=w.payment_id)
     or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED')
   );
end $$;

create or replace function lubricenter_private.payroll_review_work_v3(
 p_id uuid,p_version integer,p_decision text,p_obligation_usd numeric,p_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare w public.payroll_work_items; updated public.payroll_work_items;
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 select * into w from public.payroll_work_items where id=p_id for update;
 if not found then raise exception 'Trabajo no encontrado'; end if;
 if w.payroll_run_id is not null then raise exception 'Este trabajo ya está liquidado; su recibo no se puede reescribir'; end if;
 if w.version<>p_version then raise exception 'El trabajo cambió. Recarga la revisión antes de guardar'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo del cambio (mínimo 5 caracteres)'; end if;
 if p_decision is null or p_decision not in ('PAY','HOLD','EXCLUDE')
    or p_obligation_usd is null or p_obligation_usd::text in ('NaN','Infinity','-Infinity')
 then raise exception 'Decisión o monto inválido'; end if;
 if w.reversal_of is null and p_obligation_usd<0 then raise exception 'La comisión no puede ser negativa'; end if;
 if w.reversal_of is null and (
   not exists(select 1 from public.payroll_accruals where id=w.accrual_id)
   or not exists(select 1 from public.payments where id=w.payment_id)
   or not exists(select 1 from public.orders where id=w.order_id and status='CLOSED')
 ) then raise exception 'Este trabajo fue anulado o corregido y no puede pagarse'; end if;
 if w.reversal_of is not null and p_obligation_usd<>w.obligation_usd then
   raise exception 'La reversión conserva el monto originalmente liquidado';
 end if;
 update public.payroll_work_items
 set decision=p_decision,
     obligation_usd=round(p_obligation_usd,2),
     reason=trim(p_reason),
     version=version+1
 where id=p_id
 returning * into updated;
 insert into public.payroll_work_history(work_item_id,actor_id,reason,before_data,after_data)
 values(p_id,auth.uid(),trim(p_reason),to_jsonb(w),to_jsonb(updated));
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('payroll.work_reviewed_v3','payroll_work_item',p_id,
   jsonb_build_object('reason',p_reason,'before',to_jsonb(w),'after',to_jsonb(updated),'actor',auth.uid()));
end $$;

create or replace function public.payroll_review_work_v3(
 p_id uuid,p_version integer,p_decision text,p_obligation_usd numeric,p_reason text
) returns void language sql security invoker set search_path='' as $$
 select lubricenter_private.payroll_review_work_v3(p_id,p_version,p_decision,p_obligation_usd,p_reason)
$$;

create or replace function lubricenter_private.payroll_settle(
 p_employee_id uuid,p_period_start date,p_period_end date,p_expected jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 run_id uuid; fixed numeric:=0; variable numeric:=0; adjustments numeric:=0;
 hard_usd numeric:=0; bcv_usd numeric:=0; actual jsonb;
begin
 perform lubricenter_private.payroll_sync();
 if p_period_start is null or p_period_end is null or p_period_end<p_period_start or p_period_end-p_period_start<>6 then
   raise exception 'Selecciona una semana de 7 días';
 end if;
 perform 1 from public.employees where id=p_employee_id and active for update;
 if not found then raise exception 'Empleado no disponible'; end if;
 if exists(
   select 1 from public.payroll_runs
   where employee_id=p_employee_id and status='SETTLED'
     and daterange(period_start,period_end,'[]')&&daterange(p_period_start,p_period_end,'[]')
 ) then raise exception 'Este empleado ya tiene una liquidación para ese período'; end if;

 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]')
 into actual
 from public.payroll_work_items
 where employee_id=p_employee_id and payroll_run_id is null
   and decision in ('PAY','EXCLUDE')
   and (earned_at at time zone 'America/Caracas')::date<=p_period_end;
 if p_expected->'work' is distinct from actual then
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

 select coalesce(jsonb_agg(jsonb_build_object('id',id,'amount_ref',amount_ref) order by id),'[]')
 into actual
 from public.payroll_adjustments
 where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;
 if p_expected->'adjustments' is distinct from actual then
   raise exception 'Cambiaron los ajustes. Recarga y revisa el resumen';
 end if;

 select
   coalesce(sum(obligation_usd),0),
   coalesce(sum(obligation_usd) filter(where payout_mode='HARD_USD'),0),
   coalesce(sum(obligation_usd) filter(where payout_mode='BCV_VES'),0)
 into variable,hard_usd,bcv_usd
 from public.payroll_work_items
 where employee_id=p_employee_id and payroll_run_id is null
   and decision='PAY'
   and (earned_at at time zone 'America/Caracas')::date<=p_period_end;

 select coalesce(sum(amount_ref),0) into adjustments
 from public.payroll_adjustments
 where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;

 if fixed+variable+adjustments<0 then
   raise exception 'El saldo a favor del negocio supera esta liquidación; deja los descuentos pendientes y revisa el detalle';
 end if;

 insert into public.payroll_runs(
   employee_id,period_start,period_end,fixed_ref,variable_ref,adjustments_ref,total_ref,
   commission_usd,commission_ves,commission_hard_usd,commission_bcv_usd,payroll_version
 )
 values(
   p_employee_id,p_period_start,p_period_end,fixed,variable,adjustments,fixed+variable+adjustments,
   hard_usd,null,hard_usd,bcv_usd,3
 )
 returning id into run_id;

 update public.payroll_work_items
 set payroll_run_id=run_id
 where employee_id=p_employee_id and payroll_run_id is null
   and decision in ('PAY','EXCLUDE')
   and (earned_at at time zone 'America/Caracas')::date<=p_period_end;

 update public.payroll_adjustments
 set payroll_run_id=run_id
 where employee_id=p_employee_id and payroll_run_id is null and occurred_on<=p_period_end;

 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('payroll.settled_v3','payroll_run',run_id,
   jsonb_build_object(
     'actor',auth.uid(),'commission_hard_usd',hard_usd,'commission_bcv_usd',bcv_usd,
     'fixed_ref',fixed,'adjustments_ref',adjustments,'work_items',actual
   ));
 return run_id;
end $$;

do $$declare f record; begin
 for f in
   select p.oid::regprocedure signature
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','lubricenter_private')
     and p.proname in ('payroll_sync','payroll_review_work_v3','payroll_settle')
 loop
   execute format('revoke all on function %s from public, anon',f.signature);
   execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

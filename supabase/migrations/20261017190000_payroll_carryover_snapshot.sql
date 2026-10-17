-- Historical carryovers: include only unassigned jobs earned through the selected week.
-- Immutable prior payroll runs/payments remain untouched.
CREATE OR REPLACE FUNCTION lubricenter_private.payroll_review(p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    and (w.earned_at at time zone 'America/Caracas')::date <= p_end;

  return result;
end
$function$

CREATE OR REPLACE FUNCTION lubricenter_private.payroll_settle(p_employee_id uuid, p_period_start date, p_period_end date, p_expected jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  run_id uuid; fixed numeric:=0; variable numeric:=0; adjustments numeric:=0;
  hard_usd numeric:=0; bcv_usd numeric:=0; actual_work jsonb; actual_adjustments jsonb;
begin
  perform lubricenter_private.payroll_sync();

  if p_period_start is null or p_period_end is null or p_period_end<p_period_start or p_period_end-p_period_start<>5 then
    raise exception 'Selecciona una semana de lunes a sábado';
  end if;
  if extract(isodow from p_period_start)<>1 or extract(isodow from p_period_end)<>6 then
    raise exception 'La nómina debe ir de lunes a sábado';
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
  ) then
    raise exception 'Este empleado ya tiene una liquidación para ese período';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]')
  into actual_work
  from public.payroll_work_items
  where employee_id=p_employee_id and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and (earned_at at time zone 'America/Caracas')::date <= p_period_end;

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
  where employee_id=p_employee_id
    and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and occurred_on<=p_period_end;

  if p_expected->'adjustments' is distinct from actual_adjustments then
    raise exception 'Cambiaron los ajustes. Recarga y revisa el resumen';
  end if;

  select
    coalesce(sum(obligation_usd),0),
    coalesce(sum(obligation_usd) filter(where payout_mode='HARD_USD'),0),
    coalesce(sum(obligation_usd) filter(where payout_mode='BCV_VES'),0)
  into variable,hard_usd,bcv_usd
  from public.payroll_work_items
  where employee_id=p_employee_id
    and payroll_run_id is null
    and decision='PAY'
    and (earned_at at time zone 'America/Caracas')::date <= p_period_end;

  select coalesce(sum(amount_ref),0) into adjustments
  from public.payroll_adjustments
  where employee_id=p_employee_id
    and payroll_run_id is null
    and decision='PAY'
    and occurred_on<=p_period_end;

  if fixed+variable+adjustments<0 then
    raise exception 'El saldo a favor del negocio supera esta liquidación; prorroga parte de los descuentos y revisa el detalle';
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
  where employee_id=p_employee_id
    and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and (earned_at at time zone 'America/Caracas')::date <= p_period_end;

  update public.payroll_adjustments
  set payroll_run_id=run_id,updated_at=now()
  where employee_id=p_employee_id
    and payroll_run_id is null
    and decision in ('PAY','EXCLUDE')
    and occurred_on<=p_period_end;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values(
    'payroll.settled_v5','payroll_run',run_id,
    jsonb_build_object(
      'actor',auth.uid(),
      'period_start',p_period_start,
      'period_end',p_period_end,
      'commission_hard_usd',hard_usd,
      'commission_bcv_usd',bcv_usd,
      'fixed_ref',fixed,
      'adjustments_ref',adjustments,
      'work_items',actual_work,
      'adjustments',actual_adjustments
    )
  );

 -- Persist audited inclusion, exclusion and deferred decisions at settlement time.
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 select 'payroll.settlement_admin_snapshot','payroll_run',run_id,
 jsonb_build_object(
   'employee_id',p_employee_id,'period_start',p_period_start,'period_end',p_period_end,
   'included_work',coalesce((select jsonb_agg(to_jsonb(w) order by w.earned_at,w.id)
     from public.payroll_work_items w where w.payroll_run_id=run_id),'[]'::jsonb),
   'deferred_work',coalesce((select jsonb_agg(to_jsonb(w) order by w.earned_at,w.id)
     from public.payroll_work_items w where w.employee_id=p_employee_id and w.payroll_run_id is null
       and w.decision='HOLD' and (w.earned_at at time zone 'America/Caracas')::date<=p_period_end),'[]'::jsonb),
   'included_adjustments',coalesce((select jsonb_agg(to_jsonb(a) order by a.occurred_on,a.id)
     from public.payroll_adjustments a where a.payroll_run_id=run_id),'[]'::jsonb),
   'deferred_adjustments',coalesce((select jsonb_agg(to_jsonb(a) order by a.occurred_on,a.id)
     from public.payroll_adjustments a where a.employee_id=p_employee_id and a.payroll_run_id is null
       and a.decision='HOLD' and a.occurred_on<=p_period_end),'[]'::jsonb),
   'fixed_ref',fixed,'commission_hard_usd',hard_usd,'commission_bcv_usd',bcv_usd,
   'adjustments_ref',adjustments,'total_ref',fixed+variable+adjustments,
   'snapshot_type','immutable_admin_audit');

  return run_id;
end
$function$


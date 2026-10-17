-- Apply advances to one completed week, then subtract from unpaid component without moving money twice.
CREATE OR REPLACE FUNCTION lubricenter_private.payroll_settle(p_employee_id uuid, p_period_start date, p_period_end date, p_expected jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  run_id uuid; fixed numeric:=0; variable numeric:=0; adjustments numeric:=0;
  hard_usd numeric:=0; bcv_usd numeric:=0; actual_work jsonb; actual_adjustments jsonb;
v_advance record; v_available numeric(18,2); v_apply numeric(18,2); v_remaining numeric(18,2);
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


 -- Apply prepaid wages only to this employee's unsettled payroll. Never create a second cash outflow.
 v_remaining:=round(fixed+variable+adjustments,2);
 FOR v_advance IN
   SELECT pa.id,pa.usd_equivalent,
      coalesce((SELECT sum(x.usd_applied) FROM public.payroll_advance_applications x WHERE x.advance_id=pa.id),0) already_applied
   FROM public.payroll_advances pa
   WHERE pa.employee_id=p_employee_id AND pa.intended_period_end<=p_period_end
   ORDER BY pa.paid_on,pa.created_at,pa.id FOR UPDATE OF pa
 LOOP
   v_available:=round(v_advance.usd_equivalent-v_advance.already_applied,2);
   v_apply:=least(v_available,v_remaining);
   IF v_apply>0.009 THEN
     INSERT INTO public.payroll_advance_applications(advance_id,payroll_run_id,usd_applied)
     VALUES(v_advance.id,run_id,v_apply);
     v_remaining:=round(v_remaining-v_apply,2);
   END IF;
   EXIT WHEN v_remaining<=0.009;
 END LOOP;
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
$function$;;

CREATE OR REPLACE FUNCTION lubricenter_private.payroll_record_payment(p_run_id uuid, p_account_id uuid, p_paid_on date, p_amount_original numeric, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.payroll_runs;
  a public.financial_accounts;
  v_bcv public.exchange_rates;
  v_op public.exchange_rates;
  v_usd numeric(18,2);
  v_total_paid numeric(18,2);
  v_advances_paid numeric(18,2);
  v_outstanding numeric(18,2);
  v_value_ves numeric(18,2);
  v_hard_due numeric(18,2);
  v_bcv_due numeric(18,2);
  v_hard_paid numeric(18,2);
  v_bcv_paid numeric(18,2);
  v_component text;
  v_component_outstanding numeric(18,2);
  v_movement uuid;
  v_id uuid;
  v_name text;
begin
  perform lubricenter_private.require_order_admin();
  perform pg_advisory_xact_lock(220034);

  if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then
    raise exception 'Selecciona una fecha de pago válida';
  end if;
  if p_amount_original is null or p_amount_original<=0 then
    raise exception 'Monto inválido';
  end if;

  select * into r
  from public.payroll_runs
  where id=p_run_id and status='SETTLED'
  for update;
  if not found then raise exception 'Liquidación no disponible'; end if;

  select * into a
  from public.financial_accounts
  where id=p_account_id
    and active
    and currency in ('USD','VES')
    and account_type in ('BANK','CASH','CLEARING')
  for update;
  if not found then raise exception 'Selecciona una cuenta activa USD o Bs'; end if;

  if a.account_type='BANK'
     and length(regexp_replace(coalesce(p_reference,''),'\D','','g'))<4 then
    raise exception 'Indica al menos los últimos 4 dígitos de la referencia bancaria';
  end if;

  select
    coalesce(sum(usd_equivalent),0),
    coalesce(sum(usd_equivalent) filter(where component='HARD_USD'),0),
    coalesce(sum(usd_equivalent) filter(where component='BCV_VES'),0)
  into v_total_paid,v_hard_paid,v_bcv_paid
  from public.payroll_payments
  where payroll_run_id=p_run_id;

  select coalesce(sum(x.usd_applied),0) into v_advances_paid
  from public.payroll_advance_applications x where x.payroll_run_id=p_run_id;
  v_total_paid:=v_total_paid+v_advances_paid;
  v_outstanding:=round(r.total_ref-v_total_paid,2);
  if v_outstanding<=0 then raise exception 'Esta liquidación ya está pagada'; end if;

  v_hard_due:=round(least(coalesce(r.commission_hard_usd,0),r.total_ref),2);
  v_bcv_due:=round(r.total_ref-v_hard_due,2);
  -- An already paid advance covers the BCV portion before any HARD_USD component.
  v_bcv_paid:=v_bcv_paid+least(v_advances_paid,v_bcv_due);
  v_hard_paid:=v_hard_paid+greatest(v_advances_paid-v_bcv_due,0);

  if a.currency='VES' then
    v_component:='BCV_VES';
    v_component_outstanding:=round(v_bcv_due-v_bcv_paid,2);
    if v_component_outstanding<=0 then
      raise exception 'La parte pagadera en Bs ya está saldada. Queda únicamente USD real';
    end if;

    select * into v_bcv
    from public.exchange_rates
    where rate_type='BCV'
      and effective_at<((p_paid_on+1)::timestamp at time zone 'America/Caracas')
    order by effective_at desc
    limit 1;
    if not found or v_bcv.value<=0 then
      raise exception 'No hay tasa BCV para esa fecha';
    end if;

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

    select * into v_op
    from public.exchange_rates
    where rate_type='OPERATIVE'
      and effective_at<((p_paid_on+1)::timestamp at time zone 'America/Caracas')
    order by effective_at desc
    limit 1;
    if not found or v_op.value<=0 then
      raise exception 'No hay tasa operativa para esa fecha';
    end if;

    v_value_ves:=round(p_amount_original*v_op.value,2);
  end if;

  if v_usd>v_component_outstanding+0.01 then
    if v_component='HARD_USD' then
      raise exception 'USD real pendiente: $%. Registra primero ese monto; luego puedes hacer otro pago para la parte BCV',v_component_outstanding;
    end if;
    raise exception 'El pago supera la parte BCV pendiente de $%',v_component_outstanding;
  end if;

  select name into v_name
  from public.employees
  where id=r.employee_id;

  insert into public.account_movements(
    account_id,direction,movement_type,currency,amount_original,value_ves,
    category,payee,note,reference,occurred_at,finance_nature
  )
  values(
    a.id,'OUT','EXPENSE',a.currency,round(p_amount_original,2),v_value_ves,
    'Nómina',v_name,
    coalesce(nullif(trim(p_note),''),'Pago nómina '||r.period_start||' al '||r.period_end),
    nullif(trim(p_reference),''),
    (p_paid_on::timestamp+time '12:00') at time zone 'America/Caracas',
    'PAYROLL'
  )
  returning id into v_movement;

  insert into public.payroll_payments(
    payroll_run_id,account_id,account_movement_id,paid_on,currency,
    amount_original,usd_equivalent,bcv_rate,bcv_effective_at,
    reference,note,payment_mode,component
  )
  values(
    r.id,a.id,v_movement,p_paid_on,a.currency,
    round(p_amount_original,2),v_usd,
    case when a.currency='VES' then v_bcv.value end,
    case when a.currency='VES' then v_bcv.effective_at end,
    nullif(trim(p_reference),''),nullif(trim(p_note),''),'ACTUAL',v_component
  )
  returning id into v_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values(
    'payroll.payment_recorded','payroll_payment',v_id,
    jsonb_build_object(
      'run_id',r.id,'movement_id',v_movement,'paid_on',p_paid_on,
      'currency',a.currency,'component',v_component,
      'amount_original',round(p_amount_original,2),
      'usd_equivalent',v_usd,'account_id',a.id,'actor',auth.uid()
    )
  );

  return v_id;
end
$function$;

CREATE OR REPLACE FUNCTION lubricenter_private.payroll_mark_historical_paid(p_run_id uuid, p_paid_on date, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.payroll_runs;
  v_paid numeric(18,2);
  v_outstanding numeric(18,2);
  v_id uuid;
begin
  perform lubricenter_private.require_order_admin();

  if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then
    raise exception 'Fecha inválida';
  end if;
  if length(trim(coalesce(p_note,'')))<8 then
    raise exception 'Explica la regularización histórica';
  end if;

  select * into r
  from public.payroll_runs
  where id=p_run_id and status='SETTLED'
  for update;
  if not found then raise exception 'Liquidación no disponible'; end if;

  select coalesce(sum(usd_equivalent),0)
  into v_paid
  from public.payroll_payments
  where payroll_run_id=p_run_id;

  v_outstanding:=round(r.total_ref-v_paid-
    coalesce((select sum(x.usd_applied) from public.payroll_advance_applications x
      where x.payroll_run_id=p_run_id),0),2);
  if v_outstanding<=0 then
    raise exception 'Esta liquidación ya está pagada';
  end if;

  insert into public.payroll_payments(
    payroll_run_id,paid_on,currency,amount_original,usd_equivalent,
    note,payment_mode,component
  )
  values(
    r.id,p_paid_on,'MANUAL',v_outstanding,v_outstanding,
    trim(p_note),'HISTORICAL_MANUAL','MANUAL'
  )
  returning id into v_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values(
    'payroll.historical_payment_regularized','payroll_payment',v_id,
    jsonb_build_object(
      'run_id',r.id,'paid_on',p_paid_on,'usd_equivalent',v_outstanding,
      'note',trim(p_note),'actor',auth.uid()
    )
  );

  return v_id;
end
$function$;

CREATE OR REPLACE FUNCTION public.payroll_employee_open_balance(p_employee_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE answer numeric;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 SELECT coalesce(sum(greatest(r.total_ref-coalesce(p.paid,0)-coalesce(adv.applied,0),0)),0)
 INTO answer FROM public.payroll_runs r
 LEFT JOIN (SELECT payroll_run_id,sum(usd_equivalent) paid FROM public.payroll_payments GROUP BY payroll_run_id) p
 ON p.payroll_run_id=r.id
 LEFT JOIN (SELECT payroll_run_id,sum(usd_applied) applied FROM public.payroll_advance_applications GROUP BY payroll_run_id) adv
 ON adv.payroll_run_id=r.id
 WHERE r.employee_id=p_employee_id AND r.status='SETTLED' AND r.payroll_version>=3;
 RETURN answer;
END $body$;
REVOKE ALL ON FUNCTION public.payroll_employee_open_balance(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_employee_open_balance(uuid) TO authenticated;

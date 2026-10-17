-- Administrator-only, read-only forensic report of an already settled payroll week.
-- Reconstructs decisions at the time of settlement, including unlinked HOLD rows.
CREATE OR REPLACE FUNCTION lubricenter_private.payroll_admin_week_history(p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE p_start date; response jsonb;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_end IS NULL OR extract(isodow from p_end)<>6 THEN
   RAISE EXCEPTION 'Selecciona el sábado que cierra la semana de nómina';
 END IF;
 p_start:=p_end-5;
 WITH runs AS (
   SELECT r.*,e.name employee_name FROM public.payroll_runs r
   JOIN public.employees e ON e.id=r.employee_id
   WHERE r.period_start=p_start AND r.period_end=p_end AND r.status='SETTLED'
 ), run_cards AS (
   SELECT r.*,
     coalesce((SELECT sum(p.usd_equivalent) FROM public.payroll_payments p WHERE p.payroll_run_id=r.id),0) paid_usd,
     coalesce((SELECT sum(x.usd_applied) FROM public.payroll_advance_applications x WHERE x.payroll_run_id=r.id),0) advance_applied_usd,
     coalesce((SELECT jsonb_agg(jsonb_build_object(
       'id',a.id,'employee_id',a.employee_id,'paid_on',a.paid_on,'usd_equivalent',a.usd_equivalent,
       'applied_usd',x.usd_applied,'currency',a.currency,'amount_original',a.amount_original,
       'account_code',fa.code,'reference',a.reference,'note',a.note,'movement_id',a.account_movement_id
      ) ORDER BY a.paid_on,a.id)
      FROM public.payroll_advance_applications x
      JOIN public.payroll_advances a ON a.id=x.advance_id
      JOIN public.financial_accounts fa ON fa.id=a.account_id WHERE x.payroll_run_id=r.id),'[]'::jsonb) advances,
     coalesce((SELECT jsonb_agg(jsonb_build_object(
       'id',p.id,'paid_on',p.paid_on,'currency',p.currency,'amount_original',p.amount_original,
       'usd_equivalent',p.usd_equivalent,'payment_mode',p.payment_mode,'component',p.component,
       'reference',p.reference,'note',p.note,'account_code',fa.code,
       'ledger_movement_id',p.account_movement_id,'created_at',p.created_at
       ) ORDER BY p.paid_on,p.created_at)
       FROM public.payroll_payments p LEFT JOIN public.financial_accounts fa ON fa.id=p.account_id
       WHERE p.payroll_run_id=r.id),'[]'::jsonb) payments,
     (SELECT a.data FROM public.audit_events a WHERE a.event_type='payroll.settlement_admin_snapshot'
      AND a.entity_id=r.id ORDER BY a.created_at DESC LIMIT 1) admin_snapshot
   FROM runs r
 ), work_rows AS (
   SELECT r.id run_id,r.employee_id,w.id work_id,
     w.order_id,w.order_number,w.description,w.source_type,w.payout_mode,
     w.earned_at,w.created_at,w.payroll_run_id current_run_id,
     (w.payroll_run_id=r.id) settled_in_run,
     (w.created_at>r.created_at) recorded_after_settlement,
     CASE WHEN next_history.before_data IS NOT NULL THEN next_history.before_data
       WHEN prior_history.after_data IS NOT NULL THEN prior_history.after_data
       ELSE to_jsonb(w) END snapshot,
     coalesce((SELECT jsonb_agg(jsonb_build_object(
       'occurred_at',h.occurred_at,'reason',h.reason,
       'before_decision',h.before_data->>'decision','after_decision',h.after_data->>'decision',
       'before_amount',h.before_data->>'obligation_usd','after_amount',h.after_data->>'obligation_usd',
       'before_reason',h.before_data->>'reason','after_reason',h.after_data->>'reason'
       ) ORDER BY h.occurred_at)
       FROM public.payroll_work_history h WHERE h.work_item_id=w.id),'[]'::jsonb) timeline
   FROM runs r
   JOIN public.payroll_work_items w ON w.employee_id=r.employee_id
      AND (w.payroll_run_id=r.id OR
        (w.earned_at AT TIME ZONE 'America/Caracas')::date BETWEEN p_start AND p_end)
   LEFT JOIN LATERAL (SELECT h.before_data FROM public.payroll_work_history h
     WHERE h.work_item_id=w.id AND h.occurred_at>r.created_at
     ORDER BY h.occurred_at ASC LIMIT 1) next_history ON true
   LEFT JOIN LATERAL (SELECT h.after_data FROM public.payroll_work_history h
     WHERE h.work_item_id=w.id AND h.occurred_at<=r.created_at
     ORDER BY h.occurred_at DESC LIMIT 1) prior_history ON true
 ), adjustment_rows AS (
   SELECT r.id run_id,a.id,a.amount_ref,a.adjustment_type,a.note,a.decision,a.occurred_on,
       a.payroll_run_id,a.created_at,(a.created_at>r.created_at) recorded_after_settlement
   FROM runs r
   JOIN public.payroll_adjustments a ON a.employee_id=r.employee_id
     AND (a.payroll_run_id=r.id OR
       (a.occurred_on BETWEEN p_start AND p_end))
 ), cards AS (
 SELECT jsonb_agg(jsonb_build_object(
   'id',r.id,'employee_id',r.employee_id,'employee_name',r.employee_name,
   'period_start',r.period_start,'period_end',r.period_end,
   'created_at',r.created_at,'status',r.status,'payroll_version',r.payroll_version,
   'fixed_ref',r.fixed_ref,'variable_ref',r.variable_ref,'adjustments_ref',r.adjustments_ref,
   'total_ref',r.total_ref,'paid_usd',r.paid_usd,'advances_applied_usd',r.advance_applied_usd,
   'outstanding_usd',greatest(r.total_ref-r.paid_usd-r.advance_applied_usd,0),
   'advances',r.advances,
   'payments',r.payments,'admin_snapshot',r.admin_snapshot,
   'work',coalesce((SELECT jsonb_agg(jsonb_build_object(
       'id',w.work_id,'order_id',w.order_id,'order_number',w.order_number,
       'description',w.description,'source_type',w.source_type,'payout_mode',w.payout_mode,
       'earned_at',w.earned_at,'decision_at_settlement',
          CASE WHEN w.recorded_after_settlement THEN 'LATE_POSTING'
             ELSE coalesce(w.snapshot->>'decision','UNKNOWN') END,
       'reason_at_settlement',CASE WHEN w.recorded_after_settlement
           THEN 'Trabajo registrado después de la liquidación original'
           ELSE w.snapshot->>'reason' END,
       'amount_at_settlement',CASE WHEN w.recorded_after_settlement THEN 0
           ELSE coalesce((w.snapshot->>'obligation_usd')::numeric,0) END,
       'current_payroll_run_id',w.current_run_id,
       'settled_in_this_run',w.settled_in_run,'late_posting',w.recorded_after_settlement,
       'carried_from_prior_week',(w.earned_at AT TIME ZONE 'America/Caracas')::date<p_start,
       'timeline',w.timeline
       ) ORDER BY w.earned_at,w.work_id)
     FROM work_rows w WHERE w.run_id=r.id),'[]'::jsonb),
   'adjustments',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',a.id,'type',a.adjustment_type,'amount_ref',a.amount_ref,
      'note',a.note,'decision',a.decision,'occurred_on',a.occurred_on,
      'included_in_run',a.payroll_run_id=r.id,'late_posting',a.recorded_after_settlement
      ) ORDER BY a.occurred_on,a.id)
     FROM adjustment_rows a WHERE a.run_id=r.id),'[]'::jsonb)
   ) ORDER BY r.employee_name) AS list FROM run_cards r
 )
 SELECT jsonb_build_object('start',p_start,'end',p_end,'runs',coalesce(cards.list,'[]'::jsonb))
 INTO response FROM cards;
 RETURN response;
END $body$;
CREATE OR REPLACE FUNCTION public.payroll_admin_week_history(p_end date)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $body$ SELECT lubricenter_private.payroll_admin_week_history(p_end) $body$;
REVOKE ALL ON FUNCTION lubricenter_private.payroll_admin_week_history(date) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.payroll_admin_week_history(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION lubricenter_private.payroll_admin_week_history(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_admin_week_history(date) TO authenticated;

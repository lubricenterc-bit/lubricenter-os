-- Commission policy chosen during payroll review (never at checkout).
-- One policy per employee commission accrual. Every bonus is backed by the source work.
CREATE TABLE IF NOT EXISTS public.cashea_payroll_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accrual_id uuid NOT NULL UNIQUE REFERENCES public.payroll_accruals(id) ON DELETE RESTRICT,
  cashea_sale_id uuid NOT NULL REFERENCES public.cashea_sales(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('AS_COLLECTED','FULL_UPFRONT')),
  advance_adjustment_id uuid UNIQUE REFERENCES public.payroll_adjustments(id) ON DELETE RESTRICT,
  decision_week_end date NOT NULL CHECK (extract(isodow from decision_week_end)=6),
  decision_reason text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  selected_by uuid DEFAULT auth.uid(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS cashea_payroll_policy_employee_idx
 ON public.cashea_payroll_policies(employee_id,decision_week_end);
ALTER TABLE public.cashea_payroll_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cashea_payroll_policies FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.payroll_cashea_set_policy(
 p_accrual_id uuid,p_mode text,p_period_end date,p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
 accrual public.payroll_accruals%ROWTYPE;
 sale public.cashea_sales%ROWTYPE;
 existing public.cashea_payroll_policies%ROWTYPE;
 extra public.payroll_adjustments%ROWTYPE;
 already numeric:=0; outstanding numeric:=0;
 v_mode text:=upper(coalesce(p_mode,'')); v_reason text:=btrim(coalesce(p_reason,''));
 target_adjustment uuid;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 PERFORM set_config('lubricenter.cashea_policy_edit','yes',true);
 PERFORM pg_advisory_xact_lock(240924,1);
 IF v_mode NOT IN ('AS_COLLECTED','FULL_UPFRONT') THEN
   RAISE EXCEPTION 'Modo Cashea inválido'; END IF;
 IF p_period_end IS NULL OR extract(isodow from p_period_end)<>6
   OR p_period_end<timezone('America/Caracas',now())::date
 THEN RAISE EXCEPTION 'Selecciona un sábado de nómina todavía abierto'; END IF;
 IF length(v_reason)<8 THEN RAISE EXCEPTION 'Indica el motivo del acuerdo con el mecánico'; END IF;
 PERFORM lubricenter_private.payroll_sync();
 SELECT * INTO accrual FROM public.payroll_accruals WHERE id=p_accrual_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Comisión original no encontrada'; END IF;
 SELECT cs.* INTO sale FROM public.cashea_sales cs
 JOIN public.order_items i ON i.order_id=cs.order_id
 JOIN public.orders o ON o.id=cs.order_id
 WHERE i.id=accrual.source_order_item_id AND o.status='CLOSED'
  AND cs.status IN ('ACTIVE','SETTLED') AND cs.ownership_status='OWN'
 FOR UPDATE OF cs;
 IF NOT FOUND THEN RAISE EXCEPTION 'La comisión no corresponde a una venta Cashea vigente de este local'; END IF;
 SELECT * INTO existing FROM public.cashea_payroll_policies WHERE accrual_id=p_accrual_id FOR UPDATE;
 IF FOUND AND existing.mode='FULL_UPFRONT'
   AND EXISTS(SELECT 1 FROM public.payroll_adjustments a WHERE a.id=existing.advance_adjustment_id
      AND a.payroll_run_id IS NOT NULL)
 THEN RAISE EXCEPTION 'La comisión adelantada ya fue liquidada. La política histórica está bloqueada'; END IF;
 IF existing.mode='FULL_UPFRONT' AND v_mode='AS_COLLECTED'
   AND EXISTS(SELECT 1 FROM public.payroll_work_items w WHERE w.accrual_id=p_accrual_id
       AND w.reason LIKE 'Comisión ya cubierta por adelanto Cashea%'
       AND w.decision='EXCLUDE')
 THEN RAISE EXCEPTION 'Ya hay cuotas cubiertas por esta decisión. Para revertirla se requiere una rectificación auditada'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_work_items w WHERE w.accrual_id=p_accrual_id
  AND w.reversal_of IS NULL AND w.decision IN ('HOLD','EXCLUDE') AND w.payroll_run_id IS NULL)
 THEN RAISE EXCEPTION 'Hay cuotas de esta comisión retenidas o excluidas; revísalas antes de adelantar el saldo'; END IF;
 -- Includes all collected commission tranches, including already settled ones.
 SELECT coalesce(sum(w.obligation_usd),0) INTO already
 FROM public.payroll_work_items w WHERE w.accrual_id=p_accrual_id
   AND w.reversal_of IS NULL AND w.decision='PAY';
 outstanding:=round(greatest(accrual.amount_ref-already,0),2);
 IF v_mode='FULL_UPFRONT' AND outstanding<0.01
 THEN RAISE EXCEPTION 'No queda comisión por adelantar'; END IF;
 IF v_mode='FULL_UPFRONT' THEN
   IF existing.advance_adjustment_id IS NOT NULL THEN
     UPDATE public.payroll_adjustments SET decision='PAY',amount_ref=outstanding,
       adjustment_type='BONUS',note='Adelanto comisión Cashea · '||v_reason,
       occurred_on=p_period_end,version=version+1,updated_at=now()
       WHERE id=existing.advance_adjustment_id AND payroll_run_id IS NULL
       RETURNING id INTO target_adjustment;
   ELSE
     INSERT INTO public.payroll_adjustments(employee_id,adjustment_type,amount_ref,note,
       occurred_on,decision)
     VALUES(accrual.employee_id,'BONUS',outstanding,
       'Adelanto comisión Cashea · '||v_reason,p_period_end,'PAY')
     RETURNING id INTO target_adjustment;
   END IF;
 ELSE
   target_adjustment:=existing.advance_adjustment_id;
   IF target_adjustment IS NOT NULL THEN
      UPDATE public.payroll_adjustments SET decision='EXCLUDE',
       note='Adelanto Cashea cancelado en borrador · '||v_reason,
       version=version+1,updated_at=now()
       WHERE id=target_adjustment AND payroll_run_id IS NULL;
   END IF;
 END IF;
 INSERT INTO public.cashea_payroll_policies(accrual_id,cashea_sale_id,employee_id,
   mode,advance_adjustment_id,decision_week_end,decision_reason)
 VALUES(p_accrual_id,sale.id,accrual.employee_id,v_mode,target_adjustment,p_period_end,v_reason)
 ON CONFLICT(accrual_id) DO UPDATE SET mode=EXCLUDED.mode,
  advance_adjustment_id=EXCLUDED.advance_adjustment_id,
  decision_week_end=EXCLUDED.decision_week_end,
  decision_reason=EXCLUDED.decision_reason,selected_at=now(),selected_by=auth.uid(),
  version=cashea_payroll_policies.version+1;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES ('payroll.cashea_commission_policy','payroll_accrual',p_accrual_id,jsonb_build_object(
 'mode',v_mode,'commission_full_ref',accrual.amount_ref,'already_collected_commission',already,
 'advance_ref',CASE WHEN v_mode='FULL_UPFRONT' THEN outstanding ELSE 0 END,
 'adjustment_id',target_adjustment,'decision_week_end',p_period_end,
 'reason',v_reason,'actor',auth.uid(),'no_cash_movement',true));
 RETURN jsonb_build_object('ok',true,'mode',v_mode,'full_ref',accrual.amount_ref,
   'collected_ref',already,'advance_ref',CASE WHEN v_mode='FULL_UPFRONT' THEN outstanding ELSE 0 END,
   'adjustment_id',target_adjustment);
END
$body$;

-- Show every employee's Cashea policy and an accurate unpaid commission ceiling
-- in the payroll-reconciliation screen.
CREATE OR REPLACE FUNCTION public.payroll_cashea_options(p_end date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE response jsonb;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_end IS NULL OR extract(isodow from p_end)<>6
 THEN RAISE EXCEPTION 'Selecciona el sábado de nómina'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
    'accrual_id',a.id,'employee_id',a.employee_id,'order_id',o.id,'order_number',o.order_number,
    'description',a.description,'full_commission_ref',a.amount_ref,'cashea_sale_id',s.id,
    'gross_ref',s.gross_ref,'cashea_service_fee_ref',s.commission_ref,'initial_ref',s.initial_ref,'financed_ref',s.financed_ref,
    'cashea_reference',s.cashea_reference,
    'commission_from_collections',coalesce(col.collected,0),
    'amount_to_advance',greatest(round(a.amount_ref-coalesce(col.collected,0),2),0),
    'mode',coalesce(pol.mode,'AS_COLLECTED'),
    'advance_adjustment_id',pol.advance_adjustment_id,
    'advance_already_liquidated',coalesce(ad.payroll_run_id IS NOT NULL,false),
    'installments',coalesce(inst.installments,'[]'::jsonb))
    ORDER BY o.order_number,a.description),'[]'::jsonb) INTO response
 FROM public.payroll_accruals a
 JOIN public.order_items i ON i.id=a.source_order_item_id
 JOIN public.orders o ON o.id=i.order_id AND o.status='CLOSED'
 JOIN public.cashea_sales s ON s.order_id=o.id
   AND s.status IN ('ACTIVE','SETTLED') AND s.ownership_status='OWN'
 LEFT JOIN public.cashea_payroll_policies pol ON pol.accrual_id=a.id
 LEFT JOIN public.payroll_adjustments ad ON ad.id=pol.advance_adjustment_id
 LEFT JOIN LATERAL (SELECT sum(w.obligation_usd) FILTER (WHERE w.reversal_of IS NULL
   AND w.decision='PAY') collected FROM public.payroll_work_items w
   WHERE w.accrual_id=a.id) col ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
    'installment_no',t.installment_no,'due_date',t.due_date,
    'amount_ref',t.amount_ref,'paid_ref',t.paid_ref,'status',t.status)
   ORDER BY t.installment_no) installments
    FROM public.cashea_installments t WHERE t.cashea_sale_id=s.id) inst ON true
 WHERE EXISTS(SELECT 1 FROM public.payroll_work_items w
   WHERE w.accrual_id=a.id AND w.payroll_run_id IS NULL
   AND (w.earned_at AT TIME ZONE 'America/Caracas')::date<=p_end)
 OR (pol.decision_week_end=p_end AND ad.payroll_run_id IS NULL);
 RETURN response;
END $body$;

-- Keep the original finance payroll_sync behavior and add an idempotent exclusion
-- of future Cashea tranches already covered by a paid-in-full commission decision.
CREATE OR REPLACE FUNCTION lubricenter_private.payroll_sync()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 perform 1 FROM public.orders o WHERE EXISTS(
    SELECT 1 FROM public.payroll_work_items w WHERE w.order_id=o.id
  ) OR EXISTS(
    SELECT 1 FROM public.order_items i JOIN public.payroll_accruals a
      ON a.source_order_item_id=i.id WHERE i.order_id=o.id AND a.payroll_run_id IS NULL
  ) ORDER BY o.id FOR UPDATE;
 insert into public.payroll_work_items(
   accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,
   currency,original_amount,amount,ref_per_unit,obligation_usd,payout_mode,earned_at
 )
 select a.id,p.id,a.employee_id,o.id,o.order_number,coalesce(a.description,i.description),
   a.source_type,p.currency,
   round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
   round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
   p.value_ref/p.amount_original,
   round((case when i.price_denomination='USD'
      then a.amount_ref*i.bcv_rate_snapshot/nullif(i.operative_rate_snapshot,0)
      else a.amount_ref end)*p.value_ves/nullif(o.total_ves,0),2),
   case when p.currency='USD' then 'HARD_USD' else 'BCV_VES' end,
   greatest(a.occurred_at,p.paid_at)
 from public.payroll_accruals a
 join public.order_items i on i.id=a.source_order_item_id
 join public.orders o on o.id=i.order_id
 join public.payments p on p.order_id=o.id
 where a.payroll_run_id is null and o.status='CLOSED' and o.total_ves>0
   and p.amount_original>0 and p.value_ref>0 and p.value_ves>0
 on conflict(accrual_id,payment_id) where reversal_of is null do nothing;

 insert into public.payroll_work_items(
  accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,
  currency,original_amount,amount,ref_per_unit,obligation_usd,payout_mode,earned_at,reversal_of,reason
 )
 select w.accrual_id,w.payment_id,w.employee_id,w.order_id,w.order_number,
  'Reversión · '||w.description,w.source_type,w.currency,
  -w.amount,-w.amount,w.ref_per_unit,
  -abs(coalesce(w.obligation_usd,case when w.currency='USD' then w.amount else w.amount*w.ref_per_unit end)),
  coalesce(w.payout_mode,case when w.currency='USD' then 'HARD_USD' else 'BCV_VES' end),
  now(),w.id,'Orden anulada o cobro/trabajo corregido'
 from public.payroll_work_items w
 where w.payroll_run_id IS NOT NULL AND w.reversal_of IS NULL AND w.decision='PAY'
  AND w.amount<>0 AND (
   NOT EXISTS(SELECT 1 FROM public.payroll_accruals a WHERE a.id=w.accrual_id)
   OR NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=w.payment_id)
   OR NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=w.order_id AND o.status='CLOSED')
  )
 on conflict(reversal_of) where reversal_of is not null do nothing;

 update public.payroll_work_items w
 set decision='EXCLUDE',reason='Orden anulada o cobro/trabajo corregido',version=version+1
 where w.payroll_run_id IS NULL AND w.reversal_of IS NULL AND w.decision<>'EXCLUDE'
  AND (
   NOT EXISTS(SELECT 1 FROM public.payroll_accruals a WHERE a.id=w.accrual_id)
   OR NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=w.payment_id)
   OR NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=w.order_id AND o.status='CLOSED')
  );
 -- Future cash collection is still recognized in payments and Cashea installments;
 -- this only excludes the second wage on a covered commission.
 update public.payroll_work_items w
 set decision='EXCLUDE',
     reason='Comisión ya cubierta por adelanto Cashea (no volver a pagar esta cuota)',
     version=w.version+1
 from public.cashea_payroll_policies pol
 join public.payroll_adjustments adj ON adj.id=pol.advance_adjustment_id
 where w.accrual_id=pol.accrual_id AND pol.mode='FULL_UPFRONT'
   AND adj.decision='PAY'
   AND w.payroll_run_id IS NULL AND w.reversal_of IS NULL
   AND w.decision='PAY'
   AND w.created_at>pol.selected_at;
end
$function$;

-- Special Cashea bonus is system managed; its decision is edited only by the policy RPC.
CREATE OR REPLACE FUNCTION public.payroll_cashea_advance_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF EXISTS(SELECT 1 FROM public.cashea_payroll_policies p
   WHERE p.advance_adjustment_id=OLD.id) AND
   (OLD.amount_ref IS DISTINCT FROM NEW.amount_ref
     OR OLD.decision IS DISTINCT FROM NEW.decision
     OR OLD.payroll_run_id IS DISTINCT FROM NEW.payroll_run_id)
 THEN
   -- Payroll settlement must be able to attach a run but cannot alter the bonus amount.
   IF OLD.amount_ref IS DISTINCT FROM NEW.amount_ref
      OR (OLD.decision IS DISTINCT FROM NEW.decision AND pg_trigger_depth()=1)
   THEN
     -- Admin policy RPC is permitted through transaction-local setting.
     IF current_setting('lubricenter.cashea_policy_edit',true) IS DISTINCT FROM 'yes'
     THEN RAISE EXCEPTION 'La comisión adelantada solo puede modificarse desde Política Cashea'; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS cashea_policy_guard_adjustment ON public.payroll_adjustments;
CREATE TRIGGER cashea_policy_guard_adjustment
 BEFORE UPDATE ON public.payroll_adjustments
 FOR EACH ROW EXECUTE FUNCTION public.payroll_cashea_advance_integrity();

REVOKE ALL ON FUNCTION public.payroll_cashea_set_policy(uuid,text,date,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.payroll_cashea_options(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_cashea_set_policy(uuid,text,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_cashea_options(date) TO authenticated;
REVOKE ALL ON FUNCTION public.payroll_cashea_advance_integrity() FROM PUBLIC,anon,authenticated;

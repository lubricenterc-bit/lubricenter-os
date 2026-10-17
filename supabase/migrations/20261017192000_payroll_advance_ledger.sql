-- Actual advance paid before weekly settlement: distinct from salary deductions
-- and distinct from normal payments on a settled payroll run.
CREATE TABLE IF NOT EXISTS public.payroll_advances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 employee_id uuid NOT NULL REFERENCES public.employees(id),
 paid_on date NOT NULL,
 intended_period_end date NOT NULL,
 account_id uuid NOT NULL REFERENCES public.financial_accounts(id),
 account_movement_id uuid NOT NULL UNIQUE REFERENCES public.account_movements(id),
 currency text NOT NULL CHECK(currency IN ('USD','VES')),
 amount_original numeric(18,2) NOT NULL CHECK(amount_original>0),
 usd_equivalent numeric(18,2) NOT NULL CHECK(usd_equivalent>0),
 bcv_rate numeric(18,6),
 bcv_effective_at timestamptz,
 reference text,
 note text NOT NULL CHECK(length(btrim(note))>=8),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid DEFAULT auth.uid(),
 CONSTRAINT payroll_advances_week_check CHECK(extract(isodow from intended_period_end)=6),
 CONSTRAINT payroll_advances_date_check CHECK(paid_on<=intended_period_end)
);
CREATE TABLE IF NOT EXISTS public.payroll_advance_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 advance_id uuid NOT NULL REFERENCES public.payroll_advances(id),
 payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id),
 usd_applied numeric(18,2) NOT NULL CHECK(usd_applied>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(advance_id,payroll_run_id)
);
CREATE INDEX IF NOT EXISTS payroll_advance_employee_period_idx ON public.payroll_advances(employee_id,intended_period_end,paid_on);
CREATE INDEX IF NOT EXISTS payroll_advance_applications_run_idx ON public.payroll_advance_applications(payroll_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_advance_reference_guard_idx ON public.payroll_advances(account_id,paid_on,reference) WHERE reference IS NOT NULL;
ALTER TABLE public.payroll_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_advance_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_advances,public.payroll_advance_applications FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.payroll_record_advance(
 p_employee_id uuid,p_paid_on date,p_intended_period_end date,p_account_id uuid,
 p_amount_original numeric,p_reference text,p_note text,p_expected_usd numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE a public.financial_accounts%ROWTYPE; e public.employees%ROWTYPE;
 v_bcv public.exchange_rates%ROWTYPE; v_op public.exchange_rates%ROWTYPE;
 v_usd numeric(18,2);v_ves numeric(18,2);v_movement uuid;v_advance uuid;v_ref text;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 PERFORM pg_advisory_xact_lock(220034);
 IF p_paid_on IS NULL OR p_paid_on>timezone('America/Caracas',now())::date
   OR p_intended_period_end IS NULL OR extract(isodow from p_intended_period_end)<>6
   OR p_paid_on>p_intended_period_end
 THEN RAISE EXCEPTION 'Fecha de pago o semana destino inválida'; END IF;
 IF p_amount_original IS NULL OR p_amount_original<=0
   OR round(p_amount_original,2)<>p_amount_original
   OR p_amount_original::text IN ('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'Indica el monto real entregado en la moneda de la cuenta'; END IF;
 IF length(btrim(coalesce(p_note,'')))<8 THEN RAISE EXCEPTION 'Explica el anticipo y sus trabajos (mínimo 8 caracteres)'; END IF;
 SELECT * INTO e FROM public.employees WHERE id=p_employee_id AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Empleado activo no encontrado'; END IF;
 SELECT * INTO a FROM public.financial_accounts
   WHERE id=p_account_id AND active AND currency IN ('VES','USD') AND account_type IN ('BANK','CASH','CLEARING')
     AND code<>'MOBILE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Selecciona la cuenta real desde la que entregaste el dinero'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_runs r
    WHERE r.employee_id=e.id AND r.period_end=p_intended_period_end AND r.status='SETTLED')
 THEN RAISE EXCEPTION 'La semana seleccionada ya fue liquidada; no insertes un anticipo después del cierre'; END IF;
 v_ref:=nullif(btrim(p_reference),'');
 IF a.account_type='BANK' AND length(regexp_replace(coalesce(v_ref,''),'\D','','g'))<4
 THEN RAISE EXCEPTION 'El pago bancario debe incluir al menos cuatro dígitos de referencia'; END IF;
 -- Reference collision with any recorded outgoing bank/cash ledger (not just advances).
 IF v_ref IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.account_movements m WHERE m.account_id=a.id AND m.direction='OUT'
   AND m.reference=v_ref AND (m.occurred_at AT TIME ZONE 'America/Caracas')::date
         BETWEEN p_paid_on-interval '1 day' AND p_paid_on+interval '1 day')
 THEN RAISE EXCEPTION 'Ya existe una salida de esta cuenta con esa referencia en una fecha cercana; evita duplicar caja'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_advances pa
   WHERE pa.employee_id=e.id AND pa.account_id=a.id AND pa.paid_on=p_paid_on
   AND pa.amount_original=p_amount_original AND pa.reference IS NOT DISTINCT FROM v_ref)
 THEN RAISE EXCEPTION 'Este anticipo ya fue registrado'; END IF;
 SELECT * INTO v_bcv FROM public.exchange_rates
 WHERE rate_type='BCV' AND effective_at<((p_paid_on+1)::timestamp AT TIME ZONE 'America/Caracas')
 ORDER BY effective_at DESC LIMIT 1;
 IF NOT FOUND OR v_bcv.value<=0 THEN RAISE EXCEPTION 'Falta BCV para el día del anticipo'; END IF;
 IF a.currency='VES' THEN
   v_ves:=round(p_amount_original,2);v_usd:=round(v_ves/v_bcv.value,2);
 ELSE
   v_usd:=round(p_amount_original,2);
   SELECT * INTO v_op FROM public.exchange_rates
   WHERE rate_type='OPERATIVE' AND effective_at<((p_paid_on+1)::timestamp AT TIME ZONE 'America/Caracas')
   ORDER BY effective_at DESC LIMIT 1;
   IF NOT FOUND OR v_op.value<=0 THEN RAISE EXCEPTION 'Falta tasa operativa para calcular el equivalente en bolívares'; END IF;
   v_ves:=round(v_usd*v_op.value,2);
 END IF;
 IF v_usd<=0 THEN RAISE EXCEPTION 'Equivalente USD del anticipo inválido'; END IF;
 IF p_expected_usd IS NOT NULL AND abs(v_usd-p_expected_usd)>0.51
 THEN RAISE EXCEPTION 'El importe real corresponde a $%, no a los $% indicados; revisa cuenta y tasa del día',v_usd,p_expected_usd; END IF;
 INSERT INTO public.account_movements(account_id,direction,movement_type,currency,amount_original,
  value_ves,category,payee,note,reference,occurred_at,finance_nature)
 VALUES (a.id,'OUT','EXPENSE',a.currency,round(p_amount_original,2),v_ves,'Nómina',e.name,
  'Anticipo real de nómina · '||btrim(p_note),v_ref,
  (p_paid_on::timestamp+time '12:00') AT TIME ZONE 'America/Caracas','PAYROLL')
 RETURNING id INTO v_movement;
 INSERT INTO public.payroll_advances(employee_id,paid_on,intended_period_end,account_id,account_movement_id,
  currency,amount_original,usd_equivalent,bcv_rate,bcv_effective_at,reference,note)
 VALUES(e.id,p_paid_on,p_intended_period_end,a.id,v_movement,a.currency,round(p_amount_original,2),
   v_usd,v_bcv.value,v_bcv.effective_at,v_ref,btrim(p_note))
 RETURNING id INTO v_advance;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES('payroll.advance_recorded','payroll_advance',v_advance,
    jsonb_build_object('employee_id',e.id,'paid_on',p_paid_on,
      'target_week_end',p_intended_period_end,'amount_original',round(p_amount_original,2),
      'currency',a.currency,'usd_equivalent',v_usd,'account_movement_id',v_movement,
      'account_id',a.id,'reference',v_ref,'note',p_note,'actor',auth.uid()));
 RETURN jsonb_build_object('id',v_advance,'recorded',true,'paid_on',p_paid_on,'usd_equivalent',v_usd,
   'account_code',a.code,'movement_id',v_movement);
END $body$;

CREATE OR REPLACE FUNCTION public.payroll_advance_admin_history()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE response jsonb;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',a.id,'employee_id',a.employee_id,'employee_name',e.name,'paid_on',a.paid_on,
  'intended_period_end',a.intended_period_end,'account_code',fa.code,'currency',a.currency,
  'amount_original',a.amount_original,'usd_equivalent',a.usd_equivalent,'reference',a.reference,
  'note',a.note,'created_at',a.created_at,'movement_id',a.account_movement_id,
  'allocated_usd',coalesce(v.applied,0),
  'unapplied_usd',greatest(a.usd_equivalent-coalesce(v.applied,0),0),
  'applications',coalesce(v.details,'[]'::jsonb))
  ORDER BY a.paid_on DESC,a.created_at DESC),'[]'::jsonb) INTO response
 FROM public.payroll_advances a
 JOIN public.employees e ON e.id=a.employee_id
 JOIN public.financial_accounts fa ON fa.id=a.account_id
 LEFT JOIN LATERAL (SELECT sum(x.usd_applied) applied,
   jsonb_agg(jsonb_build_object('run_id',x.payroll_run_id,'usd_applied',x.usd_applied,
    'period_end',r.period_end) ORDER BY x.created_at) details
  FROM public.payroll_advance_applications x
  JOIN public.payroll_runs r ON r.id=x.payroll_run_id WHERE x.advance_id=a.id) v ON true;
 RETURN response;
END $body$;

REVOKE ALL ON FUNCTION public.payroll_record_advance(uuid,date,date,uuid,numeric,text,text,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.payroll_advance_admin_history() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_record_advance(uuid,date,date,uuid,numeric,text,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_advance_admin_history() TO authenticated;

-- Fix inaccessible payroll RPC facades. All private functions below already
-- validate the sole permitted payroll administrator. Never grant private helpers
-- directly to browser roles.
CREATE OR REPLACE FUNCTION public.payroll_review_adjustment(
 p_id uuid,p_version integer,p_decision text,p_amount_ref numeric,p_note text
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$ SELECT lubricenter_private.payroll_review_adjustment(
 p_id,p_version,p_decision,p_amount_ref,p_note) $$;
CREATE OR REPLACE FUNCTION public.payroll_record_payment(
 p_run_id uuid,p_account_id uuid,p_paid_on date,p_amount_original numeric,
 p_reference text DEFAULT NULL,p_note text DEFAULT NULL
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$ SELECT lubricenter_private.payroll_record_payment(
 p_run_id,p_account_id,p_paid_on,p_amount_original,p_reference,p_note) $$;
CREATE OR REPLACE FUNCTION public.payroll_mark_historical_paid(
 p_run_id uuid,p_paid_on date,p_note text
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$ SELECT lubricenter_private.payroll_mark_historical_paid(p_run_id,p_paid_on,p_note) $$;
REVOKE ALL ON FUNCTION public.payroll_review_adjustment(uuid,integer,text,numeric,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.payroll_record_payment(uuid,uuid,date,numeric,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.payroll_mark_historical_paid(uuid,date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_review_adjustment(uuid,integer,text,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_record_payment(uuid,uuid,date,numeric,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_mark_historical_paid(uuid,date,text) TO authenticated;

-- Linked transfer entries are always born on HOLD, never as automatic wage
-- garnishments. A signed voluntary agreement and labor-law check are required
-- before a manager can approve the pair.
ALTER TABLE public.payroll_adjustments ADD COLUMN IF NOT EXISTS transfer_id uuid;
ALTER TABLE public.payroll_adjustments ADD COLUMN IF NOT EXISTS transfer_role text;
ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_transfer_role_check
 CHECK (transfer_role IS NULL OR transfer_role IN('FROM','TO'));
CREATE UNIQUE INDEX IF NOT EXISTS payroll_transfer_unique_role_idx
 ON public.payroll_adjustments(transfer_id,transfer_role) WHERE transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.payroll_adjustment_update(
 p_id uuid,p_version integer,p_type text,p_decision text,p_amount_ref numeric,p_note text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE a public.payroll_adjustments%rowtype;updated public.payroll_adjustments%rowtype;
 v_type text:=upper(coalesce(p_type,''));v_decision text:=upper(coalesce(p_decision,''));
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 SELECT * INTO a FROM public.payroll_adjustments WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ajuste no encontrado'; END IF;
 IF a.payroll_run_id IS NOT NULL THEN RAISE EXCEPTION 'Ajuste ya liquidado. No se puede reescribir'; END IF;
 IF a.transfer_id IS NOT NULL THEN
  RAISE EXCEPTION 'La reasignación está vinculada a dos empleados. Usa Aprobar o Descartar transferencia';
 END IF;
 IF a.version<>p_version THEN RAISE EXCEPTION 'Ajuste modificado por otro usuario; recarga'; END IF;
 IF v_type NOT IN('SUPPLIES','ADVANCE','DEBT','BONUS','OTHER') OR
    v_decision NOT IN('PAY','HOLD','EXCLUDE') THEN
    RAISE EXCEPTION 'Tipo o decisión inválidos';
 END IF;
 IF p_amount_ref IS NULL OR p_amount_ref::text IN('NaN','Infinity','-Infinity')
   OR p_amount_ref=0 OR abs(p_amount_ref)>100000 THEN RAISE EXCEPTION 'Monto de ajuste inválido'; END IF;
 IF v_type='BONUS' AND p_amount_ref<=0 THEN RAISE EXCEPTION 'Un bono debe ser positivo'; END IF;
 IF v_type IN('DEBT','ADVANCE','SUPPLIES') AND p_amount_ref>=0 THEN
  RAISE EXCEPTION 'Un descuento debe ser negativo. El empleado no puede recibirlo como bono';
 END IF;
 IF length(btrim(coalesce(p_note,'')))<8 OR length(p_note)>700 THEN
  RAISE EXCEPTION 'Escribe un motivo de al menos 8 caracteres';
 END IF;
 UPDATE public.payroll_adjustments SET
  adjustment_type=v_type,decision=v_decision,amount_ref=round(p_amount_ref,2),
  note=btrim(p_note),version=version+1,updated_at=now()
 WHERE id=p_id RETURNING * INTO updated;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES('payroll.adjustment_updated_v2','payroll_adjustment',p_id,
  jsonb_build_object('before',to_jsonb(a),'after',to_jsonb(updated),
    'actor',auth.uid()));
 RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION public.payroll_adjustment_update(uuid,integer,text,text,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_adjustment_update(uuid,integer,text,text,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.payroll_transfer_draft(
 p_from_employee uuid,p_to_employee uuid,p_amount_usd numeric,p_reason text,
 p_occurred_on date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_id uuid:=gen_random_uuid();v_from uuid;v_to uuid;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_from_employee IS NULL OR p_to_employee IS NULL OR p_from_employee=p_to_employee THEN
  RAISE EXCEPTION 'Selecciona dos trabajadores diferentes'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE id=p_from_employee AND active)
 OR NOT EXISTS(SELECT 1 FROM public.employees WHERE id=p_to_employee AND active) THEN
  RAISE EXCEPTION 'Ambos empleados deben estar activos'; END IF;
 IF p_amount_usd IS NULL OR p_amount_usd::text IN('NaN','Infinity','-Infinity')
 OR p_amount_usd<=0 OR p_amount_usd>1000 THEN RAISE EXCEPTION 'Monto a reasignar inválido'; END IF;
 IF length(btrim(coalesce(p_reason,'')))<12 OR length(p_reason)>700 THEN
  RAISE EXCEPTION 'Explica el incidente y la razón de la posible reasignación'; END IF;
 IF p_occurred_on IS NULL OR p_occurred_on>timezone('America/Caracas',now())::date
 OR p_occurred_on<timezone('America/Caracas',now())::date-90 THEN
  RAISE EXCEPTION 'Fecha de incidente inválida'; END IF;

 INSERT INTO public.payroll_adjustments(
 employee_id,adjustment_type,amount_ref,note,occurred_on,decision,
 transfer_id,transfer_role)
 VALUES(p_from_employee,'OTHER',-round(p_amount_usd,2),
  'Propuesta de compensación pendiente de autorización: '||btrim(p_reason),
  p_occurred_on,'HOLD',v_id,'FROM') RETURNING id INTO v_from;
 INSERT INTO public.payroll_adjustments(
 employee_id,adjustment_type,amount_ref,note,occurred_on,decision,
 transfer_id,transfer_role)
 VALUES(p_to_employee,'BONUS',round(p_amount_usd,2),
  'Compensación pendiente de aprobación: '||btrim(p_reason),
  p_occurred_on,'HOLD',v_id,'TO') RETURNING id INTO v_to;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES('payroll.transfer_draft_created','payroll_transfer',v_id,
  jsonb_build_object('from_employee',p_from_employee,'to_employee',p_to_employee,
   'amount_usd',round(p_amount_usd,2),'reason',btrim(p_reason),'actor',auth.uid(),
   'from_adjustment_id',v_from,'to_adjustment_id',v_to,
   'requires_legal_and_worker_consent',true));
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.payroll_transfer_draft(uuid,uuid,numeric,text,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_transfer_draft(uuid,uuid,numeric,text,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.payroll_transfer_decide(
 p_transfer_id uuid,p_action text,p_evidence text,
 p_authorization_verified boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_from public.payroll_adjustments%rowtype;v_to public.payroll_adjustments%rowtype;
 v_from_run boolean;v_to_run boolean;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 PERFORM pg_advisory_xact_lock(hashtextextended(p_transfer_id::text,5419));
 SELECT * INTO v_from FROM public.payroll_adjustments
  WHERE transfer_id=p_transfer_id AND transfer_role='FROM' FOR UPDATE;
 SELECT * INTO v_to FROM public.payroll_adjustments
  WHERE transfer_id=p_transfer_id AND transfer_role='TO' FOR UPDATE;
 IF v_from.id IS NULL OR v_to.id IS NULL THEN RAISE EXCEPTION 'No se encontró la transferencia completa'; END IF;
 IF v_from.payroll_run_id IS NOT NULL OR v_to.payroll_run_id IS NOT NULL THEN
  RAISE EXCEPTION 'Esta reasignación ya está en una liquidación; no se puede cambiar';
 END IF;
 IF v_from.decision<>'HOLD' OR v_to.decision<>'HOLD' THEN
  RAISE EXCEPTION 'La propuesta ya fue tramitada'; END IF;
 IF v_from.amount_ref>=0 OR v_to.amount_ref<=0 OR v_from.amount_ref+v_to.amount_ref<>0 THEN
  RAISE EXCEPTION 'La transferencia debe sumar exactamente cero'; END IF;
 IF p_action NOT IN('APPROVE','REJECT') THEN RAISE EXCEPTION 'Acción inválida'; END IF;
 IF length(btrim(coalesce(p_evidence,'')))<12 OR length(p_evidence)>800 THEN
   RAISE EXCEPTION 'Registra motivo, acuerdo y documentación revisada (mínimo 12 caracteres)'; END IF;
 IF p_action='APPROVE' AND p_authorization_verified IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'No se puede descontar salario sin verificar previamente autorización y legalidad';
 END IF;
 UPDATE public.payroll_adjustments
 SET decision=CASE WHEN p_action='APPROVE' THEN 'PAY' ELSE 'EXCLUDE' END,
     note=note||' · Decisión: '||btrim(p_evidence),
     version=version+1,updated_at=now()
 WHERE transfer_id=p_transfer_id;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES('payroll.transfer_decided','payroll_transfer',p_transfer_id,
   jsonb_build_object('action',p_action,'evidence',btrim(p_evidence),
    'consent_and_legality_verified',p_authorization_verified,'actor',auth.uid(),
    'negative_adjustment_id',v_from.id,'positive_adjustment_id',v_to.id,
    'net_change',v_from.amount_ref+v_to.amount_ref));
END $$;
REVOKE ALL ON FUNCTION public.payroll_transfer_decide(uuid,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.payroll_transfer_decide(uuid,text,text,boolean) TO authenticated;

-- An individual edit must never partially approve an inter-employee pair.
CREATE OR REPLACE FUNCTION lubricenter_private.payroll_review_adjustment(
 p_id uuid,p_version integer,p_decision text,p_amount_ref numeric,p_note text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE a public.payroll_adjustments%rowtype;
 v_decision text:=upper(coalesce(p_decision,''));
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 SELECT * INTO a FROM public.payroll_adjustments WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ajuste no encontrado'; END IF;
 IF a.payroll_run_id IS NOT NULL THEN RAISE EXCEPTION 'Este ajuste ya fue liquidado'; END IF;
 IF a.transfer_id IS NOT NULL THEN RAISE EXCEPTION 'Modifica la transferencia como pareja, no cada empleado'; END IF;
 IF a.version<>p_version THEN RAISE EXCEPTION 'El ajuste cambió. Recarga'; END IF;
 IF v_decision NOT IN('PAY','HOLD','EXCLUDE') OR p_amount_ref IS NULL
 OR p_amount_ref=0 OR p_amount_ref::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Decisión o importe inválido'; END IF;
 IF length(trim(coalesce(p_note,'')))<5 THEN RAISE EXCEPTION 'Explica el motivo'; END IF;
 UPDATE public.payroll_adjustments
 SET decision=v_decision,amount_ref=round(p_amount_ref,2),note=trim(p_note),
  version=version+1,updated_at=now() WHERE id=p_id;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 VALUES('payroll.adjustment_reviewed','payroll_adjustment',p_id,
   jsonb_build_object('before',to_jsonb(a),
    'after',(select to_jsonb(x) from public.payroll_adjustments x where x.id=p_id),
    'actor',auth.uid()));
 RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION lubricenter_private.payroll_review_adjustment(uuid,integer,text,numeric,text)
 FROM PUBLIC,anon,authenticated;

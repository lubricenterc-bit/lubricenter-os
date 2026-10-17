-- Detect exact, unique bank evidence before moving any money in the internal ledger.
-- Never infer an actual deposit from a Cashea order or an order payment alone.
CREATE OR REPLACE FUNCTION lubricenter_private.finance_exact_bank_mismatches(
 p_from date,p_to date
) RETURNS TABLE (
 payment_id uuid, order_id uuid, order_number text, external_transaction_id uuid,
 recorded_account text, actual_account text, reference text,
 recorded_ves numeric, verified_ves numeric, paid_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $body$
 WITH candidates AS (
  SELECT p.id payment_id,p.order_id,o.order_number,et.id external_transaction_id,
    original_account.code recorded_account,ext_account.code actual_account,
    p.reference,p.amount_original recorded_ves,et.amount verified_ves,p.paid_at,
    count(*) OVER (PARTITION BY p.id) payment_candidates,
    count(*) OVER (PARTITION BY et.id) external_candidates
  FROM public.payments p
  JOIN public.orders o ON o.id=p.order_id AND o.status='CLOSED'
  JOIN public.financial_accounts original_account ON original_account.id=p.financial_account_id
    AND original_account.code IN ('BDV','BNC')
  JOIN public.external_transactions et ON et.direction='IN' AND et.currency='VES'
    AND abs(et.amount-p.amount_original)<=0.01
    AND et.occurred_at BETWEEN p.paid_at-interval '2 days' AND p.paid_at+interval '2 days'
  JOIN public.external_sources es ON es.id=et.source_id
  JOIN public.financial_accounts ext_account ON ext_account.id=es.account_id
    AND ext_account.code IN ('BDV','BNC')
  WHERE p.method IN ('TRANSFER_BDV','TRANSFER_BNC')
    AND p.reference ~ '^\d{4,32}$'
    AND right(regexp_replace(coalesce(et.reference,''),'[^0-9]','','g'),length(p.reference))=p.reference
    AND (p.paid_at AT TIME ZONE 'America/Caracas')::date BETWEEN p_from AND p_to
    AND NOT EXISTS(SELECT 1 FROM public.reconciliation_allocations a
      JOIN public.account_movements m ON m.id=a.account_movement_id
      WHERE m.source_payment_id=p.id AND a.reversed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.order_tenders t WHERE t.payment_id=p.id)
 )
 SELECT c.payment_id,c.order_id,c.order_number,c.external_transaction_id,
   c.recorded_account,c.actual_account,c.reference,c.recorded_ves,c.verified_ves,c.paid_at
 FROM candidates c WHERE c.payment_candidates=1 AND c.external_candidates=1
   AND c.recorded_account<>c.actual_account;
$body$;

CREATE OR REPLACE FUNCTION public.finance_exact_bank_mismatches(
 p_from date,p_to date
) RETURNS TABLE (
 payment_id uuid, order_id uuid, order_number text, external_transaction_id uuid,
 recorded_account text, actual_account text, reference text,
 recorded_ves numeric, verified_ves numeric, paid_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_from IS NULL OR p_to IS NULL OR p_from>p_to OR p_to-p_from>35
 THEN RAISE EXCEPTION 'Período inválido de máximo 36 días'; END IF;
 RETURN QUERY SELECT * FROM lubricenter_private.finance_exact_bank_mismatches(p_from,p_to);
END $body$;

-- One-click correction of all evidence-backed mismatches. No new sale/payment is inserted.
CREATE OR REPLACE FUNCTION lubricenter_private.finance_autofix_bank_mismatches(
 p_from date,p_to date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
 hit record; p public.payments%ROWTYPE; old_movement jsonb;
 target_account uuid; fixed integer:=0; skipped integer:=0; errors jsonb:='[]'::jsonb;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_from IS NULL OR p_to IS NULL OR p_from>p_to OR p_to-p_from>35
 THEN RAISE EXCEPTION 'Período inválido de máximo 36 días'; END IF;
 FOR hit IN SELECT * FROM lubricenter_private.finance_exact_bank_mismatches(p_from,p_to)
 LOOP
  BEGIN
   SELECT * INTO p FROM public.payments WHERE id=hit.payment_id FOR UPDATE;
   IF NOT FOUND OR p.method NOT IN ('TRANSFER_BDV','TRANSFER_BNC')
     OR NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=p.order_id AND o.status='CLOSED')
   THEN RAISE EXCEPTION 'Pago no válido para rectificación'; END IF;
   IF (SELECT code FROM public.financial_accounts WHERE id=p.financial_account_id)<>hit.recorded_account
   THEN RAISE EXCEPTION 'La cuenta cambió mientras se revisaba'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.external_transactions et
       JOIN public.external_sources es ON es.id=et.source_id
       JOIN public.financial_accounts fa ON fa.id=es.account_id
       WHERE et.id=hit.external_transaction_id AND et.direction='IN' AND et.currency='VES'
        AND fa.code=hit.actual_account AND abs(et.amount-p.amount_original)<=0.01
        AND right(regexp_replace(coalesce(et.reference,''),'[^0-9]','','g'),length(p.reference))=p.reference)
   THEN RAISE EXCEPTION 'La evidencia bancaria ya no coincide'; END IF;
   IF EXISTS(SELECT 1 FROM public.reconciliation_allocations a
       JOIN public.account_movements m ON m.id=a.account_movement_id
       WHERE a.reversed_at IS NULL AND m.source_payment_id=p.id)
       OR EXISTS(SELECT 1 FROM public.order_tenders t WHERE t.payment_id=p.id)
   THEN RAISE EXCEPTION 'Tiene conciliación activa o vuelto auditado'; END IF;
   SELECT id INTO target_account FROM public.financial_accounts WHERE code=hit.actual_account AND active;
   IF target_account IS NULL THEN RAISE EXCEPTION 'La cuenta destino no está activa'; END IF;
   SELECT to_jsonb(m) INTO old_movement FROM public.account_movements m
    WHERE m.source_payment_id=p.id FOR UPDATE;
   IF old_movement IS NULL THEN RAISE EXCEPTION 'Falta movimiento de caja original'; END IF;
   UPDATE public.payments SET
      method=CASE WHEN hit.actual_account='BDV' THEN 'TRANSFER_BDV' ELSE 'TRANSFER_BNC' END,
      financial_account_id=target_account
    WHERE id=p.id;
   UPDATE public.account_movements SET account_id=target_account
    WHERE source_payment_id=p.id;
   UPDATE public.cashea_sales s SET initial_payment_method=
      CASE WHEN (SELECT count(DISTINCT ip.method) FROM public.payments ip
        WHERE ip.order_id=p.order_id AND NOT EXISTS
         (SELECT 1 FROM public.audit_events a WHERE a.event_type='cashea.installment_payment_recorded'
          AND a.data->>'payment_id'=ip.id::text))=1
        THEN (SELECT min(ip.method) FROM public.payments ip WHERE ip.order_id=p.order_id
         AND NOT EXISTS(SELECT 1 FROM public.audit_events a
          WHERE a.event_type='cashea.installment_payment_recorded'
          AND a.data->>'payment_id'=ip.id::text)) ELSE 'MIXED' END
    WHERE s.order_id=p.order_id AND s.status IN ('ACTIVE','SETTLED')
    AND NOT EXISTS(SELECT 1 FROM public.audit_events a
         WHERE a.event_type='cashea.installment_payment_recorded'
           AND a.data->>'payment_id'=p.id::text);
   INSERT INTO public.audit_events(event_type,entity_type,entity_id,actor_id,data)
    VALUES('finance.bank_autocorrected','payment',p.id,auth.uid(),jsonb_build_object(
     'previous_payment',to_jsonb(p),'previous_movement',old_movement,
     'external_transaction_id',hit.external_transaction_id,
     'actual_account',hit.actual_account,'reason','Referencia, fecha e importe exactos; coincidencia bancaria única',
     'new_sale',false,'bank_refund',false));
   fixed:=fixed+1;
  EXCEPTION WHEN OTHERS THEN
    skipped:=skipped+1;
    errors:=errors||jsonb_build_array(jsonb_build_object('payment_id',hit.payment_id,'error',SQLERRM));
  END;
 END LOOP;
 RETURN jsonb_build_object('corrected',fixed,'skipped',skipped,'errors',errors);
END $body$;

CREATE OR REPLACE FUNCTION public.finance_autofix_bank_mismatches(
 p_from date,p_to date
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $body$ SELECT lubricenter_private.finance_autofix_bank_mismatches(p_from,p_to) $body$;

REVOKE ALL ON FUNCTION lubricenter_private.finance_exact_bank_mismatches(date,date) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.finance_exact_bank_mismatches(date,date) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION lubricenter_private.finance_autofix_bank_mismatches(date,date) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.finance_autofix_bank_mismatches(date,date) FROM PUBLIC,anon;
-- Internal evidence query has no direct authenticated grant; public wrapper checks administrator.
GRANT EXECUTE ON FUNCTION public.finance_exact_bank_mismatches(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION lubricenter_private.finance_autofix_bank_mismatches(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_autofix_bank_mismatches(date,date) TO authenticated;

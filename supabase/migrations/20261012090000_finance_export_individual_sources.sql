-- Read-only, owner/admin-only historical reconciliation evidence. Does not close periods or modify cash.
CREATE OR REPLACE FUNCTION lubricenter_private.finance_export_period(p_from date,p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
DECLARE v_rows jsonb;v_orders jsonb;v_sources jsonb;v_total integer;v_pending integer;v_period_status text;v_is_final boolean;
BEGIN
 PERFORM lubricenter_private.finance_require();
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>92 THEN
  RAISE EXCEPTION 'Selecciona un período válido de máximo 93 días';
 END IF;
 SELECT count(*) INTO v_total FROM public.external_transactions x
 WHERE timezone('America/Caracas',x.occurred_at)::date BETWEEN p_from AND p_to;
 IF v_total>10000 THEN RAISE EXCEPTION 'Demasiados movimientos para un reporte. Divide el período';END IF;

 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.occurred_at,t.provider,t.reference),'[]'::jsonb) INTO v_rows FROM (
 SELECT x.id, s.provider,s.name source_name,timezone('America/Caracas',x.occurred_at) occurred_at,
   x.reference,x.description,x.direction,x.currency,x.amount,x.balance,x.external_order,
   x.installments,x.amount_ref,x.assigned_ref,x.ownership_status,x.nature,x.category,x.classification_reason,
   coalesce(os.order_number,op.order_number,'') order_number,
   coalesce(v.count_alloc,0)::integer allocations,
   coalesce(v.amount_alloc,0)::numeric amount_alloc,
   CASE
    WHEN s.provider='CASHEA_TRANSACTIONS' AND x.ownership_status<>'OWN' THEN 'NO_ATRIBUIDO_A_OS'
    WHEN coalesce(v.count_alloc,0)=0 THEN 'PENDIENTE'
    WHEN coalesce(v.amount_alloc,0)+0.000001 <
     CASE WHEN s.provider='CASHEA_TRANSACTIONS' THEN coalesce(x.assigned_ref,x.amount_ref,x.amount) ELSE x.amount END
     THEN 'PARCIAL'
    WHEN coalesce(b.verified,false) THEN 'CONCILIADO'
    ELSE 'ASIGNADO_PENDIENTE_VERIFICAR_REPORTE'
   END reconciliation_status,
   coalesce(b.verified,false) report_verified,
   coalesce(v.reason,'') reconciliation_reason
 FROM public.external_transactions x
 JOIN public.external_sources s ON s.id=x.source_id
 LEFT JOIN public.cashea_sales cs ON s.provider='CASHEA_TRANSACTIONS' AND cs.cashea_reference=x.external_order
 LEFT JOIN public.orders os ON os.id=cs.order_id
 LEFT JOIN LATERAL (
  SELECT count(*) count_alloc,sum(a.external_amount) amount_alloc,string_agg(coalesce(a.reason,a.method),'; ' ORDER BY a.created_at) reason,
         (array_agg(a.account_movement_id ORDER BY a.created_at))[1] account_movement_id
  FROM public.reconciliation_allocations a WHERE a.external_transaction_id=x.id AND a.reversed_at IS NULL
 ) v ON true
 LEFT JOIN public.account_movements am ON am.id=v.account_movement_id
 LEFT JOIN public.payments pay ON pay.id=am.source_payment_id
 LEFT JOIN public.orders op ON op.id=pay.order_id
 LEFT JOIN LATERAL (
  SELECT bool_or(y.verified_at IS NOT NULL AND y.status='COMPLETE') verified
  FROM public.external_batch_transactions link JOIN public.external_import_batches y ON y.id=link.batch_id
  WHERE link.transaction_id=x.id
 ) b ON true
 WHERE timezone('America/Caracas',x.occurred_at)::date BETWEEN p_from AND p_to
 ) t;
 SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY y.purchased_on,y.external_order),'[]'::jsonb) INTO v_orders FROM (
 SELECT snap.external_order,snap.purchased_on,snap.status,snap.total_ref,snap.initial_ref,
    snap.installments,snap.raw->>'# Factura' invoice_no,
    coalesce(o.order_number,'') order_number,
    CASE WHEN o.id IS NULL THEN 'SIN_FACTURA_OS' ELSE 'RELACIONADA_OS' END relation_status,
    b.verified_at IS NOT NULL AND b.status='COMPLETE' report_verified
 FROM public.cashea_order_snapshots snap
 JOIN public.external_import_batches b ON b.id=snap.batch_id
 LEFT JOIN public.cashea_sales cs ON cs.cashea_reference=snap.external_order
 LEFT JOIN public.orders o ON o.id=cs.order_id
 WHERE snap.purchased_on BETWEEN p_from AND p_to
 ) y;
 SELECT count(*) INTO v_pending FROM jsonb_array_elements(v_rows) z
 WHERE z->>'reconciliation_status' NOT IN ('CONCILIADO','NO_ATRIBUIDO_A_OS');

 SELECT jsonb_agg(jsonb_build_object('provider',p.provider,
  'records',CASE WHEN p.provider='CASHEA_ORDERS' THEN jsonb_array_length(v_orders) ELSE coalesce(t.n,0) END,
  'in_ves',coalesce(t.in_ves,0),'out_ves',coalesce(t.out_ves,0),
  'own_in_ves',coalesce(t.own_in_ves,0),'unattributed_in_ves',coalesce(t.unattributed_in_ves,0),
  'not_final',coalesce(t.pending,0),
  'coverage',CASE WHEN coalesce(t.n,0)=0 AND p.provider<>'CASHEA_ORDERS' THEN 'SIN_EXTRACTO'
   WHEN p.provider='CASHEA_ORDERS' AND jsonb_array_length(v_orders)=0 THEN 'SIN_EXTRACTO'
   WHEN p.provider='CASHEA_ORDERS' THEN 'REVISAR_ORDENES'
   WHEN coalesce(t.pending,0)>0 THEN 'CONCILIACION_PENDIENTE'
   ELSE 'CONCILIADO_EN_REGISTROS' END)) INTO v_sources
 FROM (VALUES('BDV'),('BNC'),('CASHEA_TRANSACTIONS'),('CASHEA_ORDERS')) p(provider)
 LEFT JOIN LATERAL (
  SELECT count(*) n,
   coalesce(sum((j->>'amount')::numeric) FILTER(WHERE j->>'direction'='IN' AND j->>'currency'='VES'),0) in_ves,
   coalesce(sum((j->>'amount')::numeric) FILTER(WHERE j->>'direction'='OUT' AND j->>'currency'='VES'),0) out_ves,
   count(*) FILTER(WHERE j->>'reconciliation_status' NOT IN ('CONCILIADO','NO_ATRIBUIDO_A_OS')) pending,
   coalesce(sum((j->>'amount')::numeric) FILTER(WHERE j->>'direction'='IN' AND j->>'currency'='VES' AND j->>'ownership_status'='OWN'),0) own_in_ves,
   coalesce(sum((j->>'amount')::numeric) FILTER(WHERE j->>'direction'='IN' AND j->>'currency'='VES' AND j->>'ownership_status'<>'OWN'),0) unattributed_in_ves
  FROM jsonb_array_elements(v_rows) j WHERE j->>'provider'=p.provider
 ) t ON true;
 SELECT rp.status INTO v_period_status FROM public.finance_reconciliation_periods rp
 WHERE rp.period_start<=p_from AND rp.period_end>=p_to
 ORDER BY rp.period_start DESC LIMIT 1;
 v_is_final:=coalesce(v_period_status='CLOSED',false)
  AND v_pending=0
  AND (SELECT count(*) FROM jsonb_array_elements(v_sources) z WHERE z->>'coverage'='SIN_EXTRACTO')=0
  AND NOT EXISTS (SELECT 1 FROM public.external_import_batches b JOIN public.external_sources s ON s.id=b.source_id
     WHERE b.observed_from<=p_to AND b.observed_to>=p_from AND s.provider IN ('BDV','BNC','CASHEA_TRANSACTIONS','CASHEA_ORDERS')
       AND (b.status<>'COMPLETE' OR b.verified_at IS NULL));
 RETURN jsonb_build_object('from',p_from,'to',p_to,'generated_at',now(),
  'status',CASE WHEN v_is_final THEN 'CONCILIADO' WHEN v_period_status='CLOSED_WITH_EXCEPTION' THEN 'CIERRE_CON_EXCEPCIONES' ELSE 'BORRADOR_HASTA_VERIFICAR_COBERTURA_SALDOS_Y_PENDIENTES' END,
  'transactions',v_rows,'orders',v_orders,'sources',v_sources,'pending_transactions',v_pending,
  'pending_note','Las cuotas Cashea y los abonos BNC son evidencias de fuentes distintas: no sumar ambos como dos ingresos. Los reportes sin cobertura verificada no son conciliación final.');
END $f$;

CREATE OR REPLACE FUNCTION public.finance_export_period(p_from date,p_to date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO '' AS $w$
 SELECT lubricenter_private.finance_export_period(p_from,p_to)
$w$;
REVOKE ALL ON FUNCTION public.finance_export_period(date,date) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION lubricenter_private.finance_export_period(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finance_export_period(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION lubricenter_private.finance_export_period(date,date) TO authenticated;

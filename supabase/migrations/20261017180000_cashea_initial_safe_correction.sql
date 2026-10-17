-- Correct an existing Cashea initial without cancelling the commercial order.
-- There is no bank refund in this flow: payment identity, stock, sale and payroll survive.
-- Intentionally requires explicit administrator confirmation and preserves audit evidence.
CREATE OR REPLACE FUNCTION lubricenter_private.correct_cashea_initial(
 p_order_id uuid, p_reason text, p_initial_percent numeric, p_lines jsonb,
 p_confirmed boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
 o public.orders%ROWTYPE; s public.cashea_sales%ROWTYPE;
 old_s jsonb; old_payments jsonb; old_installments jsonb;
 line jsonb; pay public.payments%ROWTYPE; movement public.account_movements%ROWTYPE;
 account_uuid uuid; pay_uuid uuid; old_id uuid;
 v_method text; ref text; currency_code text; account_code text;
 input_amount numeric; equivalent numeric; new_initial numeric; new_ves numeric; new_financed numeric;
 amount_1 numeric; amount_3 numeric; gross_paid numeric:=0;
 updated_count integer:=0; created_count integer:=0; deleted_count integer:=0;
 line_ids uuid[]:=ARRAY[]::uuid[]; initial_ids uuid[]:=ARRAY[]::uuid[];
 old_payment_ids uuid[]:=ARRAY[]::uuid[]; installment_row public.cashea_installments%ROWTYPE;
 initial_method text; snapshot_date timestamptz; operative_rate numeric;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF NOT p_confirmed THEN RAISE EXCEPTION 'Confirma expresamente la rectificación del dinero real recibido'; END IF;
 IF length(btrim(coalesce(p_reason,'')))<8 THEN RAISE EXCEPTION 'Describe la causa de la corrección (mínimo ocho caracteres)'; END IF;
 IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)<1
   OR jsonb_array_length(p_lines)>8 THEN RAISE EXCEPTION 'Indica entre uno y ocho cobros de la inicial'; END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.status<>'CLOSED' THEN RAISE EXCEPTION 'Solo se rectifican órdenes cerradas'; END IF;
 SELECT * INTO s FROM public.cashea_sales WHERE order_id=o.id FOR UPDATE;
 IF NOT FOUND OR s.status NOT IN ('ACTIVE','SETTLED') OR s.ownership_status<>'OWN'
 THEN RAISE EXCEPTION 'No hay una operación Cashea propia y vigente para esta orden'; END IF;
 IF p_initial_percent IS NULL OR p_initial_percent<=0 OR p_initial_percent>=100
 OR p_initial_percent::text IN ('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'La inicial debe ser mayor que cero y menor que 100 por ciento'; END IF;
 IF s.bcv_rate_snapshot<=0 THEN RAISE EXCEPTION 'La tasa BCV original no es válida'; END IF;
 -- This correction MUST NOT invalidate a bank match, settled installment or documented change.
 IF EXISTS (SELECT 1 FROM public.reconciliation_allocations a
   WHERE a.reversed_at IS NULL AND (a.cashea_sale_id=s.id
    OR a.cashea_installment_id IN (SELECT id FROM public.cashea_installments WHERE cashea_sale_id=s.id)))
 THEN RAISE EXCEPTION 'Cashea ya tiene conciliaciones; revísalas antes de rectificar la inicial'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.installment_no),'[]'::jsonb) INTO old_installments
 FROM public.cashea_installments i WHERE i.cashea_sale_id=s.id;
 SELECT array_agg(p.id),coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.paid_at),'[]'::jsonb),min(p.paid_at),
        max(p.operative_rate_snapshot)
 INTO old_payment_ids,old_payments,snapshot_date,operative_rate
 FROM public.payments p WHERE p.order_id=o.id
   AND NOT EXISTS (SELECT 1 FROM public.audit_events a
      WHERE a.event_type='cashea.installment_payment_recorded' AND a.data->>'payment_id'=p.id::text)
   AND p.receivable_id IS NULL;
 IF old_payment_ids IS NULL THEN RAISE EXCEPTION 'No se encontraron cobros iniciales para corregir'; END IF;
 IF EXISTS(SELECT 1 FROM public.order_tenders t WHERE t.order_id=o.id
            AND t.payment_id=ANY(old_payment_ids))
 THEN RAISE EXCEPTION 'La orden contiene un vuelto documentado; necesita devolución auditada'; END IF;
 IF EXISTS(SELECT 1 FROM public.reconciliation_allocations a
   JOIN public.account_movements m ON m.id=a.account_movement_id
   WHERE a.reversed_at IS NULL AND m.source_payment_id=ANY(old_payment_ids))
 THEN RAISE EXCEPTION 'Un cobro está conciliado; deshaz su asignación antes de rectificar'; END IF;
 PERFORM 1 FROM public.payments p WHERE p.id=ANY(old_payment_ids) ORDER BY p.id FOR UPDATE;
 PERFORM 1 FROM public.account_movements m WHERE m.source_payment_id=ANY(old_payment_ids) ORDER BY m.id FOR UPDATE;
 PERFORM 1 FROM public.cashea_installments i WHERE i.cashea_sale_id=s.id ORDER BY i.id FOR UPDATE;
 old_s:=to_jsonb(s);
 new_initial:=round(s.gross_ref*p_initial_percent/100,4);
 new_ves:=round(new_initial*s.bcv_rate_snapshot,2);
 new_financed:=s.gross_ref-new_initial;
 amount_1:=round(new_financed/3,4);
 amount_3:=new_financed-2*amount_1;
 IF amount_1<=0 OR amount_3<=0 THEN RAISE EXCEPTION 'Las tres cuotas restantes deben ser positivas'; END IF;
 IF EXISTS(SELECT 1 FROM public.cashea_installments i WHERE i.cashea_sale_id=s.id AND
   (CASE WHEN i.installment_no=3 THEN amount_3 ELSE amount_1 END)<i.paid_ref)
 THEN RAISE EXCEPTION 'La nueva inicial reduciría una cuota por debajo de lo ya pagado'; END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
   v_method:=line->>'method'; ref:=nullif(btrim(coalesce(line->>'reference','')),'');
   IF v_method NOT IN ('TRANSFER_BDV','TRANSFER_BNC','CASH_VES','CASH_USD','ZELLE','BINANCE')
   THEN RAISE EXCEPTION 'Método de cobro de inicial no admitido'; END IF;
   input_amount:=(line->>'amount')::numeric;
   IF input_amount IS NULL OR input_amount<=0 OR input_amount::text IN ('NaN','Infinity','-Infinity')
       OR round(input_amount,2)<>input_amount THEN RAISE EXCEPTION 'Monto de inicial inválido'; END IF;
   IF v_method IN ('TRANSFER_BDV','TRANSFER_BNC') AND coalesce(ref,'') !~ '^\d{4,32}$'
   THEN RAISE EXCEPTION 'Cada pago bancario necesita al menos los últimos cuatro dígitos'; END IF;
   IF v_method IN ('ZELLE','BINANCE') AND length(coalesce(ref,''))<4
   THEN RAISE EXCEPTION 'El cobro electrónico necesita referencia'; END IF;
   currency_code:=CASE WHEN v_method IN ('CASH_USD','ZELLE','BINANCE') THEN 'USD' ELSE 'VES' END;
   account_code:=CASE WHEN v_method='TRANSFER_BDV' THEN 'BDV'
                      WHEN v_method='TRANSFER_BNC' THEN 'BNC' ELSE v_method END;
   SELECT id INTO account_uuid FROM public.financial_accounts WHERE code=account_code AND active;
   IF account_uuid IS NULL THEN RAISE EXCEPTION 'Cuenta financiera no disponible: %',account_code; END IF;
   equivalent:=CASE WHEN currency_code='USD' THEN round(input_amount*s.bcv_rate_snapshot,2) ELSE input_amount END;
   gross_paid:=gross_paid+equivalent;
   old_id:=nullif(line->>'source_id','')::uuid;
   IF old_id IS NOT NULL THEN
     IF old_id=ANY(line_ids) OR NOT (old_id=ANY(old_payment_ids))
     THEN RAISE EXCEPTION 'Cobro inicial repetido o ajeno a esta venta'; END IF;
     line_ids:=array_append(line_ids,old_id);
     SELECT * INTO pay FROM public.payments WHERE id=old_id FOR UPDATE;
     UPDATE public.payments SET method=v_method, currency=currency_code,amount_original=input_amount,
         value_ves=equivalent,value_ref=round(equivalent/s.bcv_rate_snapshot,4),
         reference=ref,financial_account_id=account_uuid
       WHERE id=old_id;
     UPDATE public.account_movements SET account_id=account_uuid,currency=currency_code,
         amount_original=input_amount,value_ves=equivalent,reference=ref
       WHERE source_payment_id=old_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'El pago no tiene movimiento financiero asociado'; END IF;
     updated_count:=updated_count+1;
   ELSE
     INSERT INTO public.payments(order_id,method,currency,amount_original,
       bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,
       financial_account_id,paid_at,created_by)
     VALUES(o.id,v_method,currency_code,input_amount,s.bcv_rate_snapshot,
       coalesce(operative_rate,s.bcv_rate_snapshot),equivalent,
       round(equivalent/s.bcv_rate_snapshot,4),ref,account_uuid,
       coalesce(snapshot_date,s.created_at),auth.uid())
     RETURNING id INTO pay_uuid;
     created_count:=created_count+1;
   END IF;
 END LOOP;
 IF abs(gross_paid-new_ves)>greatest(1,round(s.bcv_rate_snapshot*0.5,2)) THEN
    RAISE EXCEPTION 'La inicial simulada (Bs %) no corresponde al % por ciento (Bs %). Comprueba porcentaje e importes',
       gross_paid,p_initial_percent,new_ves;
 END IF;
 -- Delete ONLY an old initial line explicitly omitted from the new split.
 FOREACH pay_uuid IN ARRAY old_payment_ids LOOP
   IF NOT (pay_uuid=ANY(line_ids)) THEN
     DELETE FROM public.account_movements WHERE source_payment_id=pay_uuid;
     DELETE FROM public.payments WHERE id=pay_uuid;
     deleted_count:=deleted_count+1;
   END IF;
 END LOOP;
 SELECT CASE WHEN count(DISTINCT p.method)=1 THEN min(p.method) ELSE 'MIXED' END
 INTO initial_method
 FROM public.payments p WHERE p.order_id=o.id AND p.receivable_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.audit_events a
        WHERE a.event_type='cashea.installment_payment_recorded' AND a.data->>'payment_id'=p.id::text);
 UPDATE public.cashea_sales SET initial_percent=p_initial_percent,initial_ref=new_initial,
   initial_ves_snapshot=new_ves,financed_ref=new_financed,initial_payment_method=initial_method
 WHERE id=s.id;
 UPDATE public.cashea_installments i SET
   amount_ref=CASE WHEN installment_no=3 THEN amount_3 ELSE amount_1 END,
   amount_ves_snapshot=round((CASE WHEN installment_no=3 THEN amount_3 ELSE amount_1 END)*s.bcv_rate_snapshot,2),
   status=CASE WHEN (CASE WHEN installment_no=3 THEN amount_3 ELSE amount_1 END)-i.paid_ref<=0.0001
     THEN 'PAID' WHEN i.paid_ref>0 THEN 'PARTIAL' ELSE 'PENDING' END
 WHERE cashea_sale_id=s.id;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,actor_id,data)
 VALUES ('cashea.initial_correction','order',o.id,auth.uid(),jsonb_build_object(
  'reason',btrim(p_reason),'before_sale',old_s,'before_initial_payments',old_payments,
  'before_installments',old_installments,'after_initial_percent',p_initial_percent,
  'after_initial_ref',new_initial,'after_initial_ves',new_ves,'received_ves',gross_paid,
  'after_lines',p_lines,'payments_updated',updated_count,'payments_added',created_count,
  'payments_removed',deleted_count,'sale_recreated',false,'bank_refund',false));
 RETURN jsonb_build_object('ok',true,'order_id',o.id,'cashea_sale_id',s.id,
    'initial_ref',new_initial,'financed_ref',new_financed,'received_ves',gross_paid,
    'updated',updated_count,'added',created_count,'removed',deleted_count);
END
$body$;

CREATE OR REPLACE FUNCTION public.correct_cashea_initial(
 p_order_id uuid,p_reason text,p_initial_percent numeric,p_lines jsonb,p_confirmed boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $body$
 SELECT lubricenter_private.correct_cashea_initial(p_order_id,p_reason,p_initial_percent,p_lines,p_confirmed)
$body$;

REVOKE ALL ON FUNCTION lubricenter_private.correct_cashea_initial(uuid,text,numeric,jsonb,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.correct_cashea_initial(uuid,text,numeric,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION lubricenter_private.correct_cashea_initial(uuid,text,numeric,jsonb,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_cashea_initial(uuid,text,numeric,jsonb,boolean) TO authenticated;

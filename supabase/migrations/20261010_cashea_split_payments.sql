-- Cobro de inicial Cashea en varias cuentas, sin modificar pagos históricos.
-- Fuente de verdad del destino: payments.method -> assign_payment_account() -> account_movements.
-- Un único cierre por transacción. Si falla cualquier validación, se revierten TODOS los pagos.
ALTER TABLE public.cashea_sales
  DROP CONSTRAINT IF EXISTS cashea_sales_initial_payment_method_check;
ALTER TABLE public.cashea_sales
  ADD CONSTRAINT cashea_sales_initial_payment_method_check CHECK (
    initial_payment_method IN (
      'CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC',
      'ZELLE','BINANCE','MIXED'
    )
  );

CREATE OR REPLACE FUNCTION lubricenter_private.close_order_cashea_split(
  p_order_id uuid, p_initial_percent numeric, p_initial_payments jsonb,
  p_cashea_reference text, p_expected_total_ves numeric,
  p_expected_total_ref numeric, p_expected_bcv numeric
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $cashea$
DECLARE
  v_order public.orders;
  v_bcv numeric; v_op numeric;
  v_total_ves numeric; v_total_ref numeric; v_initial_ves numeric;
  v_paid numeric; v_new_paid numeric := 0;
  v_row jsonb; v_method text; v_amount_text text; v_amount numeric;
  v_ves numeric; v_currency text; v_reference text; v_code text; v_seen int := 0;
  v_sale_id uuid; v_label text; v_count int;
BEGIN
  PERFORM public.require_auth();
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'Falta identificar la orden'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden no encontrada'; END IF;
  IF EXISTS (SELECT 1 FROM public.cashea_sales WHERE order_id=p_order_id) THEN
    RAISE EXCEPTION 'Esta venta Cashea ya quedó registrada. Recarga la orden; no cobres nuevamente';
  END IF;
  IF v_order.status <> 'OPEN' THEN RAISE EXCEPTION 'La orden no está abierta'; END IF;
  PERFORM public.validate_order_ready_to_close(p_order_id);

  IF p_initial_percent IS NULL OR p_initial_percent::text IN ('NaN','Infinity','-Infinity')
    OR p_initial_percent<=0 OR p_initial_percent>100 THEN
    RAISE EXCEPTION 'La inicial aprobada debe estar entre 0 y 100 por ciento';
  END IF;
  IF p_cashea_reference IS NULL OR btrim(p_cashea_reference) !~ '^[0-9]{1,32}$' THEN
    RAISE EXCEPTION 'Registra el número de orden de Cashea (solo dígitos)';
  END IF;
  IF p_initial_payments IS NULL OR jsonb_typeof(p_initial_payments)<>'array' THEN
    RAISE EXCEPTION 'Envía el desglose de la inicial como lista';
  END IF;
  IF jsonb_array_length(p_initial_payments)>8 THEN
    RAISE EXCEPTION 'La inicial admite entre 0 y 8 formas de cobro';
  END IF;

  SELECT coalesce(sum(charged_ves_amount),0),coalesce(sum(charged_ref_amount),0)
    INTO v_total_ves,v_total_ref FROM public.order_items WHERE order_id=p_order_id;
  IF v_total_ves<=0 OR v_total_ref<=0 THEN RAISE EXCEPTION 'Orden sin artículos cobrables'; END IF;
  IF p_expected_total_ves IS NULL OR p_expected_total_ref IS NULL OR
     abs(v_total_ves-p_expected_total_ves)>0.01 OR
     abs(v_total_ref-p_expected_total_ref)>0.0001 THEN
    RAISE EXCEPTION 'El total de la orden cambió. Actualiza el cobro antes de confirmar';
  END IF;
  SELECT bcv_rate,operative_rate INTO v_bcv,v_op FROM public.current_exchange_rates;
  IF v_bcv IS NULL OR v_bcv<=0 OR v_op IS NULL OR v_op<=0 OR
     p_expected_bcv IS NULL OR p_expected_bcv<>v_bcv THEN
    RAISE EXCEPTION 'La tasa BCV cambió. Actualiza los importes de la inicial';
  END IF;
  v_initial_ves := round(round(v_total_ref*p_initial_percent/100,4)*v_bcv,2);
  SELECT coalesce(sum(value_ves),0) INTO v_paid FROM public.payments
    WHERE order_id=p_order_id;
  IF v_paid>v_initial_ves THEN
    RAISE EXCEPTION 'Los pagos anteriores superan la inicial de Cashea: revisa sus montos';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_initial_payments)
  LOOP
    v_seen:=v_seen+1;
    IF jsonb_typeof(v_row)<>'object' THEN
      RAISE EXCEPTION 'Cada cobro debe tener método y monto';
    END IF;
    v_method := upper(btrim(coalesce(v_row->>'method','')));
    v_amount_text := btrim(coalesce(v_row->>'amount',''));
    v_reference := nullif(btrim(coalesce(v_row->>'reference','')),'');
    IF v_method NOT IN ('TRANSFER_BDV','TRANSFER_BNC','CASH_VES','CASH_USD','ZELLE','BINANCE') THEN
      RAISE EXCEPTION 'Selecciona el banco o forma de pago exacta para cada cobro';
    END IF;
    IF v_amount_text !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'Cobro %: ingresa monto positivo con máximo dos decimales',v_seen;
    END IF;
    v_amount := v_amount_text::numeric;
    IF v_amount<=0 THEN RAISE EXCEPTION 'Cobro %: el monto debe ser mayor a cero',v_seen; END IF;
    IF v_method IN ('TRANSFER_BDV','TRANSFER_BNC') AND
       (v_reference IS NULL OR v_reference !~ '^[0-9]{4,32}$') THEN
      RAISE EXCEPTION 'Cobro %: registra al menos los últimos 4 dígitos de la referencia bancaria',v_seen;
    END IF;
    IF v_method IN ('ZELLE','BINANCE') AND
       (v_reference IS NULL OR length(v_reference)<4 OR length(v_reference)>100) THEN
      RAISE EXCEPTION 'Cobro %: registra la referencia de Zelle o Binance',v_seen;
    END IF;
    IF length(coalesce(v_reference,''))>100 THEN
      RAISE EXCEPTION 'Cobro %: referencia demasiado larga',v_seen;
    END IF;
    v_currency := CASE WHEN v_method IN ('CASH_USD','ZELLE','BINANCE') THEN 'USD' ELSE 'VES' END;
    v_code := CASE v_method
      WHEN 'TRANSFER_BDV' THEN 'BDV' WHEN 'TRANSFER_BNC' THEN 'BNC'
      ELSE v_method END;
    IF NOT EXISTS (SELECT 1 FROM public.financial_accounts
                   WHERE code=v_code AND active AND currency=v_currency) THEN
      RAISE EXCEPTION 'La cuenta % no está activa o su moneda no corresponde al pago',v_code;
    END IF;
    v_ves := CASE WHEN v_currency='USD' THEN round(v_amount*v_bcv,2)
                  ELSE v_amount END;
    IF v_ves<=0 THEN RAISE EXCEPTION 'El monto convertido del cobro es inválido'; END IF;
    v_new_paid := v_new_paid+v_ves;
    IF v_paid+v_new_paid>v_initial_ves THEN
      RAISE EXCEPTION 'Los cobros superan la inicial aprobada. Revisa el desglose';
    END IF;
    -- Los USD de la inicial Cashea se valoran a BCV, NO a tasa operativa.
    -- Triggers existentes seleccionan cuenta y generan exactamente un movimiento.
    INSERT INTO public.payments(
      order_id,method,currency,amount_original,bcv_rate_snapshot,
      operative_rate_snapshot,value_ves,value_ref,reference,paid_at
    ) VALUES(
      p_order_id,v_method,v_currency,v_amount,v_bcv,v_op,v_ves,
      round(v_ves/v_bcv,4),v_reference,now()
    );
  END LOOP;
  IF v_paid+v_new_paid<>v_initial_ves THEN
    RAISE EXCEPTION 'La inicial no cuadra: falta Bs %. Completa o ajusta los cobros',
      round(v_initial_ves-v_paid-v_new_paid,2);
  END IF;
  SELECT count(DISTINCT method),min(method)
    INTO v_count,v_label FROM public.payments WHERE order_id=p_order_id;
  IF v_count=0 THEN RAISE EXCEPTION 'La inicial no tiene pagos registrados'; END IF;
  IF v_count>1 OR v_label NOT IN ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') THEN v_label:='MIXED'; END IF;

  -- El cierre probado calcula comisión/cuotas, no agrega pago porque ya
  -- fue cubierta EXACTAMENTE la inicial (0 de remanente).
  SELECT lubricenter_private.close_order_cashea(
    p_order_id,p_initial_percent,'TRANSFER_BDV',NULL,p_cashea_reference,
    p_expected_total_ves,p_expected_total_ref,p_expected_bcv
  ) INTO v_sale_id;
  UPDATE public.cashea_sales SET initial_payment_method=v_label WHERE id=v_sale_id;
  INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
  VALUES ('cashea.initial_split','cashea_sale',v_sale_id,
    jsonb_build_object('order_id',p_order_id,'initial_ves',v_initial_ves,
      'previous_payments_ves',v_paid,'new_payments_ves',v_new_paid,
      'initial_payment_method',v_label,'new_payment_count',v_seen));
  RETURN v_sale_id;
END;
$cashea$;

CREATE OR REPLACE FUNCTION public.close_order_cashea_split(
  p_order_id uuid,p_initial_percent numeric,p_initial_payments jsonb,
  p_cashea_reference text,p_expected_total_ves numeric,
  p_expected_total_ref numeric,p_expected_bcv numeric
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $cashea$
  SELECT lubricenter_private.close_order_cashea_split(
    p_order_id,p_initial_percent,p_initial_payments,p_cashea_reference,
    p_expected_total_ves,p_expected_total_ref,p_expected_bcv);
$cashea$;

CREATE TABLE IF NOT EXISTS public.cashea_split_requests (
  request_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  order_id uuid UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cashea_split_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cashea_split_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.quick_sale_cashea_split(
  p_request uuid,p_items jsonb,p_business_at timestamptz,
  p_initial_percent numeric,p_initial_payments jsonb,p_cashea_reference text,
  p_expected_total_ves numeric,p_expected_total_ref numeric,p_expected_bcv numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $cashea$
DECLARE
  v_hash text; v_previous record; v_draft jsonb; v_order_id uuid;
  v_sale_id uuid; v_response jsonb; v_date date;
BEGIN
  PERFORM public.require_auth();
  IF p_request IS NULL THEN RAISE EXCEPTION 'Falta identificador de cobro. Reabre la venta'; END IF;
  v_hash:=md5(jsonb_build_array(p_items,p_business_at,p_initial_percent,p_initial_payments,
     p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv)::text);
  INSERT INTO public.cashea_split_requests(request_id,payload_hash)
    VALUES(p_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_previous FROM public.cashea_split_requests WHERE request_id=p_request FOR UPDATE;
  IF v_previous.payload_hash<>v_hash THEN
    RAISE EXCEPTION 'Este intento de cobro corresponde a otro desglose. Usa una nueva operación';
  END IF;
  IF v_previous.order_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'order_id',o.id,'order_number',o.order_number,'total_ves',o.total_ves,
      'total_ref',o.total_ref,'initial_ref',s.initial_ref,
      'initial_ves',s.initial_ves_snapshot,'financed_ref',s.financed_ref,
      'commission_ref',s.commission_ref,'cashea_sale_id',s.id
    ) INTO v_response
    FROM public.orders o JOIN public.cashea_sales s ON s.order_id=o.id
    WHERE o.id=v_previous.order_id;
    IF v_response IS NULL THEN RAISE EXCEPTION 'La venta registrada no se pudo recuperar'; END IF;
    RETURN v_response;
  END IF;
  v_draft:=lubricenter_private.quick_sale_dated(
    p_items,'DRAFT',p_business_at,'TRANSFER_BDV',NULL,40,NULL);
  v_order_id:=(v_draft->>'order_id')::uuid;
  v_sale_id:=lubricenter_private.close_order_cashea_split(
    v_order_id,p_initial_percent,p_initial_payments,p_cashea_reference,
    p_expected_total_ves,p_expected_total_ref,p_expected_bcv);
  v_date:=(coalesce(p_business_at,now()) AT TIME ZONE 'America/Caracas')::date;
  UPDATE public.cashea_installments SET due_date=v_date+installment_no*14
    WHERE cashea_sale_id=v_sale_id;
  UPDATE public.cashea_split_requests SET order_id=v_order_id WHERE request_id=p_request;
  SELECT jsonb_build_object(
    'order_id',o.id,'order_number',o.order_number,'total_ves',o.total_ves,
    'total_ref',o.total_ref,'initial_ref',s.initial_ref,
    'initial_ves',s.initial_ves_snapshot,'financed_ref',s.financed_ref,
    'commission_ref',s.commission_ref,'cashea_sale_id',s.id
  ) INTO v_response
  FROM public.orders o JOIN public.cashea_sales s ON s.order_id=o.id
  WHERE o.id=v_order_id;
  RETURN v_response;
END;
$cashea$;

CREATE OR REPLACE FUNCTION public.quick_sale_cashea_split(
  p_request uuid,p_items jsonb,p_business_at timestamptz,
  p_initial_percent numeric,p_initial_payments jsonb,p_cashea_reference text,
  p_expected_total_ves numeric,p_expected_total_ref numeric,p_expected_bcv numeric
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $cashea$
  SELECT lubricenter_private.quick_sale_cashea_split(
    p_request,p_items,p_business_at,p_initial_percent,p_initial_payments,
    p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv);
$cashea$;

REVOKE ALL ON FUNCTION lubricenter_private.close_order_cashea_split(uuid,numeric,jsonb,text,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION lubricenter_private.quick_sale_cashea_split(uuid,jsonb,timestamptz,numeric,jsonb,text,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.close_order_cashea_split(uuid,numeric,jsonb,text,numeric,numeric,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.quick_sale_cashea_split(uuid,jsonb,timestamptz,numeric,jsonb,text,numeric,numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.close_order_cashea_split(uuid,numeric,jsonb,text,numeric,numeric,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_sale_cashea_split(uuid,jsonb,timestamptz,numeric,jsonb,text,numeric,numeric,numeric) TO authenticated;

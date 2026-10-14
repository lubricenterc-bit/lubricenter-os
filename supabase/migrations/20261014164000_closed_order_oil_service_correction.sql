-- OWNER-only non-financial service correction for closed commercial orders.
-- Never cancel/recreate a sale, change price, reverse the bank, recalculate Cashea,
-- re-consume stock or mutate installments. Records are additive/audited.
CREATE OR REPLACE FUNCTION lubricenter_private.correct_closed_oil_service(
 p_order_id uuid,p_service_item_id uuid,p_vehicle_id uuid,p_odometer integer,
 p_oil_brand text,p_oil_viscosity text,p_oil_liters numeric,p_filter_code text,
 p_next_service_odometer integer,p_next_service_date date,p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
 v_order public.orders%rowtype;v_item public.order_items%rowtype;
 v_original jsonb;v_created boolean:=false;v_id uuid;v_vehicle public.vehicles%rowtype;
 v_snap public.order_items%rowtype;v_followup uuid;v_crm_count integer;
 v_day date:=(now() at time zone 'America/Caracas')::date;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF length(btrim(coalesce(p_reason,'')))<8 OR length(p_reason)>800 THEN
   RAISE EXCEPTION 'Describe la corrección y su motivo (8 a 800 caracteres)';
 END IF;
 SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR v_order.status<>'CLOSED' THEN
   RAISE EXCEPTION 'Esta corrección conserva cobros y requiere una orden cerrada';
 END IF;
 IF v_order.customer_id IS NULL OR v_order.is_walk_in THEN
   RAISE EXCEPTION 'El servicio requiere una orden con cliente identificado';
 END IF;
 SELECT * INTO v_vehicle FROM public.vehicles WHERE id=p_vehicle_id FOR UPDATE;
 IF NOT FOUND OR v_vehicle.customer_id IS NULL THEN
   RAISE EXCEPTION 'Selecciona un vehículo y su propietario para generar el CRM correcto';
 END IF;
 IF p_odometer IS NULL OR p_odometer<0 OR p_odometer>9999999 THEN
   RAISE EXCEPTION 'Kilometraje actual inválido';
 END IF;
 IF length(btrim(coalesce(p_oil_brand,'')))<2 OR length(p_oil_brand)>150 THEN
   RAISE EXCEPTION 'Indica el aceite utilizado';
 END IF;
 IF length(coalesce(p_oil_viscosity,''))>80 OR length(coalesce(p_filter_code,''))>100
 OR p_oil_liters IS NOT NULL AND (p_oil_liters<=0 OR p_oil_liters>100 OR p_oil_liters::text='NaN') THEN
   RAISE EXCEPTION 'Viscosidad, filtro o litros inválidos';
 END IF;
 IF p_next_service_odometer IS NULL AND p_next_service_date IS NULL THEN
   RAISE EXCEPTION 'Indica el próximo servicio por fecha o kilometraje';
 END IF;
 IF p_next_service_odometer IS NOT NULL AND
   (p_next_service_odometer<=p_odometer OR p_next_service_odometer>9999999) THEN
   RAISE EXCEPTION 'El próximo kilometraje debe ser mayor al actual';
 END IF;
 IF p_next_service_date IS NOT NULL AND p_next_service_date < v_day-interval '10 years' THEN
   RAISE EXCEPTION 'Fecha del próximo servicio inválida';
 END IF;

 IF p_service_item_id IS NOT NULL THEN
  SELECT * INTO v_item FROM public.order_items
  WHERE id=p_service_item_id AND order_id=p_order_id
    AND item_type='SERVICE' AND business_area='OIL_CHANGE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La línea no es un cambio de aceite de esta orden'; END IF;
  v_original:=to_jsonb(v_item);
  v_id:=v_item.id;
 ELSE
  IF EXISTS(SELECT 1 FROM public.order_items i WHERE i.order_id=p_order_id
     AND i.item_type='SERVICE' AND i.business_area='OIL_CHANGE'
     AND coalesce(i.service_vehicle_id,v_order.vehicle_id)=p_vehicle_id)
  THEN RAISE EXCEPTION 'Ya existe un cambio de aceite para este carro en la orden; corrige esa línea'; END IF;
  SELECT * INTO v_snap FROM public.order_items
  WHERE order_id=p_order_id ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden sin artículos originales'; END IF;
  INSERT INTO public.order_items(order_id,item_type,business_area,description,quantity,
   pricing_mode,base_ref_amount,customer_ref_amount,charged_ves_amount,
   charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot,
   service_vehicle_id,service_odometer,oil_brand,oil_viscosity,oil_quantity_liters,
   oil_filter_code,next_service_odometer,next_service_date)
  VALUES(p_order_id,'SERVICE','OIL_CHANGE','Cambio de aceite',1,'STANDARD',0,0,0,0,
   v_snap.bcv_rate_snapshot,v_snap.operative_rate_snapshot,p_vehicle_id,p_odometer,
   btrim(p_oil_brand),nullif(btrim(coalesce(p_oil_viscosity,'')),''),
   p_oil_liters,nullif(btrim(coalesce(p_filter_code,'')),''),
   p_next_service_odometer,p_next_service_date)
  RETURNING id INTO v_id;
  v_created:=true;
 END IF;
 IF NOT v_created THEN
  UPDATE public.order_items SET service_vehicle_id=p_vehicle_id,service_odometer=p_odometer,
   oil_brand=btrim(p_oil_brand),oil_viscosity=nullif(btrim(coalesce(p_oil_viscosity,'')),''),
   oil_quantity_liters=p_oil_liters,
   oil_filter_code=nullif(btrim(coalesce(p_filter_code,'')),''),
   next_service_odometer=p_next_service_odometer,next_service_date=p_next_service_date
  WHERE id=v_id;
 END IF;
 SELECT * INTO v_item FROM public.order_items WHERE id=v_id;
 INSERT INTO public.service_records(
  order_id,order_item_id,customer_id,vehicle_id,service_type,description,odometer,
  oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,
  next_service_odometer,next_service_date,charged_ref_amount,charged_ves_amount,
  performed_at,created_by
 ) VALUES(p_order_id,v_id,v_vehicle.customer_id,p_vehicle_id,'OIL_CHANGE',
  v_item.description,p_odometer,v_item.oil_brand,v_item.oil_viscosity,v_item.oil_quantity_liters,
  v_item.oil_filter_code,v_item.next_service_odometer,v_item.next_service_date,
  v_item.charged_ref_amount,v_item.charged_ves_amount,coalesce(v_order.closed_at,now()),
  auth.uid())
 ON CONFLICT(order_item_id) DO UPDATE SET
  customer_id=excluded.customer_id,vehicle_id=excluded.vehicle_id,
  description=excluded.description,odometer=excluded.odometer,
  oil_brand=excluded.oil_brand,oil_viscosity=excluded.oil_viscosity,
  oil_quantity_liters=excluded.oil_quantity_liters,oil_filter_code=excluded.oil_filter_code,
  next_service_odometer=excluded.next_service_odometer,next_service_date=excluded.next_service_date;

 UPDATE public.vehicles SET
   current_odometer=greatest(coalesce(current_odometer,0),p_odometer),
   updated_at=now()
 WHERE id=p_vehicle_id;

 v_followup:=lubricenter_private.upsert_vehicle_crm(p_order_id,p_vehicle_id,true);
 INSERT INTO public.integration_events(event_type,aggregate_type,aggregate_id,payload)
 VALUES('vehicle.service_history_updated','vehicle',p_vehicle_id,
  jsonb_build_object('order_id',p_order_id,'corrected',true,'service_item_id',v_id,
   'next_service_odometer',p_next_service_odometer,'next_service_date',p_next_service_date));

 INSERT INTO public.audit_events(event_type,entity_type,entity_id,actor_id,data)
 VALUES('order.service_corrected','order_item',v_id,auth.uid(),
  jsonb_build_object('reason',btrim(p_reason),'order_id',p_order_id,
   'vehicle_id',p_vehicle_id,'previous',v_original,'after',to_jsonb(v_item),
   'price_unchanged',true,'payments_unchanged',true,'stock_unchanged',true,
   'cashea_unchanged',true,'followup_id',v_followup));
 RETURN jsonb_build_object('ok',true,'created_service',v_created,'item_id',v_id,
   'followup_id',v_followup,'cashea_and_payments_unchanged',true);
END $$;
CREATE OR REPLACE FUNCTION public.correct_closed_oil_service(
 p_order_id uuid,p_service_item_id uuid,p_vehicle_id uuid,p_odometer integer,
 p_oil_brand text,p_oil_viscosity text,p_oil_liters numeric,p_filter_code text,
 p_next_service_odometer integer,p_next_service_date date,p_reason text
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$ SELECT lubricenter_private.correct_closed_oil_service(
 p_order_id,p_service_item_id,p_vehicle_id,p_odometer,p_oil_brand,
 p_oil_viscosity,p_oil_liters,p_filter_code,p_next_service_odometer,
 p_next_service_date,p_reason) $$;
REVOKE ALL ON FUNCTION public.correct_closed_oil_service(uuid,uuid,uuid,integer,text,text,numeric,text,integer,date,text)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.correct_closed_oil_service(uuid,uuid,uuid,integer,text,text,numeric,text,integer,date,text)
 TO authenticated;
REVOKE ALL ON FUNCTION lubricenter_private.correct_closed_oil_service(uuid,uuid,uuid,integer,text,text,numeric,text,integer,date,text)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION lubricenter_private.correct_closed_oil_service(uuid,uuid,uuid,integer,text,text,numeric,text,integer,date,text)
 TO authenticated;

-- CRM followups are per beneficiary vehicle, not per Cashea payment/order.
-- Preserve the old records, including POST_SERVICE SENT records.
ALTER TABLE public.customer_followups
 DROP CONSTRAINT IF EXISTS customer_followups_order_id_followup_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS customer_followups_order_vehicle_type_unique
 ON public.customer_followups(order_id,followup_type,vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_followups_order_type_no_vehicle_unique
 ON public.customer_followups(order_id,followup_type) WHERE vehicle_id IS NULL;

CREATE OR REPLACE FUNCTION public.build_post_service_message_for_vehicle(
 p_order_id uuid,p_vehicle_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
 v_o public.orders%rowtype;v_v public.vehicles%rowtype;
 v_item public.order_items%rowtype;v_name text;v_body text;v_due text;
 v_is_single boolean;v_date text;
BEGIN
 SELECT * INTO v_o FROM public.orders WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Orden no encontrada'; END IF;
 SELECT * INTO v_v FROM public.vehicles WHERE id=p_vehicle_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Vehículo no encontrado'; END IF;
 -- Existing single-vehicle orders preserve the established customized template.
 SELECT count(distinct coalesce(oi.service_vehicle_id,v_o.vehicle_id))<=1
 INTO v_is_single FROM public.order_items oi
 WHERE oi.order_id=p_order_id AND oi.item_type='SERVICE';
 IF v_is_single AND v_o.vehicle_id=p_vehicle_id THEN
    RETURN public.build_post_service_message(p_order_id);
 END IF;
 SELECT coalesce(nullif(btrim(c.name),''),'cliente') INTO v_name FROM public.customers c
 WHERE c.id=coalesce(v_v.customer_id,v_o.customer_id);
 SELECT * INTO v_item FROM public.order_items oi
 WHERE oi.order_id=p_order_id AND oi.item_type='SERVICE'
  AND oi.business_area='OIL_CHANGE'
  AND coalesce(oi.service_vehicle_id,v_o.vehicle_id)=p_vehicle_id
 ORDER BY oi.created_at DESC,oi.id DESC LIMIT 1;
 v_body:='Hola *'||coalesce(v_name,'cliente')||'* 👋'||chr(10)||chr(10)
  ||'Gracias por confiar en *Lubricenter*.'||chr(10)
  ||'🚘 *Vehículo:* '||btrim(concat_ws(' ',v_v.make,v_v.model))
  ||coalesce(' · '||nullif(v_v.plate,''),'');
 IF v_item.id IS NOT NULL THEN
   v_body:=v_body||chr(10)||chr(10)||'🛢️ *Cambio de aceite realizado*'
    ||chr(10)||'• Aceite: '||coalesce(nullif(btrim(concat_ws(' ',v_item.oil_brand,v_item.oil_viscosity)),''),'registrado')
    ||case when v_item.oil_filter_code IS NOT NULL then chr(10)||'• Filtro: '||v_item.oil_filter_code else '' end
    ||case when v_item.service_odometer IS NOT NULL then chr(10)||'• Kilometraje: '||v_item.service_odometer||' km' else '' end;
   v_due:=concat_ws(' o ',
     case when v_item.next_service_odometer IS NOT NULL then v_item.next_service_odometer||' km' end,
     case when v_item.next_service_date IS NOT NULL then to_char(v_item.next_service_date,'DD/MM/YYYY') end);
   IF v_due<>'' THEN v_body:=v_body||chr(10)||chr(10)||'📅 *Próximo mantenimiento:* '||v_due; END IF;
 ELSE
   v_body:=v_body||chr(10)||chr(10)||'🔧 *Servicio realizado*';
 END IF;
 RETURN v_body||chr(10)||chr(10)||'💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.'||chr(10)||'*Lubricenter*';
END $$;
REVOKE ALL ON FUNCTION public.build_post_service_message_for_vehicle(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.build_post_service_message_for_vehicle(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.upsert_vehicle_crm(
 p_order_id uuid,p_vehicle_id uuid,p_is_correction boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_o public.orders%rowtype;v_owner uuid;v_type text:='POST_SERVICE';
 v_last text;v_text text;v_start date;v_saved uuid;
BEGIN
 SELECT * INTO v_o FROM public.orders WHERE id=p_order_id;
 IF NOT FOUND OR v_o.status<>'CLOSED' THEN RAISE EXCEPTION 'El CRM requiere una venta cerrada'; END IF;
 SELECT coalesce(v.customer_id,v_o.customer_id) INTO v_owner
 FROM public.vehicles v WHERE v.id=p_vehicle_id;
 IF v_owner IS NULL THEN RAISE EXCEPTION 'Vehículo sin propietario: completa el CRM antes de continuar'; END IF;
 IF p_is_correction AND EXISTS(
   SELECT 1 FROM public.customer_followups f WHERE f.order_id=p_order_id
    AND f.vehicle_id=p_vehicle_id AND f.followup_type='POST_SERVICE' AND f.status='SENT'
 ) THEN v_type:='POST_SERVICE_CORRECTION'; END IF;
 v_text:=public.build_post_service_message_for_vehicle(p_order_id,p_vehicle_id);
 IF v_type='POST_SERVICE_CORRECTION' THEN
  v_text:='📝 *Corrección del historial de mantenimiento*'||chr(10)||chr(10)||v_text;
 END IF;
 SELECT coalesce((s.value #>> '{}')::date,date '2026-09-10') INTO v_start
 FROM public.app_settings s WHERE s.key='crm_operational_start_date';
 v_start:=coalesce(v_start,date '2026-09-10');
 INSERT INTO public.customer_followups(
   order_id,customer_id,vehicle_id,followup_type,channel,status,message,sent_at
 ) VALUES (
   p_order_id,v_owner,p_vehicle_id,v_type,'WHATSAPP',
   case when p_is_correction OR (coalesce(v_o.closed_at,v_o.created_at) AT TIME ZONE 'America/Caracas')::date>=v_start
        then 'PENDING' else 'SENT' end,
   v_text,
   case when not p_is_correction AND (coalesce(v_o.closed_at,v_o.created_at) AT TIME ZONE 'America/Caracas')::date<v_start
       then coalesce(v_o.closed_at,now()) else null end
 )
 ON CONFLICT(order_id,followup_type,vehicle_id) WHERE vehicle_id IS NOT NULL
 DO UPDATE SET customer_id=excluded.customer_id,message=excluded.message,
 status=excluded.status,sent_at=excluded.sent_at,snoozed_until=null,updated_at=now()
 WHERE public.customer_followups.status<>'SENT'
 RETURNING id INTO v_saved;
 RETURN coalesce(v_saved,(select f.id from public.customer_followups f
  where f.order_id=p_order_id AND f.vehicle_id=p_vehicle_id AND f.followup_type=v_type));
END $$;
REVOKE ALL ON FUNCTION lubricenter_private.upsert_vehicle_crm(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;

-- Service history and odometers from each oil service's own vehicle.
CREATE OR REPLACE FUNCTION public.capture_service_records_on_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE rec record; v_next record;
BEGIN
 IF new.status='CLOSED' AND old.status IS DISTINCT FROM 'CLOSED' THEN
  INSERT INTO public.service_records(
    order_id,order_item_id,customer_id,vehicle_id,service_type,description,odometer,
    oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,
    next_service_odometer,next_service_date,charged_ref_amount,charged_ves_amount,
    performed_at,created_by
  )
  SELECT new.id,oi.id,coalesce(v.customer_id,new.customer_id),v.id,
   CASE WHEN oi.business_area in('OIL_CHANGE','WORKSHOP','ELECTROAUTO')
        THEN oi.business_area ELSE 'OTHER' END,
   oi.description,coalesce(oi.service_odometer,v.current_odometer),
   oi.oil_brand,oi.oil_viscosity,oi.oil_quantity_liters,oi.oil_filter_code,
   oi.next_service_odometer,oi.next_service_date,oi.charged_ref_amount,
   oi.charged_ves_amount,coalesce(new.closed_at,now()),new.created_by
  FROM public.order_items oi
  JOIN public.vehicles v ON v.id=coalesce(oi.service_vehicle_id,new.vehicle_id)
  WHERE oi.order_id=new.id AND oi.item_type='SERVICE'
  ON CONFLICT(order_item_id) DO NOTHING;

  FOR rec IN SELECT DISTINCT coalesce(oi.service_vehicle_id,new.vehicle_id) AS vehicle_id
   FROM public.order_items oi
   WHERE oi.order_id=new.id AND oi.item_type='SERVICE' AND
     coalesce(oi.service_vehicle_id,new.vehicle_id) IS NOT NULL
  LOOP
   UPDATE public.vehicles v SET
    current_odometer=greatest(coalesce(v.current_odometer,0),
     coalesce((SELECT max(i.service_odometer) FROM public.order_items i
       WHERE i.order_id=new.id AND i.item_type='SERVICE'
         AND coalesce(i.service_vehicle_id,new.vehicle_id)=rec.vehicle_id
         AND i.service_odometer IS NOT NULL),0)),
    updated_at=now()
   WHERE v.id=rec.vehicle_id AND EXISTS(
     SELECT 1 FROM public.order_items i WHERE i.order_id=new.id
       AND i.item_type='SERVICE' AND coalesce(i.service_vehicle_id,new.vehicle_id)=rec.vehicle_id
       AND i.service_odometer IS NOT NULL);
   SELECT i.next_service_odometer,i.next_service_date INTO v_next
   FROM public.order_items i WHERE i.order_id=new.id AND i.item_type='SERVICE'
     AND i.business_area='OIL_CHANGE'
     AND coalesce(i.service_vehicle_id,new.vehicle_id)=rec.vehicle_id
   ORDER BY i.created_at DESC,i.id DESC LIMIT 1;
   INSERT INTO public.integration_events(event_type,aggregate_type,aggregate_id,payload)
   VALUES('vehicle.service_history_updated','vehicle',rec.vehicle_id,
     jsonb_build_object('order_id',new.id,'order_number',new.order_number,
       'customer_id',new.customer_id,'vehicle_id',rec.vehicle_id,
       'next_service_odometer',v_next.next_service_odometer,
       'next_service_date',v_next.next_service_date,
       'has_oil_change',v_next.next_service_odometer is not null OR v_next.next_service_date is not null));
   v_next:=null;
  END LOOP;
 END IF;
 RETURN new;
END $$;

CREATE OR REPLACE FUNCTION public.queue_post_service_followup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE rec record;v_has_services boolean;
BEGIN
 IF new.status='CLOSED' AND old.status IS DISTINCT FROM 'CLOSED' AND new.customer_id IS NOT NULL THEN
  v_has_services:=false;
  FOR rec IN
   SELECT DISTINCT coalesce(i.service_vehicle_id,new.vehicle_id) vehicle_id
   FROM public.order_items i WHERE i.order_id=new.id AND i.item_type='SERVICE'
      AND coalesce(i.service_vehicle_id,new.vehicle_id) IS NOT NULL
  LOOP
   v_has_services:=true;
   PERFORM lubricenter_private.upsert_vehicle_crm(new.id,rec.vehicle_id,false);
  END LOOP;
  -- Legacy product-only orders still receive one generic message.
  IF NOT v_has_services THEN
   INSERT INTO public.customer_followups(
    order_id,customer_id,vehicle_id,followup_type,channel,status,message,sent_at
   ) VALUES(new.id,new.customer_id,new.vehicle_id,'POST_SERVICE','WHATSAPP',
    'PENDING',public.build_post_service_message(new.id),null)
   ON CONFLICT(order_id,followup_type,vehicle_id) WHERE vehicle_id IS NOT NULL
   DO NOTHING;
  END IF;
 END IF;
 RETURN new;
END $$;

-- Repair the manual CRM workflow so a commercial commitment can exist before
-- the beneficiary or vehicle is known. This migration never writes payments,
-- orders, tenders, Cashea sales, inventory or account movements.
ALTER TABLE public.crm_manual_cases ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE public.crm_manual_cases ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE public.crm_manual_cases ADD COLUMN subject_hint text;
ALTER TABLE public.crm_manual_cases ADD CONSTRAINT crm_manual_cases_completed_subject_check
  CHECK (status <> 'COMPLETED' OR (customer_id IS NOT NULL AND vehicle_id IS NOT NULL));
ALTER TABLE public.crm_manual_cases ADD CONSTRAINT crm_manual_cases_pending_identity_check
  CHECK (customer_id IS NOT NULL OR vehicle_id IS NOT NULL OR length(btrim(coalesce(subject_hint, notes, ''))) >= 3);
CREATE INDEX crm_manual_cases_customer_idx ON public.crm_manual_cases(customer_id,created_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION lubricenter_private.crm_manual_case_save(
 p_case_id uuid, p_payload jsonb, p_expected_version integer DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_case public.crm_manual_cases%rowtype; v_old jsonb;
 v_vehicle public.vehicles%rowtype;v_order public.orders%rowtype;
 v_vehicle_id uuid;v_customer_id uuid;v_payer uuid;v_linked uuid;v_context text;v_note text;
 v_scheduled timestamptz;v_followup date;v_notes text;v_subject_hint text;v_request uuid;
 v_today date:=(now() at time zone 'America/Caracas')::date;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Datos del CRM inválidos'; END IF;
 v_vehicle_id:=NULLIF(p_payload->>'vehicle_id','')::uuid;
 v_customer_id:=NULLIF(p_payload->>'customer_id','')::uuid;
 v_linked:=NULLIF(p_payload->>'linked_order_id','')::uuid;
 v_payer:=NULLIF(p_payload->>'payer_customer_id','')::uuid;
 v_context:=COALESCE(NULLIF(p_payload->>'payment_context',''),'UNVERIFIED');
 v_note:=NULLIF(btrim(coalesce(p_payload->>'payment_note','')),'');
 v_notes:=NULLIF(btrim(coalesce(p_payload->>'notes','')),'');
 v_subject_hint:=NULLIF(btrim(coalesce(p_payload->>'subject_hint','')),'');
 v_scheduled:=NULLIF(p_payload->>'scheduled_for','')::timestamptz;
 v_followup:=NULLIF(p_payload->>'next_contact_on','')::date;
 v_request:=NULLIF(p_payload->>'request_id','')::uuid;
 IF v_context NOT IN ('UNVERIFIED','REPORTED_EXTERNALLY','ORDER_LINKED','NO_CHARGE') THEN
  RAISE EXCEPTION 'Origen de pago inválido';
 END IF;
 IF v_vehicle_id IS NOT NULL THEN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id=v_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehículo no encontrado'; END IF;
  IF v_vehicle.customer_id IS NULL THEN RAISE EXCEPTION 'Asigna un propietario al vehículo antes de usarlo en este pendiente'; END IF;
  IF v_customer_id IS NOT NULL AND v_customer_id IS DISTINCT FROM v_vehicle.customer_id THEN
   RAISE EXCEPTION 'El vehículo no pertenece al cliente seleccionado';
  END IF;
  v_customer_id:=v_vehicle.customer_id;
 ELSIF v_customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE id=v_customer_id) THEN
  RAISE EXCEPTION 'Cliente no encontrado';
 END IF;
 IF v_customer_id IS NULL AND length(coalesce(v_subject_hint,v_notes,''))<3 THEN
  RAISE EXCEPTION 'Escribe una referencia para reconocer este compromiso cuando llegue el cliente';
 END IF;
 IF length(coalesce(v_subject_hint,''))>250 OR length(coalesce(v_notes,''))>1500 OR length(coalesce(v_note,''))>450 THEN
  RAISE EXCEPTION 'La referencia o las notas son demasiado extensas';
 END IF;
 IF v_scheduled IS NOT NULL AND (v_scheduled<now()-interval '2 years' OR v_scheduled>now()+interval '3 years') THEN
  RAISE EXCEPTION 'Fecha programada fuera del intervalo permitido';
 END IF;
 IF v_followup IS NOT NULL AND (v_followup<v_today-interval '2 years' OR v_followup>v_today+interval '3 years') THEN
  RAISE EXCEPTION 'Fecha de contacto fuera del intervalo permitido';
 END IF;
 IF v_context='REPORTED_EXTERNALLY' AND length(coalesce(v_note,''))<8 THEN
  RAISE EXCEPTION 'Describe dónde se reportó el pago, sin generar un ingreso nuevo';
 END IF;
 IF v_context='ORDER_LINKED' AND v_linked IS NULL THEN
  RAISE EXCEPTION 'Selecciona la orden que contiene el pago registrado';
 END IF;
 IF v_linked IS NOT NULL THEN
  SELECT * INTO v_order FROM public.orders WHERE id=v_linked;
  IF NOT FOUND OR v_order.status<>'CLOSED' THEN RAISE EXCEPTION 'La orden vinculada debe existir y estar cerrada'; END IF;
  IF v_order.customer_id IS NULL THEN RAISE EXCEPTION 'La orden vinculada necesita pagador identificado'; END IF;
  IF v_payer IS NOT NULL AND v_payer IS DISTINCT FROM v_order.customer_id THEN
   RAISE EXCEPTION 'El pagador debe coincidir con el cliente de la orden anterior';
  END IF;
  v_payer:=v_order.customer_id;
 END IF;
 IF v_payer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id=v_payer) THEN
  RAISE EXCEPTION 'Pagador no encontrado';
 END IF;
 IF p_case_id IS NULL THEN
  IF v_request IS NULL THEN RAISE EXCEPTION 'Identificador de solicitud requerido'; END IF;
  SELECT id INTO p_case_id FROM public.crm_manual_cases WHERE request_id=v_request;
  IF FOUND THEN RETURN p_case_id; END IF;
  INSERT INTO public.crm_manual_cases(
   request_id,vehicle_id,customer_id,payer_customer_id,linked_order_id,payment_context,
   payment_note,status,scheduled_for,next_contact_on,notes,subject_hint,created_by,updated_by)
  VALUES(v_request,v_vehicle_id,v_customer_id,v_payer,v_linked,v_context,v_note,
   CASE WHEN v_scheduled IS NULL THEN 'PENDING_SERVICE' ELSE 'SCHEDULED' END,
   v_scheduled,v_followup,v_notes,v_subject_hint,auth.uid(),auth.uid()) RETURNING id INTO p_case_id;
  INSERT INTO public.crm_manual_case_events(case_id,event_type,after_data,actor_id)
  SELECT id,'CREATED',to_jsonb(c),auth.uid() FROM public.crm_manual_cases c WHERE id=p_case_id;
  RETURN p_case_id;
 END IF;
 SELECT * INTO v_case FROM public.crm_manual_cases WHERE id=p_case_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ficha de CRM manual no encontrada'; END IF;
 IF v_case.status IN('COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'No puedes cambiar una ficha realizada o anulada: conserva el historial'; END IF;
 IF p_expected_version IS DISTINCT FROM v_case.version THEN RAISE EXCEPTION 'Otro usuario modificó la ficha. Recarga antes de guardar'; END IF;
 v_old:=to_jsonb(v_case);
 UPDATE public.crm_manual_cases c SET
  vehicle_id=v_vehicle_id,customer_id=v_customer_id,payer_customer_id=v_payer,
  linked_order_id=v_linked,payment_context=v_context,payment_note=v_note,
  status=CASE WHEN v_scheduled IS NULL THEN 'PENDING_SERVICE' ELSE 'SCHEDULED' END,
  scheduled_for=v_scheduled,next_contact_on=v_followup,notes=v_notes,subject_hint=v_subject_hint,
  updated_by=auth.uid(),updated_at=now(),version=c.version+1
 WHERE id=p_case_id;
 INSERT INTO public.crm_manual_case_events(case_id,event_type,before_data,after_data,actor_id)
 SELECT c.id,'UPDATED',v_old,to_jsonb(c),auth.uid() FROM public.crm_manual_cases c WHERE c.id=p_case_id;
 RETURN p_case_id;
END; $$;

CREATE OR REPLACE FUNCTION lubricenter_private.crm_manual_case_transition(
 p_case_id uuid,p_action text,p_expected_version integer,p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE c public.crm_manual_cases%rowtype; v_old jsonb;v_order public.orders%rowtype;
 v_km integer;v_oil text;v_vis text;v_filter text;v_liters numeric;v_next_km integer;
 v_next_date date;v_at timestamptz;v_sr uuid;v_message text;v_customer text;
 v_plate text;v_reason text;v_contact_permission text;v_vehicle_owner uuid;
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_action NOT IN ('COMPLETE','CANCEL','MARK_CONTACT_SENT') THEN RAISE EXCEPTION 'Acción CRM inválida'; END IF;
 SELECT * INTO c FROM public.crm_manual_cases WHERE id=p_case_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ficha CRM no encontrada'; END IF;
 IF p_action='COMPLETE' AND c.status='COMPLETED' THEN
  RETURN jsonb_build_object('id',c.id,'service_record_id',c.service_record_id,'already_completed',true);
 END IF;
 IF p_expected_version IS DISTINCT FROM c.version THEN RAISE EXCEPTION 'La ficha cambió; recarga antes de continuar'; END IF;
 v_old:=to_jsonb(c);
 v_reason:=NULLIF(btrim(coalesce(p_payload->>'reason','')),'');
 IF p_action='CANCEL' THEN
  IF c.status IN('COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'No se puede anular un servicio ya realizado o anulado'; END IF;
  IF length(coalesce(v_reason,''))<8 THEN RAISE EXCEPTION 'Explica por qué se anula el pendiente'; END IF;
  UPDATE public.crm_manual_cases SET status='CANCELLED',updated_by=auth.uid(),updated_at=now(),version=version+1 WHERE id=c.id;
  INSERT INTO public.crm_manual_case_events(case_id,event_type,before_data,after_data,reason,actor_id)
  SELECT id,'CANCELLED',v_old,to_jsonb(x),v_reason,auth.uid() FROM public.crm_manual_cases x WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'status','CANCELLED');
 END IF;
 IF p_action='MARK_CONTACT_SENT' THEN
  IF c.status='CANCELLED' THEN RAISE EXCEPTION 'No se contacta desde una ficha anulada'; END IF;
  IF c.customer_id IS NULL THEN RAISE EXCEPTION 'Asigna al cliente antes de registrar un contacto'; END IF;
  IF c.crm_message_sent_at IS NOT NULL THEN RETURN jsonb_build_object('id',c.id,'already_sent',true); END IF;
  SELECT status INTO v_contact_permission FROM public.crm_contact_permissions WHERE customer_id=c.customer_id;
  IF v_contact_permission IS DISTINCT FROM 'OPT_IN' THEN RAISE EXCEPTION 'Comprueba autorización de contacto del propietario antes de registrar envío'; END IF;
  v_message:=NULLIF(btrim(coalesce(p_payload->>'message','')),'');
  IF length(coalesce(v_message,''))<20 OR length(v_message)>1800 THEN RAISE EXCEPTION 'Registra el texto real enviado por WhatsApp (20 a 1800 caracteres)'; END IF;
  UPDATE public.crm_manual_cases SET crm_message=v_message,crm_message_sent_at=now(),updated_by=auth.uid(),updated_at=now(),version=version+1 WHERE id=c.id;
  INSERT INTO public.crm_manual_case_events(case_id,event_type,before_data,after_data,actor_id)
  SELECT id,'CONTACT_SENT',v_old,to_jsonb(x),auth.uid() FROM public.crm_manual_cases x WHERE id=c.id;
  RETURN jsonb_build_object('id',c.id,'status',c.status,'contact_sent',true);
 END IF;
 IF c.status NOT IN('PENDING_SERVICE','SCHEDULED') THEN RAISE EXCEPTION 'Este servicio no está pendiente'; END IF;
 IF c.customer_id IS NULL OR c.vehicle_id IS NULL THEN RAISE EXCEPTION 'Asigna o registra el cliente y el vehículo antes de confirmar el servicio'; END IF;
 SELECT customer_id INTO v_vehicle_owner FROM public.vehicles WHERE id=c.vehicle_id FOR SHARE;
 IF NOT FOUND OR v_vehicle_owner IS DISTINCT FROM c.customer_id THEN RAISE EXCEPTION 'El vehículo ya no está asociado al cliente de esta ficha; corrige la asignación'; END IF;
 v_km:=NULLIF(p_payload->>'odometer','')::integer;
 v_oil:=NULLIF(btrim(coalesce(p_payload->>'oil_brand','')),'');
 v_vis:=NULLIF(btrim(coalesce(p_payload->>'oil_viscosity','')),'');
 v_filter:=NULLIF(btrim(coalesce(p_payload->>'oil_filter_code','')),'');
 v_liters:=NULLIF(p_payload->>'oil_quantity_liters','')::numeric;
 v_next_km:=NULLIF(p_payload->>'next_service_odometer','')::integer;
 v_next_date:=NULLIF(p_payload->>'next_service_date','')::date;
 v_at:=COALESCE(NULLIF(p_payload->>'performed_at','')::timestamptz,now());
 IF v_km IS NULL OR v_km<0 OR v_km>9999999 THEN RAISE EXCEPTION 'Kilometraje del servicio inválido'; END IF;
 IF length(coalesce(v_oil,''))<2 OR length(v_oil)>150 THEN RAISE EXCEPTION 'Aceite utilizado requerido'; END IF;
 IF v_liters IS NOT NULL AND (v_liters<=0 OR v_liters>100 OR v_liters::text='NaN') THEN RAISE EXCEPTION 'Litros inválidos'; END IF;
 IF length(coalesce(v_vis,''))>80 OR length(coalesce(v_filter,''))>100 THEN RAISE EXCEPTION 'Datos de aceite/filtro demasiado largos'; END IF;
 IF v_next_km IS NULL AND v_next_date IS NULL THEN RAISE EXCEPTION 'Indica el próximo mantenimiento'; END IF;
 IF v_next_km IS NOT NULL AND (v_next_km<=v_km OR v_next_km>9999999) THEN RAISE EXCEPTION 'Próximo kilometraje inválido'; END IF;
 IF v_at>now()+interval '5 minutes' OR v_at<now()-interval '3 years' THEN RAISE EXCEPTION 'Fecha real del servicio inválida'; END IF;
 IF c.linked_order_id IS NOT NULL THEN
  SELECT * INTO v_order FROM public.orders WHERE id=c.linked_order_id FOR SHARE;
  IF NOT FOUND OR v_order.status<>'CLOSED' THEN RAISE EXCEPTION 'La orden vinculada ya no está cerrada'; END IF;
  IF EXISTS (SELECT 1 FROM public.service_records sr WHERE sr.order_id=c.linked_order_id AND sr.vehicle_id=c.vehicle_id
   AND sr.service_type='OIL_CHANGE' AND abs(extract(epoch FROM (sr.performed_at-v_at)))<86400)
  THEN RAISE EXCEPTION 'Este vehículo ya tiene un cambio de aceite de esa orden y fecha. Revisa el historial antes de duplicarlo'; END IF;
 END IF;
 INSERT INTO public.service_records(order_id,order_item_id,customer_id,vehicle_id,service_type,description,
  odometer,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,next_service_odometer,next_service_date,
  charged_ref_amount,charged_ves_amount,performed_at,created_by,source_system,source_key,service_notes,source_payload)
 VALUES(c.linked_order_id,NULL,c.customer_id,c.vehicle_id,'OIL_CHANGE','Cambio de aceite registrado en CRM manual',
  v_km,v_oil,v_vis,v_liters,v_filter,v_next_km,v_next_date,0,0,v_at,auth.uid(),'LUBRICENTER_CRM_MANUAL',
  c.id::text,c.notes,jsonb_build_object('crm_manual_case_id',c.id,'commercial_order_linked_for_reference_only',c.linked_order_id))
 RETURNING id INTO v_sr;
 UPDATE public.vehicles SET current_odometer=greatest(coalesce(current_odometer,0),v_km),updated_at=now() WHERE id=c.vehicle_id;
 SELECT coalesce(nullif(btrim(name),''),'cliente') INTO v_customer FROM public.customers WHERE id=c.customer_id;
 SELECT coalesce(nullif(btrim(concat_ws(' ',v.make,v.model)),''),'Vehículo')||coalesce(' · '||nullif(v.plate,''),'')
  INTO v_plate FROM public.vehicles v WHERE v.id=c.vehicle_id;
 v_message:='Hola *'||v_customer||'* 👋'||chr(10)||'Registramos el mantenimiento de tu vehículo *'||v_plate||'*.'||chr(10)||
  '🛢️ Aceite: '||v_oil||coalesce(' · '||v_vis,'')||chr(10)||'Kilometraje: '||v_km||' km.'||chr(10)||
  '📅 Próximo servicio: '||concat_ws(' o ',CASE WHEN v_next_km IS NOT NULL THEN v_next_km||' km' END,
  CASE WHEN v_next_date IS NOT NULL THEN to_char(v_next_date,'DD/MM/YYYY') END)||chr(10)||'*Lubricenter*';
 UPDATE public.crm_manual_cases SET status='COMPLETED',service_record_id=v_sr,crm_message=v_message,
  crm_message_sent_at=NULL,updated_by=auth.uid(),updated_at=now(),version=version+1 WHERE id=c.id;
 INSERT INTO public.crm_manual_case_events(case_id,event_type,before_data,after_data,actor_id)
 SELECT id,'COMPLETED',v_old,to_jsonb(x),auth.uid() FROM public.crm_manual_cases x WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'status','COMPLETED','service_record_id',v_sr);
END; $$;

CREATE OR REPLACE FUNCTION public.update_vehicle_profile(
 p_vehicle_id uuid,p_customer_id uuid,p_plate text DEFAULT NULL,p_make text DEFAULT NULL,
 p_model text DEFAULT NULL,p_year integer DEFAULT NULL,p_engine text DEFAULT NULL,p_current_odometer integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_before jsonb;v_plate text:=NULLIF(upper(btrim(p_plate)),'');
BEGIN
 PERFORM lubricenter_private.require_order_admin();
 IF p_customer_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.customers WHERE id=p_customer_id) THEN RAISE EXCEPTION 'Cliente no encontrado'; END IF;
 IF v_plate IS NULL AND NULLIF(btrim(p_make),'') IS NULL AND NULLIF(btrim(p_model),'') IS NULL THEN RAISE EXCEPTION 'Indica placa, marca o modelo'; END IF;
 IF p_year IS NOT NULL AND (p_year<1900 OR p_year>extract(year from (now() at time zone 'America/Caracas'))::integer+1) THEN RAISE EXCEPTION 'Año de vehículo inválido'; END IF;
 IF p_current_odometer IS NOT NULL AND (p_current_odometer<0 OR p_current_odometer>9999999) THEN RAISE EXCEPTION 'Kilometraje inválido'; END IF;
 IF v_plate IS NOT NULL AND EXISTS(SELECT 1 FROM public.vehicles WHERE upper(plate)=v_plate AND id<>p_vehicle_id) THEN RAISE EXCEPTION 'Esa placa pertenece a otro vehículo; selecciónalo para conservar su historial'; END IF;
 SELECT to_jsonb(v) INTO v_before FROM public.vehicles v WHERE id=p_vehicle_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Vehículo no encontrado'; END IF;
 UPDATE public.vehicles SET customer_id=p_customer_id,plate=v_plate,make=NULLIF(btrim(p_make),''),
  model=NULLIF(btrim(p_model),''),year=p_year,engine=NULLIF(btrim(p_engine),''),
  current_odometer=COALESCE(p_current_odometer,current_odometer),updated_at=now() WHERE id=p_vehicle_id;
 INSERT INTO public.vehicle_customer_history(vehicle_id,customer_id,source_system,first_seen_at,last_seen_at)
 VALUES(p_vehicle_id,p_customer_id,'LUBRICENTER_OS',now(),now()) ON CONFLICT(vehicle_id,customer_id,source_system)
 DO UPDATE SET last_seen_at=excluded.last_seen_at;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,actor_id,data)
 VALUES('vehicle.profile_updated','vehicle',p_vehicle_id,auth.uid(),jsonb_build_object('before',v_before,'customer_id',p_customer_id));
END; $$;

REVOKE ALL ON FUNCTION public.update_vehicle_profile(uuid,uuid,text,text,text,integer,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_vehicle_profile(uuid,uuid,text,text,text,integer,text,integer) TO authenticated;
REVOKE ALL ON FUNCTION lubricenter_private.crm_manual_case_save(uuid,jsonb,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION lubricenter_private.crm_manual_case_transition(uuid,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.crm_manual_cases,public.crm_manual_case_events TO authenticated;

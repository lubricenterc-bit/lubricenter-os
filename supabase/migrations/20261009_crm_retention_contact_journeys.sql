-- Retención CRM manual. No envía WhatsApp, ni modifica importes, órdenes, inventario o propietarios.
-- Consentimiento confirmado por el equipo y bitácora por servicio/vehículo.
CREATE TABLE IF NOT EXISTS public.crm_contact_permissions (
  customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('OPT_IN','OPT_OUT')),
  evidence text NOT NULL DEFAULT '',
  recorded_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.crm_maintenance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_record_id uuid NOT NULL REFERENCES public.service_records(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN
    ('SENT','REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','REACTIVATED')),
  stage text CHECK(stage IS NULL OR stage IN
    ('PREVENTIVE','DUE','LATE','RECOVERY','WINBACK')),
  message_text text,
  notes text,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_maintenance_events_service_at
  ON public.crm_maintenance_events(service_record_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS crm_maintenance_events_customer_at
  ON public.crm_maintenance_events(customer_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS crm_maintenance_events_vehicle_at
  ON public.crm_maintenance_events(vehicle_id,recorded_at DESC);

ALTER TABLE public.crm_contact_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_maintenance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_permissions_authenticated_read ON public.crm_contact_permissions;
CREATE POLICY crm_permissions_authenticated_read ON public.crm_contact_permissions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS crm_events_authenticated_read ON public.crm_maintenance_events;
CREATE POLICY crm_events_authenticated_read ON public.crm_maintenance_events
  FOR SELECT TO authenticated USING (true);
-- La escritura es exclusivamente a través de funciones validadas.
REVOKE INSERT, UPDATE, DELETE ON public.crm_contact_permissions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.crm_maintenance_events FROM authenticated, anon;
GRANT SELECT ON public.crm_contact_permissions,public.crm_maintenance_events TO authenticated;
REVOKE ALL ON public.crm_contact_permissions,public.crm_maintenance_events FROM anon;

CREATE OR REPLACE FUNCTION public.set_crm_contact_permission(
  p_customer_id uuid, p_status text, p_evidence text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $crm$
BEGIN
  PERFORM public.require_auth();
  IF p_status NOT IN ('OPT_IN','OPT_OUT') THEN
    RAISE EXCEPTION 'Estado de consentimiento no válido';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id=p_customer_id) THEN
    RAISE EXCEPTION 'Cliente no encontrado';
  END IF;
  IF p_status='OPT_IN' AND length(btrim(coalesce(p_evidence,'')))<8 THEN
    RAISE EXCEPTION 'Indica dónde y cómo autorizó el cliente estos recordatorios';
  END IF;
  IF length(coalesce(p_evidence,''))>400 THEN
    RAISE EXCEPTION 'La nota de consentimiento no puede superar 400 caracteres';
  END IF;
  INSERT INTO public.crm_contact_permissions(customer_id,status,evidence,recorded_by,updated_at)
  VALUES (p_customer_id,p_status,btrim(coalesce(p_evidence,'')),auth.uid(),now())
  ON CONFLICT (customer_id) DO UPDATE SET
    status=EXCLUDED.status,evidence=EXCLUDED.evidence,
    recorded_by=auth.uid(),updated_at=now();
END;
$crm$;

-- Ingreso de contacto explícito: abrir WhatsApp nunca cuenta como enviar.
-- Se evita confundir 'SENT' heredado del corte histórico con envío realmente registrado.
CREATE OR REPLACE FUNCTION public.record_crm_maintenance_activity(
  p_service_record_id uuid,
  p_event_type text,
  p_stage text DEFAULT NULL,
  p_message_text text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $crm$
DECLARE
  r record;
  v_permission text;
  v_latest uuid;
  v_count int;
  v_last timestamptz;
  v_last_customer timestamptz;
  v_stage text;
  v_days int;
  v_id uuid;
  v_today date := (now() AT TIME ZONE 'America/Caracas')::date;
BEGIN
  PERFORM public.require_auth();
  IF p_event_type NOT IN
    ('SENT','REPLIED','BOOKED','DECLINED','CLOSED_NO_REPLY','REACTIVATED') THEN
    RAISE EXCEPTION 'Acción CRM no válida';
  END IF;
  IF length(coalesce(p_message_text,''))>1800 OR length(coalesce(p_notes,''))>500 THEN
    RAISE EXCEPTION 'Mensaje o nota demasiado extensa';
  END IF;
  SELECT * INTO r FROM public.maintenance_reminders_current
    WHERE service_record_id=p_service_record_id;
  IF NOT FOUND OR r.customer_id IS NULL THEN
    RAISE EXCEPTION 'El servicio ya no es el último cambio del vehículo actual';
  END IF;
  -- Serializa los envíos de distintos carros a una misma persona.
  PERFORM pg_advisory_xact_lock(hashtextextended(r.customer_id::text, 0));
  SELECT status INTO v_permission FROM public.crm_contact_permissions
    WHERE customer_id=r.customer_id;
  SELECT sr.id INTO v_latest
    FROM public.service_records sr
    WHERE sr.vehicle_id=r.vehicle_id AND sr.service_type='OIL_CHANGE'
      AND sr.customer_id=r.customer_id
      AND NOT EXISTS (
        SELECT 1 FROM public.orders o WHERE o.id=sr.order_id AND o.status='CANCELLED'
      )
    ORDER BY sr.performed_at DESC,sr.created_at DESC,sr.id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_service_record_id THEN
    RAISE EXCEPTION 'El cliente ya tiene un cambio de aceite más reciente';
  END IF;

  IF p_event_type='REACTIVATED' THEN
    IF v_permission IS DISTINCT FROM 'OPT_IN' THEN
      RAISE EXCEPTION 'Debes comprobar la autorización de contacto antes de reactivar';
    END IF;
    IF r.reminder_status<>'SENT' OR EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id
         AND event_type IN ('REACTIVATED','SENT')
    ) THEN
      RAISE EXCEPTION 'Este registro no es un archivo histórico reactivable';
    END IF;
    PERFORM public.set_maintenance_reminder_status(p_service_record_id,'PENDING',NULL);
  ELSIF p_event_type='SENT' THEN
    IF v_permission IS DISTINCT FROM 'OPT_IN' THEN
      RAISE EXCEPTION 'No se puede contactar por WhatsApp sin autorización comprobada';
    END IF;
    IF length(btrim(coalesce(p_message_text,'')))<25 THEN
      RAISE EXCEPTION 'Guarda el texto real del mensaje antes de marcarlo enviado';
    END IF;
    IF p_stage NOT IN ('PREVENTIVE','DUE','LATE','RECOVERY','WINBACK') THEN
      RAISE EXCEPTION 'Selecciona la etapa real de seguimiento';
    END IF;
    v_days := v_today-r.next_service_date;
    v_stage := CASE
      WHEN v_days < -14 THEN 'NOT_READY'
      WHEN v_days < -4 THEN 'PREVENTIVE'
      WHEN v_days <= 7 THEN 'DUE'
      WHEN v_days <= 30 THEN 'LATE'
      WHEN v_days <= 90 THEN 'RECOVERY'
      ELSE 'WINBACK'
    END;
    IF p_stage<>v_stage THEN
      RAISE EXCEPTION 'La etapa cambió; actualiza el recordatorio antes de registrar el envío';
    END IF;
    IF r.reminder_status='SNOOZED' AND r.snoozed_until > v_today THEN
      RAISE EXCEPTION 'El contacto está pospuesto';
    END IF;
    IF r.reminder_status='SENT' AND NOT EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type='SENT'
    ) AND NOT EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type='REACTIVATED'
    ) THEN
      RAISE EXCEPTION 'El historial antiguo debe revisarse y reactivarse de forma explícita';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type IN
          ('BOOKED','REPLIED','DECLINED','CLOSED_NO_REPLY')
    ) THEN
      RAISE EXCEPTION 'El cliente ya respondió o se cerró el seguimiento';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type='SENT' AND stage=p_stage
    ) THEN
      RAISE EXCEPTION 'Ya se envió un mensaje durante esta misma etapa';
    END IF;
    SELECT count(*)::int,max(recorded_at) INTO v_count,v_last
      FROM public.crm_maintenance_events
      WHERE service_record_id=p_service_record_id AND event_type='SENT';
    IF v_count>=3 THEN
      RAISE EXCEPTION 'El máximo es de tres contactos por ciclo de mantenimiento';
    END IF;
    IF v_last IS NOT NULL AND v_last > now()-interval '10 days' THEN
      RAISE EXCEPTION 'Espera al menos diez días desde el contacto anterior';
    END IF;
    SELECT max(recorded_at) INTO v_last_customer
      FROM public.crm_maintenance_events
      WHERE customer_id=r.customer_id AND event_type='SENT';
    IF v_last_customer IS NOT NULL AND v_last_customer>now()-interval '14 days' THEN
      RAISE EXCEPTION 'Este cliente recibió otro recordatorio en los últimos catorce días';
    END IF;
  ELSE
    -- Las respuestas se registran aunque el consentimiento se haya retirado posteriormente.
    IF NOT EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type='SENT'
    ) THEN
      RAISE EXCEPTION 'Todavía no hay un contacto confirmado para este mantenimiento';
    END IF;
    IF p_event_type IN ('REPLIED','BOOKED') AND EXISTS (
      SELECT 1 FROM public.crm_maintenance_events
       WHERE service_record_id=p_service_record_id AND event_type=p_event_type
    ) THEN
      RAISE EXCEPTION 'Esta respuesta ya fue registrada';
    END IF;
  END IF;

  INSERT INTO public.crm_maintenance_events
    (service_record_id,vehicle_id,customer_id,event_type,stage,
     message_text,notes,recorded_by)
  VALUES (p_service_record_id,r.vehicle_id,r.customer_id,p_event_type,
    CASE WHEN p_event_type='SENT' THEN p_stage ELSE NULL END,
    CASE WHEN p_event_type='SENT' THEN btrim(p_message_text) ELSE NULL END,
    nullif(btrim(coalesce(p_notes,'')),''),auth.uid())
  RETURNING id INTO v_id;
  IF p_event_type='SENT' THEN
    PERFORM public.set_maintenance_reminder_status(p_service_record_id,'SENT',NULL);
  END IF;
  RETURN v_id;
END;
$crm$;

REVOKE ALL ON FUNCTION public.set_crm_contact_permission(uuid,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_crm_maintenance_activity(uuid,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_crm_contact_permission(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_crm_maintenance_activity(uuid,text,text,text,text) TO authenticated;

COMMENT ON TABLE public.crm_contact_permissions IS
 'Consentimiento verificable por cliente; desconocido si no hay registro. Bloquea campañas manuales sin autorización.';
COMMENT ON TABLE public.crm_maintenance_events IS
 'Bitácora de WhatsApp confirmados y respuestas por service_record_id/vehicle_id: 3 envíos máximo, sin automatización.';

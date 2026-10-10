-- Fix: la vista anterior ejecutaba el pronóstico estadístico repetidamente
-- cuando el optimizador insertaba los filtros de urgencia (hasta 89 segundos).
-- Este CTE MATERIALIZED calcula una sola vez los pronósticos por solicitud;
-- service_record_id está indexado y cada carro se une a su último servicio.
-- Mantiene exactamente las 31 columnas previas, su orden, nombres y tipos.
-- No cambia ningún dato financiero, kilometraje, fecha original ni acción CRM.
-- Rollback: reinstalar la definición maintenance_reminders_current de
-- supabase/migrations/20261009_vehicle_oil_usage_forecasts.sql.
CREATE OR REPLACE VIEW public.maintenance_reminders_current
WITH (security_invoker = true) AS
WITH forecast AS MATERIALIZED (
  SELECT * FROM public.vehicle_oil_usage_forecasts
),
cutoff AS (
 SELECT COALESCE((SELECT trim(both '"' from value::text)::date
 FROM public.app_settings WHERE key='crm_operational_start_date'),'2026-09-10'::date) start_date
)

SELECT
 f.service_record_id,f.vehicle_id,v.customer_id,
 c.name customer_name,c.phone customer_phone,v.plate,v.make,v.model,v.year,v.current_odometer,
 s.performed_at,s.odometer service_odometer,s.oil_brand,s.oil_viscosity,s.oil_filter_code,
 COALESCE(f.due_km,s.next_service_odometer) next_service_odometer,
 f.recommended_due_date next_service_date,
 CASE WHEN a.status IS NOT NULL THEN a.status
   WHEN f.recommended_due_date<cutoff.start_date THEN 'SENT' ELSE 'PENDING' END reminder_status,
 a.snoozed_until,
 CASE WHEN a.sent_at IS NOT NULL THEN a.sent_at
   WHEN a.status IS NULL AND f.recommended_due_date<cutoff.start_date
     THEN f.recommended_due_date::timestamptz END sent_at,
 CASE WHEN a.status='SENT' THEN 'SENT'
   WHEN a.status IS NULL AND f.recommended_due_date<cutoff.start_date THEN 'SENT'
   WHEN a.status='SNOOZED' AND a.snoozed_until>(now() AT TIME ZONE 'America/Caracas')::date THEN 'SNOOZED'
   WHEN f.recommended_due_date<=(now() AT TIME ZONE 'America/Caracas')::date THEN 'DUE'
   WHEN f.due_km IS NOT NULL AND v.current_odometer>=f.due_km THEN 'DUE'
   WHEN f.recommended_due_date<=(now() AT TIME ZONE 'America/Caracas')::date+14 THEN 'SOON'
   ELSE 'UPCOMING' END urgency,
 f.service_count,f.mileage_points,f.slope_pairs,f.km_per_day,f.days_per_5000km,
 f.typical_visit_days,f.projected_km_due_date,f.projected_habit_due_date,
 f.calendar_due_date,f.confidence forecast_confidence,f.due_reason
FROM forecast f
JOIN public.service_records s ON s.id = f.service_record_id
JOIN public.vehicles v ON v.id = f.vehicle_id AND v.customer_id = f.customer_id
JOIN public.customers c ON c.id = v.customer_id
LEFT JOIN public.maintenance_reminder_actions a ON a.service_record_id = f.service_record_id
CROSS JOIN cutoff;

COMMENT ON VIEW public.maintenance_reminders_current IS
 'Recordatorios por vehículo y fecha proyectada. El pronóstico robusto se evalúa una vez por consulta, evitando joins anidados de coste explosivo. Las acciones SENT/SNOOZED se preservan.';

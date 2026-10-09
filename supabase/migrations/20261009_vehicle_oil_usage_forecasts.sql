-- Regla por vehicle_id; los registros de otro propietario NO entrenan el modelo.
-- Robusto: estimador Theil-Sen y MAD. SIN cambios a caja, órdenes, inventario o clientes.
CREATE OR REPLACE VIEW public.vehicle_oil_usage_forecasts WITH (security_invoker=true) AS
WITH all_oil AS (
 SELECT s.id,s.vehicle_id,s.customer_id,s.performed_at,s.created_at,
        (s.performed_at AT TIME ZONE 'America/Caracas')::date AS service_day,
        s.odometer,s.next_service_date,s.next_service_odometer,
        row_number() OVER(PARTITION BY s.vehicle_id ORDER BY s.performed_at DESC,s.created_at DESC,s.id DESC) rn
 FROM public.service_records s
 JOIN public.vehicles v ON v.id=s.vehicle_id
 WHERE s.service_type='OIL_CHANGE' AND s.customer_id=v.customer_id
   AND v.customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id=s.order_id AND o.status='CANCELLED')
), recent AS (SELECT * FROM all_oil WHERE rn<=12),
dedup AS (
 SELECT DISTINCT ON(vehicle_id,service_day) vehicle_id,service_day,odometer,id,performed_at
 FROM recent ORDER BY vehicle_id,service_day,performed_at DESC,id DESC
), points AS (SELECT * FROM dedup WHERE odometer BETWEEN 100 AND 900000),
slopes AS (
 SELECT a.vehicle_id,
  ((b.odometer-a.odometer)::numeric/(b.service_day-a.service_day))::double precision rate
 FROM points a JOIN points b ON a.vehicle_id=b.vehicle_id AND b.service_day>a.service_day
 WHERE (b.service_day-a.service_day) BETWEEN 14 AND 730
   AND b.odometer>a.odometer
   AND ((b.odometer-a.odometer)::numeric/(b.service_day-a.service_day)) BETWEEN 1 AND 350
), median_slopes AS (
 SELECT vehicle_id,count(*)::int pair_count,
    percentile_cont(.5) WITHIN GROUP(ORDER BY rate) median_rate
 FROM slopes GROUP BY vehicle_id
), slope_mad AS (
 SELECT s.vehicle_id,percentile_cont(.5) WITHIN GROUP(ORDER BY abs(s.rate-m.median_rate)) mad
 FROM slopes s JOIN median_slopes m USING(vehicle_id) GROUP BY s.vehicle_id
), sequenced AS (
 SELECT d.*,lag(d.service_day) OVER(PARTITION BY d.vehicle_id ORDER BY d.service_day) previous_day,
       lag(d.odometer) OVER(PARTITION BY d.vehicle_id ORDER BY d.service_day) previous_km
 FROM dedup d
), counts AS (
 SELECT vehicle_id,count(*)::int services,
   count(*) FILTER(WHERE odometer BETWEEN 100 AND 900000)::int mileage_points,
   count(*) FILTER(WHERE previous_km BETWEEN 100 AND 900000
        AND odometer BETWEEN 100 AND 900000 AND odometer<previous_km)::int regressions
 FROM sequenced GROUP BY vehicle_id
), intervals AS (
 SELECT vehicle_id,(service_day-previous_day)::double precision days
 FROM sequenced WHERE previous_day IS NOT NULL
 AND (service_day-previous_day) BETWEEN 14 AND 540
), median_visits AS (
 SELECT vehicle_id,count(*)::int valid_intervals,
   percentile_cont(.5) WITHIN GROUP(ORDER BY days) median_days
 FROM intervals GROUP BY vehicle_id
), visit_mad AS (
 SELECT i.vehicle_id,percentile_cont(.5) WITHIN GROUP(ORDER BY abs(i.days-m.median_days)) mad
 FROM intervals i JOIN median_visits m USING(vehicle_id) GROUP BY i.vehicle_id
), features AS (
 SELECT a.id service_record_id,a.vehicle_id,a.customer_id,a.service_day,
   a.odometer last_odometer,COALESCE(a.next_service_date,a.service_day+90) calendar_due_date,
   COALESCE(c.services,0) visits,COALESCE(c.mileage_points,0) mileage_points,
   COALESCE(c.regressions,0) regressions,
   COALESCE(s.pair_count,0) pairs,s.median_rate,sm.mad slope_mad,
   COALESCE(v.valid_intervals,0) valid_intervals,v.median_days,vm.mad visit_mad,
   CASE WHEN a.odometer BETWEEN 100 AND 900000
     THEN CASE WHEN a.next_service_odometer BETWEEN a.odometer+1000 AND a.odometer+15000
       THEN LEAST(a.odometer+5000,a.next_service_odometer)
       ELSE a.odometer+5000 END END due_km
 FROM all_oil a
 LEFT JOIN counts c USING(vehicle_id)
 LEFT JOIN median_slopes s USING(vehicle_id)
 LEFT JOIN slope_mad sm USING(vehicle_id)
 LEFT JOIN median_visits v USING(vehicle_id)
 LEFT JOIN visit_mad vm USING(vehicle_id)
 WHERE a.rn=1
), quality AS (
 SELECT f.*,
  CASE
   WHEN mileage_points<2 OR pairs<1 OR regressions>0 OR last_odometer NOT BETWEEN 100 AND 900000
     OR median_rate IS NULL OR slope_mad>median_rate*.6 THEN 'INSUFFICIENT'
   WHEN mileage_points>=4 AND pairs>=6 AND slope_mad<=median_rate*.20
     AND current_date-service_day<=240 THEN 'HIGH'
   WHEN mileage_points>=3 AND pairs>=3 AND slope_mad<=median_rate*.40
     AND current_date-service_day<=360 THEN 'MEDIUM'
   ELSE 'LOW' END confidence,
  CASE WHEN visits>=3 AND valid_intervals>=2 AND median_days BETWEEN 28 AND 365
     AND visit_mad<=median_days*.35 THEN round(median_days)::int END habitual_days
 FROM features f
), predictions AS (
 SELECT q.*,
 CASE WHEN confidence<>'INSUFFICIENT' AND due_km IS NOT NULL
   AND ceil((due_km-last_odometer)/median_rate) BETWEEN 14 AND 540
   THEN service_day+ceil((due_km-last_odometer)/median_rate)::int END km_due_date,
 CASE WHEN habitual_days IS NOT NULL THEN service_day+habitual_days END habitual_due_date
 FROM quality q
)
SELECT p.service_record_id,p.vehicle_id,p.customer_id,p.service_day AS last_service_date,
 p.last_odometer,p.due_km,p.calendar_due_date,p.visits service_count,
 p.mileage_points,p.pairs slope_pairs,p.regressions odometer_regressions,
 CASE WHEN confidence<>'INSUFFICIENT' THEN round(median_rate::numeric,1) END km_per_day,
 CASE WHEN confidence<>'INSUFFICIENT' THEN round((5000/median_rate)::numeric)::int END days_per_5000km,
 CASE WHEN median_days IS NOT NULL THEN round(median_days::numeric)::int END typical_visit_days,
 p.km_due_date projected_km_due_date,p.habitual_due_date projected_habit_due_date,
 LEAST(p.calendar_due_date,p.km_due_date,p.habitual_due_date) recommended_due_date,
 p.confidence,
 CASE WHEN p.km_due_date IS NOT NULL AND p.km_due_date<=p.calendar_due_date
           AND (p.habitual_due_date IS NULL OR p.km_due_date<=p.habitual_due_date) THEN 'KM_USAGE'
      WHEN p.habitual_due_date IS NOT NULL AND p.habitual_due_date<=p.calendar_due_date THEN 'VISIT_PATTERN'
      ELSE 'CALENDAR_LIMIT' END due_reason
FROM predictions p;

-- Mantiene las columnas originales y añade métricas descriptivas al final.
CREATE OR REPLACE VIEW public.maintenance_reminders_current WITH (security_invoker=true) AS
WITH recent_service AS (
 SELECT DISTINCT ON(s.vehicle_id) s.id service_record_id,s.vehicle_id,s.customer_id,
  s.performed_at,s.odometer,s.oil_brand,s.oil_viscosity,s.oil_filter_code,
  s.next_service_odometer,s.next_service_date
 FROM public.service_records s JOIN public.vehicles v ON v.id=s.vehicle_id
 WHERE s.service_type='OIL_CHANGE' AND s.customer_id=v.customer_id
  AND v.customer_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=s.order_id AND o.status='CANCELLED')
 ORDER BY s.vehicle_id,s.performed_at DESC,s.created_at DESC,s.id DESC
), cutoff AS (
 SELECT COALESCE((SELECT trim(both '"' from value::text)::date
 FROM public.app_settings WHERE key='crm_operational_start_date'),'2026-09-10'::date) start_date
)
SELECT
 s.service_record_id,s.vehicle_id,v.customer_id,
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
FROM recent_service s
JOIN public.vehicles v ON v.id=s.vehicle_id
JOIN public.customers c ON c.id=v.customer_id
JOIN public.vehicle_oil_usage_forecasts f ON f.service_record_id=s.service_record_id
LEFT JOIN public.maintenance_reminder_actions a ON a.service_record_id=s.service_record_id
CROSS JOIN cutoff;

COMMENT ON VIEW public.vehicle_oil_usage_forecasts IS
 'Regresión robusta Theil-Sen y MAD: pronóstico no contable por vehículo y dueño actual; evita mezclar conductores.';
COMMENT ON VIEW public.maintenance_reminders_current IS
 'Recordatorios por vehículo: km estimados, periodicidad histórica estable y fecha límite, con estados existentes.';

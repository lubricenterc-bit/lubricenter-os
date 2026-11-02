-- Rendimiento: pronóstico de cambio de aceite (vehicle_oil_usage_forecasts).
--
-- Postgres estimaba 1 fila para cada CTE de agregados por vehículo y los
-- volvía a calcular por cada vehículo (bucle anidado): ~316 ms con 371
-- vehículos, y crece al cuadrado. maintenance_reminders_current lo lee, e
-- Inicio (dashboard_overview) lee esa vista dos veces: ~640 ms por carga.
--
-- Marcar esos CTE como MATERIALIZED obliga a calcularlos una sola vez.
-- Mismo texto de la vista, mismas columnas, mismo resultado (verificado con
-- md5 de todas las filas antes y después): 316 ms -> 35 ms.
--
-- Idempotente: si ya están materializados, el reemplazo no cambia nada.

do $$
declare
  d text := pg_get_viewdef('public.vehicle_oil_usage_forecasts'::regclass);
  cte text;
begin
  foreach cte in array array['median_slopes', 'slope_mad', 'counts', 'median_visits', 'visit_mad'] loop
    d := replace(d, ' ' || cte || ' AS (', ' ' || cte || ' AS MATERIALIZED (');
  end loop;
  execute 'create or replace view public.vehicle_oil_usage_forecasts with (security_invoker = true) as ' || d;
end $$;

-- Higiene: el historial de pg_cron crece sin límite (4.600 filas en dos meses).
-- Se conservan 14 días.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-cron-run-details';
    perform cron.schedule(
      'purge-cron-run-details',
      '40 4 * * *',
      $job$delete from cron.job_run_details where end_time < now() - interval '14 days'$job$
    );
  end if;
end $$;

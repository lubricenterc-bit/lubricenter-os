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
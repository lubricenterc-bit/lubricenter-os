-- Invoke the server-side Notion synchronizer every 15 minutes.
-- The URL and public invocation key live in Supabase Vault and are provisioned
-- separately, so neither value is committed to the repository.
do $block$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'notion-pricing-sync-15m'
   limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end
$block$;

select cron.schedule(
  'notion-pricing-sync-15m',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'notion_pricing_sync_url'
         limit 1
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'notion_pricing_sync_anon_key'
           limit 1
        )
      ),
      body := '{"scheduled":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);


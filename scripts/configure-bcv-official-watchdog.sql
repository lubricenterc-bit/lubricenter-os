-- Backup scheduler while n8n is unavailable, or if its scheduled run is missed.
-- 08:15, 18:15 and 20:15 America/Caracas. n8n runs 15 minutes earlier.
-- Never updates active exchange rates in observer mode; never touches Notion.
do $$begin
 if not exists(select 1 from vault.secrets where name='lubricenter_bcv_official_job_secret')
 or not exists(select 1 from vault.secrets where name='notion_pricing_sync_anon_key') then
  raise exception 'Faltan credenciales del captador oficial';
 end if;
 if not exists(select 1 from vault.secrets where name='lubricenter_bcv_official_sync_url') then
  perform vault.create_secret(
   regexp_replace((select decrypted_secret from vault.decrypted_secrets where name='notion_pricing_sync_url'),'/functions/v1/notion-pricing-sync$','/functions/v1/bcv-rate-sync'),
   'lubricenter_bcv_official_sync_url');
 end if;
 if not exists(select 1 from vault.decrypted_secrets where name='lubricenter_bcv_official_sync_url' and decrypted_secret ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/bcv-rate-sync$') then
  raise exception 'Endpoint oficial inválido';
 end if;
 perform cron.schedule('bcv-official-watchdog','15 0,12,22 * * *',$job$
  select net.http_post(
   url:=(select decrypted_secret from vault.decrypted_secrets where name='lubricenter_bcv_official_sync_url'),
   headers:=jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='notion_pricing_sync_anon_key'),
    'x-lubricenter-job',(select decrypted_secret from vault.decrypted_secrets where name='lubricenter_bcv_official_job_secret')),
   body:='{}'::jsonb,timeout_milliseconds:=45000)
  where not exists(select 1 from lubricenter_private.bcv_official_observer_state where id and last_success_at>now()-interval '30 minutes');
 $job$);
end$$;

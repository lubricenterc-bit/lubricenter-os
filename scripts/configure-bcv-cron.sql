-- Run only after the BCV collector migration and Edge Function have been tested.
-- No secrets are returned by this script or stored in Git.
do $setup$
declare endpoint text; key_present boolean;
begin
 select regexp_replace(decrypted_secret,'/functions/v1/notion-pricing-sync$','/functions/v1/bcv-rate-sync')
 into endpoint from vault.decrypted_secrets where name='notion_pricing_sync_url';
 if endpoint is null or endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/bcv-rate-sync$' then
   raise exception 'No se pudo resolver el endpoint BCV de este proyecto';
 end if;
 select exists(select 1 from vault.secrets where name='notion_pricing_sync_anon_key') into key_present;
 if not key_present or not exists(select 1 from vault.secrets where name='lubricenter_bcv_cron_secret') then
   raise exception 'Faltan credenciales del programador en Vault';
 end if;
 if not exists(select 1 from vault.secrets where name='lubricenter_bcv_sync_url') then
   perform vault.create_secret(endpoint,'lubricenter_bcv_sync_url');
 end if;
 perform cron.schedule('bcv-direct-sync-15m','*/15 * * * *',$job$
  select net.http_post(
   url:=(select decrypted_secret from vault.decrypted_secrets where name='lubricenter_bcv_sync_url'),
   headers:=jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='notion_pricing_sync_anon_key'),
    'x-lubricenter-job',(select decrypted_secret from vault.decrypted_secrets where name='lubricenter_bcv_cron_secret')),
   body:='{}'::jsonb,timeout_milliseconds:=45000
  );
 $job$);
end
$setup$;
-- Verification (read-only; never display request headers):
select jobname,schedule,active from cron.job where jobname='bcv-direct-sync-15m';
select source_key,last_verified_at,last_success_payload from public.integration_sync_state where source_key='bcv_direct';

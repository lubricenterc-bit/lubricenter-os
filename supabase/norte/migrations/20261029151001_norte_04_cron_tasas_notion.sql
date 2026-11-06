-- NOTA (repo): la clave pública (anon) que se aplicó en la base se reemplazó aquí por <NORTE_ANON_KEY>
-- para no guardar claves en el repo. Es la misma de la variable NEXT_PUBLIC_SUPABASE_ANON_KEY de norte-web.
-- Por eso el md5 de este archivo no coincide con lo aplicado; el resto del texto es idéntico.
select vault.create_secret('https://yfkotqmccrmlhxmybhps.supabase.co/functions/v1/notion-pricing-sync','notion_pricing_sync_url','URL de la función de tasas de Norte')
where not exists (select 1 from vault.secrets where name='notion_pricing_sync_url');
select vault.create_secret('<NORTE_ANON_KEY>','notion_pricing_sync_anon_key','Clave pública (anon) de Norte')
where not exists (select 1 from vault.secrets where name='notion_pricing_sync_anon_key');
select cron.schedule('notion-pricing-sync-15m','*/15 * * * *', $c$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'notion_pricing_sync_url' limit 1),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notion_pricing_sync_anon_key' limit 1)),
      body := '{"scheduled":true}'::jsonb,
      timeout_milliseconds := 120000
    );
$c$);
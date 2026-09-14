-- Server-only entrypoint for the Edge Function plus the scheduler extensions.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.sync_notion_pricing_service(
  p_bcv numeric,
  p_operative numeric,
  p_products jsonb,
  p_synced_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Esta función es exclusiva del sincronizador del servidor';
  end if;
  return lubricenter_private.apply_notion_pricing(p_bcv, p_operative, p_products, p_synced_at);
end
$function$;

revoke all on function public.sync_notion_pricing_service(numeric, numeric, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.sync_notion_pricing_service(numeric, numeric, jsonb, timestamptz)
  to service_role;


-- Native catalog and purchasing release while BOTH rates remain owned by Notion.
-- Install after catalog cutover/editing/intake, in the same transaction.
do $$begin
 if public.exchange_rate_authority()<>'NOTION' then raise exception 'Esta entrega conserva las tasas de Notion'; end if;
end$$;

create or replace view public.current_exchange_rates with (security_invoker=true) as
select
 (select value from public.exchange_rates where rate_type='BCV' and source='Notion · Tasas' and effective_at<=now() order by effective_at desc,created_at desc limit 1) bcv_rate,
 (select value from public.exchange_rates where rate_type='OPERATIVE' and source='Notion · Tasas' and effective_at<=now() order by effective_at desc,created_at desc limit 1) operative_rate;

create or replace function public.ignore_notion_exchange_rates()
returns trigger language plpgsql security invoker set search_path=''
as $$begin
 if new.source ilike 'Notion%' and public.exchange_rate_authority()='BCV_OFFICIAL' then return null;end if;
 return new;
end$$;

create or replace function public.assert_notion_pricing_fresh()
returns void language plpgsql security definer set search_path=''
as $$declare catalog_native boolean; catalog_at timestamptz; rates_at timestamptz; bcv numeric; operative numeric;
begin
 catalog_native:=exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS');
 if catalog_native then
  if not exists(select 1 from public.products where active and available and cash_usd_base_price>0) then raise exception 'No hay artículos publicados con precios válidos';end if;
 else
  select last_verified_at into catalog_at from public.integration_sync_state where source_key='notion_catalog';
  if catalog_at is null or catalog_at<now()-interval '24 hours' then raise exception 'El catálogo de Notion está desactualizado';end if;
 end if;
 select last_verified_at into rates_at from public.integration_sync_state where source_key='notion_rates';
 if rates_at is null or rates_at<now()-interval '3 hours' or rates_at>now()+interval '5 minutes' then raise exception 'Tasas de Notion desactualizadas: comprueba su sincronización';end if;
 select bcv_rate,operative_rate into bcv,operative from public.current_exchange_rates;
 if bcv is null or bcv<=0 or operative is null or operative<=0 then raise exception 'Faltan tasas BCV u operativa válidas';end if;
end$$;

create or replace function public.get_pricing_sync_status()
returns table(catalog_synced_at timestamptz,catalog_products bigint,bcv_rate numeric,bcv_effective_at timestamptz,operative_rate numeric,operative_effective_at timestamptz)
language sql stable security definer set search_path=''
as $$select
 case when exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS') then now()
 else (select last_verified_at from public.integration_sync_state where source_key='notion_catalog') end,
 (select count(*) from public.products where active and available),
 (select bcv_rate from public.current_exchange_rates),
 (select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
 (select operative_rate from public.current_exchange_rates),
 (select last_verified_at from public.integration_sync_state where source_key='notion_rates')$$;

create or replace function lubricenter_private.get_exchange_rate_control_status()
returns jsonb language plpgsql stable security definer set search_path=''
as $$begin
 if auth.uid() is null then raise exception 'Inicia sesión para ver las tasas';end if;
 return jsonb_build_object('catalog_authority',(select value #>> '{}' from public.app_settings where key='catalog_authority'),
 'catalog_version',(select max(updated_at) from public.products),'exchange_rate_authority','NOTION','bcv_provider','Notion · Tasas',
 'rates_verified_at',(select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
 'rates_fresh',coalesce((select last_verified_at between now()-interval '3 hours' and now()+interval '5 minutes' from public.integration_sync_state where source_key='notion_rates'),false),
 'bcv_active',(select bcv_rate from public.current_exchange_rates),
 'bcv_active_since',(select effective_at from public.exchange_rates where rate_type='BCV' and source='Notion · Tasas' and effective_at<=now() order by effective_at desc,created_at desc limit 1),
 'bcv_next',null,'bcv_last_fetch',null,'operative_current',(select operative_rate from public.current_exchange_rates),'operative_manual_since',null);
end$$;
create or replace function public.get_exchange_rate_control_status()
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.get_exchange_rate_control_status()$$;
revoke all on function lubricenter_private.get_exchange_rate_control_status(),public.get_exchange_rate_control_status() from public,anon;
grant execute on function lubricenter_private.get_exchange_rate_control_status(),public.get_exchange_rate_control_status() to authenticated;

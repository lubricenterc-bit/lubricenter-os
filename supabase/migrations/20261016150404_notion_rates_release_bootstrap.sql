-- Expand first: no change to products, stock, rates or the existing sync job.
insert into public.app_settings(key,value,updated_at)
values('exchange_rate_authority','"NOTION"'::jsonb,now()) on conflict(key) do nothing;

create or replace function public.exchange_rate_authority()
returns text language sql stable security invoker set search_path=''
as $$select coalesce((select value #>> '{}' from public.app_settings where key='exchange_rate_authority'),
 case when exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS') then 'BCV_OFFICIAL' else 'NOTION' end)$$;
revoke all on function public.exchange_rate_authority() from public,anon;
grant execute on function public.exchange_rate_authority() to authenticated,service_role;

create or replace function lubricenter_private.get_notion_pricing_job_state()
returns jsonb language plpgsql stable security definer set search_path=''
as $$begin
 if auth.role() is distinct from 'service_role' then raise exception 'Solo el sincronizador interno'; end if;
 return jsonb_build_object('catalog_native',exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS'),
 'rate_authority',public.exchange_rate_authority(),'rates_verified_at',(select last_verified_at from public.integration_sync_state where source_key='notion_rates'));
end$$;
create or replace function public.get_notion_pricing_job_state()
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.get_notion_pricing_job_state()$$;
revoke all on function lubricenter_private.get_notion_pricing_job_state(),public.get_notion_pricing_job_state() from public,anon,authenticated;
grant usage on schema lubricenter_private to service_role;
grant execute on function lubricenter_private.get_notion_pricing_job_state(),public.get_notion_pricing_job_state() to service_role;

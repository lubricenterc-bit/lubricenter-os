create or replace function lubricenter_private.get_exchange_rate_control_status()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'Inicia sesión para ver las tasas'; end if;
 select jsonb_build_object(
 'catalog_authority',(select value #>> '{}' from public.app_settings where key='catalog_authority'),
 'catalog_version',(select max(updated_at) from public.products),
 'exchange_rate_authority',public.exchange_rate_authority(),
 'bcv_provider','BCV oficial · captador propio',
 'bcv_active',(select er.value from public.exchange_rates er
   where er.rate_type='BCV' and er.effective_at<=now()
   and case when public.exchange_rate_authority()='BCV_OFFICIAL' then er.source='BCV_API_DATE_VALUE' else er.source is distinct from 'BCV_API_DATE_VALUE' end
   order by er.effective_at desc,er.created_at desc limit 1),
 'bcv_active_since',(select er.effective_at from public.exchange_rates er
   where er.rate_type='BCV' and er.effective_at<=now()
   and case when public.exchange_rate_authority()='BCV_OFFICIAL' then er.source='BCV_API_DATE_VALUE' else er.source is distinct from 'BCV_API_DATE_VALUE' end
   order by er.effective_at desc,er.created_at desc limit 1),
 'bcv_next',(select jsonb_build_object('value',r.usd_ves,'fecha_valor',r.value_date)
   from public.bcv_rate_publications r
   where r.value_date>(now() at time zone 'America/Caracas')::date
   order by r.value_date limit 1),
 'bcv_last_fetch',(select s.last_verified_at from public.integration_sync_state s
   where s.source_key='bcv_direct'),
 'operative_current',(select er.value from public.exchange_rates er
   where er.rate_type='OPERATIVE' and er.effective_at<=now()
   order by er.effective_at desc,er.created_at desc limit 1),
 'operative_manual_since',(select er.effective_at from public.exchange_rates er
   where er.rate_type='OPERATIVE' and er.source='LUBRICENTER_MANUAL'
   order by er.effective_at desc limit 1)
 ) into result;
 return result;
end $$;
create or replace function public.get_exchange_rate_control_status()
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.get_exchange_rate_control_status()$$;
revoke all on function lubricenter_private.get_exchange_rate_control_status() from public,anon;
grant execute on function lubricenter_private.get_exchange_rate_control_status() to authenticated;
revoke all on function public.get_exchange_rate_control_status() from public,anon;
grant execute on function public.get_exchange_rate_control_status() to authenticated;

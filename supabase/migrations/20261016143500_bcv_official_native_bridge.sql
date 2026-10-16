-- Apply after the direct-rate and observer migrations, BEFORE native cutover.
-- Only a fresh official observation can supply the native BCV ledger.
create function lubricenter_private.bcv_promote_official_observation(p_date date)
returns void language plpgsql security definer set search_path=''
as $$
declare observation lubricenter_private.bcv_official_observations; prior_value numeric; last_value numeric;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Solo el captador oficial'; end if;
 select * into observation from lubricenter_private.bcv_official_observations where value_date=p_date;
 if not found or observation.last_seen_at<now()-interval '24 hours' then raise exception 'Falta observación oficial reciente'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-bcv-rate',0));
 select usd_ves into prior_value from public.bcv_rate_publications where value_date=p_date;
 if prior_value is not null and prior_value<>observation.usd_ves then raise exception 'Conflicto entre BCV registrado y fuente oficial'; end if;
 select value into last_value from public.exchange_rates where rate_type='BCV' and effective_at<=now() order by effective_at desc,created_at desc limit 1;
 if last_value is not null and abs(observation.usd_ves/last_value-1)>0.12 then raise exception 'Variación BCV superior a 12%%: requiere revisión'; end if;
 -- BCV publishes Fecha Valor, not a reliable machine-readable publication time.
 -- published_at here records first observation; the payload states that basis.
 insert into public.bcv_rate_publications(value_date,usd_ves,published_at,provider,source_url)
 values(p_date,observation.usd_ves,observation.first_seen_at,'BCV_OFFICIAL',observation.source_url)
 on conflict(value_date) do nothing;
 if exists(select 1 from public.exchange_rates where rate_type='BCV' and source='BCV_API_DATE_VALUE'
  and effective_at=p_date::timestamp at time zone 'America/Caracas' and value<>observation.usd_ves) then
  raise exception 'Conflicto en el historial BCV vigente';
 end if;
 if not exists(select 1 from public.exchange_rates where rate_type='BCV' and source='BCV_API_DATE_VALUE'
  and effective_at=p_date::timestamp at time zone 'America/Caracas') then
  insert into public.exchange_rates(rate_type,value,effective_at,source,created_by)
  values('BCV',observation.usd_ves,p_date::timestamp at time zone 'America/Caracas','BCV_API_DATE_VALUE',null);
 end if;
 insert into lubricenter_private.bcv_official_verifications(value_date,usd_ves,official_url,evidence_sha256,verified_at)
 values(p_date,observation.usd_ves,observation.source_url,observation.evidence_sha256,observation.last_seen_at)
 on conflict(value_date) do update set verified_at=excluded.verified_at;
 insert into public.integration_sync_state(source_key,last_verified_at,last_success_payload,updated_at)
 values('bcv_direct',now(),jsonb_build_object('rate',observation.usd_ves,'fecha_valor',p_date,'provider','BCV_OFFICIAL',
  'evidence_sha256',observation.evidence_sha256,'publication_time_basis','FIRST_OBSERVED','active_now',p_date<=(now() at time zone 'America/Caracas')::date),now())
 on conflict(source_key) do update set last_verified_at=excluded.last_verified_at,last_success_payload=excluded.last_success_payload,updated_at=excluded.updated_at;
end$$;
revoke all on function lubricenter_private.bcv_promote_official_observation(date) from public,anon,authenticated,service_role;
-- Retire the obsolete third-party writer. The official observer invokes only
-- its private promotion function, inside the same evidence transaction.
revoke all on function public.bcv_accept_publication(numeric,date,timestamptz,text),
 lubricenter_private.bcv_accept_publication(numeric,date,timestamptz,text) from service_role;

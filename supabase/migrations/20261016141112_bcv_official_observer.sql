-- Parallel official observer. No product, stock, payment or active-rate writes.
grant usage on schema lubricenter_private to service_role;
create table lubricenter_private.bcv_official_observations (
 value_date date primary key,
 usd_ves numeric(20,8) not null check(usd_ves>0 and usd_ves<1000000),
 source_url text not null check(source_url='https://www.bcv.org.ve/'),
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 capture_count integer not null default 1 check(capture_count>0),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 evidence_html text not null check(octet_length(evidence_html) between 10 and 2000000)
);
create table lubricenter_private.bcv_official_observer_state (
 id boolean primary key default true check(id),
 last_attempt_at timestamptz not null default now(),
 last_success_at timestamptz,
 last_error text
);
alter table lubricenter_private.bcv_official_observations enable row level security;
alter table lubricenter_private.bcv_official_observer_state enable row level security;
revoke all on lubricenter_private.bcv_official_observations,lubricenter_private.bcv_official_observer_state from public,anon,authenticated,service_role;

do $$begin
 if not exists(select 1 from vault.secrets where name='lubricenter_bcv_official_job_secret') then
  perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'lubricenter_bcv_official_job_secret');
 end if;
end$$;

create function lubricenter_private.bcv_official_authorize(p_secret text)
returns boolean language sql stable security definer set search_path=''
as $$select p_secret is not null and length(p_secret)>32 and exists(
 select 1 from vault.decrypted_secrets where name='lubricenter_bcv_official_job_secret' and decrypted_secret=p_secret)$$;
create function public.bcv_official_authorize(p_secret text)
returns boolean language sql security invoker set search_path=''
as $$select lubricenter_private.bcv_official_authorize(p_secret)$$;

create function lubricenter_private.bcv_official_record(p_value numeric,p_value_date date,p_html text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare prior_value numeric; last_value numeric; result jsonb; today_local date:=(now() at time zone 'America/Caracas')::date;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Solo el captador oficial puede registrar evidencia'; end if;
 if p_value is null or p_value<=0 or p_value>=1000000 or p_value::text in ('NaN','Infinity','-Infinity')
 or p_value_date is null or p_value_date<today_local-14 or p_value_date>today_local+10
 or p_html is null or octet_length(p_html) not between 10 and 2000000 then raise exception 'Captura oficial inválida'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-bcv-official-observer',0));
 select usd_ves into prior_value from lubricenter_private.bcv_official_observations where value_date=p_value_date;
 if prior_value is not null and prior_value<>p_value then raise exception 'Conflicto en publicación oficial BCV para %',p_value_date; end if;
 select usd_ves into last_value from lubricenter_private.bcv_official_observations order by value_date desc limit 1;
 if last_value is not null and abs(p_value/last_value-1)>0.12 then raise exception 'Variación oficial BCV superior a 12%%: requiere revisión'; end if;
 insert into lubricenter_private.bcv_official_observations(value_date,usd_ves,source_url,evidence_sha256,evidence_html)
 values(p_value_date,p_value,'https://www.bcv.org.ve/',encode(sha256(convert_to(p_html,'UTF8')),'hex'),p_html)
 on conflict(value_date) do update set last_seen_at=now(),capture_count=bcv_official_observations.capture_count+1;
 insert into lubricenter_private.bcv_official_observer_state(id,last_attempt_at,last_success_at,last_error)
 values(true,now(),now(),null) on conflict(id) do update set last_attempt_at=now(),last_success_at=now(),last_error=null;
 -- The bridge is installed only with the coordinated native release.
 if to_regprocedure('lubricenter_private.bcv_promote_official_observation(date)') is not null then
  execute 'select lubricenter_private.bcv_promote_official_observation($1)' using p_value_date;
 end if;
 select jsonb_build_object('ok',true,'provider','BCV_OFFICIAL','usd_ves',usd_ves,'fecha_valor',value_date,
 'first_seen_at',first_seen_at,'last_seen_at',last_seen_at,'evidence_sha256',evidence_sha256,
 'mode',case when to_regprocedure('lubricenter_private.bcv_promote_official_observation(date)') is null then 'OBSERVER' else 'NATIVE_BRIDGE' end)
 into result from lubricenter_private.bcv_official_observations where value_date=p_value_date;
 return result;
end$$;
create function public.bcv_official_record(p_value numeric,p_value_date date,p_html text)
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.bcv_official_record(p_value,p_value_date,p_html)$$;

create function lubricenter_private.bcv_official_record_failure(p_error text)
returns void language plpgsql security definer set search_path=''
as $$begin
 if auth.role() is distinct from 'service_role' then raise exception 'Solo el captador oficial'; end if;
 insert into lubricenter_private.bcv_official_observer_state(id,last_attempt_at,last_error)
 values(true,now(),left(p_error,400)) on conflict(id) do update set last_attempt_at=now(),last_error=excluded.last_error;
end$$;
create function public.bcv_official_record_failure(p_error text)
returns void language sql security invoker set search_path=''
as $$select lubricenter_private.bcv_official_record_failure(p_error)$$;

create function lubricenter_private.get_bcv_official_status()
returns jsonb language plpgsql stable security definer set search_path=''
as $$begin
 if auth.uid() is null then raise exception 'Inicia sesión para consultar el captador oficial'; end if;
 return jsonb_build_object('provider','BCV_OFFICIAL','mode',case when to_regprocedure('lubricenter_private.bcv_promote_official_observation(date)') is null then 'OBSERVER' else 'NATIVE_BRIDGE' end,
 'state',(select to_jsonb(s)-'id' from lubricenter_private.bcv_official_observer_state s where id),
 'current',(select to_jsonb(o)-'evidence_html' from lubricenter_private.bcv_official_observations o where value_date<=(now() at time zone 'America/Caracas')::date order by value_date desc limit 1),
 'next',(select to_jsonb(o)-'evidence_html' from lubricenter_private.bcv_official_observations o where value_date>(now() at time zone 'America/Caracas')::date order by value_date limit 1));
end$$;
create function public.get_bcv_official_status()
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.get_bcv_official_status()$$;

revoke all on function lubricenter_private.bcv_official_authorize(text),public.bcv_official_authorize(text),
 lubricenter_private.bcv_official_record(numeric,date,text),public.bcv_official_record(numeric,date,text),
 lubricenter_private.bcv_official_record_failure(text),public.bcv_official_record_failure(text) from public,anon,authenticated;
grant execute on function lubricenter_private.bcv_official_authorize(text),public.bcv_official_authorize(text),
 lubricenter_private.bcv_official_record(numeric,date,text),public.bcv_official_record(numeric,date,text),
 lubricenter_private.bcv_official_record_failure(text),public.bcv_official_record_failure(text) to service_role;
revoke all on function lubricenter_private.get_bcv_official_status(),public.get_bcv_official_status() from public,anon;
grant execute on function lubricenter_private.get_bcv_official_status(),public.get_bcv_official_status() to authenticated;

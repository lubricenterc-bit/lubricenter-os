create or replace function public.exchange_rate_authority()
returns text language sql stable security invoker set search_path=''
as $$select coalesce((select value #>> '{}' from public.app_settings where key='exchange_rate_authority'),
 case when exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS') then 'BCV_OFFICIAL' else 'NOTION' end)$$;
revoke all on function public.exchange_rate_authority() from public,anon;
grant execute on function public.exchange_rate_authority() to authenticated,service_role;


-- Rates cutover: Notion remains catalog-only, BCV comes from dated source publication,
-- OPERATIVE rate is changed exclusively by a finance OWNER.
-- Historical rate rows, orders, payments and invoice snapshots are never rewritten.
grant usage on schema lubricenter_private to service_role;
create table if not exists public.bcv_rate_publications(
 id uuid primary key default gen_random_uuid(),
 value_date date not null unique,
 usd_ves numeric(20,8) not null check(usd_ves>0 and usd_ves<1000000),
 published_at timestamptz not null,
 imported_at timestamptz not null default now(),
 provider text not null default 'BCV_TODAY',
 source_url text not null default 'https://bcv.today/api/v1/rate.json',
 check (published_at <= imported_at + interval '5 minutes')
);
alter table public.bcv_rate_publications enable row level security;
revoke all on public.bcv_rate_publications from public,anon,authenticated;
grant select on public.bcv_rate_publications to authenticated;
create policy bcv_publications_read on public.bcv_rate_publications
  for select to authenticated using (auth.uid() is not null);

-- Release evidence is recorded only after an operator has inspected the official
-- dated publication. A third-party heartbeat is not official verification.
create table if not exists lubricenter_private.bcv_official_verifications (
 value_date date primary key,
 usd_ves numeric(20,8) not null check(usd_ves>0 and usd_ves<1000000),
 official_url text not null check(official_url ~ '^https://(www\.)?bcv\.org\.ve(/|$)'),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz not null default now()
);
alter table lubricenter_private.bcv_official_verifications enable row level security;
revoke all on lubricenter_private.bcv_official_verifications from public,anon,authenticated;
grant all on lubricenter_private.bcv_official_verifications to service_role;

-- Supabase Cron invokes a JWT-protected Edge Function with this private one-time secret.
-- Creation is idempotent; the secret never appears in repository files or migration output.
do $$
begin
 if not exists (select 1 from vault.secrets where name='lubricenter_bcv_cron_secret') then
   perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'lubricenter_bcv_cron_secret');
 end if;
end $$;

create or replace function lubricenter_private.bcv_authorize_job(p_secret text)
returns boolean language sql stable security definer set search_path=''
as $$
 select p_secret is not null and length(p_secret)>32
 and exists(select 1 from vault.decrypted_secrets
   where name='lubricenter_bcv_cron_secret' and decrypted_secret=p_secret);
$$;
create or replace function public.bcv_authorize_job(p_secret text)
returns boolean language sql stable security invoker set search_path=''
as $$select lubricenter_private.bcv_authorize_job(p_secret)$$;
revoke all on function lubricenter_private.bcv_authorize_job(text) from public,anon,authenticated;
revoke all on function public.bcv_authorize_job(text) from public,anon,authenticated;
grant execute on function lubricenter_private.bcv_authorize_job(text) to service_role;
grant execute on function public.bcv_authorize_job(text) to service_role;

-- A verified rate can be known on Friday but must not enter 'current' until
-- its published BCV Fecha Valor (local Caracas 00:00). No fixed weekend calendar.
create or replace function lubricenter_private.bcv_accept_publication(
 p_value numeric,p_value_date date,p_published_at timestamptz,
 p_source_url text default 'https://bcv.today/api/v1/rate.json'
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare today_local date:=(now() at time zone 'America/Caracas')::date;
        last_value numeric; existing_value numeric; activated boolean;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Solo el captador interno BCV puede registrar tasas'; end if;
 if p_value is null or p_value<=0 or p_value>1000000
    or p_value_date is null or p_value_date<today_local-14 or p_value_date>today_local+10
    or p_published_at is null or p_published_at>now()+interval '5 minutes'
    or p_published_at<now()-interval '21 days'
    or p_source_url <> 'https://bcv.today/api/v1/rate.json'
 then raise exception 'Publicación BCV inválida o desactualizada'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-bcv-rate',0));
 select usd_ves into existing_value from public.bcv_rate_publications where value_date=p_value_date;
 if existing_value is not null and existing_value<>p_value then
   raise exception 'Conflicto BCV para %: previa %, recibida %',p_value_date,existing_value,p_value;
 end if;
 select value into last_value from public.exchange_rates
 where rate_type='BCV' and effective_at<=now()
 order by effective_at desc,created_at desc limit 1;
 if last_value is not null and abs(p_value/last_value-1)>0.12 then
   raise exception 'Variación BCV superior a 12%%: requiere revisión de fuente';
 end if;
 insert into public.bcv_rate_publications(value_date,usd_ves,published_at,source_url)
 values(p_value_date,p_value,p_published_at,p_source_url)
 on conflict(value_date) do nothing;
 -- Only the first acceptance creates the effective-dated ledger record.
 if not exists(select 1 from public.exchange_rates where rate_type='BCV'
   and source='BCV_API_DATE_VALUE' and effective_at=(p_value_date::timestamp at time zone 'America/Caracas'))
 then
   insert into public.exchange_rates(rate_type,value,effective_at,source,created_by)
   values('BCV',p_value,p_value_date::timestamp at time zone 'America/Caracas','BCV_API_DATE_VALUE',null);
 end if;
 activated:=p_value_date<=today_local;
 insert into public.integration_sync_state(source_key,last_verified_at,last_success_payload,updated_at)
 values('bcv_direct',now(),jsonb_build_object('rate',p_value,
   'fecha_valor',p_value_date,'fetched_at',now(),'active_now',activated,'provider','BCV_TODAY'),now())
 on conflict(source_key) do update set
  last_verified_at=excluded.last_verified_at,
  last_success_payload=excluded.last_success_payload,updated_at=excluded.updated_at;
 return jsonb_build_object('ok',true,'fecha_valor',p_value_date,
    'vigente_ahora',activated,'usd_ves',p_value);
end $$;
create or replace function public.bcv_accept_publication(
 p_value numeric,p_value_date date,p_published_at timestamptz,
 p_source_url text default 'https://bcv.today/api/v1/rate.json'
) returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.bcv_accept_publication(p_value,p_value_date,p_published_at,p_source_url)$$;
revoke all on function lubricenter_private.bcv_accept_publication(numeric,date,timestamptz,text) from public,anon,authenticated;
revoke all on function public.bcv_accept_publication(numeric,date,timestamptz,text) from public,anon,authenticated;
grant execute on function lubricenter_private.bcv_accept_publication(numeric,date,timestamptz,text) to service_role;
grant execute on function public.bcv_accept_publication(numeric,date,timestamptz,text) to service_role;

-- Retire the legacy Notion rate side effects WITHOUT interrupting Notion catalog sync.
create or replace function public.ignore_notion_exchange_rates()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
 if new.source ilike 'Notion%' and public.exchange_rate_authority()='BCV_OFFICIAL' then return null; end if;
 return new;
end $$;
drop trigger if exists ignore_notion_exchange_rates on public.exchange_rates;
create trigger ignore_notion_exchange_rates before insert on public.exchange_rates
for each row execute function public.ignore_notion_exchange_rates();

-- Date-effective choice also applies to payment, order and catalog price snapshots.
create or replace view public.current_exchange_rates with (security_invoker=true) as
select
 (select er.value from public.exchange_rates er
  where er.rate_type='BCV' and er.effective_at<=now()
    and case when public.exchange_rate_authority()='BCV_OFFICIAL' then er.source='BCV_API_DATE_VALUE'
      else er.source is distinct from 'BCV_API_DATE_VALUE' end
  order by er.effective_at desc,er.created_at desc limit 1) bcv_rate,
 (select er.value from public.exchange_rates er
  where er.rate_type='OPERATIVE' and er.effective_at<=now()
  order by er.effective_at desc,er.created_at desc limit 1) operative_rate;

create or replace function lubricenter_private.set_operative_manual(p_value numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare previous numeric; rate_id uuid; changed boolean;
begin
 perform lubricenter_private.finance_require('OWNER');
 if p_value is null or p_value<=0 or p_value>=1000000 or p_value::text in ('NaN','Infinity','-Infinity')
 then raise exception 'La tasa operativa debe ser un número positivo válido'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-operative-manual',0));
 select operative_rate into previous from public.current_exchange_rates;
 changed:=previous is distinct from p_value;
 if changed then
  insert into public.exchange_rates(rate_type,value,effective_at,source,created_by)
  values('OPERATIVE',p_value,now(),'LUBRICENTER_MANUAL',auth.uid()) returning id into rate_id;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values('rates.operative_manual','exchange_rates',rate_id,jsonb_build_object(
   'old',previous,'new',p_value,'note',left(coalesce(p_note,''),300)),auth.uid());
 end if;
 return jsonb_build_object('ok',true,'changed',changed,'previous',previous,'current',p_value);
end $$;
create or replace function public.set_operative_manual(p_value numeric,p_note text default null)
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.set_operative_manual(p_value,p_note)$$;
revoke all on function public.set_operative_manual(numeric,text) from public,anon;
revoke all on function lubricenter_private.set_operative_manual(numeric,text) from public,anon;
grant execute on function public.set_operative_manual(numeric,text) to authenticated;
grant execute on function lubricenter_private.set_operative_manual(numeric,text) to authenticated;

-- The old procedure changed BOTH rates with no finance OWNER permission.
create or replace function public.set_exchange_rates(p_bcv numeric,p_operative numeric)
returns void language plpgsql security invoker set search_path=''
as $$
begin
 raise exception 'Esta función fue retirada. BCV automático; tasa operativa en Configuración.';
end $$;
revoke all on function public.set_exchange_rates(numeric,numeric) from public,anon,authenticated;

-- Keep all existing catalog gates, but no longer consider an unchanged manual
-- operative rate "stale" after three hours. Never require Notion for FX.
create or replace function public.assert_notion_pricing_fresh()
returns void language plpgsql security definer set search_path=''
as $$
declare v_catalog_sync timestamptz; v_bcv numeric; v_op numeric; v_bcv_at timestamptz;
begin
 select coalesce(
  (select s.last_verified_at from public.integration_sync_state s where s.source_key='notion_catalog'),
  (select max(p.catalog_synced_at) from public.products p where p.catalog_source='Notion · Nuestros Productos')
 ) into v_catalog_sync;
 if v_catalog_sync is null or v_catalog_sync<now()-interval '24 hours'
 then raise exception 'El catálogo de Notion está desactualizado. Revisa la sincronización de productos.'; end if;
 select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates;
 if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0
 then raise exception 'Faltan tasas BCV u operativa válidas para vender'; end if;
 select effective_at into v_bcv_at from public.exchange_rates
 where rate_type='BCV' and effective_at<=now()
 order by effective_at desc,created_at desc limit 1;
 if v_bcv_at<now()-interval '10 days'
 then raise exception 'La tasa BCV está demasiado antigua. Revisa el captador antes de vender.'; end if;
end $$;

-- Keep the current RPC response shape for quotes, settings, and inventory.
create or replace function public.get_pricing_sync_status()
returns table(
 catalog_synced_at timestamptz,catalog_products bigint,
 bcv_rate numeric,bcv_effective_at timestamptz,
 operative_rate numeric,operative_effective_at timestamptz
) language sql stable security definer set search_path=''
as $$
 select
 (select s.last_verified_at from public.integration_sync_state s where s.source_key='notion_catalog'),
 (select count(*) from public.products p where p.catalog_source='Notion · Nuestros Productos' and p.active and p.available),
 (select r.value from public.exchange_rates r where r.rate_type='BCV' and r.effective_at<=now()
    and case when public.exchange_rate_authority()='BCV_OFFICIAL' then r.source='BCV_API_DATE_VALUE' else r.source is distinct from 'BCV_API_DATE_VALUE' end
  order by r.effective_at desc,r.created_at desc limit 1),
 (select r.effective_at from public.exchange_rates r where r.rate_type='BCV' and r.effective_at<=now()
    and case when public.exchange_rate_authority()='BCV_OFFICIAL' then r.source='BCV_API_DATE_VALUE' else r.source is distinct from 'BCV_API_DATE_VALUE' end
  order by r.effective_at desc,r.created_at desc limit 1),
 (select r.value from public.exchange_rates r where r.rate_type='OPERATIVE' and r.effective_at<=now()
  order by r.effective_at desc,r.created_at desc limit 1),
 (select r.effective_at from public.exchange_rates r where r.rate_type='OPERATIVE' and r.effective_at<=now()
  order by r.effective_at desc,r.created_at desc limit 1);
$$;

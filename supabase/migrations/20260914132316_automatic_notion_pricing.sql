-- Transactional Notion pricing import used by the scheduled sync and the administrator.
create schema if not exists lubricenter_private;
revoke all on schema lubricenter_private from public, anon;
grant usage on schema lubricenter_private to authenticated;

create or replace function lubricenter_private.apply_notion_pricing(
  p_bcv numeric, p_operative numeric, p_products jsonb, p_synced_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_item jsonb; v_name text; v_key text; v_price numeric;
  v_seen text[] := array[]::text[];
  v_catalog_count integer := 0; v_product_changes integer := 0;
  v_retired integer := 0; v_rate_changes integer := 0; v_latest numeric;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lubricenter-notion-pricing', 0));

  if p_bcv is null or p_bcv <= 0 or p_bcv > 1000000 then
    raise exception 'La tasa BCV recibida no es válida';
  end if;
  if p_operative is null or p_operative <= 0 or p_operative > 1000000 then
    raise exception 'La tasa operativa recibida no es válida';
  end if;
  if p_synced_at is null or p_synced_at > now() + interval '5 minutes' then
    raise exception 'La fecha de sincronización no es válida';
  end if;
  if pg_catalog.jsonb_typeof(p_products) <> 'array'
     or pg_catalog.jsonb_array_length(p_products) < 1
     or pg_catalog.jsonb_array_length(p_products) > 500 then
    raise exception 'El catálogo debe contener entre 1 y 500 productos';
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_products)
  loop
    v_name := pg_catalog.btrim(coalesce(v_item ->> 'name', ''));
    v_key := pg_catalog.lower(v_name);
    if v_name = '' then raise exception 'Hay un producto sin nombre'; end if;
    if v_key = any(v_seen) then raise exception 'El catálogo contiene el producto repetido: %', v_name; end if;

    begin
      v_price := (v_item ->> 'base_usd')::numeric;
    exception when others then
      raise exception 'El precio de % no es numérico', v_name;
    end;
    if v_price is null or v_price < 0 or v_price > 1000000 then
      raise exception 'El precio de % no es válido', v_name;
    end if;

    if exists (
      select 1 from public.products p
      where pg_catalog.lower(pg_catalog.btrim(p.name)) = v_key
        and (p.name, p.category, p.available, p.active, p.cash_usd_base_price, p.notes, p.image_url, p.catalog_source)
          is distinct from
            (v_name, nullif(pg_catalog.btrim(v_item ->> 'category'), ''), true, true, v_price,
             nullif(pg_catalog.btrim(v_item ->> 'description'), ''),
             nullif(pg_catalog.btrim(v_item ->> 'image_url'), ''), 'Notion · Nuestros Productos')
    ) or not exists (
      select 1 from public.products p where pg_catalog.lower(pg_catalog.btrim(p.name)) = v_key
    ) then v_product_changes := v_product_changes + 1; end if;

    insert into public.products (
      name, category, available, active, cash_usd_base_price, notes, image_url,
      catalog_source, catalog_synced_at, updated_at
    ) values (
      v_name, nullif(pg_catalog.btrim(v_item ->> 'category'), ''), true, true, v_price,
      nullif(pg_catalog.btrim(v_item ->> 'description'), ''),
      nullif(pg_catalog.btrim(v_item ->> 'image_url'), ''),
      'Notion · Nuestros Productos', p_synced_at, p_synced_at
    )
    on conflict (pg_catalog.lower(pg_catalog.btrim(name))) do update set
      name = excluded.name, category = excluded.category, available = true, active = true,
      cash_usd_base_price = excluded.cash_usd_base_price, notes = excluded.notes,
      image_url = excluded.image_url, catalog_source = excluded.catalog_source,
      catalog_synced_at = excluded.catalog_synced_at, updated_at = excluded.updated_at;

    v_seen := pg_catalog.array_append(v_seen, v_key);
    v_catalog_count := v_catalog_count + 1;
  end loop;

  update public.products p
  set available = false, catalog_synced_at = p_synced_at, updated_at = p_synced_at
  where p.catalog_source = 'Notion · Nuestros Productos'
    and not (pg_catalog.lower(pg_catalog.btrim(p.name)) = any(v_seen)) and p.available;
  get diagnostics v_retired = row_count;
  v_product_changes := v_product_changes + v_retired;

  select er.value into v_latest from public.exchange_rates er
  where er.rate_type = 'BCV' order by er.effective_at desc, er.created_at desc limit 1;
  if v_latest is distinct from p_bcv then
    insert into public.exchange_rates(rate_type, value, effective_at, source, created_by)
    values ('BCV', p_bcv, p_synced_at, 'Notion · Tasas', null);
    v_rate_changes := v_rate_changes + 1;
  end if;

  select er.value into v_latest from public.exchange_rates er
  where er.rate_type = 'OPERATIVE' order by er.effective_at desc, er.created_at desc limit 1;
  if v_latest is distinct from p_operative then
    insert into public.exchange_rates(rate_type, value, effective_at, source, created_by)
    values ('OPERATIVE', p_operative, p_synced_at, 'Notion · Tasas', null);
    v_rate_changes := v_rate_changes + 1;
  end if;

  insert into public.integration_sync_state(source_key, last_verified_at, last_success_payload, updated_at)
  values ('notion_catalog', p_synced_at,
    pg_catalog.jsonb_build_object('products', v_catalog_count, 'changed', v_product_changes), p_synced_at)
  on conflict (source_key) do update set last_verified_at = excluded.last_verified_at,
    last_success_payload = excluded.last_success_payload, updated_at = excluded.updated_at;

  insert into public.integration_sync_state(source_key, last_verified_at, last_success_payload, updated_at)
  values ('notion_rates', p_synced_at,
    pg_catalog.jsonb_build_object('BCV', p_bcv, 'OPERATIVE', p_operative, 'changed', v_rate_changes), p_synced_at)
  on conflict (source_key) do update set last_verified_at = excluded.last_verified_at,
    last_success_payload = excluded.last_success_payload, updated_at = excluded.updated_at;

  insert into public.audit_events(event_type, entity_type, entity_id, data, actor_id)
  values ('NOTION_PRICING_SYNCED', 'integration_sync_state', null,
    pg_catalog.jsonb_build_object('products', v_catalog_count, 'product_changes', v_product_changes,
      'rate_changes', v_rate_changes, 'bcv', p_bcv, 'operative', p_operative, 'synced_at', p_synced_at),
    auth.uid());

  return pg_catalog.jsonb_build_object('ok', true, 'products', v_catalog_count,
    'product_changes', v_product_changes, 'rate_changes', v_rate_changes, 'synced_at', p_synced_at);
end
$function$;

revoke all on function lubricenter_private.apply_notion_pricing(numeric, numeric, jsonb, timestamptz)
  from public, anon, authenticated;

create or replace function public.sync_notion_pricing(
  p_bcv numeric, p_operative numeric, p_products jsonb, p_synced_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
begin
  perform lubricenter_private.require_order_admin();
  return lubricenter_private.apply_notion_pricing(p_bcv, p_operative, p_products, p_synced_at);
end
$function$;

revoke all on function public.sync_notion_pricing(numeric, numeric, jsonb, timestamptz) from public, anon;
grant execute on function public.sync_notion_pricing(numeric, numeric, jsonb, timestamptz) to authenticated;


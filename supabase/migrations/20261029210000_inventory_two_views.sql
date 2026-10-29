-- Dos vistas sobre una sola fuente (inventory_items):
--   * Inventario: absolutamente todos los artículos (activos, archivados y fusionados), con todo editable.
--   * Catálogo: solo los artículos marcados «en catálogo», con sus precios de venta.
-- La tabla products (lista vieja de Notion) ya no se lee en ninguna pantalla.
-- Migración solo aditiva: columna nueva, funciones nuevas y get_catalog_snapshot con la misma firma.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'in_catalog') then
    alter table public.inventory_items add column in_catalog boolean not null default false;
    -- Arranque: entran al catálogo los artículos activos que ya tienen precio de venta.
    update public.inventory_items set in_catalog = true
    where active and merged_into is null and price_usd > 0;
  end if;
end $$;

comment on column public.inventory_items.in_catalog is 'Se muestra en el Catálogo y en los cotizadores. Requiere precio de venta.';

-- Catálogo para cotizadores (misma firma de siempre): artículos marcados en catálogo.
create or replace function public.get_catalog_snapshot()
returns table(id uuid, name text, category text, available boolean, active boolean, cash_usd_base_price numeric,
  current_price_ves numeric, current_ref_bcv numeric, image_url text, catalog_source text, catalog_synced_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id, coalesce(c.display_name, c.description), c.category, true, true,
         c.price_usd, c.current_price_ves, c.current_ref_bcv, c.image_url, 'Inventario', c.price_updated_at
  from public.inventory_current c
  join public.inventory_items i on i.id = c.id
  where c.location_code = 'CABUDARE' and i.in_catalog and i.merged_into is null
  order by c.category nulls last, coalesce(c.display_name, c.description);
$$;

-- Catálogo con existencia, para la pantalla Catálogo.
create or replace function public.get_catalog_view(p_location_code text default 'CABUDARE')
returns table(id uuid, sku text, name text, brand text, category text, unit text, quantity_on_hand numeric,
  price_usd numeric, current_price_ves numeric, current_ref_bcv numeric, image_url text, price_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id, c.sku, coalesce(c.display_name, c.description), c.brand, c.category, c.unit, c.quantity_on_hand,
         c.price_usd, c.current_price_ves, c.current_ref_bcv, c.image_url, c.price_updated_at
  from public.inventory_current c
  join public.inventory_items i on i.id = c.id
  where c.location_code = p_location_code and i.in_catalog and i.merged_into is null
  order by c.category nulls last, coalesce(c.display_name, c.description);
$$;

-- Inventario completo: todos los artículos, también archivados y fusionados.
create or replace function public.get_inventory_full(p_location_code text default 'CABUDARE')
returns table(id uuid, sku text, display_name text, description text, brand text, category text, unit text,
  quantity_on_hand numeric, movement_count bigint, last_movement_at timestamptz, last_counted_at timestamptz,
  price_usd numeric, current_price_ves numeric, current_ref_bcv numeric, price_updated_at timestamptz,
  average_cost_ref numeric, last_purchase_cost_ref numeric, last_purchased_at timestamptz, source_cost_ref numeric,
  cost_missing boolean, needs_review boolean, active boolean, in_catalog boolean,
  merged_into uuid, merged_into_sku text, alt_codes text[], image_url text, product_id uuid, updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  with loc as (select id from public.locations where code = p_location_code limit 1),
  stock as (
    select m.inventory_item_id, sum(m.quantity_delta) q, count(*) n, max(m.created_at) last_at
    from public.inventory_movements m, loc where m.location_id = loc.id group by 1
  ),
  rounding as (
    select coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'price_rounding_step'), 10) step,
           coalesce((select value #>> '{}' from public.app_settings where key = 'price_rounding_mode'), 'nearest') mode
  )
  select i.id, i.sku, i.display_name, i.description, i.brand, i.category, i.unit,
         coalesce(s.q, 0), coalesce(s.n, 0), s.last_at, i.last_counted_at,
         i.price_usd,
         case when i.price_usd > 0 and r.operative_rate > 0 then public.round_to_step(i.price_usd * r.operative_rate, rd.step, rd.mode) end,
         case when i.price_usd > 0 and r.operative_rate > 0 and r.bcv_rate > 0
              then public.round_to_step(i.price_usd * r.operative_rate, rd.step, rd.mode) / r.bcv_rate end,
         i.price_updated_at, i.average_cost_ref, i.last_purchase_cost_ref, i.last_purchased_at, i.source_cost_ref,
         i.cost_missing, i.needs_review, i.active, i.in_catalog,
         i.merged_into, mi.sku, coalesce(i.alt_codes, '{}'), i.image_url, i.product_id, i.updated_at
  from public.inventory_items i
  left join stock s on s.inventory_item_id = i.id
  left join public.inventory_items mi on mi.id = i.merged_into
  cross join public.current_exchange_rates r
  cross join rounding rd
  order by i.category nulls last, i.brand nulls last, i.sku;
$$;

-- Guardar todas las propiedades de un artículo. La existencia se cambia con inventory_set_count_at_location.
create or replace function lubricenter_private.inventory_save_item_full(
  p_id uuid, p_sku text, p_display_name text, p_description text, p_brand text, p_category text, p_unit text,
  p_price_usd numeric, p_cost_ref numeric, p_image_url text, p_alt_codes text[],
  p_active boolean, p_needs_review boolean, p_in_catalog boolean,
  p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.inventory_items; v_id uuid;
  v_sku text := upper(btrim(coalesce(p_sku,'')));
  v_name text := btrim(coalesce(p_display_name,''));
  v_desc text := nullif(btrim(coalesce(p_description,'')),'');
  v_photo text := nullif(btrim(coalesce(p_image_url,'')),'');
  v_price numeric := nullif(p_price_usd, 0);
  v_cost numeric := nullif(p_cost_ref, 0);
  v_active boolean := coalesce(p_active, true);
  v_catalog boolean := coalesce(p_in_catalog, false);
  v_codes text[] := coalesce((select array_agg(distinct btrim(c)) from unnest(coalesce(p_alt_codes,'{}')) c where btrim(c) <> ''), '{}');
begin
  perform lubricenter_private.require_order_admin();
  if length(v_sku) < 2 or length(v_sku) > 60 then raise exception 'Código (SKU) inválido: usa entre 2 y 60 caracteres'; end if;
  if length(v_name) < 2 or length(v_name) > 180 then raise exception 'Nombre de venta inválido: usa entre 2 y 180 caracteres'; end if;
  if v_desc is not null and length(v_desc) > 400 then raise exception 'La descripción es demasiado larga (máximo 400 caracteres)'; end if;
  if p_price_usd is not null and (p_price_usd < 0 or p_price_usd > 1000000 or p_price_usd::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Precio de venta inválido'; end if;
  if p_cost_ref is not null and (p_cost_ref < 0 or p_cost_ref > 1000000 or p_cost_ref::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Costo inválido'; end if;
  if v_photo is not null and (length(v_photo) > 1800 or v_photo !~* '^https://[^[:space:]]+$') then
    raise exception 'La foto debe ser un enlace https válido'; end if;
  if v_catalog and v_price is null then raise exception 'Para mostrarlo en el catálogo ponle un precio de venta'; end if;
  if v_catalog and not v_active then raise exception 'Un artículo archivado no puede estar en el catálogo'; end if;
  if exists(select 1 from public.inventory_items where upper(sku)=v_sku and id is distinct from p_id and merged_into is null) then
    raise exception 'Ya existe un artículo con el código %', v_sku; end if;

  if p_id is null then
    insert into public.inventory_items(sku, display_name, description, brand, category, unit, price_usd, price_updated_at,
      average_cost_ref, cost_missing, image_url, alt_codes, active, needs_review, in_catalog, source_name, imported_at, updated_at)
    values (v_sku, v_name, coalesce(v_desc, v_name), nullif(btrim(coalesce(p_brand,'')),''), nullif(btrim(coalesce(p_category,'')),''),
      coalesce(nullif(btrim(coalesce(p_unit,'')),''),'UND'), v_price, case when v_price is not null then now() end,
      v_cost, v_cost is null, v_photo, v_codes, v_active, coalesce(p_needs_review,false), v_catalog, 'Lubricenter OS', now(), now())
    returning id into v_id;
  else
    select * into v_old from public.inventory_items where id=p_id for update;
    if v_old.id is null then raise exception 'Artículo no encontrado'; end if;
    if v_old.merged_into is not null then raise exception 'Este artículo se fusionó con otro; edita el artículo principal'; end if;
    if p_expected_updated_at is not null and v_old.updated_at is distinct from p_expected_updated_at then
      raise exception 'Otra persona modificó este artículo. Recarga antes de guardar.'; end if;
    update public.inventory_items set
      sku=v_sku, display_name=v_name, description=coalesce(v_desc, v_old.description, v_name),
      brand=nullif(btrim(coalesce(p_brand,'')),''), category=nullif(btrim(coalesce(p_category,'')),''),
      unit=coalesce(nullif(btrim(coalesce(p_unit,'')),''),unit),
      price_usd=v_price,
      price_updated_at=case when v_price is distinct from v_old.price_usd then now() else v_old.price_updated_at end,
      average_cost_ref=v_cost, cost_missing=(v_cost is null),
      image_url=v_photo, alt_codes=v_codes, active=v_active, needs_review=coalesce(p_needs_review, v_old.needs_review),
      in_catalog=v_catalog, updated_at=now()
    where id=p_id;
    v_id := p_id;
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data, actor_id)
  values ('inventory.item_saved','inventory_item',v_id,
    jsonb_build_object('sku',v_sku,'name',v_name,'price_usd',v_price,'cost_ref',v_cost,'active',v_active,'in_catalog',v_catalog,
      'before', case when v_old.id is null then null else jsonb_build_object('sku',v_old.sku,'name',v_old.display_name,
        'price_usd',v_old.price_usd,'cost_ref',v_old.average_cost_ref,'active',v_old.active,'in_catalog',v_old.in_catalog) end),
    auth.uid());
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.inventory_save_item_full(
  p_id uuid, p_sku text, p_display_name text, p_description text, p_brand text, p_category text, p_unit text,
  p_price_usd numeric, p_cost_ref numeric, p_image_url text, p_alt_codes text[],
  p_active boolean, p_needs_review boolean, p_in_catalog boolean,
  p_expected_updated_at timestamptz default null)
returns jsonb language sql set search_path = '' as
$$select lubricenter_private.inventory_save_item_full(p_id,p_sku,p_display_name,p_description,p_brand,p_category,p_unit,
  p_price_usd,p_cost_ref,p_image_url,p_alt_codes,p_active,p_needs_review,p_in_catalog,p_expected_updated_at)$$;

-- Meter o sacar varios artículos del catálogo de una vez. Solo entran los que tienen precio y están activos.
create or replace function lubricenter_private.inventory_set_catalog_bulk(p_item_ids uuid[], p_in_catalog boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  perform lubricenter_private.require_order_admin();
  if p_in_catalog is null then raise exception 'Indica si entran o salen del catálogo'; end if;
  if coalesce(array_length(p_item_ids,1),0) = 0 or array_length(p_item_ids,1) > 1000 then raise exception 'Selecciona entre 1 y 1000 artículos'; end if;
  update public.inventory_items set in_catalog = p_in_catalog, updated_at = now()
  where id = any(p_item_ids) and in_catalog is distinct from p_in_catalog
    and (not p_in_catalog or (active and merged_into is null and price_usd > 0));
  get diagnostics n = row_count;
  insert into public.audit_events(event_type, entity_type, data, actor_id)
  values ('inventory.catalog_bulk','inventory_item', jsonb_build_object('items', p_item_ids, 'in_catalog', p_in_catalog, 'updated', n), auth.uid());
  return n;
end;
$$;

create or replace function public.inventory_set_catalog_bulk(p_item_ids uuid[], p_in_catalog boolean)
returns integer language sql set search_path = '' as
$$select lubricenter_private.inventory_set_catalog_bulk(p_item_ids, p_in_catalog)$$;

-- Archivar saca del catálogo.
create or replace function lubricenter_private.inventory_catalog_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not new.active or new.merged_into is not null then new.in_catalog := false; end if;
  return new;
end $$;
drop trigger if exists inventory_catalog_guard on public.inventory_items;
create trigger inventory_catalog_guard before insert or update on public.inventory_items
  for each row execute function lubricenter_private.inventory_catalog_guard();

revoke all on function public.get_catalog_view(text) from public, anon;
revoke all on function public.get_inventory_full(text) from public, anon;
grant execute on function public.get_catalog_view(text) to authenticated, service_role;
grant execute on function public.get_inventory_full(text) to authenticated, service_role;
revoke all on function lubricenter_private.inventory_save_item_full(uuid,text,text,text,text,text,text,numeric,numeric,text,text[],boolean,boolean,boolean,timestamptz) from public, anon;
revoke all on function public.inventory_save_item_full(uuid,text,text,text,text,text,text,numeric,numeric,text,text[],boolean,boolean,boolean,timestamptz) from public, anon;
grant execute on function lubricenter_private.inventory_save_item_full(uuid,text,text,text,text,text,text,numeric,numeric,text,text[],boolean,boolean,boolean,timestamptz) to authenticated;
grant execute on function public.inventory_save_item_full(uuid,text,text,text,text,text,text,numeric,numeric,text,text[],boolean,boolean,boolean,timestamptz) to authenticated;
revoke all on function lubricenter_private.inventory_set_catalog_bulk(uuid[],boolean) from public, anon;
revoke all on function public.inventory_set_catalog_bulk(uuid[],boolean) from public, anon;
grant execute on function lubricenter_private.inventory_set_catalog_bulk(uuid[],boolean) to authenticated;
grant execute on function public.inventory_set_catalog_bulk(uuid[],boolean) to authenticated;
revoke all on function lubricenter_private.inventory_catalog_guard() from public, anon;

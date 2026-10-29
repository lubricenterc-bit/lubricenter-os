-- Un solo catálogo: el inventario.
--
-- Cada artículo de inventario tiene su propio nombre de venta, precio base en divisas (USD físico)
-- y foto. El precio en Bs = USD × tasa operativa (redondeado) y la referencia = Bs ÷ BCV, igual que antes.
-- La tabla products (lista de precios heredada de Notion) deja de usarse para vender:
--   * los precios se copiaron a cada artículo enlazado;
--   * get_catalog_snapshot (catálogo visual y cotizadores) devuelve artículos de inventario;
--   * vender un producto de la lista que no tenga artículo queda bloqueado siempre.
-- Las tasas BCV y operativa siguen llegando desde Notion.

alter table public.inventory_items
  add column if not exists display_name text,
  add column if not exists price_usd numeric(14,4),
  add column if not exists price_updated_at timestamptz,
  add column if not exists image_url text;

comment on column public.inventory_items.display_name is 'Nombre de venta que ven el cliente y la caja.';
comment on column public.inventory_items.price_usd is 'Precio base en divisas (USD físico). Bs = USD × operativa; REF = Bs ÷ BCV.';

-- Precio y foto desde la lista vieja (un grupo como "Filtro A1" pasa su precio a cada filtro).
update public.inventory_items i
set price_usd = p.cash_usd_base_price,
    price_updated_at = now(),
    image_url = coalesce(i.image_url, p.image_url)
from public.products p
where p.id = i.product_id and i.price_usd is null and p.cash_usd_base_price > 0;

-- Nombre de venta: el del producto cuando era exclusivo del artículo; si no, marca + descripción (+ código en filtros).
with solo as (
  select product_id from public.inventory_items where product_id is not null and active group by product_id having count(*) = 1
)
update public.inventory_items i
set display_name = p.name
from public.products p, solo s
where s.product_id = i.product_id and p.id = i.product_id and i.display_name is null;

-- Filtros: "Filtro de <tipo> <marca> <código>"; los de cabina llevan el vehículo.
update public.inventory_items i
set display_name = btrim(regexp_replace(
  case
    when i.category = 'Filtro Cabina' and i.description ~* 'habit[aá]culo'
      then 'Filtro de cabina ' || btrim(regexp_replace(i.description, '^.*habit[aá]culo\s*(gen[eé]rico\s*)?', '', 'i'))
           || case when i.brand is null or i.brand ~* '^(g/n|gen[eé]rico)$' or i.description ilike '%' || i.brand || '%' then '' else ' ' || i.brand end
    else 'Filtro de ' || lower(regexp_replace(i.category, '^Filtro\s+', '', 'i'))
         || case when i.brand is null or i.brand ~* '^(g/n|gen[eé]rico|desconocida)$' then '' else ' ' || i.brand end
         || case when i.sku ~ '^[A-Z0-9][A-Z0-9 ./-]*$' and i.sku !~ '(FILHABI|GENE|^S/C$)' then ' ' || i.sku else '' end
  end, '\s+', ' ', 'g'))
where i.display_name is null and i.category ilike 'filtro %';

update public.inventory_items i
set display_name = btrim(
  case when i.brand is null or i.brand ~* '^(g/n|gen[eé]rico|desconocida)$' or i.description ilike '%' || i.brand || '%' then i.description
       else i.brand || ' ' || i.description end)
where i.display_name is null;

create or replace view public.inventory_current with (security_invoker = true) as
 WITH stock AS (
         SELECT inventory_movements.inventory_item_id,
            inventory_movements.location_id,
            sum(inventory_movements.quantity_delta) AS quantity_on_hand
           FROM inventory_movements
          GROUP BY inventory_movements.inventory_item_id, inventory_movements.location_id
        ), rounding AS (
         SELECT COALESCE(( SELECT (app_settings.value #>> '{}'::text[])::numeric FROM app_settings WHERE app_settings.key = 'price_rounding_step'::text), 10::numeric) AS step,
                COALESCE(( SELECT app_settings.value #>> '{}'::text[] FROM app_settings WHERE app_settings.key = 'price_rounding_mode'::text), 'nearest'::text) AS mode
        ), priced AS (
         SELECT i_1.id,
            CASE WHEN i_1.price_usd > 0 AND r.operative_rate > 0
                 THEN round_to_step(i_1.price_usd * r.operative_rate, rounding.step, rounding.mode) END AS price_ves,
            r.bcv_rate
           FROM inventory_items i_1
             CROSS JOIN current_exchange_rates r
             CROSS JOIN rounding
        )
 SELECT i.id,
    i.sku,
    i.brand,
    i.description,
    i.category,
    i.unit,
    i.source_cost_ref,
    i.source_stock_imported,
    i.source_alert,
    i.source_price_status,
    i.needs_review,
    i.cost_missing,
    i.product_id,
    l.id AS location_id,
    l.code AS location_code,
    l.name AS location_name,
    COALESCE(s.quantity_on_hand, (0)::numeric) AS quantity_on_hand,
    GREATEST(COALESCE(s.quantity_on_hand, (0)::numeric), (0)::numeric) AS sellable_quantity,
    i.display_name AS catalog_product_name,
    i.price_usd AS cash_usd_base_price,
    pr.price_ves AS current_price_ves,
    CASE WHEN pr.bcv_rate > 0 THEN pr.price_ves / pr.bcv_rate END AS current_ref_bcv,
    i.imported_at,
    i.updated_at,
    i.alt_codes,
    i.display_name,
    i.price_usd,
    i.price_updated_at,
    i.image_url
   FROM inventory_items i
     CROSS JOIN locations l
     LEFT JOIN stock s ON s.inventory_item_id = i.id AND s.location_id = l.id
     LEFT JOIN priced pr ON pr.id = i.id
  WHERE i.active = true AND l.active = true;

-- Catálogo visual, cotizador general y comparador de aceites: ahora leen el inventario.
create or replace function public.get_catalog_snapshot()
returns table(id uuid, name text, category text, available boolean, active boolean, cash_usd_base_price numeric,
  current_price_ves numeric, current_ref_bcv numeric, image_url text, catalog_source text, catalog_synced_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id, coalesce(c.display_name, c.description), c.category, c.quantity_on_hand > 0, true,
         c.price_usd, c.current_price_ves, c.current_ref_bcv, c.image_url, 'Inventario', c.price_updated_at
  from public.inventory_current c
  where c.location_code = 'CABUDARE' and c.quantity_on_hand > 0
  order by c.category nulls last, coalesce(c.display_name, c.description);
$$;

create or replace function public.get_pricing_sync_status()
returns table(catalog_synced_at timestamptz, catalog_products bigint, bcv_rate numeric, bcv_effective_at timestamptz,
  operative_rate numeric, operative_effective_at timestamptz)
language sql
stable
security definer
set search_path to ''
as $$select
 now(),
 (select count(*) from public.inventory_items where active and price_usd > 0),
 (select bcv_rate from public.current_exchange_rates),
 (select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
 (select operative_rate from public.current_exchange_rates),
 (select last_verified_at from public.integration_sync_state where source_key='notion_rates')$$;

create or replace function public.assert_notion_pricing_fresh()
returns void
language plpgsql
security definer
set search_path to ''
as $$declare rates_at timestamptz; bcv numeric; operative numeric;
begin
 select last_verified_at into rates_at from public.integration_sync_state where source_key='notion_rates';
 if rates_at is null or rates_at<now()-interval '3 hours' or rates_at>now()+interval '5 minutes' then raise exception 'Tasas de Notion desactualizadas: comprueba su sincronización';end if;
 select bcv_rate,operative_rate into bcv,operative from public.current_exchange_rates;
 if bcv is null or bcv<=0 or operative is null or operative<=0 then raise exception 'Faltan tasas BCV u operativa válidas';end if;
end$$;

-- Vender desde inventario toma el precio del artículo.
create or replace function public.add_inventory_product_item(p_order_id uuid, p_inventory_item_id uuid, p_quantity numeric, p_manual_unit_ref numeric DEFAULT NULL::numeric, p_business_area text DEFAULT 'OIL_CHANGE'::text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item public.inventory_items;
  v_order public.orders;
  v_location uuid;
  v_stock numeric;
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_unit_ref numeric;
  v_cash_usd numeric;
  v_order_item uuid;
  v_area text := upper(coalesce(p_business_area,'OIL_CHANGE'));
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad de inventario inválida'; end if;
  if v_area not in ('OIL_CHANGE','STORE') then raise exception 'Área de inventario inválida'; end if;

  select * into v_order from public.orders where id=p_order_id for update;
  select * into v_item from public.inventory_items where id=p_inventory_item_id and active=true;
  if v_item.id is null then raise exception 'Producto de inventario no encontrado'; end if;
  if v_item.needs_review then raise exception 'Este SKU requiere revisión de inventario antes de venderse: %', v_item.sku; end if;

  v_location := v_order.location_id;
  if v_location is null then
    select id into v_location from public.locations where code='CABUDARE' and active=true limit 1;
    if v_location is null then select id into v_location from public.locations where active=true order by created_at limit 1; end if;
    update public.orders set location_id=v_location where id=p_order_id;
  end if;
  if v_location is null then raise exception 'No hay sede activa para descontar inventario'; end if;

  perform 1 from public.inventory_items where id=v_item.id for update;
  v_stock := public.inventory_quantity(v_item.id,v_location);
  if v_stock < p_quantity then raise exception 'Stock insuficiente para %: el sistema tiene %, pediste %. Si llegó mercancía nueva, cárgala primero en Inventario (Ajustar conteo) y vuelve a cobrar.', v_item.sku, v_stock, p_quantity; end if;

  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';

  if p_manual_unit_ref is not null then
    if p_manual_unit_ref <= 0 then raise exception 'El precio manual debe ser mayor que cero'; end if;
    v_unit_ref := p_manual_unit_ref;
    v_unit_ves := public.round_to_step(v_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_cash_usd := null;
  else
    if coalesce(v_item.price_usd,0) <= 0 then raise exception 'El artículo % no tiene precio. Cárgalo en Inventario o escribe el precio REF.', v_item.sku; end if;
    perform public.assert_notion_pricing_fresh();
    v_cash_usd := v_item.price_usd;
    v_unit_ves := public.round_to_step(v_item.price_usd*v_op,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_unit_ref := v_unit_ves/v_bcv;
  end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,inventory_item_id,inventory_location_id,
    quantity,pricing_mode,base_ref_amount,customer_ref_amount,
    charged_ves_amount,charged_ref_amount,cash_usd_unit_snapshot,cash_usd_special_total,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT',v_area,v_item.sku||' · '||coalesce(v_item.display_name,v_item.description),v_item.product_id,v_item.id,v_location,
    p_quantity,'STANDARD',round(v_unit_ref*p_quantity,4),round(v_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(v_unit_ref*p_quantity,4),v_cash_usd,
    case when v_cash_usd is not null then round(v_cash_usd*p_quantity,4) else null end,
    v_bcv,v_op,false
  ) returning id into v_order_item;
  return v_order_item;
end;
$function$;

-- La lista vieja ya no vende por su cuenta: si un producto no tiene artículo, se bloquea siempre.
create or replace function lubricenter_private.assert_stock_sale_allowed(p_kind text, p_label text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'CATALOG' then
    raise exception 'INVENTARIO_ÚNICO: "%" no está en el inventario. Búscalo en Inventario o pide que lo creen allí.', p_label;
  end if;
  if coalesce((select value #>> '{}' from public.app_settings where key = 'inventory_strict_mode'), 'false') <> 'true' then
    return;
  end if;
  if p_kind = 'MANUAL' then
    if not lubricenter_private.staff_can('inventory.override') then
      raise exception 'INVENTARIO_ESTRICTO: solo un administrador puede vender "%" sin descontar inventario.', p_label
        using errcode = '42501';
    end if;
    insert into public.audit_events(event_type, entity_type, data, actor_id)
    values ('inventory.override_sale', 'order_item', jsonb_build_object('description', p_label), auth.uid());
  end if;
end;
$$;

-- Crear o editar un artículo (nombre, precio, foto, códigos). La existencia se cambia con conteos o compras.
create or replace function lubricenter_private.inventory_save_item(
  p_id uuid, p_sku text, p_display_name text, p_brand text, p_category text, p_unit text,
  p_price_usd numeric, p_image_url text, p_alt_codes text[], p_active boolean,
  p_expected_updated_at timestamptz DEFAULT NULL)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.inventory_items; v_id uuid;
  v_sku text := upper(btrim(coalesce(p_sku,'')));
  v_name text := btrim(coalesce(p_display_name,''));
  v_photo text := nullif(btrim(coalesce(p_image_url,'')),'');
  v_codes text[] := coalesce((select array_agg(distinct btrim(c)) from unnest(coalesce(p_alt_codes,'{}')) c where btrim(c) <> ''), '{}');
begin
  perform lubricenter_private.require_order_admin();
  if length(v_sku) < 2 or length(v_sku) > 60 then raise exception 'Código (SKU) inválido'; end if;
  if length(v_name) < 2 or length(v_name) > 180 then raise exception 'Nombre de venta inválido: usa entre 2 y 180 caracteres'; end if;
  if p_price_usd is not null and (p_price_usd < 0 or p_price_usd > 1000000 or p_price_usd::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Precio USD inválido'; end if;
  if v_photo is not null and (length(v_photo) > 1800 or v_photo !~* '^https://[^[:space:]]+$') then
    raise exception 'La foto debe ser una URL HTTPS válida'; end if;
  if exists(select 1 from public.inventory_items where upper(sku)=v_sku and id is distinct from p_id and merged_into is null) then
    raise exception 'Ya existe un artículo con el código %', v_sku; end if;

  if p_id is null then
    insert into public.inventory_items(sku, display_name, description, brand, category, unit, price_usd, price_updated_at,
      image_url, alt_codes, active, needs_review, cost_missing, source_name, imported_at, updated_at)
    values (v_sku, v_name, v_name, nullif(btrim(coalesce(p_brand,'')),''), nullif(btrim(coalesce(p_category,'')),''),
      coalesce(nullif(btrim(coalesce(p_unit,'')),''),'UND'), nullif(p_price_usd,0), case when nullif(p_price_usd,0) is not null then now() end,
      v_photo, v_codes, coalesce(p_active,true), false, true, 'Lubricenter OS', now(), now())
    returning id into v_id;
  else
    select * into v_old from public.inventory_items where id=p_id for update;
    if v_old.id is null then raise exception 'Artículo no encontrado'; end if;
    if p_expected_updated_at is not null and v_old.updated_at is distinct from p_expected_updated_at then
      raise exception 'Otra persona modificó este artículo. Recarga antes de guardar.'; end if;
    update public.inventory_items set
      sku=v_sku, display_name=v_name, brand=nullif(btrim(coalesce(p_brand,'')),''),
      category=nullif(btrim(coalesce(p_category,'')),''), unit=coalesce(nullif(btrim(coalesce(p_unit,'')),''),unit),
      price_usd=nullif(p_price_usd,0),
      price_updated_at=case when nullif(p_price_usd,0) is distinct from v_old.price_usd then now() else v_old.price_updated_at end,
      image_url=v_photo, alt_codes=v_codes, active=coalesce(p_active,v_old.active), updated_at=now()
    where id=p_id;
    v_id := p_id;
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data, actor_id)
  values ('inventory.item_saved','inventory_item',v_id,
    jsonb_build_object('sku',v_sku,'name',v_name,'price_usd',p_price_usd,
      'before', case when v_old.id is null then null else jsonb_build_object('sku',v_old.sku,'name',v_old.display_name,'price_usd',v_old.price_usd,'active',v_old.active) end),
    auth.uid());
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.inventory_save_item(
  p_id uuid, p_sku text, p_display_name text, p_brand text, p_category text, p_unit text,
  p_price_usd numeric, p_image_url text, p_alt_codes text[], p_active boolean,
  p_expected_updated_at timestamptz DEFAULT NULL)
returns jsonb language sql set search_path = '' as
$$select lubricenter_private.inventory_save_item(p_id,p_sku,p_display_name,p_brand,p_category,p_unit,p_price_usd,p_image_url,p_alt_codes,p_active,p_expected_updated_at)$$;

-- Mismo precio para varios artículos a la vez (por ejemplo, todos los filtros Wix de aceite).
create or replace function lubricenter_private.inventory_set_price_bulk(p_item_ids uuid[], p_price_usd numeric)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  perform lubricenter_private.require_order_admin();
  if p_price_usd is null or p_price_usd <= 0 or p_price_usd > 1000000 then raise exception 'Precio USD inválido'; end if;
  if coalesce(array_length(p_item_ids,1),0) = 0 or array_length(p_item_ids,1) > 500 then raise exception 'Selecciona entre 1 y 500 artículos'; end if;
  update public.inventory_items set price_usd=p_price_usd, price_updated_at=now(), updated_at=now()
  where id = any(p_item_ids) and active;
  get diagnostics n = row_count;
  insert into public.audit_events(event_type, entity_type, data, actor_id)
  values ('inventory.price_bulk','inventory_item', jsonb_build_object('items', p_item_ids, 'price_usd', p_price_usd, 'updated', n), auth.uid());
  return n;
end;
$$;

create or replace function public.inventory_set_price_bulk(p_item_ids uuid[], p_price_usd numeric)
returns integer language sql set search_path = '' as
$$select lubricenter_private.inventory_set_price_bulk(p_item_ids, p_price_usd)$$;

revoke all on function lubricenter_private.inventory_save_item(uuid,text,text,text,text,text,numeric,text,text[],boolean,timestamptz) from public, anon;
revoke all on function lubricenter_private.inventory_set_price_bulk(uuid[],numeric) from public, anon;
grant execute on function lubricenter_private.inventory_save_item(uuid,text,text,text,text,text,numeric,text,text[],boolean,timestamptz) to authenticated;
grant execute on function lubricenter_private.inventory_set_price_bulk(uuid[],numeric) to authenticated;
revoke all on function public.inventory_save_item(uuid,text,text,text,text,text,numeric,text,text[],boolean,timestamptz) from public, anon;
revoke all on function public.inventory_set_price_bulk(uuid[],numeric) from public, anon;
grant execute on function public.inventory_save_item(uuid,text,text,text,text,text,numeric,text,text[],boolean,timestamptz) to authenticated;
grant execute on function public.inventory_set_price_bulk(uuid[],numeric) to authenticated;

-- get_inventory_snapshot devuelve también precio, nombre y foto.
drop function if exists public.get_inventory_snapshot(text);
create function public.get_inventory_snapshot(p_location_code text DEFAULT 'CABUDARE'::text)
returns table(id uuid, sku text, brand text, description text, category text, unit text, source_cost_ref numeric,
  source_alert text, needs_review boolean, cost_missing boolean, location_code text, quantity_on_hand numeric,
  sellable_quantity numeric, product_id uuid, catalog_product_name text, current_price_ves numeric,
  current_ref_bcv numeric, alt_codes text[], display_name text, price_usd numeric, price_updated_at timestamptz,
  image_url text, updated_at timestamptz)
language sql
security definer
set search_path to 'public'
as $$
  select i.id,i.sku,i.brand,i.description,i.category,i.unit,i.source_cost_ref,i.source_alert,
         i.needs_review,i.cost_missing,i.location_code,i.quantity_on_hand,i.sellable_quantity,
         i.product_id,i.catalog_product_name,i.current_price_ves,i.current_ref_bcv,i.alt_codes,
         i.display_name,i.price_usd,i.price_updated_at,i.image_url,i.updated_at
  from public.inventory_current i
  where i.location_code = p_location_code
  order by i.category nulls last, i.brand nulls last, i.sku;
$$;
revoke all on function public.get_inventory_snapshot(text) from public, anon;
grant execute on function public.get_inventory_snapshot(text) to authenticated, service_role;

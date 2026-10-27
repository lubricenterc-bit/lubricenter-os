-- Inventario único: todas las ventas de mercancía descuentan del mismo artículo.
--
-- inventory_items es la única fuente de stock. products queda como lista de precios:
-- cada producto se vende a través de un artículo enlazado (inventory_items.product_id).
-- Con inventory_strict_mode = true:
--   * un producto de catálogo sin artículo enlazado no se puede vender;
--   * una línea escrita a mano (MANUAL_NO_STOCK) solo la puede registrar quien tenga
--     el permiso inventory.override, y queda en auditoría.
-- La validación de stock suficiente ya existía en add_inventory_product_item y en el cierre.
--
-- Nace apagado: se enciende después de cargar el conteo físico
--   update public.app_settings set value='true'::jsonb where key='inventory_strict_mode';

alter table public.inventory_items
  add column if not exists merged_into uuid references public.inventory_items(id),
  add column if not exists last_counted_at timestamptz;

comment on column public.inventory_items.merged_into is
  'Artículo que absorbió a este al unificar duplicados. Las órdenes viejas siguen apuntando aquí; su stock se trasladó.';
comment on column public.inventory_items.last_counted_at is
  'Fecha del último conteo físico que fijó la existencia de este artículo.';

insert into public.app_settings(key, value, updated_at)
values ('inventory_strict_mode', 'false'::jsonb, now())
on conflict (key) do nothing;

insert into public.staff_permission_catalog(key, area, label, explanation, recommended, sort_order)
values ('inventory.override', 'Inventario y compras', 'Vender sin inventario',
        'Registrar una línea escrita a mano que no descuenta stock, con auditoría', false, 34)
on conflict (key) do nothing;

create or replace function lubricenter_private.assert_stock_sale_allowed(p_kind text, p_label text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select value #>> '{}' from public.app_settings where key = 'inventory_strict_mode'), 'false') <> 'true' then
    return;
  end if;
  if p_kind = 'CATALOG' then
    raise exception 'INVENTARIO_ESTRICTO: "%" no tiene artículo de inventario enlazado. Un administrador debe enlazarlo antes de venderlo.', p_label;
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
revoke all on function lubricenter_private.assert_stock_sale_allowed(text, text) from public, anon;
grant execute on function lubricenter_private.assert_stock_sale_allowed(text, text) to authenticated, service_role;

-- Producto de catálogo: si tiene un artículo enlazado vende desde inventario (sin cambios);
-- si no lo tiene, el modo estricto lo bloquea.
create or replace function public.add_product_item(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_reveal_cash_price boolean DEFAULT false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock_item uuid; v_linked uuid;
  v_product public.products;
  v_bcv numeric; v_op numeric; v_step numeric; v_mode text;
  v_unit_ves numeric; v_unit_ref numeric; v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  v_stock_item:=lubricenter_private.catalog_stock_item(p_order_id,p_product_id);
  if v_stock_item is not null then
    v_linked:=public.add_inventory_product_item(p_order_id,v_stock_item,p_quantity,null,'STORE');
    if p_reveal_cash_price then update public.order_items set cash_price_revealed=true,pricing_mode='CASH_USD_SPECIAL' where id=v_linked; end if;
    return v_linked;
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  select * into v_product from public.products where id=p_product_id and active=true and available=true;
  if v_product.id is null then raise exception 'Producto no encontrado o no disponible'; end if;
  perform lubricenter_private.assert_stock_sale_allowed('CATALOG', v_product.name);
  if v_product.catalog_source='Notion · Nuestros Productos' then perform public.assert_notion_pricing_fresh(); end if;
  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';
  v_unit_ves := public.round_to_step(v_product.cash_usd_base_price * v_op, coalesce(v_step,10), coalesce(v_mode,'nearest'));
  v_unit_ref := v_unit_ves / v_bcv;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,quantity,pricing_mode,
    charged_ves_amount,charged_ref_amount,cash_usd_unit_snapshot,cash_usd_special_total,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',coalesce(v_product.filter_code || ' · ','') || v_product.name,v_product.id,p_quantity,
    case when p_reveal_cash_price then 'CASH_USD_SPECIAL' else 'STANDARD' end,
    round(v_unit_ves * p_quantity,2), round(v_unit_ref * p_quantity,4),v_product.cash_usd_base_price,
    round(v_product.cash_usd_base_price * p_quantity,4),v_bcv,v_op,p_reveal_cash_price
  ) returning id into v_item_id;
  return v_item_id;
end;
$$;

create or replace function public.add_catalog_product_item_override(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_manual_unit_ref numeric DEFAULT NULL::numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock_item uuid; v_linked uuid;
  v_product public.products;
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_unit_ref numeric;
  v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  v_stock_item:=lubricenter_private.catalog_stock_item(p_order_id,p_product_id);
  if v_stock_item is not null then
    v_linked:=public.add_inventory_product_item(p_order_id,v_stock_item,p_quantity,p_manual_unit_ref,'STORE');
    return v_linked;
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;

  select * into v_product from public.products where id=p_product_id and active=true and available=true;
  if v_product.id is null then raise exception 'Producto no encontrado o no disponible'; end if;
  perform lubricenter_private.assert_stock_sale_allowed('CATALOG', v_product.name);

  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';

  if p_manual_unit_ref is not null then
    if p_manual_unit_ref <= 0 then raise exception 'El precio manual debe ser mayor que cero'; end if;
    v_unit_ref := p_manual_unit_ref;
    v_unit_ves := public.round_to_step(v_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));
  else
    if v_product.catalog_source='Notion · Nuestros Productos' then perform public.assert_notion_pricing_fresh(); end if;
    v_unit_ves := public.round_to_step(v_product.cash_usd_base_price*v_op,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_unit_ref := v_unit_ves/v_bcv;
  end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    cash_usd_unit_snapshot,cash_usd_special_total,bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',v_product.name,v_product.id,p_quantity,
    case when p_manual_unit_ref is null then 'STANDARD' else 'MANUAL_OVERRIDE' end,
    round(v_unit_ref*p_quantity,4),round(v_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(v_unit_ref*p_quantity,4),
    v_product.cash_usd_base_price,round(v_product.cash_usd_base_price*p_quantity,4),
    v_bcv,v_op,false
  ) returning id into v_item_id;
  return v_item_id;
end;
$$;

create or replace function public.add_manual_product_item(p_order_id uuid, p_description text, p_quantity numeric, p_unit_ref numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if nullif(trim(p_description),'') is null then raise exception 'Escribe el producto'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  if p_unit_ref is null or p_unit_ref <= 0 then raise exception 'El precio REF debe ser mayor que cero'; end if;
  perform lubricenter_private.assert_stock_sale_allowed('MANUAL', trim(p_description));

  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';
  v_unit_ves := public.round_to_step(p_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));

  insert into public.order_items(
    order_id,item_type,business_area,description,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',trim(p_description),p_quantity,'MANUAL_NO_STOCK',
    round(p_unit_ref*p_quantity,4),round(p_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(p_unit_ref*p_quantity,4),
    v_bcv,v_op,false
  ) returning id into v_item_id;
  return v_item_id;
end;
$$;

-- Un artículo fusionado ya no se ofrece para vender: su stock vive en el artículo destino.
create or replace function lubricenter_private.catalog_stock_item(p_order uuid, p_product uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare n int; iid uuid;
begin
 perform public.require_auth();
 select count(*),(array_agg(id order by id))[1] into n,iid
   from public.inventory_items where product_id=p_product and active and merged_into is null;
 if n>1 then raise exception 'Este producto de catálogo corresponde a varios SKU. Selecciona el código exacto desde inventario'; end if;
 return iid;
end
$$;

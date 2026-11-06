-- Sin costo se guarda como 0 con cost_missing = true (average_cost_ref es NOT NULL, igual que el resto del inventario).

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
      coalesce(v_cost, 0), v_cost is null, v_photo, v_codes, v_active, coalesce(p_needs_review,false), v_catalog, 'Lubricenter OS', now(), now())
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
      average_cost_ref=coalesce(v_cost, 0), cost_missing=(v_cost is null),
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

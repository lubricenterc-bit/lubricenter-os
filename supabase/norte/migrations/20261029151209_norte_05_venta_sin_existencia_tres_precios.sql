-- 1) Vender sin existencia cuando el modo estricto está apagado (la existencia puede quedar negativa y se corrige con el conteo)
do $$
declare r record; d text; nd text;
  cond text := ' and coalesce((select s.value #>> ''{}'' from public.app_settings s where s.key=''inventory_strict_mode''),''false'')=''true''';
begin
  for r in select p.oid from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('add_inventory_product_item','add_inventory_bonus_item','consume_inventory_on_order_close') loop
    d := pg_get_functiondef(r.oid);
    nd := replace(d, 'if v_stock < p_quantity then', 'if v_stock < p_quantity'||cond||' then');
    nd := replace(nd, 'if v_stock < r.quantity then', 'if v_stock < r.quantity'||cond||' then');
    if nd = d then raise exception 'No se encontró la validación de stock en %', r.oid::regprocedure; end if;
    execute nd;
  end loop;
end $$;

-- 2) En Norte los precios ya están en dólares: la tasa operativa es igual a la BCV
create or replace function public.sync_notion_pricing_service(p_bcv numeric, p_operative numeric, p_products jsonb, p_synced_at timestamp with time zone default now())
 returns jsonb language plpgsql security definer set search_path to '' as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Esta función es exclusiva del sincronizador del servidor';
  end if;
  -- Norte: un solo tipo de cambio (BCV). Los tres precios por artículo ya marcan la diferencia.
  return lubricenter_private.apply_notion_pricing(p_bcv, p_bcv, p_products, p_synced_at);
end
$function$;
insert into public.exchange_rates(rate_type,value,effective_at,source) values ('OPERATIVE',888.8909,now(),'Norte: igual a BCV');

-- 3) Tres precios: vista y guardado
create or replace view public.inventory_current with (security_invoker=true) as
 WITH stock AS (
   SELECT inventory_movements.inventory_item_id, inventory_movements.location_id, sum(inventory_movements.quantity_delta) AS quantity_on_hand
   FROM inventory_movements GROUP BY inventory_movements.inventory_item_id, inventory_movements.location_id
 ), rounding AS (
   SELECT COALESCE((SELECT (app_settings.value #>> '{}'::text[])::numeric FROM app_settings WHERE app_settings.key = 'price_rounding_step'::text), 10::numeric) AS step,
          COALESCE((SELECT app_settings.value #>> '{}'::text[] FROM app_settings WHERE app_settings.key = 'price_rounding_mode'::text), 'nearest'::text) AS mode
 ), priced AS (
   SELECT i_1.id,
     CASE WHEN i_1.price_usd > 0::numeric AND r.operative_rate > 0::numeric THEN round_to_step(i_1.price_usd * r.operative_rate, rounding.step, rounding.mode) ELSE NULL::numeric END AS price_ves,
     r.bcv_rate
   FROM inventory_items i_1 CROSS JOIN current_exchange_rates r CROSS JOIN rounding
 )
 SELECT i.id, i.sku, i.brand, i.description, i.category, i.unit, i.source_cost_ref, i.source_stock_imported, i.source_alert, i.source_price_status,
   i.needs_review, i.cost_missing, i.product_id, l.id AS location_id, l.code AS location_code, l.name AS location_name,
   COALESCE(s.quantity_on_hand, 0::numeric) AS quantity_on_hand,
   GREATEST(COALESCE(s.quantity_on_hand, 0::numeric), 0::numeric) AS sellable_quantity,
   i.display_name AS catalog_product_name, i.price_usd AS cash_usd_base_price, pr.price_ves AS current_price_ves,
   CASE WHEN pr.bcv_rate > 0::numeric THEN pr.price_ves / pr.bcv_rate ELSE NULL::numeric END AS current_ref_bcv,
   i.imported_at, i.updated_at, i.alt_codes, i.display_name, i.price_usd, i.price_updated_at, i.image_url,
   i.price_cashea_usd, i.price_divisas_usd
 FROM inventory_items i CROSS JOIN locations l
   LEFT JOIN stock s ON s.inventory_item_id = i.id AND s.location_id = l.id
   LEFT JOIN priced pr ON pr.id = i.id
 WHERE i.active = true AND l.active = true;

create or replace function lubricenter_private.inventory_set_tier_prices(p_id uuid, p_contado numeric, p_cashea numeric, p_divisas numeric)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v public.inventory_items;
begin
  if not (lubricenter_private.is_order_admin() or lubricenter_private.staff_can('catalog.manage')) then
    raise exception 'No tienes permiso para cambiar precios' using errcode='42501';
  end if;
  if (p_contado is not null and (p_contado < 0 or p_contado > 1000000)) or (p_cashea is not null and (p_cashea < 0 or p_cashea > 1000000))
     or (p_divisas is not null and (p_divisas < 0 or p_divisas > 1000000)) then
    raise exception 'Precio inválido';
  end if;
  update public.inventory_items set
    price_usd = nullif(p_contado,0), price_cashea_usd = nullif(p_cashea,0), price_divisas_usd = nullif(p_divisas,0),
    price_updated_at = now(), updated_at = now()
  where id = p_id and merged_into is null
  returning * into v;
  if v.id is null then raise exception 'Artículo no encontrado'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values ('inventory.tier_prices','inventory_item',v.id,jsonb_build_object('contado',v.price_usd,'cashea',v.price_cashea_usd,'divisas',v.price_divisas_usd),auth.uid());
  return jsonb_build_object('id',v.id,'price_usd',v.price_usd,'price_cashea_usd',v.price_cashea_usd,'price_divisas_usd',v.price_divisas_usd);
end
$function$;
create or replace function public.inventory_set_tier_prices(p_id uuid, p_contado numeric, p_cashea numeric, p_divisas numeric)
 returns jsonb language sql set search_path to '' as $f$ select lubricenter_private.inventory_set_tier_prices(p_id,p_contado,p_cashea,p_divisas) $f$;
revoke all on function lubricenter_private.inventory_set_tier_prices(uuid,numeric,numeric,numeric) from public, anon;
grant execute on function lubricenter_private.inventory_set_tier_prices(uuid,numeric,numeric,numeric) to authenticated;
revoke all on function public.inventory_set_tier_prices(uuid,numeric,numeric,numeric) from public, anon;
grant execute on function public.inventory_set_tier_prices(uuid,numeric,numeric,numeric) to authenticated;
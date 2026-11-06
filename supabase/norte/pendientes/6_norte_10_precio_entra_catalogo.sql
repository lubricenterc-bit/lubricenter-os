-- Norte (El Cují), P-07: al guardar los tres precios, el artículo entra al catálogo si tiene precio de contado
-- y sale si se lo quitan (el catálogo exige precio de venta). Lo demás es igual a norte_05.
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
    in_catalog = (nullif(p_contado,0) is not null),
    price_updated_at = now(), updated_at = now()
  where id = p_id and merged_into is null
  returning * into v;
  if v.id is null then raise exception 'Artículo no encontrado'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values ('inventory.tier_prices','inventory_item',v.id,jsonb_build_object('contado',v.price_usd,'cashea',v.price_cashea_usd,'divisas',v.price_divisas_usd,'in_catalog',v.in_catalog),auth.uid());
  return jsonb_build_object('id',v.id,'price_usd',v.price_usd,'price_cashea_usd',v.price_cashea_usd,'price_divisas_usd',v.price_divisas_usd,'in_catalog',v.in_catalog);
end
$function$;
revoke all on function lubricenter_private.inventory_set_tier_prices(uuid,numeric,numeric,numeric) from public, anon;
grant execute on function lubricenter_private.inventory_set_tier_prices(uuid,numeric,numeric,numeric) to authenticated;

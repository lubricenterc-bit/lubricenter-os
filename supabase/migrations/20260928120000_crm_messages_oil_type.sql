-- Keep the oil classification with the billed service, not in free-form CRM text.
alter table public.order_items
  add column if not exists oil_base_type text
  check (oil_base_type in ('MINERAL', 'SEMISYNTHETIC', 'SYNTHETIC'));

-- The existing package function remains available to older clients. The new
-- wrapper saves the classification in the same transaction as the package.
create or replace function public.add_oil_change_package_with_type(
  p_order_id uuid, p_odometer integer, p_description text,
  p_service_base_ref numeric, p_service_customer_ref numeric,
  p_oil_source text, p_oil_inventory_item_id uuid, p_oil_product_id uuid,
  p_oil_description text, p_oil_units numeric, p_oil_unit_ref numeric,
  p_oil_brand text, p_oil_viscosity text, p_oil_quantity_liters numeric,
  p_filter_source text, p_filter_inventory_item_id uuid, p_filter_product_id uuid,
  p_filter_description text, p_filter_units numeric, p_filter_unit_ref numeric,
  p_filter_code text, p_next_km_interval integer, p_next_months integer,
  p_oil_base_type text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_item uuid;
begin
  perform public.require_auth();
  if p_oil_base_type not in ('MINERAL', 'SEMISYNTHETIC', 'SYNTHETIC') or p_oil_base_type is null then
    raise exception 'Selecciona el tipo de aceite';
  end if;
  v_item := public.add_oil_change_package_flexible(
    p_order_id, p_odometer, p_description, p_service_base_ref, p_service_customer_ref,
    p_oil_source, p_oil_inventory_item_id, p_oil_product_id, p_oil_description,
    p_oil_units, p_oil_unit_ref, p_oil_brand, p_oil_viscosity, p_oil_quantity_liters,
    p_filter_source, p_filter_inventory_item_id, p_filter_product_id,
    p_filter_description, p_filter_units, p_filter_unit_ref, p_filter_code,
    p_next_km_interval, p_next_months
  );
  update public.order_items set oil_base_type = p_oil_base_type
  where id = v_item and order_id = p_order_id and business_area = 'OIL_CHANGE';
  if not found then raise exception 'No se encontró el servicio de aceite creado'; end if;
  return v_item;
end;
$$;
revoke all on function public.add_oil_change_package_with_type(uuid,integer,text,numeric,numeric,text,uuid,uuid,text,numeric,numeric,text,text,numeric,text,uuid,uuid,text,numeric,numeric,text,integer,integer,text) from public, anon;
grant execute on function public.add_oil_change_package_with_type(uuid,integer,text,numeric,numeric,text,uuid,uuid,text,numeric,numeric,text,text,numeric,text,uuid,uuid,text,numeric,numeric,text,integer,integer,text) to authenticated;

create or replace function public.build_post_service_message(p_order_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_oil public.order_items%rowtype;
  v_name text;
  v_vehicle text;
  v_plate text;
  v_main text := '';
  v_extra text := '';
  v_bonus text := '';
  v_notes text := '';
  v_health text := '';
  v_next text := '';
  v_oil_type text := '';
  v_oil_brand_display text := '';
  v_oil_label text;
  v_services text;
  v_products text;
  v_included text;
  v_bonus_lines text;
  v_physical_bonuses text;
  v_template text;
  v_message text;
  v_next_km integer;
  v_next_date date;
  nl text := chr(10);
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;
  select coalesce(nullif(trim(name), ''), 'cliente') into v_name from public.customers where id = v_order.customer_id;
  select nullif(trim(concat_ws(' ', make, model)), ''), plate into v_vehicle, v_plate
  from public.vehicles where id = v_order.vehicle_id;
  v_vehicle := coalesce(v_vehicle, 'vehículo');
  if nullif(trim(coalesce(v_plate, '')), '') is not null then
    v_vehicle := v_vehicle || ' (' || trim(v_plate) || ')';
  end if;

  select * into v_oil from public.order_items
  where order_id = p_order_id and business_area = 'OIL_CHANGE' and item_type = 'SERVICE'
  order by created_at desc limit 1;

  select string_agg('• ' || description, nl order by charged_ves_amount desc, created_at)
  into v_services from (
    select description, charged_ves_amount, created_at from public.order_items
    where order_id = p_order_id and item_type = 'SERVICE'
      and (v_oil.id is null or id <> v_oil.id)
    order by charged_ves_amount desc, created_at limit 3
  ) s;

  select string_agg('• ' || description || case when quantity <> 1 then ' ×' || trim(to_char(quantity, 'FM999999990.##')) else '' end, nl order by charged_ves_amount desc, created_at)
  into v_products from (
    select description, quantity, charged_ves_amount, created_at from public.order_items
    where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode <> 'BONUS'
    order by charged_ves_amount desc, created_at limit 3
  ) p;

  if v_oil.id is not null then
    v_oil_type := case v_oil.oil_base_type
      when 'MINERAL' then 'mineral'
      when 'SEMISYNTHETIC' then 'semisintético'
      when 'SYNTHETIC' then 'full sintético'
      else case
        when coalesce(v_oil.oil_brand, '') ~* 'semi[[:space:]-]*sint' then 'semisintético'
        when coalesce(v_oil.oil_brand, '') ~* 'sint[eé]tico|synthetic' then 'full sintético'
        when coalesce(v_oil.oil_brand, '') ~* 'mineral' then 'mineral'
        else '' end end;
    v_oil_brand_display := trim(regexp_replace(regexp_replace(
      coalesce(v_oil.oil_brand, ''),
      '[0-9]{1,2}[[:space:]]*W[[:space:]]*[-/]?[[:space:]]*[0-9]{2}', ' ', 'gi'),
      'semi[[:space:]-]*sint[eé]tico|full[[:space:]-]*sint[eé]tico|sint[eé]tico|synthetic|mineral', ' ', 'gi'));
    v_oil_brand_display := trim(regexp_replace(v_oil_brand_display, '[[:space:]]+', ' ', 'g'));
    v_oil_label := nullif(trim(concat_ws(' · ',
      case when nullif(v_oil_brand_display, '') is not null then '*' || v_oil_brand_display || '*' end,
      case when nullif(trim(coalesce(v_oil.oil_viscosity, '')), '') is not null then '*' || trim(v_oil.oil_viscosity) || '*' end,
      case when nullif(v_oil_type, '') is not null then '*' || v_oil_type || '*' end
    )), '');
    v_main := '🛢️ *Cambio de aceite*' || nl || '• *Aceite:*' ||
      case when v_oil_label is not null then ' ' || v_oil_label else ' registrado' end;
    if nullif(trim(coalesce(v_oil.oil_filter_code, '')), '') is not null then
      v_main := v_main || nl || '• *Filtro de aceite:* ' || trim(v_oil.oil_filter_code);
    end if;
    -- Other paid products in an oil package are the oil and filter themselves.
    -- Their details are already above; extra work is listed separately below.
    v_extra := coalesce(v_services, '');
  else
    v_main := '🛠️ *Trabajos realizados*' || nl || coalesce(v_services, v_products, '• Atendimos tu vehículo');
    if v_services is not null then v_extra := coalesce(v_products, ''); end if;
  end if;

  select string_agg('• ' || trim(x), nl order by ord) into v_included
  from unnest(coalesce(v_order.crm_additional_services, '{}'::text[])) with ordinality as a(x, ord)
  where nullif(trim(x), '') is not null;
  if v_included is not null then
    v_extra := concat_ws(nl, nullif(v_extra, ''), v_included);
  end if;
  if nullif(v_extra, '') is not null then v_extra := '🔧 *También hicimos*' || nl || v_extra; end if;

  select string_agg('• ' || trim(x), nl order by ord) into v_bonus_lines
  from unnest(coalesce(v_order.crm_bonuses, '{}'::text[])) with ordinality as a(x, ord)
  where nullif(trim(x), '') is not null;
  select string_agg('• ' || regexp_replace(description, '^🎁 Cortesía · ', ''), nl order by created_at)
  into v_physical_bonuses from public.order_items
  where order_id = p_order_id and item_type = 'PRODUCT' and pricing_mode = 'BONUS';
  v_bonus_lines := concat_ws(nl, v_bonus_lines, v_physical_bonuses);
  if nullif(v_bonus_lines, '') is not null then v_bonus := '🎁 *De cortesía*' || nl || v_bonus_lines; end if;

  if nullif(trim(coalesce(v_order.crm_observations, '')), '') is not null then
    v_notes := '📌 *Para tener en cuenta:* ' || trim(v_order.crm_observations);
  end if;
  if v_order.health_status in ('YELLOW', 'RED') then
    v_health := case when v_order.health_status = 'RED' then '⚠️ *Requiere atención:* ' else '⚠️ *Recomendación:* ' end ||
      coalesce(nullif(trim(coalesce(v_order.health_notes, '')), ''), 'Hay una observación pendiente para tu vehículo.');
  end if;

  if v_oil.id is not null then
    v_next_km := v_oil.next_service_odometer;
    v_next_date := v_oil.next_service_date;
  else
    select next_service_odometer, next_service_date into v_next_km, v_next_date
    from public.order_items where order_id = p_order_id and item_type = 'SERVICE'
      and (next_service_odometer is not null or next_service_date is not null)
    order by created_at desc limit 1;
  end if;
  if v_next_km is not null or v_next_date is not null then
    v_next := '📅 *Próxima revisión:* ' ||
      concat_ws(' o ',
        case when v_next_km is not null then 'los ' || to_char(v_next_km, 'FM999G999G999') || ' km' end,
        case when v_next_date is not null then 'el ' || to_char(v_next_date, 'DD/MM/YYYY') end
      ) || '.';
  end if;

  select value #>> '{}' into v_template from public.app_settings where key = 'crm_post_service_template';
  if nullif(v_template, '') is null then
    v_template := 'Hola *{{nombre}}* 👋' || nl || nl ||
      'Gracias por confiar en nosotros para atender tu {{vehiculo_bloque}}. Te dejamos el detalle de lo que hicimos hoy:' || nl || nl ||
      '{{resumen_bloque}}' || nl || nl || '{{adicionales_bloque}}' || nl || nl ||
      '{{bonificaciones_bloque}}' || nl || nl || '{{observaciones_bloque}}' || nl || nl ||
      '{{estado_bloque}}' || nl || nl || '{{proximo_servicio_bloque}}' || nl || nl ||
      '💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.' || nl || nl || '*Lubricenter*';
  end if;

  v_message := replace(v_template, '{{nombre}}', coalesce(v_name, 'cliente'));
  v_message := replace(v_message, '{{orden}}', coalesce(v_order.order_number, ''));
  v_message := replace(v_message, '{{vehiculo}}', v_vehicle);
  v_message := replace(v_message, '{{placa}}', coalesce(v_plate, ''));
  v_message := replace(v_message, '{{vehiculo_bloque}}', '*' || v_vehicle || '*');
  v_message := replace(v_message, '{{resumen_bloque}}', v_main);
  v_message := replace(v_message, '{{adicionales_bloque}}', coalesce(v_extra, ''));
  v_message := replace(v_message, '{{bonificaciones_bloque}}', coalesce(v_bonus, ''));
  v_message := replace(v_message, '{{observaciones_bloque}}', coalesce(v_notes, ''));
  v_message := replace(v_message, '{{estado_bloque}}', coalesce(v_health, ''));
  v_message := replace(v_message, '{{proximo_servicio_bloque}}', coalesce(v_next, ''));
  -- Legacy variables remain usable in templates that an administrator customized.
  v_message := replace(v_message, '{{servicios_bloque}}', coalesce(v_services, ''));
  v_message := replace(v_message, '{{productos_bloque}}', coalesce(v_products, ''));
  v_message := replace(v_message, '{{cambio_aceite_bloque}}', case when v_oil.id is not null then v_main else '' end);
  v_message := replace(v_message, '{{servicios_adicionales_bloque}}', coalesce(v_extra, ''));
  v_message := replace(v_message, '{{servicios_lista}}', coalesce(v_services, ''));
  v_message := replace(v_message, '{{productos_lista}}', coalesce(v_products, ''));
  v_message := replace(v_message, '{{servicios_adicionales_lista}}', coalesce(v_included, ''));
  v_message := replace(v_message, '{{bonificaciones_lista}}', coalesce(v_bonus_lines, ''));
  v_message := replace(v_message, '{{observaciones}}', coalesce(v_order.crm_observations, ''));
  v_message := replace(v_message, '{{kilometraje}}', coalesce(v_oil.service_odometer::text, ''));
  v_message := regexp_replace(v_message, E'\\n[ \\t]+\\n', E'\\n\\n', 'g');
  v_message := regexp_replace(v_message, E'\\n{3,}', E'\\n\\n', 'g');
  return trim(v_message);
end;
$$;
revoke all on function public.build_post_service_message(uuid) from public, anon;
grant execute on function public.build_post_service_message(uuid) to authenticated;

-- Change only the untouched original default. Administrator customizations stay intact.
update public.app_settings
set value = to_jsonb($new$Hola *{{nombre}}* 👋

Gracias por confiar en nosotros para atender tu {{vehiculo_bloque}}. Te dejamos el detalle de lo que hicimos hoy:

{{resumen_bloque}}

{{adicionales_bloque}}

{{bonificaciones_bloque}}

{{observaciones_bloque}}

{{estado_bloque}}

{{proximo_servicio_bloque}}

💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.

*Lubricenter*$new$::text), updated_at = now()
where key = 'crm_post_service_template'
  and value #>> '{}' = $old$Hola *{{nombre}}*! 👋

Gracias por tu visita a *Lubricenter*. Aquí está el resumen de tu servicio:

{{vehiculo_bloque}}
{{servicios_bloque}}
{{productos_bloque}}
{{cambio_aceite_bloque}}
{{servicios_adicionales_bloque}}
{{bonificaciones_bloque}}
{{observaciones_bloque}}
{{estado_bloque}}
{{proximo_servicio_bloque}}

¡Gracias por preferir *Lubricenter*!$old$;

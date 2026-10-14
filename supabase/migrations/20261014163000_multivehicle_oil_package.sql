-- Migration audit before modifying CRM uniqueness or trigger functions.
-- Kept in a private schema: does not expose customer messages to the browser.
CREATE TABLE IF NOT EXISTS lubricenter_private.order_service_migration_backups(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 captured_at timestamptz NOT NULL DEFAULT now(),
 customer_followups_count bigint NOT NULL,
 followups_snapshot jsonb NOT NULL,
 old_trigger_functions jsonb NOT NULL
);
REVOKE ALL ON lubricenter_private.order_service_migration_backups FROM PUBLIC,anon,authenticated;
INSERT INTO lubricenter_private.order_service_migration_backups(
 customer_followups_count,followups_snapshot,old_trigger_functions)
SELECT
 (SELECT count(*) FROM public.customer_followups),
 coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.customer_followups f),'[]'::jsonb),
 jsonb_build_object(
 'queue_post_service_followup',pg_get_functiondef(to_regprocedure('public.queue_post_service_followup()')),
 'capture_service_records_on_close',pg_get_functiondef(to_regprocedure('public.capture_service_records_on_close()')),
 'regenerate_customer_followup_message',pg_get_functiondef(to_regprocedure('public.regenerate_customer_followup_message(uuid)'))
 );

-- One commercial order/Cashea payment, independent oil-change packages per vehicle.
-- All new per-vehicle lines belong to ONE atomic existing product+service transaction.
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS service_vehicle_id uuid
 REFERENCES public.vehicles(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS order_items_service_vehicle_idx
 ON public.order_items(order_id,service_vehicle_id)
 WHERE service_vehicle_id IS NOT NULL;
-- Existing historical orders fall back to orders.vehicle_id when NULL.

CREATE OR REPLACE FUNCTION public.add_oil_change_item_for_vehicle(p_order_id uuid, p_description text, p_base_ref numeric, p_customer_ref numeric, p_odometer integer, p_oil_brand text DEFAULT NULL::text, p_oil_viscosity text DEFAULT NULL::text, p_oil_quantity_liters numeric DEFAULT NULL::numeric, p_filter_code text DEFAULT NULL::text, p_next_km_interval integer DEFAULT NULL::integer, p_next_months integer DEFAULT NULL::integer, p_service_vehicle_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vehicle_id uuid;
  v_current_odometer integer;
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_default_km integer;
  v_default_months integer;
  v_interval_km integer;
  v_interval_months integer;
  v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  select v.id,v.current_odometer into v_vehicle_id,v_current_odometer
  from public.orders o join public.vehicles v on v.id=p_service_vehicle_id
  where o.id=p_order_id and not o.is_walk_in and o.customer_id is not null
   and v.customer_id is not null;

  if v_vehicle_id is null then
    raise exception 'Para registrar un cambio de aceite debes asociar un vehículo a la orden';
  end if;
  if coalesce(trim(p_description),'')='' then
    raise exception 'Descripción requerida';
  end if;
  if p_base_ref < 0 or p_customer_ref < 0 then
    raise exception 'Montos inválidos';
  end if;
  if p_odometer is null or p_odometer < 0 then
    raise exception 'Kilometraje requerido';
  end if;
  if v_current_odometer is not null and p_odometer < v_current_odometer then
    raise exception 'El kilometraje % es menor al registrado actualmente (%)', p_odometer, v_current_odometer;
  end if;
  if p_oil_quantity_liters is not null and p_oil_quantity_liters <= 0 then
    raise exception 'Cantidad de aceite inválida';
  end if;

  select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates;
  if v_bcv is null or v_op is null then
    raise exception 'Debes registrar tasa BCV y operativa antes de vender';
  end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';
  select coalesce((value #>> '{}')::integer,5000) into v_default_km from public.app_settings where key='oil_change_default_km';
  select coalesce((value #>> '{}')::integer,3) into v_default_months from public.app_settings where key='oil_change_default_months';

  v_interval_km := coalesce(p_next_km_interval,v_default_km,5000);
  v_interval_months := coalesce(p_next_months,v_default_months,3);
  if v_interval_km < 0 or v_interval_km > 50000 then raise exception 'Intervalo de kilometraje inválido'; end if;
  if v_interval_months < 0 or v_interval_months > 24 then raise exception 'Intervalo de meses inválido'; end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    bcv_rate_snapshot,operative_rate_snapshot,
    service_odometer,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,
    next_service_odometer,next_service_date,service_vehicle_id
  ) values (
    p_order_id,'SERVICE','OIL_CHANGE',trim(p_description),1,'STANDARD',
    p_base_ref,p_customer_ref,
    round(public.round_to_step(p_customer_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest')),2),
    round(p_customer_ref,4),v_bcv,v_op,
    p_odometer,nullif(trim(p_oil_brand),''),nullif(trim(p_oil_viscosity),''),p_oil_quantity_liters,nullif(trim(p_filter_code),''),
    case when v_interval_km > 0 then p_odometer+v_interval_km else null end,
    case when v_interval_months > 0 then current_date + make_interval(months=>v_interval_months) else null end,
    v_vehicle_id
  ) returning id into v_item_id;

  return v_item_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.add_oil_change_package_for_vehicle(p_order_id uuid, p_odometer integer, p_description text DEFAULT 'Cambio de aceite'::text, p_service_base_ref numeric DEFAULT 0, p_service_customer_ref numeric DEFAULT 0, p_oil_source text DEFAULT 'INVENTORY'::text, p_oil_inventory_item_id uuid DEFAULT NULL::uuid, p_oil_product_id uuid DEFAULT NULL::uuid, p_oil_description text DEFAULT NULL::text, p_oil_units numeric DEFAULT 1, p_oil_unit_ref numeric DEFAULT NULL::numeric, p_oil_brand text DEFAULT NULL::text, p_oil_viscosity text DEFAULT NULL::text, p_oil_quantity_liters numeric DEFAULT NULL::numeric, p_filter_source text DEFAULT 'NONE'::text, p_filter_inventory_item_id uuid DEFAULT NULL::uuid, p_filter_product_id uuid DEFAULT NULL::uuid, p_filter_description text DEFAULT NULL::text, p_filter_units numeric DEFAULT 1, p_filter_unit_ref numeric DEFAULT NULL::numeric, p_filter_code text DEFAULT NULL::text, p_next_km_interval integer DEFAULT 5000, p_next_months integer DEFAULT 3, p_service_vehicle_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_oil_source text := upper(coalesce(p_oil_source,''));
  v_filter_source text := upper(coalesce(p_filter_source,'NONE'));
  v_oil_item public.inventory_items;
  v_filter_item public.inventory_items;
  v_oil_product public.products;
  v_filter_product public.products;
  v_oil_brand text := nullif(trim(coalesce(p_oil_brand,'')),'');
  v_filter_code text := nullif(trim(coalesce(p_filter_code,'')),'');
  v_service_item uuid;
  v_previous_ids uuid[];
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  -- Lock and snapshot all pre-existing lines: later updates tag only this package.
  perform 1 from public.orders where id=p_order_id for update;
  select coalesce(array_agg(id),'{}'::uuid[]) into v_previous_ids
    from public.order_items where order_id=p_order_id;
  if p_service_vehicle_id is null then
    raise exception 'Selecciona el vehículo para el cambio de aceite';
  end if;

  if p_odometer is null or p_odometer < 0 then raise exception 'Ingresa el kilometraje actual'; end if;
  if p_oil_units is null or p_oil_units <= 0 then raise exception 'Indica la cantidad de aceite usada'; end if;
  if p_oil_unit_ref is null or p_oil_unit_ref <= 0 then raise exception 'Indica el precio REF del aceite'; end if;
  if v_oil_source not in ('INVENTORY','CATALOG','MANUAL') then raise exception 'Origen de aceite inválido'; end if;
  if v_filter_source not in ('NONE','INVENTORY','CATALOG','MANUAL') then raise exception 'Origen de filtro inválido'; end if;

  if v_oil_source='INVENTORY' then
    if p_oil_inventory_item_id is null then raise exception 'Selecciona el aceite del inventario'; end if;
    select * into v_oil_item from public.inventory_items where id=p_oil_inventory_item_id and active=true;
    if v_oil_item.id is null then raise exception 'Aceite de inventario no encontrado'; end if;
    perform public.add_inventory_product_item(p_order_id,p_oil_inventory_item_id,p_oil_units,p_oil_unit_ref,'OIL_CHANGE');
    v_oil_brand := coalesce(v_oil_brand,v_oil_item.brand,v_oil_item.description);
  elsif v_oil_source='CATALOG' then
    if p_oil_product_id is null then raise exception 'Selecciona el aceite del catálogo'; end if;
    select * into v_oil_product from public.products where id=p_oil_product_id and active=true and available=true;
    if v_oil_product.id is null then raise exception 'Aceite de catálogo no encontrado'; end if;
    perform public.add_catalog_product_item_override(p_order_id,p_oil_product_id,p_oil_units,p_oil_unit_ref);
    v_oil_brand := coalesce(v_oil_brand,v_oil_product.name);
  else
    if nullif(trim(coalesce(p_oil_description,'')),'') is null then raise exception 'Escribe el aceite utilizado'; end if;
    perform public.add_manual_product_item(p_order_id,trim(p_oil_description),p_oil_units,p_oil_unit_ref);
    v_oil_brand := coalesce(v_oil_brand,trim(p_oil_description));
  end if;

  if v_filter_source <> 'NONE' then
    if p_filter_units is null or p_filter_units <= 0 then raise exception 'Indica la cantidad de filtros'; end if;
    if p_filter_unit_ref is null or p_filter_unit_ref <= 0 then raise exception 'Indica el precio REF del filtro'; end if;

    if v_filter_source='INVENTORY' then
      if p_filter_inventory_item_id is null then raise exception 'Selecciona el filtro del inventario'; end if;
      select * into v_filter_item from public.inventory_items where id=p_filter_inventory_item_id and active=true;
      if v_filter_item.id is null then raise exception 'Filtro de inventario no encontrado'; end if;
      perform public.add_inventory_product_item(p_order_id,p_filter_inventory_item_id,p_filter_units,p_filter_unit_ref,'OIL_CHANGE');
      v_filter_code := coalesce(v_filter_code,v_filter_item.sku);
    elsif v_filter_source='CATALOG' then
      if p_filter_product_id is null then raise exception 'Selecciona el filtro del catálogo'; end if;
      select * into v_filter_product from public.products where id=p_filter_product_id and active=true and available=true;
      if v_filter_product.id is null then raise exception 'Filtro de catálogo no encontrado'; end if;
      perform public.add_catalog_product_item_override(p_order_id,p_filter_product_id,p_filter_units,p_filter_unit_ref);
      v_filter_code := coalesce(v_filter_code,v_filter_product.name);
    else
      if nullif(trim(coalesce(p_filter_description,'')),'') is null then raise exception 'Escribe el filtro utilizado'; end if;
      perform public.add_manual_product_item(p_order_id,trim(p_filter_description),p_filter_units,p_filter_unit_ref);
      v_filter_code := coalesce(v_filter_code,trim(p_filter_description));
    end if;
  end if;

  v_service_item := public.add_oil_change_item_for_vehicle(
    p_order_id,
    coalesce(nullif(trim(p_description),''),'Cambio de aceite'),
    coalesce(p_service_base_ref,0),
    coalesce(p_service_customer_ref,0),
    p_odometer,
    v_oil_brand,
    nullif(trim(coalesce(p_oil_viscosity,'')),''),
    p_oil_quantity_liters,
    v_filter_code,
    p_next_km_interval,
    p_next_months,
    p_service_vehicle_id
  );

  update public.order_items set service_vehicle_id=p_service_vehicle_id
  where order_id=p_order_id and id <> all(v_previous_ids);
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('oil_change.flexible_package_added','order_item',v_service_item,jsonb_build_object(
    'order_id',p_order_id,'oil_source',v_oil_source,'filter_source',v_filter_source,
    'oil_units',p_oil_units,'filter_units',case when v_filter_source='NONE' then null else p_filter_units end,
    'service_vehicle_id',p_service_vehicle_id
  ));

  return v_service_item;
end;
$function$
;

REVOKE ALL ON FUNCTION public.add_oil_change_item_for_vehicle(uuid,text,numeric,numeric,integer,text,text,numeric,text,integer,integer,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.add_oil_change_item_for_vehicle(uuid,text,numeric,numeric,integer,text,text,numeric,text,integer,integer,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.add_oil_change_package_for_vehicle(uuid,integer,text,numeric,numeric,text,uuid,uuid,text,numeric,numeric,text,text,numeric,text,uuid,uuid,text,numeric,numeric,text,integer,integer,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.add_oil_change_package_for_vehicle(uuid,integer,text,numeric,numeric,text,uuid,uuid,text,numeric,numeric,text,text,numeric,text,uuid,uuid,text,numeric,numeric,text,integer,integer,uuid) TO authenticated;

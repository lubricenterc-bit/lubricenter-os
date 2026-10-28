-- Fase 2 y 3 · Cambio de aceite desde cualquier origen, quién atendió y revisión histórica.
--
-- 1. add_oil_change_service: registra el cambio de aceite como servicio (entra al CRM al cerrar)
--    y, en la misma transacción, reemplaza las líneas sueltas de aceite/filtro que venían de la
--    cotización o de la venta. Acepta que el cliente traiga su aceite (oil_source = CUSTOMER):
--    entonces no se vende aceite y la mano de obra es obligatoria (100% Lubricenter).
-- 2. order_oil_change_candidates: líneas de aceite de motor y filtro de aceite sin servicio.
-- 3. PIN del dueño con bloqueo: 5 intentos fallidos lo bloquean 15 minutos.
-- 4. order_attendants: quién atendió cada orden (Edgar, Ender…) mientras comparten la cuenta.
-- 5. Revisión histórica: el dueño reclasifica líneas viejas (compra para el trabajo, recargo
--    Cashea, cambio de aceite) sin tocar montos, pagos ni nómina.
-- No cambia close_order ni la nómina.

-- ── 1 y 2 · Cambio de aceite ────────────────────────────────────────────────
create or replace function public.order_oil_change_candidates(p_order_id uuid)
returns table(order_item_id uuid, kind text, description text, quantity numeric, unit_ref numeric,
  inventory_item_id uuid, product_id uuid, source text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.require_auth();
  return query
  select i.id,
    case when coalesce(inv.category, p.category, '') ~* 'filtro' then 'FILTER' else 'OIL' end,
    i.description, i.quantity,
    round(i.charged_ref_amount / nullif(i.quantity, 0), 4),
    i.inventory_item_id, coalesce(i.product_id, inv.product_id),
    case when i.inventory_item_id is not null then 'INVENTORY'
         when i.product_id is not null then 'CATALOG' else 'MANUAL' end
  from public.order_items i
  left join public.inventory_items inv on inv.id = i.inventory_item_id
  left join public.products p on p.id = i.product_id
  where i.order_id = p_order_id
    and i.item_type = 'PRODUCT'
    and lubricenter_private.effective_line_role(i) = 'PRODUCT'
    and i.business_area <> 'OIL_CHANGE'
    and (
      coalesce(inv.category, p.category, '') ~* '^(aceite motor|aceite \d|aceite [0-9]+w|[0-9]+w[0-9]+$)'
      or coalesce(inv.category, p.category, '') ~* '^filtro (de )?aceite'
      or (i.inventory_item_id is null and i.product_id is null
          and i.description ~* '(\m[0-9]{1,2}w-?[0-9]{2}\M|filtro (de )?aceite)')
    )
  order by i.created_at, i.id;
end $$;

create or replace function public.add_oil_change_service(
  p_order_id uuid,
  p_service_vehicle_id uuid,
  p_odometer integer,
  p_replace_item_ids uuid[] default '{}',
  p_labor_ref numeric default 0,
  p_oil_source text default 'INVENTORY',
  p_oil_inventory_item_id uuid default null,
  p_oil_product_id uuid default null,
  p_oil_description text default null,
  p_oil_units numeric default 1,
  p_oil_unit_ref numeric default null,
  p_oil_brand text default null,
  p_oil_viscosity text default null,
  p_oil_quantity_liters numeric default null,
  p_filter_source text default 'NONE',
  p_filter_inventory_item_id uuid default null,
  p_filter_product_id uuid default null,
  p_filter_description text default null,
  p_filter_units numeric default 1,
  p_filter_unit_ref numeric default null,
  p_filter_code text default null,
  p_next_km_interval integer default 5000,
  p_next_months integer default 3,
  p_description text default 'Cambio de aceite'
) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_oil_source text := upper(coalesce(p_oil_source, ''));
  v_filter_source text := upper(coalesce(p_filter_source, 'NONE'));
  v_previous uuid[];
  v_item uuid;
  v_filter_code text := nullif(trim(coalesce(p_filter_code, '')), '');
  v_filter_item public.inventory_items;
  v_filter_product public.products;
  v_removed int := 0;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  perform 1 from public.orders where id = p_order_id for update;
  if p_service_vehicle_id is null then raise exception 'Selecciona el vehículo para el cambio de aceite'; end if;
  if p_odometer is null or p_odometer < 0 then raise exception 'Ingresa el kilometraje actual'; end if;
  if coalesce(p_labor_ref, 0) < 0 then raise exception 'La mano de obra no puede ser negativa'; end if;

  -- Quitar las líneas sueltas que este servicio reemplaza (solo productos de esta orden).
  if coalesce(array_length(p_replace_item_ids, 1), 0) > 0 then
    if exists(select 1 from unnest(p_replace_item_ids) x(id)
              where not exists(select 1 from public.order_items i
                               where i.id = x.id and i.order_id = p_order_id and i.item_type = 'PRODUCT')) then
      raise exception 'Una de las líneas a reemplazar no pertenece a esta orden';
    end if;
    delete from public.order_items where order_id = p_order_id and id = any(p_replace_item_ids);
    get diagnostics v_removed = row_count;
  end if;

  if v_oil_source <> 'CUSTOMER' then
    v_item := public.add_oil_change_package_for_vehicle(
      p_order_id, p_odometer, coalesce(nullif(trim(p_description), ''), 'Cambio de aceite'),
      coalesce(p_labor_ref, 0), coalesce(p_labor_ref, 0),
      v_oil_source, p_oil_inventory_item_id, p_oil_product_id, p_oil_description, p_oil_units, p_oil_unit_ref,
      p_oil_brand, p_oil_viscosity, p_oil_quantity_liters,
      v_filter_source, p_filter_inventory_item_id, p_filter_product_id, p_filter_description,
      p_filter_units, p_filter_unit_ref, p_filter_code, p_next_km_interval, p_next_months, p_service_vehicle_id);
  else
    -- El cliente trae su aceite: no se vende aceite y se cobra la mano de obra.
    if coalesce(p_labor_ref, 0) <= 0 then
      raise exception 'El cliente trae el aceite: indica el precio de la mano de obra';
    end if;
    if nullif(trim(coalesce(p_oil_brand, p_oil_description, '')), '') is null then
      raise exception 'Escribe qué aceite trajo el cliente (marca y viscosidad)';
    end if;
    select coalesce(array_agg(id), '{}'::uuid[]) into v_previous from public.order_items where order_id = p_order_id;

    if v_filter_source <> 'NONE' then
      if p_filter_units is null or p_filter_units <= 0 then raise exception 'Indica la cantidad de filtros'; end if;
      if p_filter_unit_ref is null or p_filter_unit_ref <= 0 then raise exception 'Indica el precio REF del filtro'; end if;
      if v_filter_source = 'INVENTORY' then
        select * into v_filter_item from public.inventory_items where id = p_filter_inventory_item_id and active = true;
        if v_filter_item.id is null then raise exception 'Filtro de inventario no encontrado'; end if;
        perform public.add_inventory_product_item(p_order_id, p_filter_inventory_item_id, p_filter_units, p_filter_unit_ref, 'OIL_CHANGE');
        v_filter_code := coalesce(v_filter_code, v_filter_item.sku);
      elsif v_filter_source = 'CATALOG' then
        select * into v_filter_product from public.products where id = p_filter_product_id and active = true and available = true;
        if v_filter_product.id is null then raise exception 'Filtro de catálogo no encontrado'; end if;
        perform public.add_catalog_product_item_override(p_order_id, p_filter_product_id, p_filter_units, p_filter_unit_ref);
        v_filter_code := coalesce(v_filter_code, v_filter_product.name);
      elsif v_filter_source = 'MANUAL' then
        if nullif(trim(coalesce(p_filter_description, '')), '') is null then raise exception 'Escribe el filtro utilizado'; end if;
        perform public.add_manual_product_item(p_order_id, trim(p_filter_description), p_filter_units, p_filter_unit_ref);
        v_filter_code := coalesce(v_filter_code, trim(p_filter_description));
      else
        raise exception 'Origen de filtro inválido';
      end if;
    end if;

    v_item := public.add_oil_change_item_for_vehicle(
      p_order_id, coalesce(nullif(trim(p_description), ''), 'Cambio de aceite') || ' · aceite del cliente',
      p_labor_ref, p_labor_ref, p_odometer,
      trim(coalesce(p_oil_brand, p_oil_description)) || ' (traído por el cliente)',
      nullif(trim(coalesce(p_oil_viscosity, '')), ''), p_oil_quantity_liters, v_filter_code,
      p_next_km_interval, p_next_months, p_service_vehicle_id);

    update public.order_items set service_vehicle_id = p_service_vehicle_id
    where order_id = p_order_id and id <> all(v_previous);
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('oil_change.service_added', 'order_item', v_item, jsonb_build_object(
    'order_id', p_order_id, 'oil_source', v_oil_source, 'filter_source', v_filter_source,
    'labor_ref', p_labor_ref, 'replaced_lines', v_removed));
  return v_item;
end $$;

-- ── 3 · PIN con bloqueo ─────────────────────────────────────────────────────
alter table lubricenter_private.owner_secrets
  add column if not exists failed_attempts int not null default 0,
  add column if not exists locked_until timestamptz;

-- Devuelve si el PIN es correcto. No lanza error para que el contador de intentos se guarde.
create or replace function lubricenter_private.owner_pin_check(p_pin text)
returns text language plpgsql volatile security definer set search_path to '' as $$
declare s lubricenter_private.owner_secrets;
begin
  select * into s from lubricenter_private.owner_secrets where key = 'discount_pin' for update;
  if not found then return 'NOT_CONFIGURED'; end if;
  if s.locked_until is not null and s.locked_until > now() then return 'LOCKED'; end if;
  if p_pin is not null and s.secret_hash = extensions.crypt(p_pin, s.secret_hash) then
    update lubricenter_private.owner_secrets set failed_attempts = 0, locked_until = null where key = 'discount_pin';
    return 'OK';
  end if;
  update lubricenter_private.owner_secrets
  set failed_attempts = s.failed_attempts + 1,
      locked_until = case when s.failed_attempts + 1 >= 5 then now() + interval '15 minutes' end
  where key = 'discount_pin';
  return case when s.failed_attempts + 1 >= 5 then 'LOCKED' else 'WRONG' end;
end $$;
revoke all on function lubricenter_private.owner_pin_check(text) from public, anon, authenticated;

create or replace function lubricenter_private.owner_pin_ok(p_pin text)
returns boolean language sql volatile security definer set search_path to '' as $$
  select lubricenter_private.owner_pin_check(p_pin) = 'OK'
$$;
revoke all on function lubricenter_private.owner_pin_ok(text) from public, anon, authenticated;

create or replace function public.verify_owner_pin(p_pin text)
returns boolean language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  return lubricenter_private.owner_pin_check(p_pin) = 'OK';
end $$;

-- Igual que antes, pero un PIN incorrecto devuelve {"error": …} en lugar de lanzar,
-- para que el intento fallido quede contado.
create or replace function public.apply_order_adjustments(
  p_order_id uuid,
  p_discount_percent numeric default 0,
  p_discount_reason text default null,
  p_rounding_mode text default 'NONE',
  p_owner_pin text default null
) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  o public.orders; v_limit numeric; v_mode text := upper(coalesce(p_rounding_mode, 'NONE'));
  v_pct numeric := round(coalesce(p_discount_percent, 0), 3); v_approved boolean := false; v_result jsonb;
  v_pin text;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  select * into o from public.orders where id = p_order_id for update;
  if exists(select 1 from public.payments p where p.order_id = p_order_id) then
    raise exception 'Aplica el descuento o el redondeo antes de registrar pagos';
  end if;
  if v_mode not in ('NONE','DOWN','HALF','UP') then raise exception 'Redondeo inválido'; end if;
  if v_pct < 0 or v_pct > 100 then raise exception 'Descuento inválido'; end if;
  v_limit := lubricenter_private.setting_number('discount_free_limit_percent', 10);
  if v_pct > 0 and nullif(trim(p_discount_reason), '') is null then
    raise exception 'Indica el motivo del descuento';
  end if;
  if v_pct > v_limit then
    if o.adjust_owner_approved and o.adjust_discount_percent = v_pct then
      v_approved := true;
    else
      v_pin := lubricenter_private.owner_pin_check(p_owner_pin);
      if v_pin = 'OK' then v_approved := true;
      elsif v_pin = 'LOCKED' then
        return jsonb_build_object('error', 'PIN bloqueado por intentos fallidos. Espera 15 minutos.');
      elsif v_pin = 'NOT_CONFIGURED' then
        return jsonb_build_object('error', 'El dueño todavía no configuró su PIN.');
      else
        return jsonb_build_object('error', 'Los descuentos mayores a ' || v_limit::text || '% necesitan el PIN correcto del dueño.');
      end if;
    end if;
  end if;

  update public.orders
  set adjust_discount_percent = v_pct,
      adjust_discount_reason = case when v_pct > 0 then trim(p_discount_reason) end,
      adjust_rounding_mode = v_mode,
      adjust_owner_approved = v_approved
  where id = p_order_id;

  v_result := lubricenter_private.recompute_order_adjustments(p_order_id);

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.adjustments_applied', 'order', p_order_id,
    jsonb_build_object('discount_percent', v_pct, 'reason', p_discount_reason, 'rounding_mode', v_mode,
      'owner_approved', v_approved, 'result', v_result));
  return v_result;
end $$;

create or replace function public.set_owner_pin(p_current text, p_new text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_check text;
begin
  perform public.require_auth();
  if not coalesce(public.can_administer_orders(), false) then
    raise exception 'Solo el dueño puede cambiar el PIN';
  end if;
  if p_new is null or p_new !~ '^\d{4,8}$' then raise exception 'El PIN debe tener de 4 a 8 números'; end if;
  if public.owner_pin_configured() then
    v_check := lubricenter_private.owner_pin_check(p_current);
    if v_check = 'LOCKED' then raise exception 'PIN bloqueado por intentos fallidos. Espera 15 minutos.'; end if;
    if v_check <> 'OK' then raise exception 'El PIN actual no coincide'; end if;
  end if;
  insert into lubricenter_private.owner_secrets(key, secret_hash, updated_at, updated_by)
  values ('discount_pin', extensions.crypt(p_new, extensions.gen_salt('bf')), now(), auth.uid())
  on conflict (key) do update set secret_hash = excluded.secret_hash, updated_at = now(),
    updated_by = auth.uid(), failed_attempts = 0, locked_until = null;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('owner_pin.changed', 'app_settings', null, jsonb_build_object('by', auth.uid()));
end $$;

-- ── 4 · Quién atendió ───────────────────────────────────────────────────────
create table if not exists public.order_attendants (
  order_id uuid primary key references public.orders(id) on delete cascade,
  attendant text not null check (char_length(attendant) between 2 and 40),
  recorded_at timestamptz not null default now(),
  recorded_by uuid default auth.uid()
);
alter table public.order_attendants enable row level security;
do $$ begin
  create policy order_attendants_read on public.order_attendants for select to authenticated
    using (lubricenter_private.staff_identity_allowed());
exception when duplicate_object then null; end $$;
revoke insert, update, delete on public.order_attendants from anon, authenticated;
grant select on public.order_attendants to authenticated;

create or replace function public.set_order_attendant(p_order_id uuid, p_attendant text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.require_auth();
  if nullif(trim(p_attendant), '') is null or char_length(trim(p_attendant)) > 40 then
    raise exception 'Indica quién atiende';
  end if;
  if not exists(select 1 from public.orders where id = p_order_id) then raise exception 'Orden no encontrada'; end if;
  insert into public.order_attendants(order_id, attendant) values (p_order_id, trim(p_attendant))
  on conflict (order_id) do update set attendant = excluded.attendant, recorded_at = now(), recorded_by = auth.uid();
end $$;

-- ── 5 · Revisión histórica de líneas ───────────────────────────────────────
create or replace function public.profit_review_candidates()
returns table(order_item_id uuid, order_id uuid, order_number text, business_at timestamptz,
  description text, charged_ref numeric, current_role text, suggested_role text, reason text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.require_auth();
  if not coalesce(public.can_administer_orders(), false) then raise exception 'Solo el dueño puede revisar'; end if;
  return query
  with lines as (
    select i.*, o.order_number, coalesce(o.business_at, o.closed_at) as bat,
      lubricenter_private.effective_line_role(i) as role,
      exists(select 1 from public.order_items w where w.order_id = i.order_id
             and w.item_type = 'SERVICE' and w.business_area in ('WORKSHOP','ELECTROAUTO')) as has_workshop
    from public.order_items i join public.orders o on o.id = i.order_id
    where o.status = 'CLOSED' and i.line_role is null
  )
  select l.id, l.order_id, l.order_number, l.bat, l.description, round(l.charged_ref_amount, 2), l.role,
    case
      when l.role = 'LABOR' and l.description ~* 'cambio de aceite|aceite' then 'OIL_LABOR'
      else 'PASS_THROUGH' end,
    case
      when l.role = 'LABOR' and l.description ~* 'cambio de aceite|aceite'
        then 'Cambio de aceite registrado como trabajo de taller'
      else 'Producto escrito a mano en una orden de taller: ¿fue una compra para el trabajo?' end
  from lines l
  where (l.role = 'LABOR' and l.description ~* 'cambio de aceite')
     or (l.role = 'PRODUCT' and l.pricing_mode = 'MANUAL_NO_STOCK' and l.has_workshop)
  order by l.bat desc;
end $$;

create or replace function public.reclassify_order_item(
  p_order_item_id uuid, p_role text, p_cost_ref numeric default null
) returns void language plpgsql security definer set search_path to 'public' as $$
declare i public.order_items; v_role text := upper(nullif(trim(coalesce(p_role, '')), ''));
begin
  perform public.require_auth();
  if not coalesce(public.can_administer_orders(), false) then raise exception 'Solo el dueño puede reclasificar'; end if;
  select * into i from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Línea no encontrada'; end if;
  if v_role is not null and v_role not in ('PRODUCT','PASS_THROUGH','CASHEA_SURCHARGE','OIL_LABOR','LABOR') then
    raise exception 'Rol inválido';
  end if;
  if v_role = 'PASS_THROUGH' and (p_cost_ref is null or p_cost_ref < 0 or p_cost_ref > i.charged_ref_amount + 0.01) then
    raise exception 'Indica lo que pagaste (entre 0 y % REF)', round(i.charged_ref_amount, 2);
  end if;
  -- Solo cambia la clasificación para el reporte de ganancias: montos, pagos e inventario quedan igual.
  update public.order_items
  set line_role = v_role,
      pass_through_cost_ref = case when v_role = 'PASS_THROUGH' then round(p_cost_ref, 4) else null end
  where id = p_order_item_id;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order_item.reclassified', 'order_item', p_order_item_id, jsonb_build_object(
    'order_id', i.order_id, 'from', i.line_role, 'to', v_role, 'cost_ref', p_cost_ref));
end $$;

-- ── Permisos ────────────────────────────────────────────────────────────────
revoke all on function public.order_oil_change_candidates(uuid) from public, anon;
revoke all on function public.add_oil_change_service(uuid, uuid, integer, uuid[], numeric, text, uuid, uuid, text, numeric, numeric, text, text, numeric, text, uuid, uuid, text, numeric, numeric, text, integer, integer, text) from public, anon;
revoke all on function public.set_order_attendant(uuid, text) from public, anon;
revoke all on function public.profit_review_candidates() from public, anon;
revoke all on function public.reclassify_order_item(uuid, text, numeric) from public, anon;
grant execute on function public.order_oil_change_candidates(uuid) to authenticated;
grant execute on function public.add_oil_change_service(uuid, uuid, integer, uuid[], numeric, text, uuid, uuid, text, numeric, numeric, text, text, numeric, text, uuid, uuid, text, numeric, numeric, text, integer, integer, text) to authenticated;
grant execute on function public.set_order_attendant(uuid, text) to authenticated;
grant execute on function public.profit_review_candidates() to authenticated;
grant execute on function public.reclassify_order_item(uuid, text, numeric) to authenticated;

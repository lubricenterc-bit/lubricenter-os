-- B0 · Precio y rebaja validados en el servidor (Venta rápida y Nueva orden).
--
-- Problema: Venta rápida y «Nueva orden» aceptan el precio que manda el navegador y el PIN
-- de descuentos mayores a 10% solo se verifica en pantalla. Con cuentas personales, cualquiera
-- podría cobrar por debajo de lista sin dejar rastro.
--
-- Solución (sin cambiar firmas de RPC ni el cálculo de totales):
--  1. Cada línea de inventario o catálogo guarda su precio de lista al entrar
--     (`list_unit_ref_snapshot`, con las tasas de esa misma línea) y el importe tal como se
--     escribió (`entered_ref_amount`).
--  2. Al CERRAR la orden (punto común de todos los cobros: directo, vuelto, Cashea, crédito,
--     «precio pactado en USD»), el servidor calcula la rebaja total frente a la lista
--     (precio editado + descuento + precio pactado; el redondeo registrado no cuenta) y la guarda
--     en la orden (`price_expected_ref`, `price_reduction_ref`) con un evento de auditoría.
--  3. Si la rebaja supera el límite libre (10% o 1 REF, lo que sea mayor) y quien cierra no es el
--     dueño, se exige una autorización con el PIN del dueño validada en el servidor
--     (`authorize_price_override`, un solo uso, 30 minutos) o un descuento ya aprobado con PIN.
--  Las líneas manuales y los servicios siguen con precio libre; las cortesías tienen su registro.
--  Aditiva: 3 columnas en orders, 2 en order_items, 1 tabla privada, 2 disparadores y 1 RPC.

alter table public.order_items add column if not exists list_unit_ref_snapshot numeric;
alter table public.order_items add column if not exists entered_ref_amount numeric;
alter table public.orders add column if not exists price_expected_ref numeric;
alter table public.orders add column if not exists price_reduction_ref numeric;
alter table public.orders add column if not exists price_override_approval_id uuid;

comment on column public.order_items.list_unit_ref_snapshot is
  'Precio de lista unitario en REF al agregar la línea (precio USD del artículo × tasa operativa de la línea, redondeado como la lista, ÷ BCV de la línea). Nulo en líneas manuales, servicios y cortesías.';
comment on column public.order_items.entered_ref_amount is
  'Importe REF de la línea tal como se agregó, antes de descuentos, precio pactado o redondeos.';
comment on column public.orders.price_expected_ref is
  'Al cerrar: total esperado a precio de lista (líneas con lista) más el importe escrito de las demás, sin recargo Cashea.';
comment on column public.orders.price_reduction_ref is
  'Al cerrar: rebaja total frente a ese esperado (precio editado, descuento, precio pactado), sin el redondeo registrado.';
comment on column public.orders.price_override_approval_id is
  'Autorización con PIN del dueño que se usó para cerrar una rebaja mayor al límite libre.';

create table if not exists lubricenter_private.price_override_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_order_id uuid,
  used_at timestamptz
);
alter table lubricenter_private.price_override_approvals enable row level security;
revoke all on lubricenter_private.price_override_approvals from public, anon, authenticated;
create index if not exists price_override_approvals_open_idx
  on lubricenter_private.price_override_approvals (user_id, expires_at) where used_order_id is null;

-- Precio de lista unitario en REF con las tasas de la línea (misma fórmula que inventory_current
-- y add_inventory_product_item / add_catalog_product_item_override).
create or replace function lubricenter_private.line_list_unit_ref(
  p_inventory_item_id uuid, p_product_id uuid, p_bcv numeric, p_operative numeric)
returns numeric language plpgsql stable security definer set search_path to '' as $$
declare v_usd numeric; v_step numeric; v_mode text;
begin
  if coalesce(p_bcv, 0) <= 0 or coalesce(p_operative, 0) <= 0 then return null; end if;
  if p_inventory_item_id is not null then
    select i.price_usd into v_usd from public.inventory_items i where i.id = p_inventory_item_id;
  elsif p_product_id is not null then
    select p.cash_usd_base_price into v_usd from public.products p where p.id = p_product_id;
  end if;
  if coalesce(v_usd, 0) <= 0 then return null; end if;
  select coalesce((s.value #>> '{}')::numeric, 10) into v_step from public.app_settings s where s.key = 'price_rounding_step';
  select coalesce(s.value #>> '{}', 'nearest') into v_mode from public.app_settings s where s.key = 'price_rounding_mode';
  return round(public.round_to_step(v_usd * p_operative, coalesce(v_step, 10), coalesce(v_mode, 'nearest')) / p_bcv, 4);
end $$;

create or replace function lubricenter_private.order_items_snapshot_list_price()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  new.entered_ref_amount := coalesce(new.entered_ref_amount, new.charged_ref_amount);
  if new.list_unit_ref_snapshot is null
     and new.item_type = 'PRODUCT'
     and coalesce(new.pricing_mode, '') <> 'BONUS'
     and coalesce(new.line_role, 'PRODUCT') = 'PRODUCT'
     and (new.inventory_item_id is not null or new.product_id is not null) then
    new.list_unit_ref_snapshot := lubricenter_private.line_list_unit_ref(
      new.inventory_item_id, new.product_id, new.bcv_rate_snapshot, new.operative_rate_snapshot);
  end if;
  return new;
end $$;

drop trigger if exists zb_snapshot_list_price on public.order_items;
create trigger zb_snapshot_list_price before insert on public.order_items
  for each row execute function lubricenter_private.order_items_snapshot_list_price();

-- Rebaja de una orden frente a la lista (también sirve para revisar órdenes ya cerradas).
create or replace function lubricenter_private.order_price_reduction(p_order_id uuid, p_rounding_ref numeric)
returns table(expected_ref numeric, final_ref numeric, reduction_ref numeric)
language sql stable security definer set search_path to '' as $$
  with lines as (
    select lubricenter_private.effective_line_role(it) as role_key, it.*
    from public.order_items it where it.order_id = p_order_id
  ), t as (
    select coalesce(sum(case when role_key = 'CASHEA_SURCHARGE' then 0
        when list_unit_ref_snapshot is not null then list_unit_ref_snapshot * quantity
        else coalesce(entered_ref_amount, list_ref_amount, charged_ref_amount) end), 0) as expected,
      coalesce(sum(case when role_key = 'CASHEA_SURCHARGE' then 0 else charged_ref_amount end), 0) as final
    from lines
  )
  select round(t.expected, 2), round(t.final, 2),
    greatest(round(t.expected - (t.final - coalesce(p_rounding_ref, 0)), 2), 0)
  from t
$$;

create or replace function lubricenter_private.order_close_price_check()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  r record; v_limit numeric; v_free numeric; v_allowed numeric; v_approval uuid; v_owner boolean;
begin
  select * into r from lubricenter_private.order_price_reduction(new.id, new.adjust_rounding_ref);
  new.price_expected_ref := r.expected_ref;
  new.price_reduction_ref := r.reduction_ref;
  if r.reduction_ref <= 0 then return new; end if;

  v_limit := lubricenter_private.setting_number('discount_free_limit_percent', 10);
  v_free := greatest(1, r.expected_ref * v_limit / 100);
  v_owner := auth.uid() is null or lubricenter_private.finance_role() = 'OWNER';
  v_allowed := v_free + case when coalesce(new.adjust_owner_approved, false)
    then r.expected_ref * coalesce(new.adjust_discount_percent, 0) / 100 else 0 end;

  if r.reduction_ref > v_allowed + 0.005 and not v_owner then
    select a.id into v_approval from lubricenter_private.price_override_approvals a
     where a.user_id = auth.uid() and a.used_order_id is null and a.expires_at > now()
     order by a.created_at limit 1 for update skip locked;
    if v_approval is null then
      raise exception '%', format(
        'REBAJA_SIN_AUTORIZACION: esta venta queda %s REF por debajo del precio de lista (%s%%). Las rebajas mayores a %s%% necesitan el PIN del dueño: pide «Autorizar rebaja» y vuelve a cobrar.',
        to_char(r.reduction_ref, 'FM999999990.00'),
        to_char(case when r.expected_ref > 0 then r.reduction_ref * 100 / r.expected_ref else 100 end, 'FM990.0'),
        to_char(v_limit, 'FM990'))
        using errcode = '42501';
    end if;
    update lubricenter_private.price_override_approvals set used_order_id = new.id, used_at = now() where id = v_approval;
    new.price_override_approval_id := v_approval;
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.price_reduction', 'order', new.id, jsonb_build_object(
    'order_number', new.order_number, 'expected_ref', r.expected_ref, 'final_ref', r.final_ref,
    'reduction_ref', r.reduction_ref, 'free_limit_ref', round(v_free, 2), 'owner', v_owner,
    'discount_percent', new.adjust_discount_percent, 'owner_approved_discount', new.adjust_owner_approved,
    'approval_id', new.price_override_approval_id, 'actor', auth.uid()));
  return new;
end $$;

drop trigger if exists ad_order_close_price_check on public.orders;
create trigger ad_order_close_price_check before update of status on public.orders
  for each row when (new.status = 'CLOSED' and old.status is distinct from 'CLOSED')
  execute function lubricenter_private.order_close_price_check();

-- El PIN se valida en el servidor y deja una autorización de un solo uso para quien la pidió.
-- Devuelve jsonb (no lanza excepción) para que el conteo de intentos fallidos no se revierta.
create or replace function public.authorize_price_override(p_owner_pin text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_check text; v_id uuid; v_expires timestamptz := now() + interval '30 minutes';
begin
  perform public.require_auth();
  v_check := lubricenter_private.owner_pin_check(p_owner_pin);
  if v_check = 'LOCKED' then
    return jsonb_build_object('ok', false, 'error', 'PIN bloqueado por intentos fallidos. Espera 15 minutos.');
  elsif v_check = 'NOT_CONFIGURED' then
    return jsonb_build_object('ok', false, 'error', 'El dueño todavía no configuró su PIN.');
  elsif v_check <> 'OK' then
    return jsonb_build_object('ok', false, 'error', 'El PIN del dueño no coincide.');
  end if;
  update lubricenter_private.price_override_approvals set expires_at = now()
   where user_id = auth.uid() and used_order_id is null and expires_at > now();
  insert into lubricenter_private.price_override_approvals(user_id, expires_at)
  values (auth.uid(), v_expires) returning id into v_id;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.price_override_authorized', 'price_override', v_id,
    jsonb_build_object('actor', auth.uid(), 'expires_at', v_expires));
  return jsonb_build_object('ok', true, 'expires_at', v_expires);
end $$;

revoke all on function lubricenter_private.line_list_unit_ref(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function lubricenter_private.order_items_snapshot_list_price() from public, anon, authenticated;
revoke all on function lubricenter_private.order_price_reduction(uuid, numeric) from public, anon, authenticated;
revoke all on function lubricenter_private.order_close_price_check() from public, anon, authenticated;
revoke all on function public.authorize_price_override(text) from public, anon;
grant execute on function public.authorize_price_override(text) to authenticated;

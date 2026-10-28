-- Fase 1 · Ganancias claras.
--
-- 1. Rol de cada línea (producto, mano de obra, compra para el trabajo, recargo Cashea).
-- 2. Compra para el trabajo: se cobra al cliente pero solo el recargo es ganancia.
-- 3. Recargo Cashea automático, solo sobre la mano de obra de taller/electroauto:
--    cubre la comisión y el costo de financiar las cuotas.
-- 4. Descuento (tope configurable; más con PIN del dueño) y redondeo del total en $.
--    Salen solo de la parte de Lubricenter: la base y el 40% de Cheo no se tocan.
-- 5. Vista de ganancia por línea y reporte Tienda / Taller.
--
-- No cambia close_order ni la nómina: las líneas nuevas no llevan participación de
-- mecánicos, así que no generan comisiones.

-- ── Columnas ────────────────────────────────────────────────────────────────
alter table public.order_items
  add column if not exists line_role text,
  add column if not exists pass_through_cost_ref numeric(14,4),
  add column if not exists list_ref_amount numeric(14,4),
  add column if not exists list_ves_amount numeric(16,2);

do $$ begin
  alter table public.order_items add constraint order_items_line_role_check
    check (line_role is null or line_role in ('PRODUCT','LABOR','OIL_LABOR','PASS_THROUGH','CASHEA_SURCHARGE'));
exception when duplicate_object then null; end $$;

comment on column public.order_items.line_role is
  'Rol para ganancias. NULL = se deduce (SERVICE taller/electroauto = LABOR, otro SERVICE = OIL_LABOR, PRODUCT = PRODUCT).';
comment on column public.order_items.pass_through_cost_ref is 'Compra para el trabajo: lo que pagó Lubricenter, en REF BCV.';
comment on column public.order_items.list_ref_amount is 'Precio antes de descuento/redondeo (REF). NULL = sin ajuste.';
comment on column public.order_items.list_ves_amount is 'Precio antes de descuento/redondeo (Bs). NULL = sin ajuste.';

alter table public.orders
  add column if not exists adjust_discount_percent numeric(6,3) not null default 0,
  add column if not exists adjust_discount_reason text,
  add column if not exists adjust_discount_ref numeric(14,4) not null default 0,
  add column if not exists adjust_rounding_mode text not null default 'NONE',
  add column if not exists adjust_rounding_ref numeric(14,4) not null default 0,
  add column if not exists adjust_owner_approved boolean not null default false,
  add column if not exists attended_by text;

do $$ begin
  alter table public.orders add constraint orders_adjust_rounding_mode_check
    check (adjust_rounding_mode in ('NONE','DOWN','HALF','UP'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_adjust_discount_percent_check
    check (adjust_discount_percent >= 0 and adjust_discount_percent <= 100);
exception when duplicate_object then null; end $$;

-- ── Configuración ───────────────────────────────────────────────────────────
insert into public.app_settings(key, value) values
  ('cashea_financing_days', '45'::jsonb),
  ('cashea_opportunity_monthly_percent', '5'::jsonb),
  ('discount_free_limit_percent', '10'::jsonb),
  ('store_markup_percent', '35'::jsonb),
  ('oil_labor_free_threshold_percent', '85'::jsonb)
on conflict (key) do nothing;

create table if not exists lubricenter_private.owner_secrets (
  key text primary key,
  secret_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
revoke all on lubricenter_private.owner_secrets from public, anon, authenticated;

create or replace function lubricenter_private.setting_number(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path to '' as $$
  select coalesce((select (s.value #>> '{}')::numeric from public.app_settings s where s.key = p_key), p_default)
$$;

-- Rol efectivo de una línea.
create or replace function lubricenter_private.effective_line_role(i public.order_items)
returns text language sql immutable set search_path to '' as $$
  select coalesce(i.line_role, case
    when i.item_type = 'SERVICE' and i.business_area in ('WORKSHOP','ELECTROAUTO') then 'LABOR'
    when i.item_type = 'SERVICE' then 'OIL_LABOR'
    -- Recargos de Cashea escritos a mano antes de este cambio (órdenes cerradas, no se editan).
    when i.pricing_mode = 'MANUAL_NO_STOCK' and i.description ~* '(ajuste|importe adicional|recargo).*cashea'
      then 'CASHEA_SURCHARGE'
    else 'PRODUCT' end)
$$;

-- ── PIN del dueño ───────────────────────────────────────────────────────────
create or replace function public.owner_pin_configured()
returns boolean language sql stable security definer set search_path to '' as $$
  select exists(select 1 from lubricenter_private.owner_secrets where key = 'discount_pin')
$$;

create or replace function lubricenter_private.owner_pin_ok(p_pin text)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists(select 1 from lubricenter_private.owner_secrets s
    where s.key = 'discount_pin' and p_pin is not null
      and s.secret_hash = extensions.crypt(p_pin, s.secret_hash))
$$;

create or replace function public.verify_owner_pin(p_pin text)
returns boolean language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  return lubricenter_private.owner_pin_ok(p_pin);
end $$;

create or replace function public.set_owner_pin(p_current text, p_new text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if not coalesce(public.can_administer_orders(), false) then
    raise exception 'Solo el dueño puede cambiar el PIN';
  end if;
  if p_new is null or p_new !~ '^\d{4,8}$' then raise exception 'El PIN debe tener de 4 a 8 números'; end if;
  if public.owner_pin_configured() and not lubricenter_private.owner_pin_ok(p_current) then
    raise exception 'El PIN actual no coincide';
  end if;
  insert into lubricenter_private.owner_secrets(key, secret_hash, updated_at, updated_by)
  values ('discount_pin', extensions.crypt(p_new, extensions.gen_salt('bf')), now(), auth.uid())
  on conflict (key) do update set secret_hash = excluded.secret_hash, updated_at = now(), updated_by = auth.uid();
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('owner_pin.changed', 'app_settings', null, jsonb_build_object('by', auth.uid()));
end $$;

create or replace function public.set_billing_settings(
  p_discount_free_limit_percent numeric,
  p_cashea_opportunity_monthly_percent numeric,
  p_cashea_financing_days numeric,
  p_store_markup_percent numeric
) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  if not coalesce(public.can_administer_orders(), false) then
    raise exception 'Solo el dueño puede cambiar esta configuración';
  end if;
  if p_discount_free_limit_percent is null or p_discount_free_limit_percent < 0 or p_discount_free_limit_percent > 50 then
    raise exception 'El tope de descuento debe estar entre 0 y 50%%'; end if;
  if p_cashea_opportunity_monthly_percent is null or p_cashea_opportunity_monthly_percent < 0 or p_cashea_opportunity_monthly_percent > 30 then
    raise exception 'El rendimiento mensual debe estar entre 0 y 30%%'; end if;
  if p_cashea_financing_days is null or p_cashea_financing_days < 0 or p_cashea_financing_days > 120 then
    raise exception 'Los días de financiamiento deben estar entre 0 y 120'; end if;
  if p_store_markup_percent is null or p_store_markup_percent < 0 or p_store_markup_percent > 300 then
    raise exception 'El recargo de tienda debe estar entre 0 y 300%%'; end if;
  insert into public.app_settings(key, value, updated_at) values
    ('discount_free_limit_percent', to_jsonb(p_discount_free_limit_percent), now()),
    ('cashea_opportunity_monthly_percent', to_jsonb(p_cashea_opportunity_monthly_percent), now()),
    ('cashea_financing_days', to_jsonb(p_cashea_financing_days), now()),
    ('store_markup_percent', to_jsonb(p_store_markup_percent), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- ── Recargo Cashea ──────────────────────────────────────────────────────────
-- recargo = 1 / (1 − comisión − financiado × r × días/30) − 1
create or replace function public.cashea_surcharge_percent(p_initial_percent numeric default 40)
returns numeric language sql stable security definer set search_path to '' as $$
  select round(100 * (1 / nullif(1
      - lubricenter_private.setting_number('cashea_commission_percent', 4) / 100
      - greatest(0, 1 - coalesce(p_initial_percent, 40) / 100)
        * lubricenter_private.setting_number('cashea_opportunity_monthly_percent', 5) / 100
        * lubricenter_private.setting_number('cashea_financing_days', 45) / 30, 0) - 1), 4)
$$;

-- Agrega (o quita, con p_initial_percent = NULL) el recargo Cashea de una orden abierta.
create or replace function public.set_cashea_surcharge(p_order_id uuid, p_initial_percent numeric)
returns table(surcharge_percent numeric, surcharge_ref numeric, total_ref numeric, total_ves numeric)
language plpgsql security definer set search_path to 'public' as $$
#variable_conflict use_column
declare
  v_bcv numeric; v_op numeric; v_labor numeric; v_pct numeric := 0; v_ref numeric := 0;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  perform 1 from public.orders where id = p_order_id for update;

  delete from public.order_items where order_id = p_order_id and line_role = 'CASHEA_SURCHARGE';

  if p_initial_percent is not null then
    if p_initial_percent <= 0 or p_initial_percent > 100 then raise exception 'Inicial inválida'; end if;
    select coalesce(sum(i.charged_ref_amount), 0) into v_labor
    from public.order_items i
    where i.order_id = p_order_id and lubricenter_private.effective_line_role(i) = 'LABOR';
    if v_labor > 0 then
      v_pct := public.cashea_surcharge_percent(p_initial_percent);
      v_ref := round(v_labor * v_pct / 100, 2);
      select r.bcv_rate, r.operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id) r;
      if v_bcv is null or v_op is null then raise exception 'Debes registrar tasas antes de cobrar'; end if;
      if v_ref > 0 then
        insert into public.order_items(order_id, item_type, business_area, description, quantity, pricing_mode,
          base_ref_amount, customer_ref_amount, charged_ves_amount, charged_ref_amount,
          bcv_rate_snapshot, operative_rate_snapshot, line_role)
        values (p_order_id, 'SERVICE', 'WORKSHOP',
          'Recargo Cashea ' || to_char(v_pct, 'FM990.00') || '% sobre mano de obra', 1, 'STANDARD',
          v_ref, v_ref, round(v_ref * v_bcv, 2), v_ref, v_bcv, v_op, 'CASHEA_SURCHARGE');
      end if;
    end if;
  end if;

  return query
  select v_pct, v_ref,
    round(coalesce(sum(i.charged_ref_amount), 0), 4), round(coalesce(sum(i.charged_ves_amount), 0), 2)
  from public.order_items i where i.order_id = p_order_id;
end $$;

-- ── Compra para el trabajo ──────────────────────────────────────────────────
create or replace function public.add_pass_through_item(
  p_order_id uuid,
  p_description text,
  p_cost_amount numeric,
  p_cost_currency text,
  p_charge_ref numeric
) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_bcv numeric; v_op numeric; v_cost_ref numeric; v_id uuid;
  v_currency text := upper(coalesce(p_cost_currency, 'REF'));
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if nullif(trim(p_description), '') is null then raise exception 'Escribe qué compraste'; end if;
  if p_cost_amount is null or p_cost_amount <= 0 then raise exception 'Indica cuánto pagaste'; end if;
  if p_charge_ref is null or p_charge_ref <= 0 then raise exception 'Indica cuánto le cobras al cliente'; end if;
  if v_currency not in ('REF','VES','USD') then raise exception 'Moneda del costo inválida'; end if;
  select r.bcv_rate, r.operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id) r;
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasas antes de vender'; end if;
  v_cost_ref := case v_currency
    when 'REF' then p_cost_amount
    when 'VES' then p_cost_amount / v_bcv
    else p_cost_amount * v_op / v_bcv end;
  if round(p_charge_ref, 4) < round(v_cost_ref, 4) - 0.01 then
    raise exception 'Estás cobrando menos de lo que pagaste (pagaste % REF)', round(v_cost_ref, 2);
  end if;
  insert into public.order_items(order_id, item_type, business_area, description, quantity, pricing_mode,
    base_ref_amount, customer_ref_amount, charged_ves_amount, charged_ref_amount,
    bcv_rate_snapshot, operative_rate_snapshot, cash_price_revealed, line_role, pass_through_cost_ref,
    unit_cost_ref_snapshot, total_cost_ref_snapshot)
  values (p_order_id, 'PRODUCT', 'STORE', 'Compra para el trabajo · ' || trim(p_description), 1, 'MANUAL_NO_STOCK',
    round(p_charge_ref, 4), round(p_charge_ref, 4), round(p_charge_ref * v_bcv, 2), round(p_charge_ref, 4),
    v_bcv, v_op, false, 'PASS_THROUGH', round(v_cost_ref, 4), round(v_cost_ref, 4), round(v_cost_ref, 4))
  returning id into v_id;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order_item.pass_through_added', 'order_item', v_id,
    jsonb_build_object('order_id', p_order_id, 'cost_amount', p_cost_amount, 'cost_currency', v_currency,
      'cost_ref', round(v_cost_ref, 4), 'charge_ref', p_charge_ref));
  return v_id;
end $$;

-- ── Descuento y redondeo ────────────────────────────────────────────────────
-- Recalcula los precios de la orden a partir de su precio de lista y los ajustes guardados.
-- El ajuste se reparte solo sobre la parte de Lubricenter de cada línea (precio − Cheo − Alexis);
-- las compras para el trabajo y el recargo Cashea no se tocan.
create or replace function lubricenter_private.recompute_order_adjustments(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  o public.orders; i record;
  v_total numeric; v_base numeric; v_discount numeric := 0; v_after numeric; v_target numeric;
  v_rounding numeric := 0; v_delta numeric; v_left numeric; v_share numeric; v_new numeric; v_count int; v_n int := 0;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'OPEN' then return null; end if;

  -- 1. Volver a precios de lista.
  update public.order_items it
  set charged_ref_amount = it.list_ref_amount, charged_ves_amount = it.list_ves_amount,
      list_ref_amount = null, list_ves_amount = null
  where it.order_id = p_order_id and it.list_ref_amount is not null;

  select coalesce(sum(it.charged_ref_amount), 0) into v_total from public.order_items it where it.order_id = p_order_id;

  -- Base repartible: parte de Lubricenter de las líneas ajustables.
  select coalesce(sum(greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
           - coalesce(it.assistant_bonus_ref_snapshot, 0), 0)), 0), count(*)
    into v_base, v_count
  from public.order_items it
  where it.order_id = p_order_id
    and lubricenter_private.effective_line_role(it) in ('PRODUCT','LABOR','OIL_LABOR')
    and greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
           - coalesce(it.assistant_bonus_ref_snapshot, 0), 0) > 0;

  -- El descuento se calcula sobre el total sin el recargo Cashea (el recargo va después).
  if o.adjust_discount_percent > 0 then
    v_discount := round((v_total - coalesce((select sum(it.charged_ref_amount) from public.order_items it
      where it.order_id = p_order_id and lubricenter_private.effective_line_role(it) = 'CASHEA_SURCHARGE'), 0))
      * o.adjust_discount_percent / 100, 2);
  end if;
  v_after := v_total - v_discount;
  v_target := case o.adjust_rounding_mode
    when 'DOWN' then floor(v_after)
    when 'UP' then ceil(v_after)
    when 'HALF' then round(v_after * 2) / 2
    else round(v_after, 2) end;
  v_rounding := v_target - v_after;
  v_delta := v_target - v_total;   -- negativo = baja el total

  if v_delta = 0 or v_count = 0 or v_base <= 0 then
    update public.orders set adjust_discount_ref = 0, adjust_rounding_ref = 0 where id = p_order_id;
    return jsonb_build_object('total_ref', v_total, 'discount_ref', 0, 'rounding_ref', 0);
  end if;
  if -v_delta > v_base then
    raise exception 'El descuento es mayor que la parte de Lubricenter en esta orden (% REF)', round(v_base, 2);
  end if;

  -- 2. Repartir el ajuste en proporción a la parte de Lubricenter.
  v_left := v_delta;
  for i in
    select it.id, it.charged_ref_amount, it.charged_ves_amount, it.bcv_rate_snapshot,
      greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
        - coalesce(it.assistant_bonus_ref_snapshot, 0), 0) as lc
    from public.order_items it
    where it.order_id = p_order_id
      and lubricenter_private.effective_line_role(it) in ('PRODUCT','LABOR','OIL_LABOR')
      and greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
        - coalesce(it.assistant_bonus_ref_snapshot, 0), 0) > 0
    order by it.charged_ref_amount desc, it.id
  loop
    v_n := v_n + 1;
    v_share := case when v_n = v_count then v_left else round(v_delta * i.lc / v_base, 4) end;
    v_left := v_left - v_share;
    v_new := round(i.charged_ref_amount + v_share, 4);
    update public.order_items it
    set list_ref_amount = i.charged_ref_amount, list_ves_amount = i.charged_ves_amount,
        charged_ref_amount = v_new, charged_ves_amount = round(v_new * i.bcv_rate_snapshot, 2)
    where it.id = i.id;
  end loop;

  update public.orders set adjust_discount_ref = v_discount, adjust_rounding_ref = v_rounding where id = p_order_id;
  return jsonb_build_object('total_ref', v_target, 'discount_ref', v_discount, 'rounding_ref', v_rounding);
end $$;

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
    elsif lubricenter_private.owner_pin_ok(p_owner_pin) then
      v_approved := true;
    else
      raise exception 'Los descuentos mayores a % necesitan el PIN del dueño', v_limit::text || '%';
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

-- Si se agrega o quita una línea, los ajustes se recalculan con los mismos parámetros.
create or replace function lubricenter_private.order_items_reapply_adjustments()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if exists(select 1 from public.orders o where o.id = v_order and o.status = 'OPEN'
      and (o.adjust_discount_percent > 0 or o.adjust_rounding_mode <> 'NONE')) then
    perform lubricenter_private.recompute_order_adjustments(v_order);
  end if;
  return null;
end $$;

drop trigger if exists zz_reapply_order_adjustments on public.order_items;
create trigger zz_reapply_order_adjustments
  after insert or delete on public.order_items
  for each row execute function lubricenter_private.order_items_reapply_adjustments();

-- ── Ganancia por línea ──────────────────────────────────────────────────────
create or replace view public.order_line_economics as
with cashea as (
  select distinct cs.order_id from public.cashea_sales cs where cs.status <> 'CANCELLED'
), cfg as (
  select lubricenter_private.setting_number('store_markup_percent', 35) as markup,
         lubricenter_private.setting_number('cashea_commission_percent', 4) as commission
)
select
  i.id as order_item_id,
  i.order_id,
  o.order_number,
  coalesce(o.business_at, o.closed_at, o.opened_at) as business_at,
  lubricenter_private.effective_line_role(i) as line_role,
  case when lubricenter_private.effective_line_role(i) in ('LABOR','CASHEA_SURCHARGE') then 'TALLER' else 'TIENDA' end as area,
  i.business_area,
  i.description,
  i.quantity,
  (c.order_id is not null) as paid_with_cashea,
  round(i.charged_ref_amount, 4) as revenue_ref,
  round(case lubricenter_private.effective_line_role(i)
    when 'PRODUCT' then coalesce(nullif(i.total_cost_ref_snapshot, 0),
      coalesce(i.list_ref_amount, i.base_ref_amount, i.charged_ref_amount) / (1 + cfg.markup / 100))
    when 'PASS_THROUGH' then coalesce(i.pass_through_cost_ref, i.charged_ref_amount)
    else 0 end, 4) as cost_ref,
  (lubricenter_private.effective_line_role(i) = 'PRODUCT' and coalesce(i.total_cost_ref_snapshot, 0) = 0) as cost_estimated,
  round(coalesce(i.worker_share_ref_snapshot, 0) + coalesce(i.assistant_bonus_ref_snapshot, 0), 4) as mechanics_ref,
  round(case when c.order_id is not null
      and lubricenter_private.effective_line_role(i) in ('LABOR','CASHEA_SURCHARGE')
    then i.charged_ref_amount * cfg.commission / 100 else 0 end, 4) as cashea_commission_ref
from public.order_items i
join public.orders o on o.id = i.order_id and o.status = 'CLOSED'
left join cashea c on c.order_id = i.order_id
cross join cfg;

comment on view public.order_line_economics is
  'Ganancia por línea de órdenes cerradas: venta − costo − mecánicos − comisión Cashea (solo taller). Sin gastos. Se consulta con finance_profit_report.';
revoke all on public.order_line_economics from public, anon, authenticated;

create or replace function public.finance_profit_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v jsonb;
begin
  perform public.require_auth();
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Rango de fechas inválido';
  end if;
  with e as (
    select x.*, round(x.revenue_ref - x.cost_ref - x.mechanics_ref - x.cashea_commission_ref, 4) as profit_ref,
      (x.business_at at time zone 'America/Caracas')::date as day
    from public.order_line_economics x
    where (x.business_at at time zone 'America/Caracas')::date between p_from and p_to
  ), areas as (
    select area,
      round(sum(revenue_ref), 2) revenue_ref, round(sum(cost_ref), 2) cost_ref,
      round(sum(mechanics_ref), 2) mechanics_ref, round(sum(cashea_commission_ref), 2) cashea_commission_ref,
      round(sum(profit_ref), 2) profit_ref, count(*) lines, count(distinct order_id) orders,
      round(sum(cost_ref) filter (where cost_estimated), 2) estimated_cost_ref,
      round(sum(revenue_ref) filter (where line_role = 'PASS_THROUGH'), 2) pass_through_revenue_ref
    from e group by area
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'areas', coalesce((select jsonb_object_agg(area, to_jsonb(a) - 'area') from areas a), '{}'::jsonb),
    'total_profit_ref', coalesce((select round(sum(profit_ref), 2) from e), 0),
    'orders', coalesce((select count(distinct order_id) from e), 0),
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
        select day, round(sum(profit_ref) filter (where area = 'TIENDA'), 2) tienda,
          round(sum(profit_ref) filter (where area = 'TALLER'), 2) taller
        from e group by day) d), '[]'::jsonb),
    'top_store', coalesce((select jsonb_agg(t) from (
        select description, round(sum(quantity), 2) quantity, round(sum(revenue_ref), 2) revenue_ref,
          round(sum(profit_ref), 2) profit_ref, bool_or(cost_estimated) cost_estimated
        from e where area = 'TIENDA' and line_role = 'PRODUCT'
        group by description order by sum(profit_ref) desc limit 5) t), '[]'::jsonb),
    'top_workshop', coalesce((select jsonb_agg(t) from (
        select order_number, description, round(revenue_ref, 2) revenue_ref, round(profit_ref, 2) profit_ref
        from e where line_role = 'LABOR' order by profit_ref desc limit 5) t), '[]'::jsonb),
    'missing_cost', coalesce((select jsonb_agg(t) from (
        select description, round(sum(revenue_ref), 2) revenue_ref, count(*) lines
        from e where cost_estimated group by description order by sum(revenue_ref) desc limit 15) t), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'order_id', order_id, 'order_number', order_number, 'day', day, 'area', area, 'role', line_role,
        'description', description, 'revenue_ref', round(revenue_ref, 2), 'cost_ref', round(cost_ref, 2),
        'mechanics_ref', round(mechanics_ref, 2), 'cashea_ref', round(cashea_commission_ref, 2),
        'profit_ref', round(profit_ref, 2), 'estimated', cost_estimated) order by business_at desc)
      from e), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ── Permisos ────────────────────────────────────────────────────────────────
revoke all on function public.verify_owner_pin(text) from public, anon;
revoke all on function public.set_owner_pin(text, text) from public, anon;
revoke all on function public.owner_pin_configured() from public, anon;
revoke all on function public.set_billing_settings(numeric, numeric, numeric, numeric) from public, anon;
revoke all on function public.cashea_surcharge_percent(numeric) from public, anon;
revoke all on function public.set_cashea_surcharge(uuid, numeric) from public, anon;
revoke all on function public.add_pass_through_item(uuid, text, numeric, text, numeric) from public, anon;
revoke all on function public.apply_order_adjustments(uuid, numeric, text, text, text) from public, anon;
revoke all on function public.finance_profit_report(date, date) from public, anon;
grant execute on function public.verify_owner_pin(text) to authenticated;
grant execute on function public.set_owner_pin(text, text) to authenticated;
grant execute on function public.owner_pin_configured() to authenticated;
grant execute on function public.set_billing_settings(numeric, numeric, numeric, numeric) to authenticated;
grant execute on function public.cashea_surcharge_percent(numeric) to authenticated;
grant execute on function public.set_cashea_surcharge(uuid, numeric) to authenticated;
grant execute on function public.add_pass_through_item(uuid, text, numeric, text, numeric) to authenticated;
grant execute on function public.apply_order_adjustments(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.finance_profit_report(date, date) to authenticated;
revoke all on function lubricenter_private.recompute_order_adjustments(uuid) from public, anon, authenticated;
revoke all on function lubricenter_private.owner_pin_ok(text) from public, anon, authenticated;

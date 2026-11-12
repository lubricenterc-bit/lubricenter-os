-- Redondeo del saldo en dólares físicos (pagos mixtos y efectivo USD).
--
-- Problema: el redondeo existente actúa sobre el total REF y solo antes del primer pago.
-- Con 50 REF, 1 REF ya pagado por pago móvil y tasa operativa 1.090,25, faltan $40,65
-- en efectivo y no había forma de quitar los 0,65.
--
-- Solución: el cajero pulsa ↓ o ↑ en el cobro en efectivo USD. El saldo pendiente en
-- dólares físicos queda en un entero; la diferencia se guarda en REF en
-- orders.adjust_cash_rounding_ref y se reparte solo en la parte de Lubricenter
-- (los mecánicos no se tocan), igual que el redondeo normal.

alter table public.orders
  add column if not exists adjust_cash_rounding_ref numeric not null default 0;

comment on column public.orders.adjust_cash_rounding_ref is
  'Ajuste REF para dejar en entero el saldo en dólares físicos. Se borra si cambian los ítems o se elimina un pago.';

-- 1) El recálculo suma el ajuste del efectivo al total buscado.
create or replace function lubricenter_private.recompute_order_adjustments(p_order_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  o public.orders; i record;
  v_total numeric; v_base numeric; v_discount numeric := 0; v_after numeric; v_target numeric;
  v_rounding numeric := 0; v_delta numeric; v_left numeric; v_share numeric; v_new numeric; v_count int; v_n int := 0;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'OPEN' then return null; end if;

  update public.order_items it
  set charged_ref_amount = it.list_ref_amount, charged_ves_amount = it.list_ves_amount,
      list_ref_amount = null, list_ves_amount = null
  where it.order_id = p_order_id and it.list_ref_amount is not null;

  select coalesce(sum(it.charged_ref_amount), 0) into v_total from public.order_items it where it.order_id = p_order_id;

  select coalesce(sum(greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
           - coalesce(it.assistant_bonus_ref_snapshot, 0), 0)), 0), count(*)
    into v_base, v_count
  from public.order_items it
  where it.order_id = p_order_id
    and lubricenter_private.effective_line_role(it) in ('PRODUCT','LABOR','OIL_LABOR')
    and greatest(it.charged_ref_amount - coalesce(it.worker_share_ref_snapshot, 0)
           - coalesce(it.assistant_bonus_ref_snapshot, 0), 0) > 0;

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
    else round(v_after, 2) end
    + coalesce(o.adjust_cash_rounding_ref, 0);
  v_rounding := v_target - v_after;
  v_delta := v_target - v_total;

  if v_delta = 0 or v_count = 0 or v_base <= 0 then
    update public.orders set adjust_discount_ref = 0, adjust_rounding_ref = 0 where id = p_order_id;
    return jsonb_build_object('total_ref', v_total, 'discount_ref', 0, 'rounding_ref', 0);
  end if;
  if -v_delta > v_base then
    raise exception 'El descuento es mayor que la parte de Lubricenter en esta orden (% REF)', round(v_base, 2);
  end if;

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
end $function$;

-- 2) Si cambian los ítems, el saldo cambia: el ajuste del efectivo se borra.
create or replace function lubricenter_private.order_items_reapply_adjustments()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if exists(select 1 from public.orders o where o.id = v_order and o.status = 'OPEN'
      and (o.adjust_discount_percent > 0 or o.adjust_rounding_mode <> 'NONE' or o.adjust_cash_rounding_ref <> 0)) then
    update public.orders set adjust_cash_rounding_ref = 0 where id = v_order and adjust_cash_rounding_ref <> 0;
    perform lubricenter_private.recompute_order_adjustments(v_order);
  end if;
  return null;
end $function$;

-- 3) Si se elimina un pago de una orden abierta, también se borra.
create or replace function lubricenter_private.payments_reset_cash_rounding()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if exists(select 1 from public.orders o where o.id = old.order_id and o.status = 'OPEN' and o.adjust_cash_rounding_ref <> 0) then
    update public.orders set adjust_cash_rounding_ref = 0 where id = old.order_id;
    perform lubricenter_private.recompute_order_adjustments(old.order_id);
  end if;
  return null;
end $function$;

drop trigger if exists zz_reset_cash_rounding on public.payments;
create trigger zz_reset_cash_rounding after delete on public.payments
  for each row execute function lubricenter_private.payments_reset_cash_rounding();

-- 4) RPC que usa el cajero: p_direction = 'DOWN' | 'UP' | 'NONE' (deshacer).
create or replace function public.round_order_cash_remainder(p_order_id uuid, p_direction text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  o public.orders; v_dir text := upper(coalesce(p_direction, 'NONE'));
  v_bcv numeric; v_op numeric; v_total_ves numeric; v_paid_ves numeric; v_remaining numeric;
  v_cash numeric; v_target numeric; v_delta_ref numeric; v_result jsonb;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if v_dir not in ('DOWN','UP','NONE') then raise exception 'Redondeo inválido'; end if;
  select * into o from public.orders where id = p_order_id for update;

  if exists(select 1 from public.order_items i where i.order_id = p_order_id and i.price_denomination = 'USD') then
    raise exception 'Esta orden tiene precio pactado en USD; ajusta el total pactado en vez de redondear.';
  end if;

  -- Partir siempre del estado sin ajuste de efectivo.
  update public.orders set adjust_cash_rounding_ref = 0 where id = p_order_id;
  perform lubricenter_private.recompute_order_adjustments(p_order_id);

  select r.bcv_rate, r.operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id) r(bcv_rate, operative_rate);
  select coalesce(sum(i.charged_ves_amount), 0) into v_total_ves from public.order_items i where i.order_id = p_order_id;
  select coalesce(sum(p.value_ves), 0) into v_paid_ves from public.payments p where p.order_id = p_order_id;
  v_remaining := v_total_ves - v_paid_ves;
  v_cash := round(v_remaining / v_op, 2);

  if v_dir = 'NONE' then
    v_delta_ref := 0;
    v_target := v_cash;
  else
    if v_remaining <= 1 then raise exception 'La orden no tiene saldo pendiente.'; end if;
    v_target := case v_dir when 'DOWN' then floor(v_cash) else ceil(v_cash) end;
    if v_target <= 0 then raise exception 'El saldo es menor a $1; no se puede redondear hacia abajo.'; end if;
    v_delta_ref := round((v_target - v_cash) * v_op / v_bcv, 4);
  end if;

  if v_delta_ref <> 0 then
    update public.orders set adjust_cash_rounding_ref = v_delta_ref where id = p_order_id;
    v_result := lubricenter_private.recompute_order_adjustments(p_order_id);
  end if;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.cash_rounding_applied', 'order', p_order_id,
    jsonb_build_object('direction', v_dir, 'cash_before', v_cash, 'cash_after', v_target,
      'delta_ref', v_delta_ref, 'operative_rate', v_op, 'bcv_rate', v_bcv, 'result', v_result));

  return jsonb_build_object('cash_before', v_cash, 'cash_after', v_target, 'delta_ref', v_delta_ref);
end $function$;

revoke all on function public.round_order_cash_remainder(uuid, text) from public, anon;
grant execute on function public.round_order_cash_remainder(uuid, text) to authenticated;

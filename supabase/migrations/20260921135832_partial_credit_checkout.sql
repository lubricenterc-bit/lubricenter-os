-- Registro atómico de un abono y el saldo pendiente en Crédito LC.
-- Evita que una venta quede con el pago guardado pero sin su cuenta por cobrar.
create or replace function public.close_order_with_partial_credit(
  p_order_id uuid,
  p_method text,
  p_amount_original numeric,
  p_reference text default null,
  p_due_date date default null
)
returns table(
  order_number text,
  total_ves numeric,
  total_ref numeric,
  payment_id uuid,
  receivable_id uuid,
  outstanding_ves numeric,
  outstanding_ref numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_total_ves numeric;
  v_paid_ves numeric;
  v_bcv numeric;
  v_operative numeric;
  v_method text := upper(coalesce(p_method, ''));
  v_new_payment_ves numeric;
  v_payment_id uuid;
  v_credit record;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC') then
    raise exception 'Selecciona una forma de pago válida para el abono';
  end if;
  if p_amount_original is null or p_amount_original <= 0 then
    raise exception 'Indica un abono mayor que cero';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.customer_id is null then
    raise exception 'Crédito LC requiere un cliente asociado a la orden';
  end if;
  if exists(select 1 from public.receivables where order_id = p_order_id) then
    raise exception 'La orden ya tiene una cuenta por cobrar';
  end if;

  select coalesce(sum(charged_ves_amount), 0) into v_total_ves
  from public.order_items where order_id = p_order_id;
  select coalesce(sum(value_ves), 0) into v_paid_ves
  from public.payments where order_id = p_order_id;
  select bcv_rate, operative_rate into v_bcv, v_operative from public.current_exchange_rates;

  if v_total_ves <= 0 then raise exception 'Agrega productos o trabajos antes de cobrar'; end if;
  if v_bcv is null or v_operative is null then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  v_new_payment_ves := case when v_method = 'CASH_USD' then p_amount_original * v_operative else p_amount_original end;
  if v_paid_ves + v_new_payment_ves >= v_total_ves - 1 then
    raise exception 'El abono cubre toda la orden. Usa “Cobro directo” para cerrarla como pagada';
  end if;

  v_payment_id := public.add_payment(p_order_id, v_method, p_amount_original, p_reference);
  select * into v_credit from public.close_order_with_credit(p_order_id, p_due_date);

  return query select
    v_credit.order_number,
    v_credit.total_ves,
    v_credit.total_ref,
    v_payment_id,
    v_credit.receivable_id,
    v_credit.outstanding_ves,
    v_credit.outstanding_ref;
end;
$$;

-- Venta rápida con cliente, abono y Crédito LC en una sola transacción.
create or replace function public.quick_sale_partial_credit(
  p_items jsonb,
  p_customer_id uuid,
  p_method text,
  p_amount_original numeric,
  p_reference text default null,
  p_due_date date default null,
  p_business_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_credit record;
begin
  perform public.require_auth();
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception 'Selecciona un cliente para dejar el saldo en Crédito LC';
  end if;

  perform set_config('lubricenter.business_at', coalesce(p_business_at::text, ''), true);
  select * into v_sale from public.build_quick_sale_order(p_items);
  perform public.set_order_party(v_sale.order_id, p_customer_id, null);
  select * into v_credit from public.close_order_with_partial_credit(
    v_sale.order_id, p_method, p_amount_original, p_reference, p_due_date
  );

  return jsonb_build_object(
    'order_id', v_sale.order_id,
    'order_number', v_credit.order_number,
    'total_ves', v_credit.total_ves,
    'total_ref', v_credit.total_ref,
    'payment_id', v_credit.payment_id,
    'receivable_id', v_credit.receivable_id,
    'outstanding_ves', v_credit.outstanding_ves,
    'outstanding_ref', v_credit.outstanding_ref
  );
end;
$$;

revoke all on function public.close_order_with_partial_credit(uuid, text, numeric, text, date) from public, anon;
grant execute on function public.close_order_with_partial_credit(uuid, text, numeric, text, date) to authenticated;
revoke all on function public.quick_sale_partial_credit(jsonb, uuid, text, numeric, text, date, timestamptz) from public, anon;
grant execute on function public.quick_sale_partial_credit(jsonb, uuid, text, numeric, text, date, timestamptz) to authenticated;


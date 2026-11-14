-- Cuenta «Por cobrar» y notas de orden (14 nov 2026, pedido del dueño).
--
-- 1. Nueva cuenta «Por cobrar» (CLEARING, Bs) y método de pago POR_COBRAR: la venta se registra
--    a precio normal, la mercancía sale del inventario y el importe queda en «Por cobrar» en vez
--    de entrar a un banco o caja que no lo recibió (p. ej. lo cobró el negocio de al lado para
--    abonar a una deuda). Así no hay entradas falsas en el BDV ni ventas «casi regaladas».
-- 2. Notas de orden: cualquier persona que ve la orden puede dejar notas en cualquier orden
--    (abierta, cerrada o anulada). Se guardan aparte, con autor y hora, y no se editan ni borran.
-- 3. Cobrar con «Por cobrar» exige una nota (qué se debe y quién lo cobra).
--
-- Solo se usa desde dos RPC nuevas: order_add_por_cobrar (Nueva orden) y quick_sale_por_cobrar
-- (Venta rápida). Las funciones de cobro existentes (vuelto, Cashea, crédito) no cambian.
-- Aditiva salvo: el CHECK de payments.method se amplía y assign_payment_account suma un caso.

insert into public.financial_accounts(code, name, currency, account_type)
select 'POR_COBRAR', 'Por cobrar', 'VES', 'CLEARING'
where not exists (select 1 from public.financial_accounts where code = 'POR_COBRAR');

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check check (method = any (array[
  'CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE',
  'CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV','POR_COBRAR']));

-- Igual a la versión en producción + POR_COBRAR → cuenta POR_COBRAR.
create or replace function public.assign_payment_account()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_code text;
begin
  if new.method in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') then
    if new.financial_account_id is not null then raise exception 'El saldo a favor no ingresa a una cuenta de caja'; end if;
    return new;
  end if;
  if new.financial_account_id is not null then return new; end if;
  v_code := case new.method
    when 'CASH_VES' then 'CASH_VES' when 'CASH_USD' then 'CASH_USD'
    when 'ZELLE' then 'ZELLE' when 'BINANCE' then 'BINANCE'
    when 'TRANSFER_BDV' then 'BDV' when 'TRANSFER_BNC' then 'BNC'
    when 'MOBILE_PAYMENT' then 'MOBILE' when 'POR_COBRAR' then 'POR_COBRAR' else null end;
  if v_code is null then raise exception 'No existe cuenta configurada para el método %',new.method; end if;
  select id into new.financial_account_id from public.financial_accounts where code=v_code and active=true;
  if new.financial_account_id is null then raise exception 'Cuenta financiera % no disponible',v_code; end if;
  return new;
end $function$;

-- Notas de orden ---------------------------------------------------------------------------
create table if not exists public.order_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  note text not null check (length(btrim(note)) between 1 and 1000),
  kind text not null default 'NOTE' check (kind in ('NOTE','POR_COBRAR')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists order_notes_order_idx on public.order_notes(order_id, created_at);
alter table public.order_notes enable row level security;
drop policy if exists order_notes_read on public.order_notes;
create policy order_notes_read on public.order_notes for select to authenticated
  using ((select lubricenter_private.staff_can('orders.view')));
revoke all on public.order_notes from anon;
revoke insert, update, delete, truncate on public.order_notes from authenticated;
grant select on public.order_notes to authenticated;

create or replace function public.add_order_note(p_order_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_note text := nullif(btrim(coalesce(p_note, '')), ''); r public.order_notes;
begin
  perform public.require_auth();
  if not lubricenter_private.staff_can('orders.view') then
    raise exception 'PERMISO_DENEGADO: orders.view' using errcode = '42501';
  end if;
  if v_note is null then raise exception 'Escribe la nota.'; end if;
  if length(v_note) > 1000 then raise exception 'La nota admite hasta 1000 caracteres.'; end if;
  if not exists (select 1 from public.orders o where o.id = p_order_id) then raise exception 'Orden no encontrada'; end if;
  insert into public.order_notes(order_id, note) values (p_order_id, v_note) returning * into r;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.note_added', 'order', p_order_id, jsonb_build_object('note_id', r.id, 'actor', auth.uid()));
  return to_jsonb(r);
end $$;

-- Un pago POR_COBRAR siempre necesita su nota. Si llega por otro camino (p. ej. corrección de
-- una venta cerrada) con referencia escrita, la referencia se guarda como la nota.
create or replace function lubricenter_private.payments_por_cobrar_note()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.method <> 'POR_COBRAR' then return new; end if;
  if not exists (select 1 from public.order_notes n where n.order_id = new.order_id and n.kind = 'POR_COBRAR') then
    if nullif(btrim(coalesce(new.reference, '')), '') is null then
      raise exception 'POR_COBRAR_SIN_NOTA: escribe la nota de «Por cobrar» (qué se debe y quién lo cobra).';
    end if;
    insert into public.order_notes(order_id, note, kind) values (new.order_id, left(btrim(new.reference), 1000), 'POR_COBRAR');
  end if;
  return new;
end $$;
drop trigger if exists aa_payments_por_cobrar_note on public.payments;
create trigger aa_payments_por_cobrar_note before insert on public.payments
  for each row execute function lubricenter_private.payments_por_cobrar_note();

-- Cobro «Por cobrar» del saldo pendiente de una orden abierta ---------------------------------
create or replace function lubricenter_private.add_por_cobrar_payment(p_order_id uuid, p_note text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_order public.orders; v_bcv numeric; v_op numeric; v_remaining numeric; v_id uuid;
begin
  if v_note is null or length(v_note) < 5 then
    raise exception 'POR_COBRAR_SIN_NOTA: escribe la nota de «Por cobrar» (qué se debe y quién lo cobra).';
  end if;
  if length(v_note) > 1000 then raise exception 'La nota admite hasta 1000 caracteres.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status <> 'OPEN' then raise exception 'La orden debe estar abierta para registrar «Por cobrar»'; end if;
  select r.bcv_rate, r.operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id) r;
  if coalesce(v_bcv, 0) <= 0 or coalesce(v_op, 0) <= 0 then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  select coalesce(sum(i.charged_ves_amount), 0) - coalesce((select sum(p.value_ves) from public.payments p where p.order_id = p_order_id), 0)
    into v_remaining from public.order_items i where i.order_id = p_order_id;
  v_remaining := round(v_remaining, 2);
  if v_remaining <= 1 then raise exception 'La orden ya está cubierta; no queda nada por cobrar.'; end if;

  insert into public.order_notes(order_id, note, kind) values (p_order_id, v_note, 'POR_COBRAR');
  insert into public.payments(order_id, method, currency, amount_original, bcv_rate_snapshot, operative_rate_snapshot,
    value_ves, value_ref, reference)
  values (p_order_id, 'POR_COBRAR', 'VES', v_remaining, v_bcv, v_op, v_remaining, round(v_remaining / v_bcv, 4), left(v_note, 100))
  returning id into v_id;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('order.por_cobrar', 'order', p_order_id, jsonb_build_object('payment_id', v_id, 'value_ves', v_remaining, 'actor', auth.uid()));
  return v_id;
end $$;

create or replace function public.order_add_por_cobrar(p_order_id uuid, p_note text)
returns uuid language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_auth();
  return lubricenter_private.add_por_cobrar_payment(p_order_id, p_note);
end $$;

-- Venta rápida cobrada con «Por cobrar» (idempotente por p_request, como quick_sale_direct_v2).
create or replace function public.quick_sale_por_cobrar(p_request uuid, p_items jsonb, p_note text,
  p_business_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare previous public.sale_operation_requests; payload jsonb := jsonb_build_array(p_items, p_note, p_business_at);
  sale record; result jsonb;
begin
  perform public.require_auth();
  if p_request is null then raise exception 'Falta el identificador de la venta'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null or length(btrim(p_note)) < 5 then
    raise exception 'POR_COBRAR_SIN_NOTA: escribe la nota de «Por cobrar» (qué se debe y quién lo cobra).';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request::text, 99));
  select * into previous from public.sale_operation_requests where id = p_request;
  if found then
    if previous.actor_id <> auth.uid() or previous.kind <> 'POR_COBRAR' or previous.payload <> payload then
      raise exception 'Solicitud reutilizada con otros datos';
    end if;
    return previous.result;
  end if;
  perform set_config('lubricenter.business_at', coalesce(p_business_at::text, ''), true);
  select * into sale from public.build_quick_sale_order(p_items);
  perform lubricenter_private.add_por_cobrar_payment(sale.order_id, p_note);
  perform public.close_order(sale.order_id);
  select jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'total_ves', o.total_ves, 'total_ref', o.total_ref)
    into result from public.orders o where o.id = sale.order_id;
  insert into public.sale_operation_requests values (p_request, auth.uid(), 'POR_COBRAR', payload, result, now());
  return result;
end $$;

revoke all on function lubricenter_private.payments_por_cobrar_note() from public, anon, authenticated;
revoke all on function lubricenter_private.add_por_cobrar_payment(uuid, text) from public, anon, authenticated;
revoke all on function public.add_order_note(uuid, text) from public, anon;
revoke all on function public.order_add_por_cobrar(uuid, text) from public, anon;
revoke all on function public.quick_sale_por_cobrar(uuid, jsonb, text, timestamptz) from public, anon;
grant execute on function public.add_order_note(uuid, text) to authenticated;
grant execute on function public.order_add_por_cobrar(uuid, text) to authenticated;
grant execute on function public.quick_sale_por_cobrar(uuid, jsonb, text, timestamptz) to authenticated;

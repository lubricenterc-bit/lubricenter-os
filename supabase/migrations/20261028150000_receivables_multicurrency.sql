-- Fase 0 · Cuentas por cobrar en REF BCV y $ divisas.
--
-- Antes: la deuda vivía solo en bolívares (outstanding_ves) y un abono en USD se
-- convertía y redondeaba, dejando restos de Bs 1,38–1,57 que nunca cerraban; además
-- la deuda perdía valor con la devaluación.
--
-- Ahora cada deuda guarda dos montos equivalentes (principal_ref y principal_usd) y la
-- parte que falta como fracción (outstanding_fraction: 1 = debe todo, 0 = pagada).
-- Un abono en Bs baja la deuda en REF al BCV del día; un abono en USD (Zelle, Binance,
-- efectivo $) la baja en $ divisas. Ambas monedas bajan en el mismo porcentaje.
-- La deuda cierra cuando lo que falta en la moneda del abono es menor a 0,01.
-- outstanding_ves se mantiene como fracción × principal_ves para que los reportes
-- existentes (equivalente al BCV de factura) sigan funcionando igual.

alter table public.receivables
  add column if not exists principal_usd numeric(14,2),
  add column if not exists outstanding_fraction numeric(14,12) not null default 1;

do $$ begin
  alter table public.receivables add constraint receivables_outstanding_fraction_range
    check (outstanding_fraction >= 0 and outstanding_fraction <= 1);
exception when duplicate_object then null; end $$;

alter table public.payments
  add column if not exists applied_ref numeric(14,4),
  add column if not exists applied_usd numeric(14,2);

comment on column public.receivables.principal_usd is
  'Monto de la deuda en $ divisas (precio USD oculto) al momento de la venta.';
comment on column public.receivables.outstanding_fraction is
  'Parte que falta por cobrar: 1 = todo, 0 = pagada. Aplica igual a principal_ref y principal_usd.';
comment on column public.payments.applied_ref is 'REF BCV de la deuda que canceló este abono.';
comment on column public.payments.applied_usd is '$ divisas de la deuda que canceló este abono.';

-- Tasa $ divisas de una orden, sin exigir sesión (uso interno: triggers y migración).
create or replace function lubricenter_private.order_divisas_rate(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (select sum(i.charged_ves_amount) / nullif(sum(i.agreed_usd), 0)
       from public.order_items i where i.order_id = p_order_id
       having bool_and(i.price_denomination = 'USD')),
    (select o.sale_operative_rate from public.orders o where o.id = p_order_id),
    (select i.operative_rate_snapshot from public.order_items i
      where i.order_id = p_order_id order by i.created_at, i.id limit 1)
  )
$$;
revoke all on function lubricenter_private.order_divisas_rate(uuid) from public, anon, authenticated;

-- Al crear una deuda (cualquiera de los flujos actuales), completa el monto en $ divisas
-- y la fracción pendiente.
create or replace function lubricenter_private.receivable_fill_currencies()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare v_rate numeric;
begin
  if new.principal_usd is null then
    v_rate := lubricenter_private.order_divisas_rate(new.order_id);
    if v_rate is not null and v_rate > 0 then
      new.principal_usd := round(new.principal_ves / v_rate, 2);
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.outstanding_fraction := case
      when new.status = 'PAID' then 0
      when coalesce(new.principal_ves, 0) <= 0 then 1
      else least(1, greatest(0, coalesce(new.outstanding_ves, new.principal_ves) / new.principal_ves))
    end;
  end if;
  return new;
end $$;

drop trigger if exists aa_receivable_fill_currencies on public.receivables;
create trigger aa_receivable_fill_currencies
  before insert on public.receivables
  for each row execute function lubricenter_private.receivable_fill_currencies();

-- Datos existentes: monto en $ divisas y fracción pendiente.
update public.receivables r
set principal_usd = coalesce(r.principal_usd,
      round(r.principal_ves / nullif(lubricenter_private.order_divisas_rate(r.order_id), 0), 2)),
    outstanding_fraction = case
      when r.status = 'PAID' then 0
      when coalesce(r.principal_ves, 0) <= 0 then 1
      else least(1, greatest(0, r.outstanding_ves / r.principal_ves))
    end;

-- Deudas que quedaron abiertas solo por un resto de redondeo (OS-000102 y OS-000121):
-- se cierran y queda constancia en la auditoría.
with residual as (
  select r.id, r.order_id, r.outstanding_ves, r.outstanding_fraction
  from public.receivables r
  where r.status = 'OPEN'
    and r.outstanding_ves > 0
    and r.outstanding_fraction * coalesce(r.principal_usd, 0) < 0.01
    and r.outstanding_fraction * r.principal_ref < 0.01
), closed as (
  update public.receivables r
  set outstanding_ves = 0, outstanding_fraction = 0, status = 'PAID', closed_at = now()
  from residual x where r.id = x.id
  returning r.id
)
insert into public.audit_events(event_type, entity_type, entity_id, data)
select 'receivable.closed_rounding_residual', 'receivable', x.id,
  jsonb_build_object('order_id', x.order_id, 'residual_ves', x.outstanding_ves,
    'residual_fraction', x.outstanding_fraction,
    'reason', 'Resto de redondeo de un abono en USD; la deuda se pagó completa')
from residual x where x.id in (select id from closed);

-- Abono a una deuda, en la moneda en que paga el cliente.
create or replace function public.record_receivable_payment(
  p_receivable_id uuid,
  p_method text,
  p_amount_original numeric,
  p_reference text default null
)
returns table(
  payment_id uuid,
  status text,
  outstanding_fraction numeric,
  remaining_ref numeric,
  remaining_usd numeric,
  remaining_ves_today numeric,
  outstanding_ves numeric
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_r public.receivables;
  v_method text := upper(coalesce(p_method, ''));
  v_currency text;
  v_bcv numeric;
  v_order_usd numeric;
  v_rem_ref numeric;
  v_rem_usd numeric;
  v_rem_pay numeric;
  v_share numeric;
  v_new_fraction numeric;
  v_value_ves numeric;
  v_payment_id uuid;
  v_status text;
begin
  perform public.require_auth();

  select * into v_r from public.receivables where id = p_receivable_id for update;
  if not found then raise exception 'Cuenta por cobrar no encontrada'; end if;
  if v_r.status <> 'OPEN' then raise exception 'La cuenta por cobrar no está abierta'; end if;

  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
    raise exception 'Método de pago inválido';
  end if;
  if p_amount_original is null or p_amount_original::text in ('NaN','Infinity','-Infinity')
     or p_amount_original <= 0 or round(p_amount_original, 2) <> p_amount_original then
    raise exception 'Indica un monto positivo con máximo dos decimales';
  end if;

  select bcv_rate into v_bcv from public.current_exchange_rates;
  if v_bcv is null or v_bcv <= 0 then raise exception 'Debes registrar la tasa BCV antes de cobrar'; end if;
  v_order_usd := public.order_usd_rate(v_r.order_id);
  if v_r.principal_usd is null or v_r.principal_usd <= 0 then
    raise exception 'La deuda no tiene monto en $ divisas; revisa la orden';
  end if;

  v_currency := case when v_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
  v_rem_ref := v_r.outstanding_fraction * v_r.principal_ref;
  v_rem_usd := v_r.outstanding_fraction * v_r.principal_usd;
  v_rem_pay := case when v_currency = 'USD' then round(v_rem_usd, 2) else round(v_rem_ref * v_bcv, 2) end;

  if p_amount_original > v_rem_pay + 0.01 then
    raise exception 'El abono excede lo que falta. Falta % % (o % REF)',
      case when v_currency = 'USD' then '$' else 'Bs' end, v_rem_pay, round(v_rem_ref, 2);
  end if;

  v_share := case when v_currency = 'USD'
    then p_amount_original / v_r.principal_usd
    else (p_amount_original / v_bcv) / v_r.principal_ref end;
  v_new_fraction := greatest(v_r.outstanding_fraction - v_share, 0);
  -- Cierra si en la moneda del abono falta menos de un céntimo.
  if p_amount_original >= v_rem_pay - 0.01
     or (case when v_currency = 'USD' then v_new_fraction * v_r.principal_usd
              else v_new_fraction * v_r.principal_ref * v_bcv end) < 0.01 then
    v_new_fraction := 0;
  end if;
  v_status := case when v_new_fraction = 0 then 'PAID' else 'OPEN' end;

  -- value_ves / value_ref conservan la valoración anterior para no alterar reportes.
  v_value_ves := case when v_currency = 'USD' then p_amount_original * v_order_usd else p_amount_original end;

  insert into public.payments(
    order_id, receivable_id, method, currency, amount_original,
    bcv_rate_snapshot, operative_rate_snapshot, value_ves, value_ref,
    applied_ref, applied_usd, reference, paid_at
  ) values (
    v_r.order_id, p_receivable_id, v_method, v_currency, p_amount_original,
    v_bcv, v_order_usd, round(v_value_ves, 2), round(v_value_ves / v_bcv, 4),
    round((v_r.outstanding_fraction - v_new_fraction) * v_r.principal_ref, 4),
    round((v_r.outstanding_fraction - v_new_fraction) * v_r.principal_usd, 2),
    nullif(trim(p_reference), ''), now()
  ) returning id into v_payment_id;

  update public.receivables
  set outstanding_fraction = v_new_fraction,
      outstanding_ves = round(v_new_fraction * principal_ves, 2),
      status = v_status,
      closed_at = case when v_status = 'PAID' then now() else null end
  where id = p_receivable_id;

  insert into public.integration_events(event_type, aggregate_type, aggregate_id, payload)
  values (
    case when v_status = 'PAID' then 'receivable.paid' else 'receivable.payment_recorded' end,
    'receivable', p_receivable_id,
    jsonb_build_object('order_id', v_r.order_id, 'payment_id', v_payment_id, 'method', v_method,
      'currency', v_currency, 'amount_original', p_amount_original,
      'outstanding_fraction', v_new_fraction, 'status', v_status));
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('receivable.payment_recorded', 'receivable', p_receivable_id,
    jsonb_build_object('payment_id', v_payment_id, 'method', v_method, 'currency', v_currency,
      'amount_original', p_amount_original, 'bcv', v_bcv,
      'fraction_before', v_r.outstanding_fraction, 'fraction_after', v_new_fraction,
      'status', v_status));

  return query select
    v_payment_id, v_status, v_new_fraction,
    round(v_new_fraction * v_r.principal_ref, 4),
    round(v_new_fraction * v_r.principal_usd, 2),
    round(v_new_fraction * v_r.principal_ref * v_bcv, 2),
    round(v_new_fraction * v_r.principal_ves, 2);
end $$;

revoke all on function public.record_receivable_payment(uuid, text, numeric, text) from public, anon;
grant execute on function public.record_receivable_payment(uuid, text, numeric, text) to authenticated;

-- La función anterior queda como envoltorio para cualquier pantalla que aún la use.
create or replace function public.record_credit_payment(
  p_receivable_id uuid, p_method text, p_amount_original numeric, p_reference text default null
)
returns table(payment_id uuid, outstanding_ves numeric, status text)
language sql
security definer
set search_path to 'public'
as $$
  select x.payment_id, x.outstanding_ves, x.status
  from public.record_receivable_payment(p_receivable_id, p_method, p_amount_original, p_reference) x
$$;

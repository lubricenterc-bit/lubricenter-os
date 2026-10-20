-- Daily rates are resolved in Caracas. A non-publishing day carries the last
-- recorded rate, with the original source date visible to the cashier.
create or replace function public.get_exchange_rates_for_date(p_date date default null)
returns table(bcv_rate numeric, operative_rate numeric, bcv_date date, operative_date date)
language plpgsql stable security invoker set search_path='' as $$
declare d date:=coalesce(p_date,(now() at time zone 'America/Caracas')::date);
begin
 perform public.require_auth();
 if d>(now() at time zone 'America/Caracas')::date then raise exception 'No se admiten tasas de fechas futuras'; end if;
 return query select b.value,o.value,
  (b.effective_at at time zone 'America/Caracas')::date,
  (o.effective_at at time zone 'America/Caracas')::date
 from lateral (select * from public.exchange_rates where rate_type='BCV'
   and (effective_at at time zone 'America/Caracas')::date<=d and effective_at<=now()
   order by effective_at desc,created_at desc,id desc limit 1) b
 cross join lateral (select * from public.exchange_rates where rate_type='OPERATIVE'
   and (effective_at at time zone 'America/Caracas')::date<=d and effective_at<=now()
   order by effective_at desc,created_at desc,id desc limit 1) o;
 if not found then raise exception 'No hay historial completo de tasas para %. Registra las tasas de esa fecha antes de vender',d; end if;
end $$;
create or replace function public.get_exchange_rate_history(p_from date,p_to date)
returns table(business_date date,bcv_rate numeric,operative_rate numeric,bcv_date date,operative_date date)
language plpgsql stable security invoker set search_path='' as $$
begin
 perform public.require_auth();
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>92 then raise exception 'Selecciona un intervalo de hasta 93 días'; end if;
 return query select d::date,r.bcv_rate,r.operative_rate,r.bcv_date,r.operative_date
 from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d
 cross join lateral public.get_exchange_rates_for_date(d::date) r order by d desc;
end $$;
revoke all on function public.get_exchange_rate_history(date,date) from public,anon;
grant execute on function public.get_exchange_rate_history(date,date) to authenticated;
alter table public.orders add column if not exists sale_bcv_rate numeric;
alter table public.orders add column if not exists sale_operative_rate numeric;
create or replace function public.get_order_rates(p_order_id uuid)
returns table(bcv_rate numeric,operative_rate numeric)
language plpgsql stable security invoker set search_path='' as $$
declare o public.orders;
begin
 perform public.require_auth();
 select * into o from public.orders where id=p_order_id;
 if not found then raise exception 'Orden no encontrada'; end if;
 if o.sale_bcv_rate is not null and o.sale_operative_rate is not null then
  return query select o.sale_bcv_rate,o.sale_operative_rate;
 else
  -- Existing orders keep their original valuation, including paid orders.
  return query select i.bcv_rate_snapshot,i.operative_rate_snapshot
   from public.order_items i where i.order_id=o.id order by i.created_at,i.id limit 1;
  if not found then return query select r.bcv_rate,r.operative_rate from public.get_exchange_rates_for_date((coalesce(o.business_at,o.opened_at) at time zone 'America/Caracas')::date) r; end if;
 end if;
end $$;
create or replace function lubricenter_private.snapshot_sale_rates()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 select r.bcv_rate,r.operative_rate into new.sale_bcv_rate,new.sale_operative_rate
 from public.get_exchange_rates_for_date((coalesce(new.business_at,new.opened_at,now()) at time zone 'America/Caracas')::date) r;
 return new;
end $$;
create trigger ac_snapshot_sale_rates before insert on public.orders
for each row execute function lubricenter_private.snapshot_sale_rates();

create or replace function lubricenter_private.set_order_date(p_order_id uuid,p_business_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare b numeric; op numeric;
begin
 perform public.require_auth(); perform public.assert_order_open(p_order_id);
 if p_business_at is null or p_business_at>now()+interval '5 minutes' then raise exception 'Indica la fecha real de la venta, sin fechas futuras'; end if;
 if exists(select 1 from public.payments where order_id=p_order_id) then
  raise exception 'La orden ya tiene pagos. La fecha y tasas quedan protegidas; usa una corrección auditada'; end if;
 select r.bcv_rate,r.operative_rate into b,op from public.get_exchange_rates_for_date((p_business_at at time zone 'America/Caracas')::date) r;
 perform set_config('lubricenter.reason','Cambio de fecha y recálculo histórico antes del cobro',true);
 update public.orders set business_at=p_business_at,opened_at=p_business_at,sale_bcv_rate=b,sale_operative_rate=op where id=p_order_id;
 update public.order_items set
  charged_ves_amount=case when price_denomination='USD' then round(agreed_usd*op,2) else round(charged_ves_amount*b/bcv_rate_snapshot,2) end,
  charged_ref_amount=case when price_denomination='USD' then round(agreed_usd*op/b,4) else charged_ref_amount end,
  base_ref_amount=case when price_denomination='USD' then round(base_ref_amount*(op/b)/(operative_rate_snapshot/bcv_rate_snapshot),4) else base_ref_amount end,
  customer_ref_amount=case when price_denomination='USD' then round(customer_ref_amount*(op/b)/(operative_rate_snapshot/bcv_rate_snapshot),4) else customer_ref_amount end,
  worker_share_ref_snapshot=case when price_denomination='USD' then round(worker_share_ref_snapshot*(op/b)/(operative_rate_snapshot/bcv_rate_snapshot),4) else worker_share_ref_snapshot end,
  assistant_bonus_ref_snapshot=case when price_denomination='USD' then round(assistant_bonus_ref_snapshot*(op/b)/(operative_rate_snapshot/bcv_rate_snapshot),4) else assistant_bonus_ref_snapshot end,
  bcv_rate_snapshot=b,operative_rate_snapshot=op
 where order_id=p_order_id;
end $$;

-- Request IDs survive retries; a request can never be reused for different data.
create table public.sale_operation_requests(
 id uuid primary key, actor_id uuid not null, kind text not null,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now()
);
alter table public.sale_operation_requests enable row level security;
revoke all on public.sale_operation_requests from anon,authenticated;
create policy sale_operation_requests_read_own on public.sale_operation_requests
for select to authenticated using(actor_id=(select auth.uid()));
grant select on public.sale_operation_requests to authenticated;
create or replace function lubricenter_private.prepare_quick_sale(p_request uuid,p_items jsonb,p_business_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.sale_operation_requests; payload jsonb:=jsonb_build_array(p_items,p_business_at); result jsonb;
begin
 perform public.require_auth();
 if p_request is null then raise exception 'Falta el identificador de la venta'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,99));
 select * into previous from public.sale_operation_requests where id=p_request;
 if found then
  if previous.actor_id<>auth.uid() or previous.kind<>'DRAFT' or previous.payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return previous.result;
 end if;
 result:=lubricenter_private.quick_sale_dated(p_items,'DRAFT',p_business_at);
 insert into public.sale_operation_requests values(p_request,auth.uid(),'DRAFT',payload,result,now());
 return result;
end $$;
create or replace function public.prepare_quick_sale(p_request uuid,p_items jsonb,p_business_at timestamptz default null) returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.prepare_quick_sale(p_request,p_items,p_business_at) $$;
revoke all on function lubricenter_private.prepare_quick_sale(uuid,jsonb,timestamptz) from public,anon;
grant execute on function lubricenter_private.prepare_quick_sale(uuid,jsonb,timestamptz) to authenticated;

create or replace function lubricenter_private.quick_sale_direct_v2(p_request uuid,p_items jsonb,p_method text,p_reference text default null,p_business_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.sale_operation_requests; payload jsonb:=jsonb_build_array(p_items,p_method,p_reference,p_business_at); result jsonb;
begin
 perform public.require_auth();
 if p_request is null then raise exception 'Falta el identificador de la venta'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,99));
 select * into previous from public.sale_operation_requests where id=p_request;
 if found then
  if previous.actor_id<>auth.uid() or previous.kind<>'DIRECT' or previous.payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return previous.result;
 end if;
 result:=lubricenter_private.quick_sale_dated(p_items,'DIRECT',p_business_at,p_method,p_reference);
 insert into public.sale_operation_requests values(p_request,auth.uid(),'DIRECT',payload,result,now());
 return result;
end $$;
create or replace function public.quick_sale_direct_v2(p_request uuid,p_items jsonb,p_method text,p_reference text default null,p_business_at timestamptz default null) returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.quick_sale_direct_v2(p_request,p_items,p_method,p_reference,p_business_at) $$;
revoke all on function lubricenter_private.quick_sale_direct_v2(uuid,jsonb,text,text,timestamptz) from public,anon;
grant execute on function lubricenter_private.quick_sale_direct_v2(uuid,jsonb,text,text,timestamptz) to authenticated;

create or replace function lubricenter_private.complete_prepared_cashea(p_request uuid,p_order_id uuid,p_initial_percent numeric,p_initial_payments jsonb,p_cashea_reference text,p_expected_total_ves numeric,p_expected_total_ref numeric,p_expected_bcv numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.sale_operation_requests; payload jsonb:=jsonb_build_array(p_order_id,p_initial_percent,p_initial_payments,p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv); result jsonb; sale uuid;
begin
 perform public.require_auth();
 if p_request is null then raise exception 'Falta el identificador del cobro'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,99));
 select * into previous from public.sale_operation_requests where id=p_request;
 if found then
  if previous.actor_id<>auth.uid() or previous.kind<>'CASHEA' or previous.payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return previous.result;
 end if;
 sale:=lubricenter_private.close_order_cashea_split(p_order_id,p_initial_percent,p_initial_payments,p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv);
 select jsonb_build_object('order_id',o.id,'order_number',o.order_number,'total_ves',o.total_ves,'total_ref',o.total_ref,'initial_ref',s.initial_ref,'financed_ref',s.financed_ref,'commission_ref',s.commission_ref) into result from public.orders o join public.cashea_sales s on s.id=sale where o.id=p_order_id;
 insert into public.sale_operation_requests values(p_request,auth.uid(),'CASHEA',payload,result,now());
 return result;
end $$;
create or replace function public.complete_prepared_cashea(p_request uuid,p_order_id uuid,p_initial_percent numeric,p_initial_payments jsonb,p_cashea_reference text,p_expected_total_ves numeric,p_expected_total_ref numeric,p_expected_bcv numeric) returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.complete_prepared_cashea(p_request,p_order_id,p_initial_percent,p_initial_payments,p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv) $$;
revoke all on function lubricenter_private.complete_prepared_cashea(uuid,uuid,numeric,jsonb,text,numeric,numeric,numeric) from public,anon;
grant execute on function lubricenter_private.complete_prepared_cashea(uuid,uuid,numeric,jsonb,text,numeric,numeric,numeric) to authenticated;

revoke all on function public.get_exchange_rates_for_date(date),public.get_order_rates(uuid),public.prepare_quick_sale(uuid,jsonb,timestamptz),public.quick_sale_direct_v2(uuid,jsonb,text,text,timestamptz),public.complete_prepared_cashea(uuid,uuid,numeric,jsonb,text,numeric,numeric,numeric) from public,anon;
grant execute on function public.get_exchange_rates_for_date(date),public.get_order_rates(uuid),public.prepare_quick_sale(uuid,jsonb,timestamptz),public.quick_sale_direct_v2(uuid,jsonb,text,text,timestamptz),public.complete_prepared_cashea(uuid,uuid,numeric,jsonb,text,numeric,numeric,numeric) to authenticated;
revoke all on function lubricenter_private.snapshot_sale_rates() from public,anon,authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.close_order_cashea(p_order_id uuid, p_initial_percent numeric, p_initial_payment_method text, p_payment_reference text DEFAULT NULL::text, p_cashea_reference text DEFAULT NULL::text, p_expected_total_ves numeric DEFAULT NULL::numeric, p_expected_total_ref numeric DEFAULT NULL::numeric, p_expected_bcv numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders; v_sale uuid; v_total_ref numeric; v_total_ves numeric;
  v_bcv numeric; v_op numeric; v_paid numeric; v_initial_ref numeric; v_initial_ves numeric;
  v_extra numeric; v_financed numeric; v_commission numeric; v_min numeric;
  v_method text := upper(coalesce(p_initial_payment_method,''));
  v_part numeric; v_date date := (now() at time zone 'America/Caracas')::date;
  i public.order_items;
begin
  perform public.require_auth();
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Orden no encontrada'; end if;
  select id into v_sale from public.cashea_sales where order_id=p_order_id;
  if v_sale is not null then return v_sale; end if;
  if v_order.status <> 'OPEN' then raise exception 'La orden ya está cerrada o cancelada'; end if;
  v_date := (coalesce(v_order.business_at,now()) at time zone 'America/Caracas')::date;
  perform public.validate_order_ready_to_close(p_order_id);
  if exists(select 1 from public.receivables where order_id=p_order_id) then raise exception 'La orden ya tiene Crédito LC. Revisa el registro antes de usar Cashea'; end if;
  if p_initial_percent is null or p_initial_percent <= 0 or p_initial_percent > 100 or p_initial_percent::text in ('NaN','Infinity','-Infinity') then raise exception 'Indica una inicial mayor que 0 y hasta 100 por ciento'; end if;
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC') then raise exception 'Selecciona cómo recibiste la inicial'; end if;
  select coalesce(sum(charged_ref_amount),0),coalesce(sum(charged_ves_amount),0) into v_total_ref,v_total_ves from public.order_items where order_id=p_order_id;
  if v_total_ves<=0 then raise exception 'Agrega productos o trabajos antes de cobrar'; end if;
  if p_expected_total_ves is null or p_expected_total_ref is null or abs(p_expected_total_ves-v_total_ves)>0.01 or abs(p_expected_total_ref-v_total_ref)>0.0001 then raise exception 'El total cambió. Actualiza la orden y revisa la inicial antes de confirmar'; end if;
  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'Actualiza las tasas antes de cobrar con Cashea'; end if;
  if p_expected_bcv is null or p_expected_bcv<>v_bcv then raise exception 'La tasa BCV cambió. Vuelve a abrir Cashea para revisar la inicial'; end if;
  select coalesce((select (value #>> '{}')::numeric from public.app_settings where key='cashea_commission_percent'),4) into v_commission;
  select coalesce((select (value #>> '{}')::numeric from public.app_settings where key='cashea_minimum_ref'),25) into v_min;
  if v_total_ref<v_min then raise exception 'Cashea requiere al menos REF %',v_min; end if;
  v_initial_ref := round(v_total_ref*p_initial_percent/100,4);
  v_initial_ves := round(v_initial_ref*v_bcv,2);
  v_financed := round(v_total_ref-v_initial_ref,4);
  select coalesce(sum(value_ves),0) into v_paid from public.payments where order_id=p_order_id;
  if v_paid>v_initial_ves+0.01 then raise exception 'Los pagos registrados superan la inicial en Bs %. Ajusta el porcentaje o corrige el pago antes de confirmar',round(v_paid-v_initial_ves,2); end if;
  v_extra := greatest(round(v_initial_ves-v_paid,2),0);
  if v_extra>0 then
    insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at)
    values(p_order_id,v_method,case when v_method='CASH_USD' then 'USD' else 'VES' end,case when v_method='CASH_USD' then round(v_extra/v_bcv,4) else v_extra end,v_bcv,v_op,v_extra,round(v_extra/v_bcv,4),nullif(trim(p_payment_reference),''),now());
  end if;
  insert into public.cashea_sales(order_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference)
  values(p_order_id,case when v_financed<=0.01 then 'SETTLED' else 'ACTIVE' end,p_initial_percent,v_commission,v_total_ref,v_total_ves,v_initial_ref,v_initial_ves,v_financed,round(v_total_ref*v_commission/100,4),round(v_total_ref*v_commission/100*v_bcv,2),v_bcv,v_method,nullif(trim(p_cashea_reference),'')) returning id into v_sale;
  if v_financed>0.01 then
    v_part:=round(v_financed/3,4);
    insert into public.cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot)
    values(v_sale,1,v_date+14,v_part,round(v_part*v_bcv,2)),(v_sale,2,v_date+28,v_part,round(v_part*v_bcv,2)),(v_sale,3,v_date+42,v_financed-2*v_part,round((v_financed-2*v_part)*v_bcv,2));
  end if;
  update public.orders set status='CLOSED',closed_at=now(),total_ves=round(v_total_ves,2),total_ref=round(v_total_ref,4),total_cash_usd_equivalent=round((select coalesce(sum(charged_ves_amount/nullif(operative_rate_snapshot,0)),0) from public.order_items where order_id=p_order_id),4) where id=p_order_id;
  for i in select * from public.order_items where order_id=p_order_id loop
    if i.business_area='WORKSHOP' and coalesce(i.worker_share_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at) values(i.worker_employee_id,i.id,'WORKSHOP_COMMISSION',i.worker_share_ref_snapshot,'Taller · '||i.description,now()) on conflict do nothing;
    end if;
    if i.business_area='WORKSHOP' and coalesce(i.assistant_bonus_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at) values(i.assistant_bonus_employee_id,i.id,'ASSISTANT_BONUS',i.assistant_bonus_ref_snapshot,'Bono ayudante · '||i.description,now()) on conflict do nothing;
    end if;
    if i.business_area='ELECTROAUTO' and coalesce(i.worker_share_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at) values(i.worker_employee_id,i.id,'ELECTROAUTO_COMMISSION',i.worker_share_ref_snapshot,'Electroauto · '||i.description,now()) on conflict do nothing;
    end if;
  end loop;
  insert into public.integration_events(event_type,aggregate_type,aggregate_id,payload) values('order.closed','order',p_order_id,jsonb_build_object('order_number',v_order.order_number,'payment_status','CASHEA','cashea_sale_id',v_sale,'total_ves',v_total_ves,'total_ref',v_total_ref));
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('order.closed_cashea','order',p_order_id,jsonb_build_object('cashea_sale_id',v_sale,'initial_ref',v_initial_ref,'financed_ref',v_financed,'previous_payments_ves',v_paid));
  return v_sale;
end $function$
;
CREATE OR REPLACE FUNCTION public.apply_customer_balance(p_order_id uuid, p_pocket text, p_amount_usd numeric DEFAULT NULL::numeric, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders; v_available numeric(18,2); v_total numeric; v_paid numeric;
  v_remaining numeric; v_bcv numeric; v_op numeric; v_rate numeric;
  v_max_units numeric(18,2); v_units numeric(18,2); v_value_ves numeric(20,2);
  v_method text; v_currency text; v_original numeric(18,2); v_payment_id uuid;
  v_existing public.customer_balance_movements;
begin
  perform public.require_auth();
  if p_request_id is null then raise exception 'Falta el identificador de esta operación'; end if;
  select * into v_existing from public.customer_balance_movements where request_id=p_request_id;
  if found then
    if v_existing.movement_type='USE' and v_existing.order_id=p_order_id and v_existing.pocket=p_pocket then
      return jsonb_build_object('payment_id',v_existing.payment_id,'used_usd',-v_existing.delta_usd,
        'value_ves',v_existing.value_ves,'pocket',v_existing.pocket);
    end if;
    raise exception 'Este identificador ya corresponde a otra operación';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.status<>'OPEN' then raise exception 'La orden debe estar abierta'; end if;
  if v_order.customer_id is null then raise exception 'Asocia un cliente antes de usar saldo a favor'; end if;
  if p_pocket not in ('USD','VES_BCV') or p_pocket is null then raise exception 'Elige el saldo USD o Bs a tasa BCV'; end if;
  if p_amount_usd is not null and (p_amount_usd::text in ('NaN','Infinity','-Infinity')
    or p_amount_usd<=0 or round(p_amount_usd,2)<>p_amount_usd) then
    raise exception 'Indica un saldo positivo con máximo dos decimales';
  end if;
  select coalesce(sum(charged_ves_amount),0) into v_total from public.order_items where order_id=p_order_id;
  select coalesce(sum(value_ves),0) into v_paid from public.payments where order_id=p_order_id;
  v_remaining := v_total-v_paid;
  if v_total<=0 or v_remaining<=1 then raise exception 'Esta orden no tiene importe pendiente para cubrir'; end if;
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then
    raise exception 'Debes tener tasas BCV y operativa vigentes para aplicar el saldo';
  end if;
  v_rate := case when p_pocket='USD' then v_op else v_bcv end;
  insert into public.customer_balance_accounts(customer_id,pocket)
    values(v_order.customer_id,p_pocket) on conflict do nothing;
  select balance_usd into v_available from public.customer_balance_accounts
    where customer_id=v_order.customer_id and pocket=p_pocket for update;
  v_max_units := trunc(v_remaining/v_rate,2);
  v_units := coalesce(p_amount_usd,least(v_available,v_max_units));
  if v_units<=0 then raise exception 'El pendiente es menor a un centavo de este saldo'; end if;
  if v_units>v_available then raise exception 'Saldo insuficiente: disponible % USD en %',v_available,p_pocket; end if;
  if v_units>v_max_units then raise exception 'El saldo aplicado excede el pendiente de la orden'; end if;
  v_value_ves := round(v_units*v_rate,2);
  if round(v_value_ves/v_rate,2)<>v_units then raise exception 'Redondeo de tasa inconsistente; ajusta el importe'; end if;
  v_method := case when p_pocket='USD' then 'CUSTOMER_BALANCE_USD' else 'CUSTOMER_BALANCE_BCV' end;
  v_currency := case when p_pocket='USD' then 'USD' else 'VES' end;
  v_original := case when p_pocket='USD' then v_units else v_value_ves end;
  insert into public.payments(
    order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,
    value_ves,value_ref,reference,paid_at,created_by
  ) values (
    p_order_id,v_method,v_currency,v_original,v_bcv,v_op,
    v_value_ves,round(v_value_ves/v_bcv,4),null,now(),auth.uid()
  ) returning id into v_payment_id;
  update public.customer_balance_movements set request_id=p_request_id
    where payment_id=v_payment_id and movement_type='USE';
  return jsonb_build_object('payment_id',v_payment_id,'used_usd',v_units,
    'value_ves',v_value_ves,'pocket',p_pocket,'remaining_ves',greatest(v_remaining-v_value_ves,0));
end $function$
;
CREATE OR REPLACE FUNCTION public.add_payment(p_order_id uuid, p_method text, p_amount_original numeric, p_reference text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders; v_bcv numeric; v_op numeric; v_currency text;
  v_method text:=upper(coalesce(p_method,'')); v_total numeric; v_paid numeric;
  v_remaining numeric; v_sale_amount numeric; v_excess numeric;
  v_payment_id uuid; v_credit_id uuid; v_value_ves numeric;
begin
  perform public.require_auth();
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.status<>'OPEN' then raise exception 'La orden debe estar abierta para agregar pagos'; end if;
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
    raise exception 'Método de pago inválido';
  end if;
  if p_amount_original is null or p_amount_original::text in ('NaN','Infinity','-Infinity')
     or p_amount_original<=0 or round(p_amount_original,2)<>p_amount_original then
    raise exception 'Indica un monto positivo con máximo dos decimales';
  end if;
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  v_currency:=case when v_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
  select coalesce(sum(charged_ves_amount),0) into v_total from public.order_items where order_id=p_order_id;
  select coalesce(sum(value_ves),0) into v_paid from public.payments where order_id=p_order_id;
  v_remaining:=v_total-v_paid;
  if v_total<=0 or v_remaining<=1 then raise exception 'La orden ya está cubierta; registra el nuevo importe como anticipo del cliente'; end if;
  v_value_ves:=round(case when v_currency='USD' then p_amount_original*v_op else p_amount_original end,2);
  v_sale_amount:=p_amount_original;
  if v_value_ves>v_remaining+1 then
    if v_order.customer_id is null then raise exception 'Asocia un cliente para guardar el sobrante como saldo a favor'; end if;
    v_sale_amount:=case when v_currency='USD' then round(v_remaining/v_op,2) else round(v_remaining,2) end;
    if v_sale_amount<=0 or v_sale_amount>=p_amount_original then
      raise exception 'No se puede separar el sobrante con este monto; revisa el pago';
    end if;
    if abs(round(v_sale_amount*case when v_currency='USD' then v_op else 1 end,2)-v_remaining)>1 then
      raise exception 'El redondeo de USD deja más de Bs 1 de diferencia. Cobra el importe exacto y registra el resto como anticipo';
    end if;
  end if;
  insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,
    operative_rate_snapshot,value_ves,value_ref,reference)
  values(p_order_id,v_method,v_currency,v_sale_amount,v_bcv,v_op,
    round(v_sale_amount*case when v_currency='USD' then v_op else 1 end,2),
    round(v_sale_amount*case when v_currency='USD' then v_op else 1 end/v_bcv,4),nullif(trim(p_reference),''))
  returning id into v_payment_id;
  v_excess:=p_amount_original-v_sale_amount;
  if v_excess>0 then
    v_credit_id:=public.record_customer_balance_deposit(v_order.customer_id,v_method,v_excess,
      p_reference,'Sobrante de pago en orden '||v_order.order_number,gen_random_uuid());
    update public.customer_balance_movements set origin='OVERPAYMENT',order_id=p_order_id,
      payment_id=v_payment_id where id=v_credit_id;
    insert into public.audit_events(event_type,entity_type,entity_id,data)
    values('customer_balance.overpayment','customer_balance_movement',v_credit_id,
      jsonb_build_object('order_id',p_order_id,'payment_id',v_payment_id,
        'received',p_amount_original,'applied_to_sale',v_sale_amount,'credited',v_excess,'currency',v_currency));
  end if;
  return v_payment_id;
end $function$
;
CREATE OR REPLACE FUNCTION public.add_inventory_bonus_item(p_order_id uuid, p_inventory_item_id uuid, p_quantity numeric, p_reason text DEFAULT NULL::text, p_business_area text DEFAULT 'STORE'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items;
  v_order public.orders;
  v_location uuid;
  v_stock numeric;
  v_bcv numeric;
  v_op numeric;
  v_order_item uuid;
  v_area text := upper(coalesce(p_business_area,'STORE'));
  v_reason text := nullif(trim(coalesce(p_reason,'')),'');
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  if v_area not in ('STORE','OIL_CHANGE') then raise exception 'Área de bonificación inválida'; end if;

  select * into v_order from public.orders where id=p_order_id for update;
  select * into v_item from public.inventory_items where id=p_inventory_item_id and active=true;
  if v_item.id is null then raise exception 'Producto de inventario no encontrado'; end if;
  if v_item.needs_review then raise exception 'Este SKU requiere revisión de inventario antes de bonificarlo: %',v_item.sku; end if;

  v_location := v_order.location_id;
  if v_location is null then
    select id into v_location from public.locations where code='CABUDARE' and active=true limit 1;
    if v_location is null then select id into v_location from public.locations where active=true order by created_at limit 1; end if;
    update public.orders set location_id=v_location where id=p_order_id;
  end if;
  if v_location is null then raise exception 'No hay sede activa para descontar inventario'; end if;

  perform 1 from public.inventory_items where id=v_item.id for update;
  v_stock := public.inventory_quantity(v_item.id,v_location);
  if v_stock < p_quantity then
    raise exception 'Stock insuficiente para bonificar %: disponible %, solicitado %',v_item.sku,v_stock,p_quantity;
  end if;

  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de registrar la cortesía'; end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,inventory_item_id,inventory_location_id,
    quantity,pricing_mode,base_ref_amount,customer_ref_amount,
    charged_ves_amount,charged_ref_amount,cash_usd_unit_snapshot,cash_usd_special_total,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT',v_area,
    '🎁 Cortesía · '||v_item.sku||' · '||v_item.description||case when v_reason is not null then ' · '||v_reason else '' end,
    v_item.product_id,v_item.id,v_location,
    p_quantity,'BONUS',0,0,0,0,null,null,v_bcv,v_op,false
  ) returning id into v_order_item;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('order.bonus_product_added','order_item',v_order_item,
         jsonb_build_object('order_id',p_order_id,'inventory_item_id',v_item.id,'sku',v_item.sku,'quantity',p_quantity,'reason',v_reason));

  return v_order_item;
end;
$function$
;CREATE OR REPLACE FUNCTION lubricenter_private.close_order_cashea_split(p_order_id uuid, p_initial_percent numeric, p_initial_payments jsonb, p_cashea_reference text, p_expected_total_ves numeric, p_expected_total_ref numeric, p_expected_bcv numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order public.orders;
  v_bcv numeric; v_op numeric;
  v_total_ves numeric; v_total_ref numeric; v_initial_ves numeric;
  v_paid numeric; v_new_paid numeric := 0;
  v_row jsonb; v_method text; v_amount_text text; v_amount numeric;
  v_ves numeric; v_currency text; v_reference text; v_code text; v_seen int := 0;
  v_sale_id uuid; v_label text; v_count int;
BEGIN
  PERFORM public.require_auth();
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'Falta identificar la orden'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden no encontrada'; END IF;
  IF EXISTS (SELECT 1 FROM public.cashea_sales WHERE order_id=p_order_id) THEN
    RAISE EXCEPTION 'Esta venta Cashea ya quedó registrada. Recarga la orden; no cobres nuevamente';
  END IF;
  IF v_order.status <> 'OPEN' THEN RAISE EXCEPTION 'La orden no está abierta'; END IF;
  PERFORM public.validate_order_ready_to_close(p_order_id);

  IF p_initial_percent IS NULL OR p_initial_percent::text IN ('NaN','Infinity','-Infinity')
    OR p_initial_percent<=0 OR p_initial_percent>100 THEN
    RAISE EXCEPTION 'La inicial aprobada debe estar entre 0 y 100 por ciento';
  END IF;
  IF p_cashea_reference IS NULL OR btrim(p_cashea_reference) !~ '^[0-9]{1,32}$' THEN
    RAISE EXCEPTION 'Registra el número de orden de Cashea (solo dígitos)';
  END IF;
  IF p_initial_payments IS NULL OR jsonb_typeof(p_initial_payments)<>'array' THEN
    RAISE EXCEPTION 'Envía el desglose de la inicial como lista';
  END IF;
  IF jsonb_array_length(p_initial_payments)>8 THEN
    RAISE EXCEPTION 'La inicial admite entre 0 y 8 formas de cobro';
  END IF;

  SELECT coalesce(sum(charged_ves_amount),0),coalesce(sum(charged_ref_amount),0)
    INTO v_total_ves,v_total_ref FROM public.order_items WHERE order_id=p_order_id;
  IF v_total_ves<=0 OR v_total_ref<=0 THEN RAISE EXCEPTION 'Orden sin artículos cobrables'; END IF;
  IF p_expected_total_ves IS NULL OR p_expected_total_ref IS NULL OR
     abs(v_total_ves-p_expected_total_ves)>0.01 OR
     abs(v_total_ref-p_expected_total_ref)>0.0001 THEN
    RAISE EXCEPTION 'El total de la orden cambió. Actualiza el cobro antes de confirmar';
  END IF;
  SELECT bcv_rate,operative_rate INTO v_bcv,v_op FROM public.get_order_rates(p_order_id);
  IF v_bcv IS NULL OR v_bcv<=0 OR v_op IS NULL OR v_op<=0 OR
     p_expected_bcv IS NULL OR p_expected_bcv<>v_bcv THEN
    RAISE EXCEPTION 'La tasa BCV cambió. Actualiza los importes de la inicial';
  END IF;
  v_initial_ves := round(round(v_total_ref*p_initial_percent/100,4)*v_bcv,2);
  SELECT coalesce(sum(value_ves),0) INTO v_paid FROM public.payments
    WHERE order_id=p_order_id;
  IF v_paid>v_initial_ves THEN
    RAISE EXCEPTION 'Los pagos anteriores superan la inicial de Cashea: revisa sus montos';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_initial_payments)
  LOOP
    v_seen:=v_seen+1;
    IF jsonb_typeof(v_row)<>'object' THEN
      RAISE EXCEPTION 'Cada cobro debe tener método y monto';
    END IF;
    v_method := upper(btrim(coalesce(v_row->>'method','')));
    v_amount_text := btrim(coalesce(v_row->>'amount',''));
    v_reference := nullif(btrim(coalesce(v_row->>'reference','')),'');
    IF v_method NOT IN ('TRANSFER_BDV','TRANSFER_BNC','CASH_VES','CASH_USD','ZELLE','BINANCE') THEN
      RAISE EXCEPTION 'Selecciona el banco o forma de pago exacta para cada cobro';
    END IF;
    IF v_amount_text !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'Cobro %: ingresa monto positivo con máximo dos decimales',v_seen;
    END IF;
    v_amount := v_amount_text::numeric;
    IF v_amount<=0 THEN RAISE EXCEPTION 'Cobro %: el monto debe ser mayor a cero',v_seen; END IF;
    IF v_method IN ('TRANSFER_BDV','TRANSFER_BNC') AND
       (v_reference IS NULL OR v_reference !~ '^[0-9]{4,32}$') THEN
      RAISE EXCEPTION 'Cobro %: registra al menos los últimos 4 dígitos de la referencia bancaria',v_seen;
    END IF;
    IF v_method IN ('ZELLE','BINANCE') AND
       (v_reference IS NULL OR length(v_reference)<4 OR length(v_reference)>100) THEN
      RAISE EXCEPTION 'Cobro %: registra la referencia de Zelle o Binance',v_seen;
    END IF;
    IF length(coalesce(v_reference,''))>100 THEN
      RAISE EXCEPTION 'Cobro %: referencia demasiado larga',v_seen;
    END IF;
    v_currency := CASE WHEN v_method IN ('CASH_USD','ZELLE','BINANCE') THEN 'USD' ELSE 'VES' END;
    v_code := CASE v_method
      WHEN 'TRANSFER_BDV' THEN 'BDV' WHEN 'TRANSFER_BNC' THEN 'BNC'
      ELSE v_method END;
    IF NOT EXISTS (SELECT 1 FROM public.financial_accounts
                   WHERE code=v_code AND active AND currency=v_currency) THEN
      RAISE EXCEPTION 'La cuenta % no está activa o su moneda no corresponde al pago',v_code;
    END IF;
    v_ves := CASE WHEN v_currency='USD' THEN round(v_amount*v_bcv,2)
                  ELSE v_amount END;
    IF v_ves<=0 THEN RAISE EXCEPTION 'El monto convertido del cobro es inválido'; END IF;
    v_new_paid := v_new_paid+v_ves;
    IF v_paid+v_new_paid>v_initial_ves THEN
      RAISE EXCEPTION 'Los cobros superan la inicial aprobada. Revisa el desglose';
    END IF;
    -- Los USD de la inicial Cashea se valoran a BCV, NO a tasa operativa.
    -- Triggers existentes seleccionan cuenta y generan exactamente un movimiento.
    INSERT INTO public.payments(
      order_id,method,currency,amount_original,bcv_rate_snapshot,
      operative_rate_snapshot,value_ves,value_ref,reference,paid_at
    ) VALUES(
      p_order_id,v_method,v_currency,v_amount,v_bcv,v_op,v_ves,
      round(v_ves/v_bcv,4),v_reference,now()
    );
  END LOOP;
  IF v_paid+v_new_paid<>v_initial_ves THEN
    RAISE EXCEPTION 'La inicial no cuadra: falta Bs %. Completa o ajusta los cobros',
      round(v_initial_ves-v_paid-v_new_paid,2);
  END IF;
  SELECT count(DISTINCT method),min(method)
    INTO v_count,v_label FROM public.payments WHERE order_id=p_order_id;
  IF v_count=0 THEN RAISE EXCEPTION 'La inicial no tiene pagos registrados'; END IF;
  IF v_count>1 OR v_label NOT IN ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') THEN v_label:='MIXED'; END IF;

  -- El cierre probado calcula comisión/cuotas, no agrega pago porque ya
  -- fue cubierta EXACTAMENTE la inicial (0 de remanente).
  SELECT lubricenter_private.close_order_cashea(
    p_order_id,p_initial_percent,'TRANSFER_BDV',NULL,p_cashea_reference,
    p_expected_total_ves,p_expected_total_ref,p_expected_bcv
  ) INTO v_sale_id;
  UPDATE public.cashea_sales SET initial_payment_method=v_label WHERE id=v_sale_id;
  INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
  VALUES ('cashea.initial_split','cashea_sale',v_sale_id,
    jsonb_build_object('order_id',p_order_id,'initial_ves',v_initial_ves,
      'previous_payments_ves',v_paid,'new_payments_ves',v_new_paid,
      'initial_payment_method',v_label,'new_payment_count',v_seen));
  RETURN v_sale_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.add_service_item(p_order_id uuid, p_business_area text, p_description text, p_base_ref numeric, p_customer_ref numeric, p_worker_share_override_ref numeric DEFAULT NULL::numeric, p_alexis_bonus_enabled boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bcv numeric; v_op numeric; v_step numeric; v_mode text;
  v_worker uuid; v_bonus_employee uuid; v_worker_pct numeric := 0; v_bonus_pct numeric := 0;
  v_worker_ref numeric := 0; v_bonus_ref numeric := 0; v_lc_ref numeric := 0; v_item_id uuid;
  v_requested_area text := upper(coalesce(p_business_area,''));
  v_area text;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if v_requested_area not in ('WORKSHOP','ELECTROAUTO','OIL_CHANGE','STORE') then raise exception 'Área de servicio inválida'; end if;
  -- The dedicated oil-change module uses add_oil_change_package/add_oil_change_item.
  -- Legacy generic UI value OIL_CHANGE therefore means a generic Lubricenter service.
  v_area := case when v_requested_area='OIL_CHANGE' then 'STORE' else v_requested_area end;
  if coalesce(trim(p_description),'') = '' then raise exception 'Descripción requerida'; end if;
  if p_base_ref <= 0 or p_customer_ref < 0 then raise exception 'Montos inválidos'; end if;
  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';

  if v_area = 'WORKSHOP' then
    select id into v_worker from public.employees where code='CHEO' and active=true;
    select id into v_bonus_employee from public.employees where code='ALEXIS' and active=true;
    v_worker_pct := coalesce(public.compensation_value('CHEO','WORKSHOP_PERCENT',(select (coalesce(business_at,opened_at) at time zone 'America/Caracas')::date from public.orders where id=p_order_id)),40);
    v_worker_ref := coalesce(p_worker_share_override_ref, round(p_base_ref * v_worker_pct / 100,4));
    if p_alexis_bonus_enabled then
      v_bonus_pct := coalesce(public.compensation_value('ALEXIS','ASSISTANT_BONUS_PERCENT',(select (coalesce(business_at,opened_at) at time zone 'America/Caracas')::date from public.orders where id=p_order_id)),5);
      v_bonus_ref := round(p_base_ref * v_bonus_pct / 100,4);
    end if;
  elsif v_area = 'ELECTROAUTO' then
    select id into v_worker from public.employees where code='ALEXIS' and active=true;
    v_worker_pct := coalesce(public.compensation_value('ALEXIS','ELECTROAUTO_PERCENT',(select (coalesce(business_at,opened_at) at time zone 'America/Caracas')::date from public.orders where id=p_order_id)),40);
    v_worker_ref := coalesce(p_worker_share_override_ref, round(p_base_ref * v_worker_pct / 100,4));
  end if;

  if v_worker_ref < 0 or v_bonus_ref < 0 then raise exception 'Las participaciones no pueden ser negativas'; end if;
  v_lc_ref := p_customer_ref - v_worker_ref - v_bonus_ref;
  if v_lc_ref < 0 then raise exception 'El monto al cliente no cubre la parte protegida del trabajador/bono. Ajusta el reparto explícitamente.'; end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    bcv_rate_snapshot,operative_rate_snapshot,
    worker_employee_id,worker_share_percent_snapshot,worker_share_ref_snapshot,
    assistant_bonus_employee_id,assistant_bonus_percent_snapshot,assistant_bonus_ref_snapshot
  ) values (
    p_order_id,'SERVICE',v_area,trim(p_description),1,'STANDARD',
    p_base_ref,p_customer_ref,
    round(public.round_to_step(p_customer_ref * v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest')),2),
    round(p_customer_ref,4),v_bcv,v_op,
    v_worker,case when v_worker is not null then v_worker_pct end,case when v_worker is not null then v_worker_ref end,
    case when v_bonus_ref > 0 then v_bonus_employee end,case when v_bonus_ref > 0 then v_bonus_pct end,case when v_bonus_ref > 0 then v_bonus_ref end
  ) returning id into v_item_id;
  return v_item_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.add_oil_change_item(p_order_id uuid, p_description text, p_base_ref numeric, p_customer_ref numeric, p_odometer integer, p_oil_brand text DEFAULT NULL::text, p_oil_viscosity text DEFAULT NULL::text, p_oil_quantity_liters numeric DEFAULT NULL::numeric, p_filter_code text DEFAULT NULL::text, p_next_km_interval integer DEFAULT NULL::integer, p_next_months integer DEFAULT NULL::integer)
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

  select o.vehicle_id, v.current_odometer
    into v_vehicle_id, v_current_odometer
  from public.orders o
  left join public.vehicles v on v.id=o.vehicle_id
  where o.id=p_order_id;

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

  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
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
    next_service_odometer,next_service_date
  ) values (
    p_order_id,'SERVICE','OIL_CHANGE',trim(p_description),1,'STANDARD',
    p_base_ref,p_customer_ref,
    round(public.round_to_step(p_customer_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest')),2),
    round(p_customer_ref,4),v_bcv,v_op,
    p_odometer,nullif(trim(p_oil_brand),''),nullif(trim(p_oil_viscosity),''),p_oil_quantity_liters,nullif(trim(p_filter_code),''),
    case when v_interval_km > 0 then p_odometer+v_interval_km else null end,
    case when v_interval_months > 0 then (select (coalesce(business_at,opened_at) at time zone 'America/Caracas')::date from public.orders where id=p_order_id) + make_interval(months=>v_interval_months) else null end
  ) returning id into v_item_id;

  return v_item_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.close_order_with_partial_credit(p_order_id uuid, p_method text, p_amount_original numeric, p_reference text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date)
 RETURNS TABLE(order_number text, total_ves numeric, total_ref numeric, payment_id uuid, receivable_id uuid, outstanding_ves numeric, outstanding_ref numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
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
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_operative from public.get_order_rates(p_order_id);

  if v_total_ves <= 0 then raise exception 'Agrega productos o trabajos antes de cobrar'; end if;
  if v_bcv is null or v_operative is null then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  v_new_payment_ves := case when v_method in ('CASH_USD','ZELLE','BINANCE') then p_amount_original * v_operative else p_amount_original end;
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
$function$
;CREATE OR REPLACE FUNCTION public.add_inventory_product_item(p_order_id uuid, p_inventory_item_id uuid, p_quantity numeric, p_manual_unit_ref numeric DEFAULT NULL::numeric, p_business_area text DEFAULT 'OIL_CHANGE'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items;
  v_order public.orders;
  v_product public.products;
  v_location uuid;
  v_stock numeric;
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_unit_ref numeric;
  v_cash_usd numeric;
  v_order_item uuid;
  v_area text := upper(coalesce(p_business_area,'OIL_CHANGE'));
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad de inventario inválida'; end if;
  if v_area not in ('OIL_CHANGE','STORE') then raise exception 'Área de inventario inválida'; end if;

  select * into v_order from public.orders where id=p_order_id for update;
  select * into v_item from public.inventory_items where id=p_inventory_item_id and active=true;
  if v_item.id is null then raise exception 'Producto de inventario no encontrado'; end if;
  if v_item.needs_review then raise exception 'Este SKU requiere revisión de inventario antes de venderse: %', v_item.sku; end if;

  v_location := v_order.location_id;
  if v_location is null then
    select id into v_location from public.locations where code='CABUDARE' and active=true limit 1;
    if v_location is null then select id into v_location from public.locations where active=true order by created_at limit 1; end if;
    update public.orders set location_id=v_location where id=p_order_id;
  end if;
  if v_location is null then raise exception 'No hay sede activa para descontar inventario'; end if;

  perform 1 from public.inventory_items where id=v_item.id for update;
  v_stock := public.inventory_quantity(v_item.id,v_location);
  if v_stock < p_quantity then raise exception 'Stock insuficiente para %: disponible %, solicitado %', v_item.sku, v_stock, p_quantity; end if;

  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';

  if p_manual_unit_ref is not null then
    if p_manual_unit_ref <= 0 then raise exception 'El precio manual debe ser mayor que cero'; end if;
    v_unit_ref := p_manual_unit_ref;
    v_unit_ves := public.round_to_step(v_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_cash_usd := null;
  else
    if v_item.product_id is null then raise exception 'Este SKU no tiene precio de catálogo. Ingresa precio REF manual.'; end if;
    select * into v_product from public.products where id=v_item.product_id and active=true and available=true;
    if v_product.id is null then raise exception 'El producto de catálogo vinculado no está disponible'; end if;
    if v_product.catalog_source='Notion · Nuestros Productos' then perform public.assert_notion_pricing_fresh(); end if;
    v_cash_usd := v_product.cash_usd_base_price;
    v_unit_ves := public.round_to_step(v_product.cash_usd_base_price*v_op,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_unit_ref := v_unit_ves/v_bcv;
  end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,inventory_item_id,inventory_location_id,
    quantity,pricing_mode,base_ref_amount,customer_ref_amount,
    charged_ves_amount,charged_ref_amount,cash_usd_unit_snapshot,cash_usd_special_total,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT',v_area,v_item.sku||' · '||v_item.description,v_item.product_id,v_item.id,v_location,
    p_quantity,'STANDARD',round(v_unit_ref*p_quantity,4),round(v_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(v_unit_ref*p_quantity,4),v_cash_usd,
    case when v_cash_usd is not null then round(v_cash_usd*p_quantity,4) else null end,
    v_bcv,v_op,false
  ) returning id into v_order_item;
  return v_order_item;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.quick_sale_with_tender(p_request uuid, p_items jsonb, p_method text, p_received numeric, p_return_usd numeric, p_return_currency text, p_change_rate numeric, p_reference text DEFAULT NULL::text, p_customer_label text DEFAULT NULL::text, p_business_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_agreed_usd numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare payload jsonb; previous public.quick_tender_requests; sale record; item public.order_items; op numeric; b numeric; weight numeric; allocated numeric:=0; part numeric; n integer:=0; count_items integer; result jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_request is null then raise exception 'Falta el identificador de la venta'; end if;
 payload:=jsonb_build_array(p_items,p_method,p_received,p_return_usd,p_return_currency,p_change_rate,p_reference,p_customer_label,p_business_at,p_agreed_usd);
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,1));
 select * into previous from public.quick_tender_requests where id=p_request;
 if found then
  if previous.payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return previous.result;
 end if;
 if p_agreed_usd is not null and (p_agreed_usd<=0 or p_agreed_usd::text in ('NaN','Infinity','-Infinity') or round(p_agreed_usd,2)<>p_agreed_usd) then raise exception 'Total pactado USD inválido'; end if;
 perform set_config('lubricenter.business_at',coalesce(p_business_at::text,''),true);
 select * into sale from public.build_quick_sale_order(p_items);
 if p_agreed_usd is not null then
  select bcv_rate,operative_rate into b,op from public.get_order_rates(sale.order_id);
  if b is null or b<=0 or op is null or op<=0 then raise exception 'Faltan tasas válidas'; end if;
  select sum(charged_ref_amount),count(*) into weight,count_items from public.order_items where order_id=sale.order_id;
  for item in select * from public.order_items where order_id=sale.order_id order by id loop
   n:=n+1;
   part:=case when n=count_items then p_agreed_usd-allocated else round(p_agreed_usd*item.charged_ref_amount/weight,4) end;
   allocated:=allocated+part;
   update public.order_items set price_denomination='USD',agreed_usd=part,charged_ves_amount=round(part*op,2),charged_ref_amount=round(part*op/b,4),customer_ref_amount=round(part*op/b,4) where id=item.id;
  end loop;
 end if;
 perform lubricenter_private.collect_order_tender(p_request,sale.order_id,p_method,p_received,p_return_usd,p_return_currency,p_change_rate,p_reference,p_customer_label);
 perform public.close_order(sale.order_id);
 select jsonb_build_object('order_id',id,'order_number',order_number,'total_ves',total_ves,'total_ref',total_ref) into result from public.orders where id=sale.order_id;
 insert into public.quick_tender_requests values(p_request,payload,result,now());
 return result;
end $function$
;
CREATE OR REPLACE FUNCTION public.add_product_item(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_reveal_cash_price boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_product public.products;
  v_bcv numeric; v_op numeric; v_step numeric; v_mode text;
  v_unit_ves numeric; v_unit_ref numeric; v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  select * into v_product from public.products where id=p_product_id and active=true and available=true;
  if v_product.id is null then raise exception 'Producto no encontrado o no disponible'; end if;
  if v_product.catalog_source='Notion · Nuestros Productos' then perform public.assert_notion_pricing_fresh(); end if;
  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';
  v_unit_ves := public.round_to_step(v_product.cash_usd_base_price * v_op, coalesce(v_step,10), coalesce(v_mode,'nearest'));
  v_unit_ref := v_unit_ves / v_bcv;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,quantity,pricing_mode,
    charged_ves_amount,charged_ref_amount,cash_usd_unit_snapshot,cash_usd_special_total,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',coalesce(v_product.filter_code || ' · ','') || v_product.name,v_product.id,p_quantity,
    case when p_reveal_cash_price then 'CASH_USD_SPECIAL' else 'STANDARD' end,
    round(v_unit_ves * p_quantity,2), round(v_unit_ref * p_quantity,4),v_product.cash_usd_base_price,
    round(v_product.cash_usd_base_price * p_quantity,4),v_bcv,v_op,p_reveal_cash_price
  ) returning id into v_item_id;
  return v_item_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.add_catalog_product_item_override(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_manual_unit_ref numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_product public.products;
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_unit_ref numeric;
  v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;

  select * into v_product from public.products where id=p_product_id and active=true and available=true;
  if v_product.id is null then raise exception 'Producto no encontrado o no disponible'; end if;

  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';

  if p_manual_unit_ref is not null then
    if p_manual_unit_ref <= 0 then raise exception 'El precio manual debe ser mayor que cero'; end if;
    v_unit_ref := p_manual_unit_ref;
    v_unit_ves := public.round_to_step(v_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));
  else
    if v_product.catalog_source='Notion · Nuestros Productos' then perform public.assert_notion_pricing_fresh(); end if;
    v_unit_ves := public.round_to_step(v_product.cash_usd_base_price*v_op,coalesce(v_step,10),coalesce(v_mode,'nearest'));
    v_unit_ref := v_unit_ves/v_bcv;
  end if;

  insert into public.order_items(
    order_id,item_type,business_area,description,product_id,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    cash_usd_unit_snapshot,cash_usd_special_total,bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',v_product.name,v_product.id,p_quantity,
    case when p_manual_unit_ref is null then 'STANDARD' else 'MANUAL_OVERRIDE' end,
    round(v_unit_ref*p_quantity,4),round(v_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(v_unit_ref*p_quantity,4),
    v_product.cash_usd_base_price,round(v_product.cash_usd_base_price*p_quantity,4),
    v_bcv,v_op,false
  ) returning id into v_item_id;
  return v_item_id;
end;
$function$
;CREATE OR REPLACE FUNCTION public.add_manual_product_item(p_order_id uuid, p_description text, p_quantity numeric, p_unit_ref numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bcv numeric;
  v_op numeric;
  v_step numeric;
  v_mode text;
  v_unit_ves numeric;
  v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  if nullif(trim(p_description),'') is null then raise exception 'Escribe el producto'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  if p_unit_ref is null or p_unit_ref <= 0 then raise exception 'El precio REF debe ser mayor que cero'; end if;

  select bcv_rate, operative_rate into v_bcv, v_op from public.get_order_rates(p_order_id);
  if v_bcv is null or v_op is null then raise exception 'Debes registrar tasa BCV y operativa antes de vender'; end if;
  select coalesce((value #>> '{}')::numeric,10) into v_step from public.app_settings where key='price_rounding_step';
  select coalesce(value #>> '{}','nearest') into v_mode from public.app_settings where key='price_rounding_mode';
  v_unit_ves := public.round_to_step(p_unit_ref*v_bcv,coalesce(v_step,10),coalesce(v_mode,'nearest'));

  insert into public.order_items(
    order_id,item_type,business_area,description,quantity,pricing_mode,
    base_ref_amount,customer_ref_amount,charged_ves_amount,charged_ref_amount,
    bcv_rate_snapshot,operative_rate_snapshot,cash_price_revealed
  ) values (
    p_order_id,'PRODUCT','STORE',trim(p_description),p_quantity,'MANUAL_NO_STOCK',
    round(p_unit_ref*p_quantity,4),round(p_unit_ref*p_quantity,4),
    round(v_unit_ves*p_quantity,2),round(p_unit_ref*p_quantity,4),
    v_bcv,v_op,false
  ) returning id into v_item_id;
  return v_item_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION lubricenter_private.add_service_priced(p_order_id uuid, p_business_area text, p_description text, p_base_ref numeric, p_customer_ref numeric, p_worker_share_override_ref numeric DEFAULT NULL::numeric, p_alexis_bonus_enabled boolean DEFAULT false, p_denomination text DEFAULT 'REF'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b numeric; op numeric; factor numeric:=1; item uuid;
begin
 perform public.require_auth();
 perform 1 from public.orders where id=p_order_id for update;
 perform public.assert_order_open(p_order_id);
 if p_denomination not in ('REF','USD') or p_denomination is null then raise exception 'Selecciona REF BCV o USD pactado'; end if;
 if p_base_ref is null or p_customer_ref is null or p_base_ref::text in ('NaN','Infinity','-Infinity') or p_customer_ref::text in ('NaN','Infinity','-Infinity') or p_worker_share_override_ref::text in ('NaN','Infinity','-Infinity') then raise exception 'Monto inválido'; end if;
 select bcv_rate,operative_rate into b,op from public.get_order_rates(p_order_id);
 if b is null or op is null or b<=0 or op<=0 then raise exception 'Faltan tasas válidas'; end if;
 if p_denomination='USD' then factor:=op/b; end if;
 item:=public.add_service_item(p_order_id,p_business_area,p_description,p_base_ref*factor,p_customer_ref*factor,p_worker_share_override_ref*factor,p_alexis_bonus_enabled);
 if p_denomination='USD' then
  update public.order_items set price_denomination='USD',agreed_usd=p_customer_ref,
   charged_ves_amount=round(p_customer_ref*op,2),charged_ref_amount=round(p_customer_ref*factor,4)
  where id=item;
 end if;
 return item;
end $function$
;
CREATE OR REPLACE FUNCTION public.complete_quick_sale(p_items jsonb, p_payment_method text, p_payment_reference text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, order_number text, total_ves numeric, total_ref numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_built record;
  v_method text := upper(coalesce(p_payment_method,''));
  v_amount numeric;
  v_op numeric;
begin
  perform public.require_auth();
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then
    raise exception 'Método de pago inválido';
  end if;
  select * into v_built from public.build_quick_sale_order(p_items);
  if v_method in ('CASH_USD','ZELLE','BINANCE') then
    select operative_rate into v_op from public.get_order_rates(v_built.order_id);
    if v_op is null or v_op <= 0 then raise exception 'No hay tasa operativa disponible'; end if;
    v_amount := round(v_built.total_ves / v_op,2);
  else
    v_amount := v_built.total_ves;
  end if;
  perform lubricenter_private.collect_order_tender(gen_random_uuid(),v_built.order_id,case when v_method='MOBILE_PAYMENT' then 'TRANSFER_BDV' else v_method end,v_amount,0,'USD',(select bcv_rate from public.get_order_rates(v_built.order_id)),p_payment_reference,null);
  perform public.close_order(v_built.order_id);
  order_id := v_built.order_id;
  order_number := v_built.order_number;
  total_ves := v_built.total_ves;
  total_ref := v_built.total_ref;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('quick_sale.completed','order',v_built.order_id,jsonb_build_object('order_number',v_built.order_number,'payment_method',v_method,'total_ves',v_built.total_ves,'total_ref',v_built.total_ref));
  return next;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.complete_quick_sale_cashea(p_items jsonb, p_initial_percent numeric, p_initial_payment_method text, p_payment_reference text DEFAULT NULL::text, p_cashea_reference text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, order_number text, total_ves numeric, total_ref numeric, initial_ves numeric, initial_ref numeric, financed_ref numeric, commission_ref numeric, cashea_sale_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_built record;
  v_bcv numeric; v_op numeric;
  v_method text := upper(coalesce(p_initial_payment_method,''));
  v_commission_pct numeric;
  v_min_ref numeric;
  v_initial_ref numeric; v_initial_ves numeric; v_financed_ref numeric;
  v_commission_ref numeric; v_commission_ves numeric;
  v_sale_id uuid;
  v_currency text; v_amount_original numeric;
  v_i1 numeric; v_i2 numeric; v_i3 numeric;
begin
  perform public.require_auth();
  if p_initial_percent is null or p_initial_percent <= 0 or p_initial_percent > 100 then raise exception 'Porcentaje inicial Cashea inválido'; end if;
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC') then raise exception 'Método de pago de la inicial inválido'; end if;

  select bcv_rate, operative_rate into v_bcv,v_op from public.get_exchange_rates_for_date((coalesce(nullif(current_setting('lubricenter.business_at',true),'')::timestamptz,now()) at time zone 'America/Caracas')::date);
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'Debes registrar tasas antes de cobrar'; end if;
  select coalesce((value #>> '{}')::numeric,4) into v_commission_pct from public.app_settings where key='cashea_commission_percent';
  select coalesce((value #>> '{}')::numeric,25) into v_min_ref from public.app_settings where key='cashea_minimum_ref';

  select * into v_built from public.build_quick_sale_order(p_items);
  if v_built.total_ref < v_min_ref then raise exception 'Cashea requiere un mínimo configurado de REF % para esta venta', v_min_ref; end if;

  v_initial_ref := round(v_built.total_ref * p_initial_percent / 100,4);
  v_initial_ves := round(v_initial_ref * v_bcv,2);
  v_financed_ref := greatest(round(v_built.total_ref - v_initial_ref,4),0);
  v_commission_ref := round(v_built.total_ref * v_commission_pct / 100,4);
  v_commission_ves := round(v_commission_ref * v_bcv,2);

  v_currency := case when v_method='CASH_USD' then 'USD' else 'VES' end;
  v_amount_original := case when v_currency='USD' then v_initial_ref else v_initial_ves end;
  insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at)
  values(v_built.order_id,v_method,v_currency,v_amount_original,v_bcv,v_op,v_initial_ves,v_initial_ref,nullif(trim(p_payment_reference),''),now());

  insert into public.cashea_sales(order_id,receivable_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference)
  values(v_built.order_id,null,case when v_financed_ref<=0.01 then 'SETTLED' else 'ACTIVE' end,p_initial_percent,v_commission_pct,v_built.total_ref,v_built.total_ves,v_initial_ref,v_initial_ves,v_financed_ref,v_commission_ref,v_commission_ves,v_bcv,v_method,nullif(trim(p_cashea_reference),''))
  returning id into v_sale_id;

  if v_financed_ref > 0.01 then
    v_i1 := round(v_financed_ref/3,4);
    v_i2 := round(v_financed_ref/3,4);
    v_i3 := round(v_financed_ref-v_i1-v_i2,4);
    insert into public.cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot)
    values
      (v_sale_id,1,current_date+14,v_i1,round(v_i1*v_bcv,2)),
      (v_sale_id,2,current_date+28,v_i2,round(v_i2*v_bcv,2)),
      (v_sale_id,3,current_date+42,v_i3,round(v_i3*v_bcv,2));
  end if;

  update public.orders
  set status='CLOSED',closed_at=now(),total_ves=round(v_built.total_ves,2),total_ref=round(v_built.total_ref,4),
      total_cash_usd_equivalent=round((select coalesce(sum(oi.charged_ves_amount/nullif(oi.operative_rate_snapshot,0)),0) from public.order_items oi where oi.order_id=v_built.order_id),4)
  where id=v_built.order_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('quick_sale.cashea_completed','order',v_built.order_id,
    jsonb_build_object('cashea_sale_id',v_sale_id,'initial_percent',p_initial_percent,'commission_percent',v_commission_pct,'initial_ref',v_initial_ref,'financed_ref',v_financed_ref,'commission_ref',v_commission_ref,'reference',nullif(trim(p_cashea_reference),'')));

  order_id := v_built.order_id;
  order_number := v_built.order_number;
  total_ves := round(v_built.total_ves,2);
  total_ref := round(v_built.total_ref,4);
  initial_ves := v_initial_ves;
  initial_ref := v_initial_ref;
  financed_ref := v_financed_ref;
  commission_ref := v_commission_ref;
  cashea_sale_id := v_sale_id;
  return next;
end;
$function$
;CREATE OR REPLACE FUNCTION lubricenter_private.collect_order_tender(p_request uuid, p_order uuid, p_method text, p_received numeric, p_return_usd numeric, p_return_currency text, p_change_rate numeric, p_reference text DEFAULT NULL::text, p_customer_label text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.orders; t public.order_tenders; pid uuid; payload jsonb; b numeric; rate numeric; remaining numeric; applied numeric; covered numeric; change numeric; currency text; a uuid; fixed_usd boolean; due numeric;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 payload:=jsonb_build_array(p_order,p_method,p_received,p_return_usd,p_return_currency,p_change_rate,p_reference,p_customer_label);
 if p_request is null then raise exception 'Falta el identificador del cobro'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into t from public.order_tenders where id=p_request;
 if found then
  if t.request_payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return t.payment_id;
 end if;
 -- Same lock as cash close: a count cannot certify half a collection.
 perform pg_advisory_xact_lock(220033);
 select * into o from public.orders where id=p_order for update;
 if not found or o.status<>'OPEN' then raise exception 'La orden debe estar abierta'; end if;
 if p_method is null or p_method not in ('CASH_USD','CASH_VES','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then raise exception 'Método inválido'; end if;
 if p_method in ('TRANSFER_BDV','TRANSFER_BNC') and coalesce(trim(p_reference),'') !~ '^[0-9]{4,32}$' then raise exception 'Faltan los últimos 4 de referencia'; end if;
 if p_received is null or p_received<=0 or p_received::text in ('NaN','Infinity','-Infinity') or round(p_received,2)<>p_received then raise exception 'Monto recibido inválido'; end if;
 if p_change_rate is null or p_change_rate<=0 or p_change_rate::text in ('NaN','Infinity','-Infinity') or round(p_change_rate,6)<>p_change_rate then raise exception 'Indica la tasa acordada para el vuelto'; end if;
 if p_return_usd is null or p_return_usd<0 or p_return_usd::text in ('NaN','Infinity','-Infinity') or round(p_return_usd,2)<>p_return_usd then raise exception 'Monto de vuelto inválido'; end if;
 select bcv_rate,public.order_usd_rate(p_order) into b,rate from public.get_order_rates(p_order);
 if b is null or b<=0 or rate is null or rate<=0 then raise exception 'Faltan tasas para cobrar'; end if;
 currency:=case when p_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
 select coalesce(sum(charged_ves_amount),0)-(select coalesce(sum(value_ves),0) from public.payments where order_id=p_order) into remaining from public.order_items where order_id=p_order;
 if remaining<=0 then raise exception 'La orden ya está cubierta'; end if;
 -- Round the commercial USD amount once. Covered Bs are bounded to the sale,
 -- including the unavoidable sub-cent equivalence difference.
 select bool_and(price_denomination='USD') into fixed_usd from public.order_items where order_id=p_order;
 if currency='VES' and fixed_usd and p_change_rate<>b then raise exception 'El pago en Bs usa la tasa BCV completa: %',b; end if;
 due:=case when currency='USD' then round(remaining/rate,2) when fixed_usd then round(remaining/rate*p_change_rate,2) else round(remaining,2) end;
 if p_method not in ('CASH_USD','CASH_VES') and (p_return_usd<>0 or p_received>due) then raise exception 'El pago digital supera el saldo. Corrige el monto o el precio antes de cobrar'; end if;
 applied:=least(p_received,due);
 if applied<=0 then raise exception 'El pendiente es menor que un centavo; revisa el cierre'; end if;
 covered:=case when p_received>=due then remaining when currency='USD' then round(applied*rate,2) when fixed_usd then round(applied/p_change_rate*rate,2) else applied end;
 change:=case when currency='USD' then p_received-applied else round((p_received-applied)/p_change_rate,2) end;
 if p_return_usd>change then raise exception 'El vuelto entregado supera el sobrante'; end if;
 if change>p_return_usd and o.customer_id is null and length(trim(coalesce(p_customer_label,'')))<3 then raise exception 'Identifica al cliente para no perder el vuelto pendiente'; end if;
 insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference)
 values(p_order,p_method,currency,applied,b,rate,covered,round(covered/b,4),nullif(trim(p_reference),'')) returning id into pid;
 select financial_account_id into a from public.payments where id=pid;
 insert into public.order_tenders(id,order_id,payment_id,customer_id,customer_label,method,currency,received,applied,payment_rate,change_usd,change_rate,rounding_ves,request_payload)
 values(p_request,p_order,pid,o.customer_id,coalesce(nullif(trim(p_customer_label),''),'Cliente de '||o.order_number),p_method,currency,p_received,applied,rate,change,p_change_rate,case when currency='VES' then round(p_received-applied-change*p_change_rate,2) else 0 end,payload);
 if p_received>applied then
  insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,reference,finance_nature,finance_request_id,tender_id)
  values(a,'IN','ADJUSTMENT',currency,p_received-applied,round((p_received-applied)*case when currency='USD' then rate else 1 end,2),'Vuelto recibido','Dinero recibido que no pertenece a la venta',p_reference,'REFUND',p_request,p_request);
 end if;
 -- Coverage uses the sale's frozen valuation. A Bs cash/bank movement uses
 -- the actual Bs handed over, never that bookkeeping equivalence.
 update public.account_movements set tender_id=p_request,value_ves=case when public.account_movements.currency='VES' then applied else public.account_movements.value_ves end where source_payment_id=pid;
 if p_return_usd>0 then perform lubricenter_private.return_order_change(gen_random_uuid(),p_request,p_return_usd,p_return_currency,p_change_rate,'Vuelto entregado al cobrar'); end if;
 return pid;
end $function$
;
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

  select bcv_rate,operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id);
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
    case when v_interval_months > 0 then (select (coalesce(business_at,opened_at) at time zone 'America/Caracas')::date from public.orders where id=p_order_id) + make_interval(months=>v_interval_months) else null end,
    v_vehicle_id
  ) returning id into v_item_id;

  return v_item_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.close_order_with_cashea(p_order_id uuid, p_initial_percent numeric, p_initial_payment_method text, p_payment_reference text DEFAULT NULL::text, p_cashea_reference text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, order_number text, total_ves numeric, total_ref numeric, initial_ves numeric, initial_ref numeric, financed_ref numeric, commission_ref numeric, cashea_sale_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders;
  v_bcv numeric;
  v_op numeric;
  v_total_ves numeric;
  v_total_ref numeric;
  v_method text := upper(coalesce(p_initial_payment_method,''));
  v_commission_pct numeric;
  v_min_ref numeric;
  v_initial_ref numeric;
  v_initial_ves numeric;
  v_financed_ref numeric;
  v_commission_ref numeric;
  v_commission_ves numeric;
  v_sale_id uuid;
  v_currency text;
  v_amount_original numeric;
  v_i1 numeric;
  v_i2 numeric;
  v_i3 numeric;
  v_cash numeric;
  i public.order_items;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);

  select * into v_order from public.orders o where o.id=p_order_id for update;
  if v_order.id is null then raise exception 'Orden no encontrada'; end if;

  if p_initial_percent is null or p_initial_percent <= 0 or p_initial_percent >= 100 then
    raise exception 'La inicial Cashea debe ser mayor que 0%% y menor que 100%%';
  end if;
  if v_method not in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC') then
    raise exception 'Método de pago de la inicial inválido';
  end if;
  if exists(select 1 from public.cashea_sales cs where cs.order_id=p_order_id) then
    raise exception 'Esta orden ya tiene una venta Cashea registrada';
  end if;
  if exists(select 1 from public.receivables r where r.order_id=p_order_id and r.status='OPEN') then
    raise exception 'La orden ya tiene una cuenta por cobrar abierta';
  end if;
  if exists(select 1 from public.payments p where p.order_id=p_order_id) then
    raise exception 'Para cerrar con Cashea elimina primero los pagos cargados en esta orden; la inicial Cashea se registra al confirmar';
  end if;

  select coalesce(sum(oi.charged_ves_amount),0), coalesce(sum(oi.charged_ref_amount),0)
  into v_total_ves,v_total_ref
  from public.order_items oi where oi.order_id=p_order_id;
  if v_total_ves <= 0 or v_total_ref <= 0 then raise exception 'La orden no tiene items cobrables'; end if;

  select cer.bcv_rate,cer.operative_rate into v_bcv,v_op from public.get_order_rates(p_order_id) cer;
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'Debes registrar tasas antes de cobrar'; end if;

  select coalesce((s.value #>> '{}')::numeric,4) into v_commission_pct from public.app_settings s where s.key='cashea_commission_percent';
  select coalesce((s.value #>> '{}')::numeric,25) into v_min_ref from public.app_settings s where s.key='cashea_minimum_ref';
  if v_total_ref < v_min_ref then raise exception 'Cashea requiere un mínimo configurado de REF % para esta venta', v_min_ref; end if;

  v_initial_ref := round(v_total_ref*p_initial_percent/100,4);
  v_initial_ves := round(v_initial_ref*v_bcv,2);
  v_financed_ref := greatest(round(v_total_ref-v_initial_ref,4),0);
  v_commission_ref := round(v_total_ref*v_commission_pct/100,4);
  v_commission_ves := round(v_commission_ref*v_bcv,2);

  v_currency := case when v_method='CASH_USD' then 'USD' else 'VES' end;
  v_amount_original := case when v_currency='USD' then v_initial_ref else v_initial_ves end;

  insert into public.payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at)
  values(p_order_id,v_method,v_currency,v_amount_original,v_bcv,v_op,v_initial_ves,v_initial_ref,nullif(trim(p_payment_reference),''),now());

  insert into public.cashea_sales(
    order_id,receivable_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,
    initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,
    initial_payment_method,cashea_reference
  ) values(
    p_order_id,null,'ACTIVE',p_initial_percent,v_commission_pct,v_total_ref,v_total_ves,
    v_initial_ref,v_initial_ves,v_financed_ref,v_commission_ref,v_commission_ves,v_bcv,
    v_method,nullif(trim(p_cashea_reference),'')
  ) returning id into v_sale_id;

  v_i1 := round(v_financed_ref/3,4);
  v_i2 := round(v_financed_ref/3,4);
  v_i3 := round(v_financed_ref-v_i1-v_i2,4);
  insert into public.cashea_installments(cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot)
  values
    (v_sale_id,1,current_date+14,v_i1,round(v_i1*v_bcv,2)),
    (v_sale_id,2,current_date+28,v_i2,round(v_i2*v_bcv,2)),
    (v_sale_id,3,current_date+42,v_i3,round(v_i3*v_bcv,2));

  select coalesce(sum(oi.charged_ves_amount/nullif(oi.operative_rate_snapshot,0)),0)
  into v_cash from public.order_items oi where oi.order_id=p_order_id;

  update public.orders o
  set status='CLOSED',closed_at=now(),total_ves=round(v_total_ves,2),total_ref=round(v_total_ref,4),total_cash_usd_equivalent=round(v_cash,4)
  where o.id=p_order_id;

  for i in select oi.* from public.order_items oi where oi.order_id=p_order_id loop
    if i.business_area='WORKSHOP' and coalesce(i.worker_share_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at)
      values(i.worker_employee_id,i.id,'WORKSHOP_COMMISSION',i.worker_share_ref_snapshot,'40% taller · '||i.description,now())
      on conflict do nothing;
    end if;
    if i.business_area='WORKSHOP' and coalesce(i.assistant_bonus_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at)
      values(i.assistant_bonus_employee_id,i.id,'ASSISTANT_BONUS',i.assistant_bonus_ref_snapshot,'Bono ayudante · '||i.description,now())
      on conflict do nothing;
    end if;
    if i.business_area='ELECTROAUTO' and coalesce(i.worker_share_ref_snapshot,0)>0 then
      insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description,occurred_at)
      values(i.worker_employee_id,i.id,'ELECTROAUTO_COMMISSION',i.worker_share_ref_snapshot,'Electroauto · '||i.description,now())
      on conflict do nothing;
    end if;
  end loop;

  insert into public.integration_events(event_type,aggregate_type,aggregate_id,payload)
  values('order.closed','order',p_order_id,jsonb_build_object(
    'order_number',v_order.order_number,'total_ves',v_total_ves,'total_ref',v_total_ref,
    'payment_status','CASHEA','cashea_sale_id',v_sale_id,'initial_percent',p_initial_percent,
    'initial_ref',v_initial_ref,'financed_ref',v_financed_ref,'commission_ref',v_commission_ref
  ));

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('order.closed_cashea','order',p_order_id,jsonb_build_object(
    'cashea_sale_id',v_sale_id,'initial_percent',p_initial_percent,'commission_percent',v_commission_pct,
    'initial_ref',v_initial_ref,'financed_ref',v_financed_ref,'commission_ref',v_commission_ref,
    'cashea_reference',nullif(trim(p_cashea_reference),'')
  ));

  order_id := p_order_id;
  order_number := v_order.order_number;
  total_ves := round(v_total_ves,2);
  total_ref := round(v_total_ref,4);
  initial_ves := v_initial_ves;
  initial_ref := v_initial_ref;
  financed_ref := v_financed_ref;
  commission_ref := v_commission_ref;
  cashea_sale_id := v_sale_id;
  return next;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.order_usd_rate(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select coalesce((select sum(charged_ves_amount)/nullif(sum(agreed_usd),0) from public.order_items where order_id=p_order_id having bool_and(price_denomination='USD')),(select operative_rate from public.get_order_rates(p_order_id)))
$function$
;

create or replace function public.close_order_with_full_payment(p_order_id uuid,p_method text,p_reference text default null)
returns table(order_number text,total_ves numeric,total_ref numeric,payment_id uuid)
language plpgsql security definer set search_path='' as $$
declare remaining numeric; r numeric; b numeric; amount numeric; pid uuid; c record;
begin
 perform public.require_auth(); perform public.assert_order_open(p_order_id);
 select coalesce(sum(charged_ves_amount),0)-(select coalesce(sum(value_ves),0) from public.payments where order_id=p_order_id) into remaining from public.order_items where order_id=p_order_id;
 select bcv_rate,public.order_usd_rate(p_order_id) into b,r from public.get_order_rates(p_order_id);
 if remaining>1 then
  amount:=case when p_method in ('CASH_USD','ZELLE','BINANCE') then round(remaining/r,2) else round(remaining,2) end;
  pid:=lubricenter_private.collect_order_tender(gen_random_uuid(),p_order_id,case when p_method='MOBILE_PAYMENT' then 'TRANSFER_BDV' else p_method end,amount,0,'USD',b,p_reference,null);
 end if;
 select * into c from public.close_order(p_order_id);
 return query select c.order_number,c.total_ves,c.total_ref,pid;
end $$;

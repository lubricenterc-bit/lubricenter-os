-- Keep the source of each liability explicit. A retained sale does not receive cash twice.
create unique index customer_balance_cancelled_payment_unique
  on public.customer_balance_movements(payment_id)
  where origin='CANCELLED_SALE';

-- Removing a mistaken split payment reverses its unused excess in the same
-- transaction. If the customer already spent that credit, require review.
create function lubricenter_private.reverse_split_payment_credit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_deposit public.customer_balance_movements; v_cash public.account_movements;
  v_available numeric; v_out uuid; v_entry uuid;
begin
  select * into v_deposit from public.customer_balance_movements
    where payment_id=old.id and origin='OVERPAYMENT';
  if not found then return old; end if;
  select balance_usd into v_available from public.customer_balance_accounts
    where customer_id=v_deposit.customer_id and pocket=v_deposit.pocket for update;
  if v_available<v_deposit.delta_usd then
    raise exception 'El sobrante de este pago ya se usó. Revisa el historial del cliente antes de quitar el cobro';
  end if;
  select * into v_cash from public.account_movements where id=v_deposit.account_movement_id;
  if not found then raise exception 'No se encontró el movimiento de caja del sobrante'; end if;
  insert into public.account_movements(account_id,direction,movement_type,currency,
    amount_original,value_ves,category,note,reference,occurred_at,created_by)
  values(v_cash.account_id,'OUT','ADJUSTMENT',v_cash.currency,v_cash.amount_original,
    v_cash.value_ves,'CUSTOMER_BALANCE_OVERPAYMENT_REVERSAL',
    'Reversión del pago de orden '||old.order_id::text,v_cash.id::text,now(),auth.uid())
  returning id into v_out;
  update public.customer_balance_accounts set balance_usd=balance_usd-v_deposit.delta_usd,
    updated_at=now() where customer_id=v_deposit.customer_id and pocket=v_deposit.pocket;
  insert into public.customer_balance_movements(customer_id,pocket,movement_type,origin,
    delta_usd,amount_original,currency,value_ves,bcv_rate_snapshot,
    operative_rate_snapshot,method,reference,note,order_id,payment_id,
    account_movement_id,related_movement_id)
  values(v_deposit.customer_id,v_deposit.pocket,'REVERSAL','OVERPAYMENT_REVERSAL',
    -v_deposit.delta_usd,v_deposit.amount_original,v_deposit.currency,v_deposit.value_ves,
    v_deposit.bcv_rate_snapshot,v_deposit.operative_rate_snapshot,v_deposit.method,
    v_deposit.reference,'Se quitó el pago que generó este sobrante',old.order_id,
    old.id,v_out,v_deposit.id) returning id into v_entry;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('customer_balance.overpayment_reversed','customer_balance_movement',v_entry,
    jsonb_build_object('order_id',old.order_id,'payment_id',old.id,
      'original_credit_id',v_deposit.id,'account_movement_id',v_out));
  return old;
end $$;
create trigger customer_balance_split_payment_deleted before delete on public.payments
for each row execute function lubricenter_private.reverse_split_payment_credit();
revoke all on function lubricenter_private.reverse_split_payment_credit() from public,anon,authenticated;

create or replace function public.add_payment(p_order_id uuid,p_method text,p_amount_original numeric,p_reference text default null)
returns uuid language plpgsql security definer set search_path=public as $$
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
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_op from public.current_exchange_rates;
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
end $$;

-- Owner-only cancellation with retained funds. Physical payment movements remain
-- in the financial account; the liability is credited without another cash IN.
create function lubricenter_private.cancel_order_to_balance(p_order_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare o public.orders; m record; a record; p public.payments;
  v_pocket text; v_units numeric(18,2); v_entry uuid;
begin
  perform lubricenter_private.require_order_admin();
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo de la anulación (al menos 5 caracteres)'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if o.status='CANCELLED' then return; end if;
  if o.status<>'CLOSED' then raise exception 'Esta opción corresponde a ventas cerradas'; end if;
  if o.customer_id is null then raise exception 'Asocia un cliente antes de conservar el cobro como saldo a favor'; end if;
  if exists(select 1 from public.cashea_sales where order_id=p_order_id) then
    raise exception 'Las ventas Cashea requieren una revisión manual antes de crear saldo a favor';
  end if;
  if exists(select 1 from public.receivables where order_id=p_order_id) then
    raise exception 'La venta tiene Crédito LC; revisa sus cobros antes de anularla con saldo a favor';
  end if;
  perform set_config('lubricenter.order_id',p_order_id::text,true);
  perform set_config('lubricenter.reason',trim(p_reason),true);
  for m in select im.* from public.inventory_movements im join public.order_items i
    on i.id=im.order_item_id where i.order_id=p_order_id and im.movement_type='SALE' loop
    insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,order_item_id,note)
    values(m.inventory_item_id,m.location_id,-m.quantity_delta,'RETURN',m.order_item_id,
      'Anulación '||o.order_number||': '||p_reason);
  end loop;
  for a in select pa.* from public.payroll_accruals pa join public.order_items i
    on i.id=pa.source_order_item_id where i.order_id=p_order_id for update of pa loop
    if a.payroll_run_id is null then delete from public.payroll_accruals where id=a.id;
    elsif a.amount_ref>0 then
      insert into public.payroll_adjustments(employee_id,adjustment_type,amount_ref,note,occurred_on)
      values(a.employee_id,'OTHER',-a.amount_ref,
        'Reversión de comisión liquidada · '||o.order_number||' · '||p_reason,
        (now() at time zone 'America/Caracas')::date);
    end if;
  end loop;
  for p in select * from public.payments where order_id=p_order_id order by id loop
    if p.method in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') then continue; end if;
    v_pocket:=case when p.currency='USD' then 'USD' else 'VES_BCV' end;
    v_units:=case when p.currency='USD' then p.amount_original
      else round(p.amount_original/p.bcv_rate_snapshot,2) end;
    if v_units<=0 then raise exception 'Un cobro es menor al mínimo acreditable; revisa la venta'; end if;
    insert into public.customer_balance_accounts(customer_id,pocket)
      values(o.customer_id,v_pocket) on conflict do nothing;
    perform 1 from public.customer_balance_accounts
      where customer_id=o.customer_id and pocket=v_pocket for update;
    update public.customer_balance_accounts set balance_usd=balance_usd+v_units,updated_at=now()
      where customer_id=o.customer_id and pocket=v_pocket;
    insert into public.customer_balance_movements(
      customer_id,pocket,movement_type,origin,delta_usd,amount_original,currency,value_ves,
      bcv_rate_snapshot,operative_rate_snapshot,method,reference,note,order_id,payment_id
    ) values (
      o.customer_id,v_pocket,'DEPOSIT','CANCELLED_SALE',v_units,p.amount_original,p.currency,p.value_ves,
      p.bcv_rate_snapshot,p.operative_rate_snapshot,p.method,p.reference,
      'Cobro conservado al anular '||o.order_number||' · '||trim(p_reason),p_order_id,p.id
    ) returning id into v_entry;
    insert into public.audit_events(event_type,entity_type,entity_id,data)
      values('customer_balance.cancelled_sale_credit','customer_balance_movement',v_entry,
        jsonb_build_object('order_id',p_order_id,'payment_id',p.id,'customer_id',o.customer_id,
          'pocket',v_pocket,'units_usd',v_units,'cash_movement_reversed',false));
  end loop;
  delete from public.customer_followups where order_id=p_order_id and status<>'SENT';
  update public.orders set status='CANCELLED',cancellation_reason=trim(p_reason),cancelled_at=now()
    where id=p_order_id;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
    values('order.cancelled','order',p_order_id,
      jsonb_build_object('reason',p_reason,'cash_and_stock_reversed',false,
        'cash_retained_as_customer_balance',true,'stock_reversed',true));
end $$;
revoke all on function lubricenter_private.cancel_order_to_balance(uuid,text) from public,anon,authenticated;

create function public.cancel_order_to_customer_balance(p_order_id uuid,p_reason text)
returns void language sql security definer set search_path='' as $$
  select lubricenter_private.cancel_order_to_balance(p_order_id,p_reason)
$$;
revoke all on function public.cancel_order_to_customer_balance(uuid,text) from public,anon;
grant execute on function public.cancel_order_to_customer_balance(uuid,text) to authenticated;

create or replace function public.search_order_admin(p_query text default '',p_status text default 'ALL',
  p_from date default null,p_to date default null,p_page integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 with rows as (
  select o.id,o.order_number,o.status,o.customer_id,
   coalesce(o.business_at,o.closed_at,o.opened_at) sale_at,o.created_at,
   o.corrects_order_id,o.cancellation_reason,c.name customer_name,v.plate,
   (cs.id is not null or r.id is not null) has_financed_sale,
   case when exists(select 1 from public.order_items i where i.order_id=o.id and i.item_type='SERVICE')
     then 'Orden de servicio' else 'Venta' end kind,
   (select coalesce(sum(charged_ref_amount),0) from public.order_items i where i.order_id=o.id) total_ref,
   (select coalesce(sum(charged_ves_amount),0) from public.order_items i where i.order_id=o.id) total_ves,
   case when cs.id is not null then 'Cashea' when r.id is not null then 'Crédito LC'
     else 'Contado / mixto' end payment_type
  from public.orders o left join public.customers c on c.id=o.customer_id
  left join public.vehicles v on v.id=o.vehicle_id
  left join public.cashea_sales cs on cs.order_id=o.id
  left join public.receivables r on r.order_id=o.id
  where (p_status='ALL' or o.status=p_status)
   and (p_from is null or coalesce(o.business_at,o.closed_at,o.opened_at)>=(p_from::timestamp at time zone 'America/Caracas'))
   and (p_to is null or coalesce(o.business_at,o.closed_at,o.opened_at)<((p_to+1)::timestamp at time zone 'America/Caracas'))
   and (trim(p_query)='' or concat_ws(' ',o.order_number,c.name,c.phone,v.plate,v.make,v.model)
     ilike '%'||trim(p_query)||'%')
 ) select jsonb_build_object('count',(select count(*) from rows),
   'rows',coalesce((select jsonb_agg(r) from
     (select * from rows order by sale_at desc,id limit 30 offset greatest(p_page,0)*30) r),'[]'::jsonb))
$$;

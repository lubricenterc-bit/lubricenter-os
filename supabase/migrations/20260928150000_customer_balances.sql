-- A customer balance is a liability, not another sale or an account receipt.
-- VES_BCV preserves the BCV USD-equivalent of bolivars received; USD preserves
-- the actual dollars received. Neither pocket is silently exchanged for the other.
create table public.customer_balance_accounts (
  customer_id uuid not null references public.customers(id) on delete restrict,
  pocket text not null check (pocket in ('VES_BCV','USD')),
  balance_usd numeric(18,2) not null default 0 check (balance_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (customer_id,pocket)
);

create table public.customer_balance_movements (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  pocket text not null check (pocket in ('VES_BCV','USD')),
  movement_type text not null check (movement_type in ('DEPOSIT','USE','RELEASE','REFUND','REVERSAL')),
  origin text not null default 'ADVANCE'
    check (origin in ('ADVANCE','OVERPAYMENT','CANCELLED_SALE','USE','RELEASE','REFUND','OVERPAYMENT_REVERSAL')),
  delta_usd numeric(18,2) not null check (delta_usd <> 0),
  amount_original numeric(18,2) not null check (amount_original > 0),
  currency text not null check (currency in ('VES','USD')),
  value_ves numeric(20,2) not null check (value_ves > 0),
  bcv_rate_snapshot numeric not null check (bcv_rate_snapshot > 0),
  operative_rate_snapshot numeric not null check (operative_rate_snapshot > 0),
  method text,
  reference text,
  note text not null,
  order_id uuid,
  payment_id uuid,
  account_movement_id uuid references public.account_movements(id) on delete restrict,
  related_movement_id uuid references public.customer_balance_movements(id) on delete restrict,
  request_id uuid unique,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (
    (movement_type in ('DEPOSIT','RELEASE') and delta_usd > 0)
    or (movement_type in ('USE','REFUND','REVERSAL') and delta_usd < 0)
  ),
  check (
    (pocket='USD' and currency='USD')
    or (pocket='VES_BCV' and currency='VES')
  )
);
create unique index customer_balance_use_payment_unique
  on public.customer_balance_movements(payment_id) where movement_type='USE';
create unique index customer_balance_release_unique
  on public.customer_balance_movements(related_movement_id) where movement_type='RELEASE';
create unique index customer_balance_reversal_unique
  on public.customer_balance_movements(related_movement_id) where movement_type='REVERSAL';
create index customer_balance_movements_customer_time
  on public.customer_balance_movements(customer_id,created_at desc,id);
create index customer_balance_movements_order
  on public.customer_balance_movements(order_id) where order_id is not null;

alter table public.customer_balance_accounts enable row level security;
alter table public.customer_balance_movements enable row level security;
create policy customer_balance_read on public.customer_balance_accounts
  for select to authenticated using (true);
create policy customer_balance_history_read on public.customer_balance_movements
  for select to authenticated using (true);
grant select on public.customer_balance_accounts,public.customer_balance_movements to authenticated;
revoke insert,update,delete on public.customer_balance_accounts,public.customer_balance_movements from anon,authenticated;

alter table public.payments drop constraint payments_method_check;
alter table public.payments add constraint payments_method_check check (
  method in ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE',
             'CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV')
);

-- Customer-balance settlement is a non-cash payment. It satisfies the order
-- but never creates another bank/cash movement.
create or replace function public.assign_payment_account()
returns trigger language plpgsql security definer set search_path=public as $$
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
    when 'MOBILE_PAYMENT' then 'MOBILE' else null end;
  if v_code is null then raise exception 'No existe cuenta configurada para el método %',new.method; end if;
  select id into new.financial_account_id from public.financial_accounts where code=v_code and active=true;
  if new.financial_account_id is null then raise exception 'Cuenta financiera % no disponible',v_code; end if;
  return new;
end $$;

create or replace function public.capture_payment_movement()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.method in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') then return new; end if;
  insert into public.account_movements(account_id,direction,movement_type,source_payment_id,currency,amount_original,value_ves,reference,occurred_at,created_by)
  values(new.financial_account_id,'IN','PAYMENT',new.id,new.currency,new.amount_original,new.value_ves,new.reference,new.paid_at,new.created_by)
  on conflict (source_payment_id) where source_payment_id is not null do nothing;
  return new;
end $$;

create function lubricenter_private.customer_balance_payment_used()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_customer_id uuid; v_status text; v_pocket text; v_units numeric(18,2);
  v_rate numeric; v_available numeric(18,2); v_entry uuid;
begin
  if new.method not in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') then return new; end if;
  select customer_id,status into v_customer_id,v_status from public.orders where id=new.order_id for update;
  if v_customer_id is null then raise exception 'Asocia un cliente antes de usar saldo a favor'; end if;
  if v_status<>'OPEN' then raise exception 'Solo se puede usar saldo a favor en una orden abierta'; end if;
  v_pocket := case when new.method='CUSTOMER_BALANCE_USD' then 'USD' else 'VES_BCV' end;
  v_rate := case when v_pocket='USD' then new.operative_rate_snapshot else new.bcv_rate_snapshot end;
  if v_rate is null or v_rate<=0 or new.value_ves<=0 then raise exception 'Tasa o importe de saldo inválido'; end if;
  if v_pocket='USD' and (new.currency<>'USD' or abs(new.value_ves-round(new.amount_original*v_rate,2))>0.01)
    or v_pocket='VES_BCV' and (new.currency<>'VES' or abs(new.value_ves-new.amount_original)>0.01) then
    raise exception 'El saldo a favor debe conservar su moneda y su tasa';
  end if;
  v_units := round(new.value_ves/v_rate,2);
  insert into public.customer_balance_accounts(customer_id,pocket) values(v_customer_id,v_pocket)
    on conflict do nothing;
  select balance_usd into v_available from public.customer_balance_accounts
    where customer_id=v_customer_id and pocket=v_pocket for update;
  if v_units<=0 or v_units>v_available then
    raise exception 'Saldo a favor insuficiente: disponible % USD en %',v_available,v_pocket;
  end if;
  update public.customer_balance_accounts set balance_usd=balance_usd-v_units,updated_at=now()
    where customer_id=v_customer_id and pocket=v_pocket;
  insert into public.customer_balance_movements(
    customer_id,pocket,movement_type,delta_usd,amount_original,currency,value_ves,
    bcv_rate_snapshot,operative_rate_snapshot,method,note,order_id,payment_id
  ) values (
    v_customer_id,v_pocket,'USE',-v_units,new.amount_original,new.currency,new.value_ves,
    new.bcv_rate_snapshot,new.operative_rate_snapshot,new.method,
    'Aplicado a la orden',new.order_id,new.id
  ) returning id into v_entry;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('customer_balance.used','customer_balance_movement',v_entry,
    jsonb_build_object('customer_id',v_customer_id,'order_id',new.order_id,'payment_id',new.id,
      'pocket',v_pocket,'units_usd',v_units,'value_ves',new.value_ves,'rate',v_rate));
  return new;
end $$;
create trigger customer_balance_payment_used after insert on public.payments
for each row execute function lubricenter_private.customer_balance_payment_used();
revoke all on function lubricenter_private.customer_balance_payment_used() from public,anon,authenticated;

create function lubricenter_private.release_customer_balance_payment(p_payment_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_use public.customer_balance_movements; v_entry uuid;
begin
  select * into v_use from public.customer_balance_movements
    where payment_id=p_payment_id and movement_type='USE';
  if not found then return; end if;
  perform 1 from public.customer_balance_accounts
    where customer_id=v_use.customer_id and pocket=v_use.pocket for update;
  if exists(select 1 from public.customer_balance_movements
    where related_movement_id=v_use.id and movement_type='RELEASE') then return; end if;
  update public.customer_balance_accounts set balance_usd=balance_usd-v_use.delta_usd,updated_at=now()
    where customer_id=v_use.customer_id and pocket=v_use.pocket;
  insert into public.customer_balance_movements(
    customer_id,pocket,movement_type,delta_usd,amount_original,currency,value_ves,
    bcv_rate_snapshot,operative_rate_snapshot,method,note,order_id,payment_id,related_movement_id
  ) values (
    v_use.customer_id,v_use.pocket,'RELEASE',-v_use.delta_usd,v_use.amount_original,v_use.currency,v_use.value_ves,
    v_use.bcv_rate_snapshot,v_use.operative_rate_snapshot,v_use.method,p_reason,v_use.order_id,p_payment_id,v_use.id
  ) returning id into v_entry;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('customer_balance.released','customer_balance_movement',v_entry,
    jsonb_build_object('customer_id',v_use.customer_id,'order_id',v_use.order_id,
      'payment_id',p_payment_id,'original_movement_id',v_use.id,'reason',p_reason));
end $$;
revoke all on function lubricenter_private.release_customer_balance_payment(uuid,text) from public,anon,authenticated;

create function lubricenter_private.customer_balance_payment_deleted()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.method in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') then
    perform lubricenter_private.release_customer_balance_payment(old.id,'Pago quitado de la orden');
  end if;
  return old;
end $$;
create trigger customer_balance_payment_deleted before delete on public.payments
for each row execute function lubricenter_private.customer_balance_payment_deleted();
revoke all on function lubricenter_private.customer_balance_payment_deleted() from public,anon,authenticated;

create function lubricenter_private.customer_balance_order_cancelled()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_payment_id uuid;
begin
  if new.status='CANCELLED' and old.status is distinct from 'CANCELLED' then
    for v_payment_id in select id from public.payments where order_id=new.id
      and method in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') order by id loop
      perform lubricenter_private.release_customer_balance_payment(v_payment_id,'Orden anulada: '||coalesce(new.cancellation_reason,'sin detalle'));
    end loop;
  end if;
  return new;
end $$;
create trigger customer_balance_order_cancelled after update of status on public.orders
for each row execute function lubricenter_private.customer_balance_order_cancelled();
revoke all on function lubricenter_private.customer_balance_order_cancelled() from public,anon,authenticated;

create function public.record_customer_balance_deposit(
  p_customer_id uuid,p_method text,p_amount_original numeric,
  p_reference text default null,p_note text default null,p_request_id uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_method text := upper(coalesce(p_method,''));
  v_pocket text; v_currency text; v_account_code text; v_account_id uuid;
  v_bcv numeric; v_op numeric; v_units numeric(18,2); v_value_ves numeric(20,2);
  v_movement_id uuid; v_entry_id uuid; v_existing public.customer_balance_movements;
begin
  perform public.require_auth();
  if p_request_id is null then raise exception 'Falta el identificador de esta operación'; end if;
  select * into v_existing from public.customer_balance_movements where request_id=p_request_id;
  if found then
    if v_existing.movement_type='DEPOSIT' and v_existing.customer_id=p_customer_id
       and v_existing.method=v_method and v_existing.amount_original=p_amount_original then return v_existing.id; end if;
    raise exception 'Este identificador ya corresponde a otra operación';
  end if;
  if not exists(select 1 from public.customers where id=p_customer_id) then raise exception 'Cliente no encontrado'; end if;
  if p_amount_original is null or p_amount_original::text in ('NaN','Infinity','-Infinity')
     or p_amount_original<=0 or round(p_amount_original,2)<>p_amount_original then
    raise exception 'Indica un monto positivo con máximo dos decimales';
  end if;
  v_account_code := case v_method
    when 'CASH_USD' then 'CASH_USD' when 'CASH_VES' then 'CASH_VES'
    when 'TRANSFER_BDV' then 'BDV' when 'TRANSFER_BNC' then 'BNC'
    when 'ZELLE' then 'ZELLE' when 'BINANCE' then 'BINANCE' else null end;
  if v_account_code is null then raise exception 'Método de ingreso inválido'; end if;
  if v_method in ('TRANSFER_BDV','TRANSFER_BNC')
     and coalesce(trim(p_reference),'') !~ '^[0-9]{4}$' then
    raise exception 'Escribe los últimos 4 dígitos de referencia del pago móvil';
  end if;
  select id into v_account_id from public.financial_accounts
    where code=v_account_code and active=true;
  if v_account_id is null then raise exception 'Cuenta financiera % no disponible',v_account_code; end if;
  select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates;
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then
    raise exception 'Debes tener tasas BCV y operativa vigentes antes de registrar el saldo';
  end if;
  v_pocket := case when v_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES_BCV' end;
  v_currency := case when v_pocket='USD' then 'USD' else 'VES' end;
  v_units := case when v_pocket='USD' then p_amount_original else round(p_amount_original/v_bcv,2) end;
  if v_units<=0 then raise exception 'El importe es menor a un centavo de saldo a favor'; end if;
  v_value_ves := case when v_pocket='USD' then round(p_amount_original*v_op,2) else p_amount_original end;
  insert into public.account_movements(
    account_id,direction,movement_type,currency,amount_original,value_ves,
    category,note,reference,occurred_at,created_by
  ) values (
    v_account_id,'IN','ADJUSTMENT',v_currency,p_amount_original,v_value_ves,
    'CUSTOMER_BALANCE_DEPOSIT','Anticipo de cliente · '||coalesce(nullif(trim(p_note),''),'saldo a favor'),
    nullif(trim(p_reference),''),now(),auth.uid()
  ) returning id into v_movement_id;
  insert into public.customer_balance_accounts(customer_id,pocket)
    values(p_customer_id,v_pocket) on conflict do nothing;
  perform 1 from public.customer_balance_accounts
    where customer_id=p_customer_id and pocket=v_pocket for update;
  update public.customer_balance_accounts set balance_usd=balance_usd+v_units,updated_at=now()
    where customer_id=p_customer_id and pocket=v_pocket;
  insert into public.customer_balance_movements(
    customer_id,pocket,movement_type,delta_usd,amount_original,currency,value_ves,
    bcv_rate_snapshot,operative_rate_snapshot,method,reference,note,account_movement_id,request_id
  ) values (
    p_customer_id,v_pocket,'DEPOSIT',v_units,p_amount_original,v_currency,v_value_ves,
    v_bcv,v_op,v_method,nullif(trim(p_reference),''),coalesce(nullif(trim(p_note),''),'Anticipo de cliente'),
    v_movement_id,p_request_id
  ) returning id into v_entry_id;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('customer_balance.deposit','customer_balance_movement',v_entry_id,
    jsonb_build_object('customer_id',p_customer_id,'pocket',v_pocket,'amount_original',p_amount_original,
      'currency',v_currency,'units_usd',v_units,'bcv_rate',v_bcv,'account_movement_id',v_movement_id));
  return v_entry_id;
end $$;
revoke all on function public.record_customer_balance_deposit(uuid,text,numeric,text,text,uuid) from public,anon;
grant execute on function public.record_customer_balance_deposit(uuid,text,numeric,text,text,uuid) to authenticated;

create function public.apply_customer_balance(
  p_order_id uuid,p_pocket text,p_amount_usd numeric default null,p_request_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
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
  select bcv_rate,public.order_usd_rate(p_order_id) into v_bcv,v_op from public.current_exchange_rates;
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
end $$;
revoke all on function public.apply_customer_balance(uuid,text,numeric,uuid) from public,anon;
grant execute on function public.apply_customer_balance(uuid,text,numeric,uuid) to authenticated;

create function public.refund_customer_balance(
  p_customer_id uuid,p_pocket text,p_amount_usd numeric,p_method text,
  p_reference text,p_reason text,p_request_id uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_existing public.customer_balance_movements; v_method text:=upper(coalesce(p_method,''));
  v_account_code text; v_account_id uuid; v_available numeric(18,2);
  v_bcv numeric; v_op numeric; v_currency text; v_original numeric(18,2);
  v_value_ves numeric(20,2); v_movement_id uuid; v_entry_id uuid;
begin
  perform lubricenter_private.finance_require('ADMIN');
  if p_request_id is null then raise exception 'Falta el identificador de esta operación'; end if;
  select * into v_existing from public.customer_balance_movements where request_id=p_request_id;
  if found then
    if v_existing.movement_type='REFUND' and v_existing.customer_id=p_customer_id
       and v_existing.pocket=p_pocket and v_existing.delta_usd=-p_amount_usd then return v_existing.id; end if;
    raise exception 'Este identificador ya corresponde a otra operación';
  end if;
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo de la devolución'; end if;
  if p_amount_usd is null or p_amount_usd::text in ('NaN','Infinity','-Infinity')
    or p_amount_usd<=0 or round(p_amount_usd,2)<>p_amount_usd then
    raise exception 'Indica un monto positivo con máximo dos decimales';
  end if;
  if p_pocket='USD' then
    if v_method not in ('CASH_USD','ZELLE','BINANCE') then raise exception 'El saldo en divisas debe devolverse en divisas'; end if;
  elsif p_pocket='VES_BCV' then
    if v_method not in ('CASH_VES','TRANSFER_BDV','TRANSFER_BNC') then raise exception 'El saldo recibido en Bs se devuelve en Bs a la BCV de hoy'; end if;
  else raise exception 'Saldo no reconocido'; end if;
  if v_method in ('TRANSFER_BDV','TRANSFER_BNC')
    and coalesce(trim(p_reference),'') !~ '^[0-9]{4}$' then
    raise exception 'Escribe los últimos 4 dígitos de referencia del pago móvil';
  end if;
  v_account_code := case v_method when 'CASH_USD' then 'CASH_USD'
    when 'CASH_VES' then 'CASH_VES' when 'TRANSFER_BDV' then 'BDV'
    when 'TRANSFER_BNC' then 'BNC' when 'ZELLE' then 'ZELLE'
    when 'BINANCE' then 'BINANCE' end;
  select id into v_account_id from public.financial_accounts where code=v_account_code and active=true;
  if v_account_id is null then raise exception 'Cuenta financiera % no disponible',v_account_code; end if;
  select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates;
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'Faltan tasas vigentes'; end if;
  select balance_usd into v_available from public.customer_balance_accounts
    where customer_id=p_customer_id and pocket=p_pocket for update;
  if v_available is null or p_amount_usd>v_available then
    raise exception 'Saldo insuficiente: disponible % USD',coalesce(v_available,0);
  end if;
  v_currency := case when p_pocket='USD' then 'USD' else 'VES' end;
  v_original := case when p_pocket='USD' then p_amount_usd else round(p_amount_usd*v_bcv,2) end;
  v_value_ves := case when p_pocket='USD' then round(p_amount_usd*v_op,2) else v_original end;
  insert into public.account_movements(
    account_id,direction,movement_type,currency,amount_original,value_ves,
    category,note,reference,occurred_at,created_by,finance_nature
  ) values (
    v_account_id,'OUT','ADJUSTMENT',v_currency,v_original,v_value_ves,
    'CUSTOMER_BALANCE_REFUND','Devolución de saldo a favor · '||trim(p_reason),
    nullif(trim(p_reference),''),now(),auth.uid(),'REFUND'
  ) returning id into v_movement_id;
  update public.customer_balance_accounts set balance_usd=balance_usd-p_amount_usd,updated_at=now()
    where customer_id=p_customer_id and pocket=p_pocket;
  insert into public.customer_balance_movements(
    customer_id,pocket,movement_type,delta_usd,amount_original,currency,value_ves,
    bcv_rate_snapshot,operative_rate_snapshot,method,reference,note,account_movement_id,request_id
  ) values (
    p_customer_id,p_pocket,'REFUND',-p_amount_usd,v_original,v_currency,v_value_ves,
    v_bcv,v_op,v_method,nullif(trim(p_reference),''),trim(p_reason),v_movement_id,p_request_id
  ) returning id into v_entry_id;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('customer_balance.refunded','customer_balance_movement',v_entry_id,
    jsonb_build_object('customer_id',p_customer_id,'pocket',p_pocket,'units_usd',p_amount_usd,
      'amount_original',v_original,'currency',v_currency,'bcv_rate',v_bcv,'account_movement_id',v_movement_id));
  return v_entry_id;
end $$;
revoke all on function public.refund_customer_balance(uuid,text,numeric,text,text,text,uuid) from public,anon;
grant execute on function public.refund_customer_balance(uuid,text,numeric,text,text,text,uuid) to authenticated;

-- Dashboard collections count actual receipts only; balance use settled a sale with previously received money.
create or replace function public.finance_dashboard(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_from date := coalesce(p_from, date_trunc('month', timezone('America/Caracas', now()))::date);
  v_to date := coalesce(p_to, timezone('America/Caracas', now())::date);
  v_result jsonb;
begin
  perform public.require_auth();
  if v_from > v_to then raise exception 'La fecha inicial debe ser anterior a la final'; end if;
  if v_to - v_from > 366 then raise exception 'El período máximo es de 367 días'; end if;

  with classified_sales as (
    select o.id, o.total_ref, o.total_ves,
      timezone('America/Caracas', coalesce(o.business_at, o.closed_at))::date sale_date,
      case when cs.id is not null then 'CASHEA'
           when r.id is not null then 'CREDIT_LC'
           else 'CASH' end sale_type
    from public.orders o
    left join public.cashea_sales cs on cs.order_id = o.id
    left join public.receivables r on r.order_id = o.id and r.debtor_type <> 'CASHEA'
    where o.status = 'CLOSED'
      and coalesce(o.business_at, o.closed_at) >= (v_from::timestamp at time zone 'America/Caracas')
      and coalesce(o.business_at, o.closed_at) < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), sales_summary as (
    select count(*) orders, coalesce(sum(total_ref),0) total_ref, coalesce(sum(total_ves),0) total_ves
    from classified_sales
  ), sales_by_type as (
    select sale_type, count(*) orders, coalesce(sum(total_ref),0) total_ref, coalesce(sum(total_ves),0) total_ves
    from classified_sales group by sale_type
  ), period_payments as (
    select p.* from public.payments p
    where p.method not in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV')
      and exists(select 1 from public.orders o where o.id=p.order_id and o.status<>'CANCELLED')
      and p.paid_at >= (v_from::timestamp at time zone 'America/Caracas')
      and p.paid_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), collections_summary as (
    select count(*) payments, coalesce(sum(value_ref),0) total_ref, coalesce(sum(value_ves),0) total_ves
    from period_payments
  ), collections_by_method as (
    select method, count(*) payments, coalesce(sum(value_ref),0) total_ref, coalesce(sum(value_ves),0) total_ves
    from period_payments group by method
  ), customer_balance_cash as (
    select coalesce(sum(value_ves) filter(where category='CUSTOMER_BALANCE_DEPOSIT'),0) deposits_ves,
      coalesce(sum(value_ves) filter(where category='CUSTOMER_BALANCE_REFUND'),0) refunds_ves,
      coalesce(sum(value_ves) filter(where category='CUSTOMER_BALANCE_OVERPAYMENT_REVERSAL'),0) reversals_ves
    from public.account_movements
    where category in ('CUSTOMER_BALANCE_DEPOSIT','CUSTOMER_BALANCE_REFUND',
      'CUSTOMER_BALANCE_OVERPAYMENT_REVERSAL')
      and occurred_at >= (v_from::timestamp at time zone 'America/Caracas')
      and occurred_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), retained_cancelled_cash as (
    select coalesce(sum(p.value_ves),0) retained_ves
    from public.customer_balance_movements cb join public.payments p on p.id=cb.payment_id
    where cb.origin='CANCELLED_SALE'
      and p.paid_at >= (v_from::timestamp at time zone 'America/Caracas')
      and p.paid_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), period_expenses as (
    select am.* from public.account_movements am
    where am.direction='OUT' and am.movement_type='EXPENSE'
      and am.occurred_at >= (v_from::timestamp at time zone 'America/Caracas')
      and am.occurred_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), expense_summary as (
    select count(*) expenses, coalesce(sum(value_ves),0) total_ves from period_expenses
  ), expenses_by_category as (
    select coalesce(category,'Sin categoría') category, count(*) expenses, coalesce(sum(value_ves),0) total_ves
    from period_expenses group by coalesce(category,'Sin categoría')
  ), daily as (
    select d::date activity_date,
      coalesce((select sum(s.total_ref) from classified_sales s where s.sale_date=d::date),0) sales_ref,
      coalesce((select sum(p.value_ref) from period_payments p where timezone('America/Caracas',p.paid_at)::date=d::date),0) collected_ref,
      coalesce((select sum(e.value_ves) from period_expenses e where timezone('America/Caracas',e.occurred_at)::date=d::date),0) expenses_ves
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
  ), lc_open as (
    select count(*) accounts, coalesce(sum(outstanding_ves),0) outstanding_ves,
      count(*) filter(where due_date is not null and due_date < timezone('America/Caracas',now())::date) overdue
    from public.receivables where status='OPEN' and debtor_type <> 'CASHEA'
  ), cashea_open as (
    select count(distinct cs.id) sales,
      count(ci.id) filter(where ci.status in ('PENDING','PARTIAL')) installments,
      coalesce(sum(greatest(ci.amount_ref-ci.paid_ref,0)) filter(where ci.status in ('PENDING','PARTIAL')),0) outstanding_ref,
      count(ci.id) filter(where ci.status in ('PENDING','PARTIAL') and ci.due_date < timezone('America/Caracas',now())::date) overdue
    from public.cashea_sales cs left join public.cashea_installments ci on ci.cashea_sale_id=cs.id
    where cs.status <> 'SETTLED'
  ), balances as (
    select id,code,name,currency,account_type,balance_native,balance_ves
    from public.account_balances_current where active order by account_type,name
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from',v_from,'to',v_to,'days',v_to-v_from+1),
    'sales', (select to_jsonb(sales_summary) from sales_summary),
    'sales_by_type', coalesce((select jsonb_agg(to_jsonb(x) order by sale_type) from sales_by_type x),'[]'::jsonb),
    'collections', (select to_jsonb(collections_summary) from collections_summary),
    'collections_by_method', coalesce((select jsonb_agg(to_jsonb(x) order by total_ves desc) from collections_by_method x),'[]'::jsonb),
    'customer_balance_cash', (select to_jsonb(customer_balance_cash) from customer_balance_cash),
    'retained_cancelled_cash_ves', (select retained_ves from retained_cancelled_cash),
    'expenses', (select to_jsonb(expense_summary) from expense_summary),
    'expenses_by_category', coalesce((select jsonb_agg(to_jsonb(x) order by total_ves desc) from expenses_by_category x),'[]'::jsonb),
    'net_cash_ves', (select total_ves from collections_summary)
      + (select deposits_ves-refunds_ves-reversals_ves from customer_balance_cash)
      + (select retained_ves from retained_cancelled_cash)
      - (select total_ves from expense_summary),
    'lc_open', (select to_jsonb(lc_open) from lc_open),
    'cashea_open', (select to_jsonb(cashea_open) from cashea_open),
    'accounts', coalesce((select jsonb_agg(to_jsonb(x)) from balances x),'[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(x) order by activity_date) from daily x),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;


CREATE OR REPLACE FUNCTION public.dashboard_overview()
 RETURNS TABLE(local_date date, closed_orders_today bigint, sales_ves_today numeric, sales_ref_today numeric, collected_ves_today numeric, collected_ref_today numeric, open_orders bigint, active_vehicles bigint, vehicles_received bigint, vehicles_diagnosis bigint, vehicles_in_progress bigint, vehicles_waiting_parts bigint, vehicles_ready bigint, post_service_action bigint, maintenance_due bigint, maintenance_soon bigint, receivables_open bigint, receivables_outstanding_ves numeric, payroll_pending_ref numeric, inventory_review bigint, inventory_negative bigint, bcv_rate numeric, operative_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
begin
  perform public.require_auth();
  return query
  with rates as (select * from public.current_exchange_rates),
  workshop as (
    select
      count(*)::bigint active,
      count(*) filter(where workflow_status='RECEIVED')::bigint received,
      count(*) filter(where workflow_status='DIAGNOSIS')::bigint diagnosis,
      count(*) filter(where workflow_status='IN_PROGRESS')::bigint in_progress,
      count(*) filter(where workflow_status='WAITING_PARTS')::bigint waiting_parts,
      count(*) filter(where workflow_status='READY')::bigint ready
    from public.workshop_board_current
  )
  select
    v_today,
    (select count(*) from public.orders where status='CLOSED' and (closed_at at time zone 'America/Caracas')::date=v_today),
    (select coalesce(sum(total_ves),0) from public.orders where status='CLOSED' and (closed_at at time zone 'America/Caracas')::date=v_today),
    (select coalesce(sum(total_ref),0) from public.orders where status='CLOSED' and (closed_at at time zone 'America/Caracas')::date=v_today),
    (select coalesce(sum(value_ves),0) from public.payments where method not in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') and exists(select 1 from public.orders o where o.id=payments.order_id and o.status<>'CANCELLED') and (paid_at at time zone 'America/Caracas')::date=v_today),
    (select coalesce(sum(value_ref),0) from public.payments where method not in ('CUSTOMER_BALANCE_USD','CUSTOMER_BALANCE_BCV') and exists(select 1 from public.orders o where o.id=payments.order_id and o.status<>'CANCELLED') and (paid_at at time zone 'America/Caracas')::date=v_today),
    (select count(*) from public.orders where status='OPEN'),
    workshop.active,workshop.received,workshop.diagnosis,workshop.in_progress,workshop.waiting_parts,workshop.ready,
    (select count(*) from public.customer_followups where followup_type='POST_SERVICE' and (status='PENDING' or (status='SNOOZED' and (snoozed_until is null or snoozed_until<=v_today)))),
    (select count(*) from public.maintenance_reminders_current where urgency='DUE'),
    (select count(*) from public.maintenance_reminders_current where urgency='SOON'),
    (select count(*) from public.receivables where status='OPEN'),
    (select coalesce(sum(outstanding_ves),0) from public.receivables where status='OPEN'),
    (select coalesce(sum(amount_ref),0) from public.payroll_accruals where payroll_run_id is null),
    (select count(*) from public.inventory_current where needs_review=true),
    (select count(*) from public.inventory_current where quantity_on_hand<0),
    rates.bcv_rate,rates.operative_rate
  from workshop cross join rates;
end;
$function$
;

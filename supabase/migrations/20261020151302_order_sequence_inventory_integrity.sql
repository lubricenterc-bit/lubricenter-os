-- Preserve every issued business number. Allocation rolls back with the sale.
lock table public.orders in share row exclusive mode;
create table lubricenter_private.order_number_counter(
 singleton boolean primary key default true check(singleton),last_number bigint not null check(last_number>=0)
);
alter table lubricenter_private.order_number_counter enable row level security;
insert into lubricenter_private.order_number_counter(singleton,last_number)
 select true,greatest((select last_value from public.orders_order_seq_seq),coalesce(max(order_seq),0)) from public.orders;
create or replace function lubricenter_private.allocate_order_number()
returns bigint language plpgsql security definer set search_path='' as $$
declare n bigint;
begin
 perform public.require_auth();
 update lubricenter_private.order_number_counter set last_number=last_number+1 where singleton returning last_number into n;
 if n is null then raise exception 'No está configurado el contador de órdenes'; end if;
 return n;
end $$;
revoke all on function lubricenter_private.allocate_order_number() from public,anon;
grant execute on function lubricenter_private.allocate_order_number() to authenticated;
alter table public.orders alter column order_seq drop identity;
alter table public.orders alter column order_seq set default lubricenter_private.allocate_order_number();

create table lubricenter_private.order_number_explanations(
 number bigint primary key,classification text not null,explanation text not null,recorded_at timestamptz not null default now()
);
alter table lubricenter_private.order_number_explanations enable row level security;
insert into lubricenter_private.order_number_explanations(number,classification,explanation)
 select n,'TEST_ROLLBACK_CONFIRMED','Pruebas de diagnóstico de ChatGPT del 20-10-2026: transacciones revertidas; sin ventas, pagos ni inventario persistentes. La secuencia anterior no revertía los números.' from generate_series(270,291) n
 where not exists(select 1 from public.orders o where o.order_seq=n);
revoke all on lubricenter_private.order_number_counter,lubricenter_private.order_number_explanations from public,anon,authenticated;

-- A draft is cancelled visibly, never physically erased together with payments.
create or replace function public.delete_open_order(p_order_id uuid,p_reason text default 'Orden duplicada')
returns text language plpgsql security definer set search_path='' as $$
declare o public.orders;
begin
 perform public.require_auth();
 select * into o from public.orders where id=p_order_id for update;
 if not found then raise exception 'Orden no encontrada'; end if;
 if o.status='CANCELLED' then return o.order_number; end if;
 if o.status<>'OPEN' then raise exception 'Solo se anulan borradores sin cobros. Usa la anulación auditada para ventas cerradas'; end if;
 if exists(select 1 from public.payments where order_id=o.id)
 or exists(select 1 from public.order_tenders where order_id=o.id)
 or exists(select 1 from public.receivables where order_id=o.id)
 or exists(select 1 from public.cashea_sales where order_id=o.id)
 or exists(select 1 from public.service_records where order_id=o.id)
 or exists(select 1 from public.inventory_movements m join public.order_items i on i.id=m.order_item_id where i.order_id=o.id) then
  raise exception 'La orden tiene cobros o movimientos. Requiere anulación auditada; no se pueden borrar';
 end if;
 if length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo de la anulación'; end if;
 perform set_config('lubricenter.reason',p_reason,true);
 update public.orders set status='CANCELLED',cancelled_at=now(),cancellation_reason=btrim(p_reason) where id=o.id;
 insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
 values('order.draft_cancelled','order',o.id,jsonb_build_object('order_number',o.order_number,'reason',p_reason,'retained',true),auth.uid());
 return o.order_number;
end $$;
create or replace function lubricenter_private.prevent_order_erasure()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Las órdenes se conservan en el historial. Anula el borrador o la venta con su motivo'; end $$;
create trigger aa_prevent_order_erasure before delete on public.orders for each row execute function lubricenter_private.prevent_order_erasure();

-- Every return identifies the exact sale movement; retries cannot return twice.
alter table public.inventory_movements add column reversal_of uuid references public.inventory_movements(id);
update public.inventory_movements r set reversal_of=s.id from public.inventory_movements s
 where r.movement_type='RETURN' and s.movement_type='SALE' and r.order_item_id=s.order_item_id
 and r.inventory_item_id=s.inventory_item_id and r.location_id=s.location_id and r.quantity_delta=-s.quantity_delta;
create unique index inventory_one_reversal on public.inventory_movements(reversal_of) where reversal_of is not null;
create or replace function lubricenter_private.return_order_stock(p_order_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare m record; prior text:=coalesce(current_setting('lubricenter.inventory_lifecycle',true),'');
begin
 perform public.require_auth();
 perform set_config('lubricenter.inventory_lifecycle','RETURN',true);
 for m in select im.* from public.inventory_movements im join public.order_items i on i.id=im.order_item_id
  where i.order_id=p_order_id and im.movement_type='SALE' order by im.inventory_item_id,im.location_id,im.id loop
  perform 1 from public.inventory_items where id=m.inventory_item_id for update;
  insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,order_item_id,note,reversal_of)
  values(m.inventory_item_id,m.location_id,-m.quantity_delta,'RETURN',m.order_item_id,p_reason,m.id)
  on conflict(reversal_of) where reversal_of is not null do nothing;
 end loop;
 perform set_config('lubricenter.inventory_lifecycle',prior,true);
end $$;
revoke all on function lubricenter_private.return_order_stock(uuid,text) from public,anon,authenticated;

create or replace function lubricenter_private.guard_inventory_ledger()
returns trigger language plpgsql security definer set search_path='' as $$
declare s public.inventory_movements; i public.order_items; flow text:=coalesce(current_setting('lubricenter.inventory_lifecycle',true),'');
begin
 if tg_op<>'INSERT' then raise exception 'El inventario conserva sus movimientos. Registra un ajuste o una devolución; no edites ni borres el historial'; end if;
 if new.order_item_id is not null and new.movement_type in ('SALE','RETURN') then
  select * into i from public.order_items where id=new.order_item_id;
  if not found then raise exception 'La línea de la orden no existe'; end if;
  if new.inventory_item_id is distinct from i.inventory_item_id then raise exception 'El movimiento no corresponde al SKU de la orden'; end if;
  if new.movement_type='SALE' then
   if flow<>'SALE' or new.quantity_delta<>-i.quantity then raise exception 'La salida se genera al cerrar la orden, con su cantidad exacta'; end if;
  else
   select * into s from public.inventory_movements where id=new.reversal_of and movement_type='SALE';
   if flow<>'RETURN' or not found or s.order_item_id<>new.order_item_id or s.inventory_item_id<>new.inventory_item_id
    or s.location_id<>new.location_id or new.quantity_delta<>-s.quantity_delta then raise exception 'La devolución debe revertir la salida original exacta'; end if;
  end if;
 end if;
 return new;
end $$;
create trigger ab_inventory_ledger_guard before insert or update or delete on public.inventory_movements for each row execute function lubricenter_private.guard_inventory_ledger();

create or replace function lubricenter_private.guard_order_lifecycle()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status in ('CLOSED','CANCELLED') and new.status='OPEN' or old.status='CANCELLED' and new.status='CLOSED' then
  raise exception 'Una orden cerrada o anulada no se reabre. Usa una corrección vinculada para conservar cobros e inventario';
 end if;
 if new.status='CANCELLED' and old.status<>'CANCELLED' then
  if (old.status='CLOSED' or exists(select 1 from public.payments where order_id=old.id))
    and coalesce(current_setting('lubricenter.order_cancel_flow',true),'')<>'yes' then raise exception 'Esta orden requiere anulación auditada de sus cobros e inventario'; end if;
  perform lubricenter_private.return_order_stock(old.id,'Anulación '||old.order_number||': '||coalesce(new.cancellation_reason,'Sin motivo'));
 end if;
 return new;
end $$;
create trigger ac_order_lifecycle before update of status on public.orders for each row execute function lubricenter_private.guard_order_lifecycle();
create or replace function lubricenter_private.guard_stock_item_edits()
returns trigger language plpgsql security definer set search_path='' as $$
declare oid uuid:=case when tg_op='INSERT' then new.order_id else old.order_id end;s text;
begin
 select status into s from public.orders where id=oid for update;
 if s in ('CLOSED','CANCELLED') then
  if tg_op='INSERT' and new.inventory_item_id is not null
   or tg_op='DELETE' and old.inventory_item_id is not null then raise exception 'Corrige la venta mediante una orden vinculada para ajustar su inventario'; end if;
  if tg_op='UPDATE' then
   if (old.inventory_item_id is not null or new.inventory_item_id is not null) and
    row(old.inventory_item_id,old.inventory_location_id,old.quantity,old.order_id) is distinct from row(new.inventory_item_id,new.inventory_location_id,new.quantity,new.order_id)
    then raise exception 'No se puede cambiar el SKU o cantidad de una orden cerrada sin su corrección de inventario'; end if;
  end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger ab_stock_item_edits before insert or update or delete on public.order_items for each row execute function lubricenter_private.guard_stock_item_edits();

-- A catalog item with a stock identity must never bypass the stock ledger.
create or replace function lubricenter_private.catalog_stock_item(p_order uuid,p_product uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare n int; iid uuid;
begin
 perform public.require_auth();
 select count(*),(array_agg(id order by id))[1] into n,iid from public.inventory_items where product_id=p_product and active;
 if n>1 then raise exception 'Este producto de catálogo corresponde a varios SKU. Selecciona el código exacto desde inventario'; end if;
 return iid;
end $$;
revoke all on function lubricenter_private.catalog_stock_item(uuid,uuid) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.cancel_order(p_order_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.orders; m record; a record;
begin
 perform lubricenter_private.require_order_admin();
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo de la anulación (al menos 5 caracteres)'; end if;
 select * into o from public.orders where id=p_order_id for update;
 if not found then raise exception 'Venta no encontrada'; end if;
 if o.status='CANCELLED' then return; end if;
 -- Lock installment writers too; their functions lock installment then sale.
 perform 1 from public.cashea_installments where cashea_sale_id in(select id from public.cashea_sales where order_id=p_order_id) order by id for update;
 perform 1 from public.cashea_sales where order_id=p_order_id for update;
 perform 1 from public.receivables where order_id=p_order_id for update;
 perform set_config('lubricenter.order_id',p_order_id::text,true);
 perform set_config('lubricenter.reason',trim(p_reason),true);
 perform set_config('lubricenter.order_cancel_flow','yes',true);
 perform lubricenter_private.return_order_stock(p_order_id,'Anulación '||o.order_number||': '||p_reason);
 for m in select am.* from public.account_movements am join public.payments p on p.id=am.source_payment_id where p.order_id=p_order_id loop
  insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,reference,occurred_at)
  values(m.account_id,case when m.direction='IN' then 'OUT' else 'IN' end,'ADJUSTMENT',m.currency,m.amount_original,m.value_ves,'ORDER_REVERSAL','Anulación '||o.order_number||': '||p_reason,m.id::text,m.occurred_at);
 end loop;
 for a in select pa.* from public.payroll_accruals pa join public.order_items i on i.id=pa.source_order_item_id where i.order_id=p_order_id for update of pa loop
  if a.payroll_run_id is null then delete from public.payroll_accruals where id=a.id;
  elsif a.amount_ref>0 then
   insert into public.payroll_adjustments(employee_id,adjustment_type,amount_ref,note,occurred_on)
   values(a.employee_id,'OTHER',-a.amount_ref,'Reversión de comisión liquidada · '||o.order_number||' · '||p_reason,(now() at time zone 'America/Caracas')::date);
  end if;
 end loop;
 update public.receivables set status='CANCELLED',outstanding_ves=0,closed_at=now() where order_id=p_order_id;
 update public.cashea_sales set status='CANCELLED' where order_id=p_order_id;
 -- Suppress pending CRM without pretending that a message was sent.
 delete from public.customer_followups where order_id=p_order_id and status<>'SENT';
 update public.orders set status='CANCELLED',cancellation_reason=trim(p_reason),cancelled_at=now() where id=p_order_id;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('order.cancelled','order',p_order_id,jsonb_build_object('reason',p_reason,'cash_and_stock_reversed',true));
end $function$
;
CREATE OR REPLACE FUNCTION lubricenter_private.cancel_order_to_balance(p_order_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform set_config('lubricenter.order_cancel_flow','yes',true);
 perform lubricenter_private.return_order_stock(p_order_id,'Anulación '||o.order_number||': '||p_reason);
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
end $function$
;CREATE OR REPLACE FUNCTION public.consume_inventory_on_order_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_prior text:=coalesce(current_setting('lubricenter.inventory_lifecycle',true),'');
  v_location uuid;
  v_stock numeric;
begin
  if new.status='CLOSED' and old.status is distinct from 'CLOSED' then
    perform set_config('lubricenter.inventory_lifecycle','SALE',true);
    for r in
      select oi.id,oi.inventory_item_id,oi.inventory_location_id,oi.quantity,ii.sku
      from public.order_items oi
      join public.inventory_items ii on ii.id=oi.inventory_item_id
      where oi.order_id=new.id and oi.inventory_item_id is not null
      order by oi.inventory_item_id,oi.inventory_location_id,oi.id
    loop
      v_location := coalesce(r.inventory_location_id,new.location_id);
      if v_location is null then select id into v_location from public.locations where code='CABUDARE' and active=true limit 1; end if;
      perform 1 from public.inventory_items where id=r.inventory_item_id for update;
      v_stock := public.inventory_quantity(r.inventory_item_id,v_location);
      if v_stock < r.quantity then
        raise exception 'No se puede cerrar: stock insuficiente para % (disponible %, requerido %)',r.sku,v_stock,r.quantity;
      end if;
      insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,order_item_id,note,occurred_at)
      values(r.inventory_item_id,v_location,-r.quantity,'SALE',r.id,'Salida por orden '||coalesce(new.order_number,new.id::text),coalesce(new.closed_at,now()))
      on conflict (order_item_id) where movement_type='SALE' and order_item_id is not null do nothing;
    end loop;
  end if;
  perform set_config('lubricenter.inventory_lifecycle',v_prior,true);
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION lubricenter_private.staff_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_permission text;
 v_new jsonb;
 v_old jsonb;
begin
 if auth.uid() is null then
  if tg_op = 'DELETE' then return old; end if;
  return new;
 end if;
 if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
 if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
 v_permission := case tg_table_name
 when 'orders' then case
   when tg_op='INSERT' then 'orders.create'
   when tg_op='DELETE' then 'orders.cancel'
   when tg_op='UPDATE' and v_new->>'status' = 'CANCELLED'
        and (v_old->>'status') is distinct from (v_new->>'status') then 'orders.cancel'
   else 'orders.edit' end
 when 'order_items' then 'orders.edit'
 when 'payments' then 'payments.manage'
 when 'order_tenders' then 'payments.manage'
 when 'customers' then 'customers.manage'
 when 'vehicles' then 'customers.manage'
 when 'inventory_movements' then 'inventory.count'
 when 'products' then 'catalog.manage'
 when 'account_movements' then 'cash.manage'
 when 'cash_closings' then 'cash.close'
 when 'crm_manual_cases' then 'crm.manage'
 when 'payroll_adjustments' then 'payroll.manage'
 else null end;
 if tg_table_name='inventory_movements' and tg_op='INSERT' then
  if v_new->>'movement_type'='SALE' and current_setting('lubricenter.inventory_lifecycle',true)='SALE' then v_permission:='orders.edit';
  elsif v_new->>'movement_type'='RETURN' and current_setting('lubricenter.inventory_lifecycle',true)='RETURN' then v_permission:='orders.cancel'; end if;
 end if;
 if v_permission is not null and not lubricenter_private.staff_can(v_permission) then
  raise exception 'PERMISO_DENEGADO: %',v_permission using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $function$
;CREATE OR REPLACE FUNCTION public.add_catalog_product_item_override(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_manual_unit_ref numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stock_item uuid; v_linked uuid;
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
  v_stock_item:=lubricenter_private.catalog_stock_item(p_order_id,p_product_id);
  if v_stock_item is not null then
    v_linked:=public.add_inventory_product_item(p_order_id,v_stock_item,p_quantity,p_manual_unit_ref,'STORE');
    return v_linked;
  end if;
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
;
CREATE OR REPLACE FUNCTION public.add_product_item(p_order_id uuid, p_product_id uuid, p_quantity numeric, p_reveal_cash_price boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stock_item uuid; v_linked uuid;
  v_product public.products;
  v_bcv numeric; v_op numeric; v_step numeric; v_mode text;
  v_unit_ves numeric; v_unit_ref numeric; v_item_id uuid;
begin
  perform public.require_auth();
  perform public.assert_order_open(p_order_id);
  v_stock_item:=lubricenter_private.catalog_stock_item(p_order_id,p_product_id);
  if v_stock_item is not null then
    v_linked:=public.add_inventory_product_item(p_order_id,v_stock_item,p_quantity,null,'STORE');
    if p_reveal_cash_price then update public.order_items set cash_price_revealed=true,pricing_mode='CASH_USD_SPECIAL' where id=v_linked; end if;
    return v_linked;
  end if;
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
CREATE OR REPLACE FUNCTION lubricenter_private.guard_order_tender()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if tg_table_name='orders' then
  if new.status='CANCELLED' and old.status<>'CANCELLED' and exists(select 1 from public.order_tenders where order_id=old.id and (change_usd>0 or received<>applied)) then raise exception 'Esta venta tiene un cobro con vuelto documentado. Requiere devolución auditada antes de anular'; end if;
 elsif tg_table_name='account_movements' then
  if old.tender_id is not null then raise exception 'El movimiento pertenece a un cobro con vuelto documentado; requiere reversión auditada'; end if;
 elsif exists(select 1 from public.order_tenders where payment_id=old.id) then raise exception 'El cobro conserva dinero y vuelto documentados; no se puede borrar ni modificar con el editor anterior';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $function$
;

create or replace function lubricenter_private.order_integrity_audit()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; ceiling bigint;
begin
 perform lubricenter_private.require_order_admin();
 select greatest(last_number,(select coalesce(max(order_seq),0) from public.orders)) into ceiling from lubricenter_private.order_number_counter where singleton;
 with deleted as (
  select distinct on(data->>'order_number') (substring(data->>'order_number' from '[0-9]+'))::bigint n,data->>'reason' reason,created_at,actor_id
  from public.audit_events where event_type='ORDER_DELETED' and data->>'order_number' ~ '^OS-[0-9]+$' order by data->>'order_number',created_at desc
 ), sequence as (
  select s.n,coalesce(o.order_number,'OS-'||lpad(s.n::text,6,'0')) order_number,o.id order_id,o.status,o.created_at,o.opened_at,o.closed_at,
   case when o.id is not null then 'EXISTS' when d.n is not null then 'DELETED' when e.number is not null then e.classification else 'UNEXPLAINED' end classification,
   case when o.id is not null then coalesce(o.cancellation_reason,'Orden conservada en el sistema') when d.n is not null then d.reason when e.number is not null then e.explanation else 'No existe orden ni evidencia persistente suficiente para atribuir una causa. No equivale a una venta perdida comprobada.' end explanation,
   d.created_at deleted_at,d.actor_id deleted_by
  from generate_series(1,ceiling) s(n) left join public.orders o on o.order_seq=s.n left join deleted d on d.n=s.n left join lubricenter_private.order_number_explanations e on e.number=s.n
 ), ledger as (
  select i.id,i.order_id,i.quantity,o.order_number,o.status,coalesce(sum(m.quantity_delta) filter(where m.movement_type='SALE'),0) sale,
   coalesce(sum(m.quantity_delta) filter(where m.movement_type='RETURN'),0) returned,count(m.id) filter(where m.movement_type='SALE') sale_count,ii.sku
  from public.order_items i join public.orders o on o.id=i.order_id join public.inventory_items ii on ii.id=i.inventory_item_id
  left join public.inventory_movements m on m.order_item_id=i.id group by i.id,o.id,ii.id
 ) select jsonb_build_object(
  'generated_at',now(),'last_number',ceiling,
  'summary',(select jsonb_build_object('existing',count(*) filter(where classification='EXISTS'),'closed',count(*) filter(where status='CLOSED'),
   'open',count(*) filter(where status='OPEN'),'cancelled',count(*) filter(where status='CANCELLED'),'deleted',count(*) filter(where classification='DELETED'),
   'tests',count(*) filter(where classification='TEST_ROLLBACK_CONFIRMED'),'unexplained',count(*) filter(where classification='UNEXPLAINED')) from sequence),
  'sequence',(select coalesce(jsonb_agg(s order by n),'[]'::jsonb) from sequence s),
  'inventory_anomalies',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (select * from ledger where status='CLOSED' and (sale<>-quantity or returned<>0 or sale_count<>1) or status in ('OPEN','CANCELLED') and sale+returned<>0)x),
  'negative_stock',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (select ii.id,ii.sku,ii.description,ii.needs_review,l.code location,sum(m.quantity_delta) quantity,
   sum(m.quantity_delta) filter(where m.movement_type='OPENING_IMPORT') opening,min(m.created_at) first_movement
   from public.inventory_movements m join public.inventory_items ii on ii.id=m.inventory_item_id join public.locations l on l.id=m.location_id group by ii.id,l.id having sum(m.quantity_delta)<0)x),
  'untracked_items',(select coalesce(jsonb_agg(x order by order_number),'[]'::jsonb) from (select o.order_number,o.id order_id,i.id item_id,i.description,i.quantity,i.pricing_mode,
   (select count(*) from public.inventory_items ii where ii.product_id=i.product_id and ii.active) candidate_count,
   (select string_agg(ii.sku,', ' order by ii.sku) from public.inventory_items ii where ii.product_id=i.product_id and ii.active) candidate_skus
   from public.order_items i join public.orders o on o.id=i.order_id where o.status='CLOSED' and i.item_type='PRODUCT' and i.inventory_item_id is null)x),
  'deleted_payments',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
   select a.data->>'order_number' order_number,h.before_data->>'method' method,h.before_data->>'currency' currency,
    (h.before_data->>'amount_original')::numeric amount,h.before_data->>'paid_at' paid_at,h.recorded_at removed_at,a.created_at order_deleted_at,
    case when abs(extract(epoch from h.recorded_at-a.created_at))<1 then 'Coincide con la eliminación de la orden' else 'Pago retirado antes de eliminar la orden' end evidence,
    (select string_agg(o.order_number,', ' order by o.order_seq) from public.orders o where o.customer_id=(select (z.before_data->>'customer_id')::uuid from public.order_history z where z.order_id=h.order_id and z.entity_type='orders' and z.action='DELETE' order by z.recorded_at desc limit 1) and o.created_at>=a.created_at and o.created_at<a.created_at+interval '7 days') later_orders
   from public.order_history h join public.audit_events a on a.entity_id=h.order_id and a.event_type='ORDER_DELETED'
   where h.entity_type='payments' and h.action='DELETE' and not exists(select 1 from public.orders o where o.id=h.order_id)
  )x),
  'movements',(select coalesce(jsonb_agg(x order by created_at),'[]'::jsonb) from (select o.order_number,o.status,ii.sku,m.id,m.quantity_delta,m.movement_type,m.reversal_of,m.note,m.created_at,m.occurred_at
   from public.inventory_movements m join public.order_items i on i.id=m.order_item_id join public.orders o on o.id=i.order_id join public.inventory_items ii on ii.id=m.inventory_item_id where m.movement_type in ('SALE','RETURN'))x)
 ) into result;
 return result;
end $$;
revoke all on function lubricenter_private.order_integrity_audit() from public,anon;
grant execute on function lubricenter_private.order_integrity_audit() to authenticated;
create or replace function public.order_integrity_audit() returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.order_integrity_audit() $$;
revoke all on function public.order_integrity_audit() from public,anon;
grant execute on function public.order_integrity_audit() to authenticated;
revoke all on function lubricenter_private.prevent_order_erasure(),lubricenter_private.guard_inventory_ledger(),lubricenter_private.guard_order_lifecycle(),lubricenter_private.guard_stock_item_edits() from public,anon,authenticated;

-- Administrative order revisions, business dates and an append-only movement history.
create schema if not exists lubricenter_private;
revoke all on schema lubricenter_private from public, anon;
grant usage on schema lubricenter_private to authenticated;

alter table public.orders add column if not exists business_at timestamptz;
alter table public.orders add column if not exists corrects_order_id uuid references public.orders(id);
alter table public.orders add column if not exists cancellation_reason text;
alter table public.orders add column if not exists cancelled_at timestamptz;
create unique index if not exists orders_one_correction on public.orders(corrects_order_id) where corrects_order_id is not null;

create table public.order_history (
 id uuid primary key default gen_random_uuid(), order_id uuid not null,
 entity_type text not null, entity_id uuid, action text not null,
 before_data jsonb, after_data jsonb, reason text,
 actor_id uuid, actor_email text, recorded_at timestamptz not null default clock_timestamp()
);
create index order_history_order_time on public.order_history(order_id,recorded_at desc);
alter table public.order_history enable row level security;
grant select on public.order_history to authenticated;
revoke insert,update,delete,truncate on public.order_history from anon,authenticated;
create policy order_history_read on public.order_history for select to authenticated using ((select auth.uid()) is not null);

create function lubricenter_private.is_order_admin() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users where id=auth.uid() and lower(email)='lubricenterc@gmail.com' and email_confirmed_at is not null)
$$;
create function public.can_administer_orders() returns boolean language sql stable security invoker set search_path='' as $$ select lubricenter_private.is_order_admin() $$;
create function lubricenter_private.require_order_admin() returns void language plpgsql security definer set search_path='' as $$
begin
 if not lubricenter_private.is_order_admin() then raise exception 'Solo lubricenterc@gmail.com puede modificar o anular ventas cerradas'; end if;
end $$;

create function lubricenter_private.capture_order_history() returns trigger language plpgsql security definer set search_path='' as $$
declare b jsonb; a jsonb; d jsonb; oid uuid; actor text;
begin
 if TG_OP<>'INSERT' then b:=to_jsonb(old); end if;
 if TG_OP<>'DELETE' then a:=to_jsonb(new); end if;
 d:=coalesce(a,b);
 if TG_TABLE_NAME='orders' then oid:=(d->>'id')::uuid;
 elsif d ? 'order_id' then oid:=(d->>'order_id')::uuid;
 elsif TG_TABLE_NAME='inventory_movements' then select order_id into oid from public.order_items where id=(d->>'order_item_id')::uuid;
 elsif TG_TABLE_NAME='account_movements' then
  select order_id into oid from public.payments where id=(d->>'source_payment_id')::uuid;
  oid:=coalesce(oid,nullif(current_setting('lubricenter.order_id',true),'')::uuid);
 elsif TG_TABLE_NAME='payroll_accruals' then select order_id into oid from public.order_items where id=(d->>'source_order_item_id')::uuid;
 elsif TG_TABLE_NAME='cashea_installments' then select order_id into oid from public.cashea_sales where id=(d->>'cashea_sale_id')::uuid;
 else oid:=nullif(current_setting('lubricenter.order_id',true),'')::uuid;
 end if;
 if oid is not null and a is distinct from b then
  select email into actor from auth.users where id=auth.uid();
  insert into public.order_history(order_id,entity_type,entity_id,action,before_data,after_data,reason,actor_id,actor_email)
  values(oid,TG_TABLE_NAME,(d->>'id')::uuid,TG_OP,b,a,nullif(current_setting('lubricenter.reason',true),''),auth.uid(),actor);
 end if;
 return coalesce(new,old);
end $$;
do $$ declare t text; begin
 foreach t in array array['orders','order_items','payments','inventory_movements','account_movements','payroll_accruals','payroll_adjustments','receivables','cashea_sales','cashea_installments','customer_followups'] loop
 execute format('create trigger audit_order_movement after insert or update or delete on public.%I for each row execute function lubricenter_private.capture_order_history()',t);
 end loop;
end $$;
create function lubricenter_private.immutable_history() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'El historial de movimientos no se puede modificar ni borrar'; end $$;
create trigger immutable_history before update or delete or truncate on public.order_history for each statement execute function lubricenter_private.immutable_history();

create function lubricenter_private.guard_closed_edits() returns trigger language plpgsql security definer set search_path='' as $$
declare oid uuid; s text;
begin
 if TG_TABLE_NAME='orders' then s:=old.status;
 else oid:=coalesce(new.order_id,old.order_id); select status into s from public.orders where id=oid for update;
 end if;
 if s in ('CLOSED','CANCELLED') then perform lubricenter_private.require_order_admin(); end if;
 return coalesce(new,old);
end $$;
create trigger guard_closed_edits before update or delete on public.orders for each row execute function lubricenter_private.guard_closed_edits();
create trigger guard_closed_edits before insert or update or delete on public.order_items for each row execute function lubricenter_private.guard_closed_edits();
create trigger guard_closed_edits before update or delete on public.payments for each row execute function lubricenter_private.guard_closed_edits();

create function lubricenter_private.apply_business_date() returns trigger language plpgsql security definer set search_path='' as $$
declare d timestamptz; s text;
begin
 if TG_TABLE_NAME='orders' then
  if TG_OP='INSERT' then
   new.business_at:=coalesce(new.business_at,nullif(current_setting('lubricenter.business_at',true),'')::timestamptz);
   if new.business_at is not null then new.opened_at:=new.business_at; end if;
  end if;
  if new.business_at>now()+interval '5 minutes' then raise exception 'La fecha de venta no puede estar en el futuro'; end if;
  if new.status='CLOSED' and new.business_at is not null then new.closed_at:=new.business_at; end if;
 elsif TG_TABLE_NAME='payments' then
  select business_at,status into d,s from public.orders where id=new.order_id;
  if s='OPEN' and d is not null and coalesce(current_setting('lubricenter.revision',true),'')<>'yes' then new.paid_at:=d; end if;
 elsif TG_TABLE_NAME='payroll_accruals' then
  select coalesce(o.business_at,o.closed_at),o.corrects_order_id::text into d,s from public.orders o join public.order_items i on i.order_id=o.id where i.id=new.source_order_item_id;
  if s is null and d is not null then new.occurred_at:=d; end if;
 end if;
 return new;
end $$;
create trigger aa_business_date before insert or update on public.orders for each row execute function lubricenter_private.apply_business_date();
create trigger aa_business_date before insert on public.payments for each row execute function lubricenter_private.apply_business_date();
create trigger aa_business_date before insert on public.payroll_accruals for each row execute function lubricenter_private.apply_business_date();

create function lubricenter_private.set_order_date(p_order_id uuid,p_business_at timestamptz) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.require_auth(); perform public.assert_order_open(p_order_id);
 if p_business_at is null or p_business_at>now()+interval '5 minutes' then raise exception 'Indica la fecha real de la venta, sin fechas futuras'; end if;
 perform set_config('lubricenter.reason','Fecha de venta indicada por el usuario',true);
 update public.orders set business_at=p_business_at,opened_at=p_business_at where id=p_order_id;
 update public.payments set paid_at=p_business_at where order_id=p_order_id;
 update public.account_movements set occurred_at=p_business_at where source_payment_id in (select id from public.payments where order_id=p_order_id);
end $$;
create function public.set_order_date(p_order_id uuid,p_business_at timestamptz) returns void language sql security invoker set search_path='' as $$ select lubricenter_private.set_order_date(p_order_id,p_business_at) $$;
create function lubricenter_private.create_order_dated(p_business_at timestamptz default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; begin
 perform public.require_auth(); perform set_config('lubricenter.business_at',coalesce(p_business_at::text,''),true);
 select * into r from public.create_order(); return to_jsonb(r);
end $$;
create function public.create_order_dated(p_business_at timestamptz default null) returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.create_order_dated(p_business_at) $$;

create function lubricenter_private.quick_sale_dated(p_items jsonb,p_mode text,p_business_at timestamptz default null,p_method text default 'MOBILE_PAYMENT',p_reference text default null,p_initial_percent numeric default 40,p_cashea_reference text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; d date; begin
 perform public.require_auth(); perform set_config('lubricenter.business_at',coalesce(p_business_at::text,''),true);
 if p_mode='DIRECT' then select * into r from public.complete_quick_sale(p_items,p_method,p_reference);
 elsif p_mode='CASHEA' then
  select * into r from public.complete_quick_sale_cashea(p_items,p_initial_percent,p_method,p_reference,p_cashea_reference);
  d:=(coalesce(p_business_at,now()) at time zone 'America/Caracas')::date;
  update public.cashea_installments set due_date=d+installment_no*14 where cashea_sale_id=r.cashea_sale_id;
 elsif p_mode='DRAFT' then select * into r from public.build_quick_sale_order(p_items);
 else raise exception 'Tipo de venta inválido'; end if;
 return to_jsonb(r);
end $$;
create function public.quick_sale_dated(p_items jsonb,p_mode text,p_business_at timestamptz default null,p_method text default 'MOBILE_PAYMENT',p_reference text default null,p_initial_percent numeric default 40,p_cashea_reference text default null) returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.quick_sale_dated(p_items,p_mode,p_business_at,p_method,p_reference,p_initial_percent,p_cashea_reference) $$;

create function lubricenter_private.cancel_order(p_order_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
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
 for m in select im.* from public.inventory_movements im join public.order_items i on i.id=im.order_item_id where i.order_id=p_order_id and im.movement_type='SALE' loop
  insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,order_item_id,note)
  values(m.inventory_item_id,m.location_id,-m.quantity_delta,'RETURN',m.order_item_id,'Anulación '||o.order_number||': '||p_reason);
 end loop;
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
end $$;
create function public.cancel_order(p_order_id uuid,p_reason text) returns void language sql security invoker set search_path='' as $$ select lubricenter_private.cancel_order(p_order_id,p_reason) $$;

-- All entries are server-derived snapshots. The client can edit only these explicit fields.
create function lubricenter_private.correct_closed_order(p_order_id uuid,p_reason text,p_business_at timestamptz,p_items jsonb,p_payments jsonb,p_customer_id uuid,p_vehicle_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.orders; n uuid; i public.order_items; ni public.order_items; p public.payments; np public.payments;
 x jsonb; q numeric; u numeric; ratio numeric; tv numeric; tr numeric; pv numeric; initial_paid numeric;
 cs public.cashea_sales; ns public.cashea_sales; ci public.cashea_installments; ci_id uuid; instmap jsonb:='{}';
 lc public.receivables; new_lc uuid; inst_id uuid; new_sale uuid; part numeric; amount numeric; fin numeric; paidinst numeric;
begin
 perform lubricenter_private.require_order_admin();
 select * into o from public.orders where id=p_order_id for update;
 if not found then raise exception 'Orden no encontrada'; end if;
 if o.status='CANCELLED' then
  select id into n from public.orders where corrects_order_id=p_order_id;
  if n is not null then return n; end if;
 end if;
 if o.status<>'CLOSED' then raise exception 'Solo se corrigen ventas cerradas'; end if;
 if p_business_at is null or p_business_at>now()+interval '5 minutes' then raise exception 'Indica la fecha real de la venta'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'La corrección necesita al menos una línea. Si no hubo venta, usa Anular'; end if;
 if jsonb_typeof(p_payments)<>'array' then raise exception 'Revisa los pagos'; end if;
 if p_vehicle_id is not null and not exists(select 1 from public.vehicles where id=p_vehicle_id and customer_id=p_customer_id) then raise exception 'El vehículo no pertenece al cliente seleccionado'; end if;
 perform 1 from public.cashea_installments where cashea_sale_id in(select id from public.cashea_sales where order_id=p_order_id) order by id for update;
 select * into cs from public.cashea_sales where order_id=p_order_id for update;
 select * into lc from public.receivables where order_id=p_order_id for update;
 perform lubricenter_private.cancel_order(p_order_id,p_reason);
 perform set_config('lubricenter.revision','yes',true);
 insert into public.orders(customer_id,vehicle_id,location_id,business_at,corrects_order_id,health_status,health_notes,health_reviewed_at,crm_additional_services,crm_bonuses,crm_observations)
 values(p_customer_id,p_vehicle_id,o.location_id,p_business_at,o.id,o.health_status,o.health_notes,o.health_reviewed_at,o.crm_additional_services,o.crm_bonuses,o.crm_observations) returning id into n;
 perform set_config('lubricenter.order_id',n::text,true);
 if (select count(*) from jsonb_array_elements(p_items))<>(select count(distinct value->>'source_id') from jsonb_array_elements(p_items)) then raise exception 'Hay líneas duplicadas en la corrección'; end if;
 for x in select value from jsonb_array_elements(p_items) loop
  select * into i from public.order_items where id=(x->>'source_id')::uuid and order_id=o.id;
  if not found then raise exception 'Una línea no pertenece a la venta original'; end if;
  q:=(x->>'quantity')::numeric; u:=(x->>'unit_ref')::numeric;
  if q is null or q<=0 or u is null or u<0 or q::text in ('NaN','Infinity','-Infinity') or u::text in ('NaN','Infinity','-Infinity') then raise exception 'Cantidad o precio inválido'; end if;
  ni:=i; ni.id:=gen_random_uuid(); ni.order_id:=n; ni.created_at:=now(); ni.quantity:=q; ni.description:=trim(x->>'description');
  if coalesce(ni.description,'')='' then raise exception 'Escribe la descripción de cada línea'; end if;
  if abs(q-i.quantity)>0.000001 or abs(u-i.charged_ref_amount/i.quantity)>0.000001 then
   ni.charged_ref_amount:=round(q*u,4); ni.charged_ves_amount:=round(ni.charged_ref_amount*i.bcv_rate_snapshot,2);
   ni.customer_ref_amount:=ni.charged_ref_amount; ni.base_ref_amount:=ni.charged_ref_amount;
   ni.pricing_mode:=case when i.pricing_mode='MANUAL_NO_STOCK' then i.pricing_mode else 'MANUAL_OVERRIDE' end;
   ni.cash_usd_special_total:=null; ni.cash_price_revealed:=false;
   ratio:=case when i.charged_ref_amount>0 then ni.charged_ref_amount/i.charged_ref_amount else q/i.quantity end;
   ni.worker_share_ref_snapshot:=round(i.worker_share_ref_snapshot*ratio,4); ni.assistant_bonus_ref_snapshot:=round(i.assistant_bonus_ref_snapshot*ratio,4);
  end if;
  insert into public.order_items select ni.*;
 end loop;
 select sum(charged_ves_amount),sum(charged_ref_amount) into tv,tr from public.order_items where order_id=n;
 if tv<=0 then raise exception 'El total debe ser mayor que cero'; end if;
 if cs.id is not null then
  ns:=cs; ns.id:=gen_random_uuid(); ns.order_id:=n; ns.created_at:=now(); ns.created_by:=auth.uid(); ns.receivable_id:=null;
  ns.gross_ref:=tr; ns.gross_ves_snapshot:=tv; ns.initial_ref:=round(tr*cs.initial_percent/100,4); ns.initial_ves_snapshot:=round(ns.initial_ref*cs.bcv_rate_snapshot,2);
  ns.financed_ref:=tr-ns.initial_ref; ns.commission_ref:=round(tr*cs.commission_percent/100,4); ns.commission_ves_snapshot:=round(ns.commission_ref*cs.bcv_rate_snapshot,2);
  ns.status:='ACTIVE'; ns.settled_at:=null; insert into public.cashea_sales select ns.*; new_sale:=ns.id;
  part:=round(ns.financed_ref/3,4);
  for ci in select * from public.cashea_installments where cashea_sale_id=cs.id order by installment_no loop
   amount:=case when ci.installment_no=3 then ns.financed_ref-2*part else part end;
   if amount+0.0001<ci.paid_ref then raise exception 'La cuota % ya recibió REF %. No puedes reducirla por debajo de ese pago',ci.installment_no,ci.paid_ref; end if;
   ci_id:=gen_random_uuid(); instmap:=instmap||jsonb_build_object(ci.id::text,ci_id);
   insert into public.cashea_installments(id,cashea_sale_id,installment_no,due_date,amount_ref,amount_ves_snapshot,paid_ref,paid_ves_actual,status,paid_at)
   values(ci_id,new_sale,ci.installment_no,(p_business_at at time zone 'America/Caracas')::date+ci.installment_no*14,amount,round(amount*cs.bcv_rate_snapshot,2),ci.paid_ref,ci.paid_ves_actual,case when amount-ci.paid_ref<=0.05 then 'PAID' when ci.paid_ref>0 then 'PARTIAL' else 'PENDING' end,ci.paid_at);
  end loop;
 end if;
 if (select count(*) from jsonb_array_elements(p_payments))<>(select count(distinct value->>'source_id') from jsonb_array_elements(p_payments)) then raise exception 'Hay pagos duplicados'; end if;
 initial_paid:=0;
 for x in select value from jsonb_array_elements(p_payments) loop
  select * into p from public.payments where id=(x->>'source_id')::uuid and order_id=o.id;
  if not found then raise exception 'Un pago no pertenece a la venta original'; end if;
  select entity_id into inst_id from public.audit_events where event_type='cashea.installment_payment_recorded' and data->>'payment_id'=p.id::text limit 1;
  if inst_id is not null and ((x->>'method') is distinct from p.method or (x->>'amount_original')::numeric<>p.amount_original) then raise exception 'Los pagos de cuotas Cashea se conservan: corrige la inicial, no una cuota ya recibida'; end if;
  np:=p; np.id:=gen_random_uuid(); np.order_id:=n; np.receivable_id:=null; np.created_at:=now(); np.created_by:=auth.uid();
  np.method:=x->>'method'; np.amount_original:=(x->>'amount_original')::numeric; np.reference:=nullif(trim(x->>'reference'),'');
  if np.amount_original is null or np.amount_original<=0 or np.amount_original::text in ('NaN','Infinity','-Infinity') then raise exception 'Monto de pago inválido'; end if;
  if np.method<>p.method or np.amount_original<>p.amount_original then
   np.currency:=case when np.method='CASH_USD' then 'USD' else 'VES' end;
   np.financial_account_id:=null;
   np.value_ves:=case when np.currency='USD' then round(np.amount_original*case when cs.id is not null then p.bcv_rate_snapshot else p.operative_rate_snapshot end,2) else np.amount_original end;
   np.value_ref:=round(np.value_ves/p.bcv_rate_snapshot,4);
  end if;
  if inst_id is null and p.receivable_id is null then np.paid_at:=p_business_at; end if;
  insert into public.payments select np.*;
  if inst_id is not null then
   if instmap->>inst_id::text is null then raise exception 'No se encontró la cuota original del pago'; end if;
   insert into public.audit_events(event_type,entity_type,entity_id,data) values('cashea.installment_payment_recorded','cashea_installment',(instmap->>inst_id::text)::uuid,jsonb_build_object('payment_id',np.id,'copied_from_payment_id',p.id,'value_ref',np.value_ref));
  else initial_paid:=initial_paid+np.value_ves; end if;
 end loop;
 if exists(select 1 from public.payments pay join public.audit_events a on a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=pay.id::text where pay.order_id=o.id and not exists(select 1 from jsonb_array_elements(p_payments) element where element.value->>'source_id'=pay.id::text)) then raise exception 'Conserva todos los pagos de cuotas Cashea ya recibidas'; end if;
 select coalesce(sum(value_ves),0) into pv from public.payments where order_id=n;
 if cs.id is null then
  if lc.id is not null then perform public.close_order_with_credit(n,lc.due_date); else perform public.close_order(n); end if;
 else
  if abs(initial_paid-ns.initial_ves_snapshot)>1 then raise exception 'Ajusta los pagos de la inicial a Bs % (inicial original de % por ciento)',ns.initial_ves_snapshot,cs.initial_percent; end if;
  perform public.validate_order_ready_to_close(n);
  update public.orders set status='CLOSED',closed_at=p_business_at,total_ves=tv,total_ref=tr,total_cash_usd_equivalent=(select sum(charged_ves_amount/operative_rate_snapshot) from public.order_items where order_id=n) where id=n;
  for i in select * from public.order_items where order_id=n loop
   if i.business_area in ('WORKSHOP','ELECTROAUTO') and coalesce(i.worker_share_ref_snapshot,0)>0 then insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description) values(i.worker_employee_id,i.id,case when i.business_area='WORKSHOP' then 'WORKSHOP_COMMISSION' else 'ELECTROAUTO_COMMISSION' end,i.worker_share_ref_snapshot,'Corrección · '||i.description); end if;
   if i.business_area='WORKSHOP' and coalesce(i.assistant_bonus_ref_snapshot,0)>0 then insert into public.payroll_accruals(employee_id,source_order_item_id,source_type,amount_ref,description) values(i.assistant_bonus_employee_id,i.id,'ASSISTANT_BONUS',i.assistant_bonus_ref_snapshot,'Corrección · '||i.description); end if;
  end loop;
  select coalesce(sum(greatest(amount_ref-paid_ref,0)),0) into fin from public.cashea_installments where cashea_sale_id=new_sale;
  update public.cashea_sales set status=case when fin<=0.05 then 'SETTLED' else 'ACTIVE' end,settled_at=case when fin<=0.05 then now() end where id=new_sale;
 end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('order.corrected','order',o.id,jsonb_build_object('replacement_order_id',n,'reason',p_reason));
 return n;
end $$;
create function public.correct_closed_order(p_order_id uuid,p_reason text,p_business_at timestamptz,p_items jsonb,p_payments jsonb,p_customer_id uuid,p_vehicle_id uuid) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.correct_closed_order(p_order_id,p_reason,p_business_at,p_items,p_payments,p_customer_id,p_vehicle_id) $$;

create function public.search_order_admin(p_query text default '',p_status text default 'ALL',p_from date default null,p_to date default null,p_page integer default 0) returns jsonb language sql stable security invoker set search_path='' as $$
 with rows as (
  select o.id,o.order_number,o.status,coalesce(o.business_at,o.closed_at,o.opened_at) sale_at,o.created_at,o.corrects_order_id,o.cancellation_reason,
   c.name customer_name,v.plate,
   case when exists(select 1 from public.order_items i where i.order_id=o.id and i.item_type='SERVICE') then 'Orden de servicio' else 'Venta' end kind,
   (select coalesce(sum(charged_ref_amount),0) from public.order_items i where i.order_id=o.id) total_ref,
   (select coalesce(sum(charged_ves_amount),0) from public.order_items i where i.order_id=o.id) total_ves,
   case when cs.id is not null then 'Cashea' when r.id is not null then 'Crédito LC' else 'Contado / mixto' end payment_type
  from public.orders o left join public.customers c on c.id=o.customer_id left join public.vehicles v on v.id=o.vehicle_id
  left join public.cashea_sales cs on cs.order_id=o.id left join public.receivables r on r.order_id=o.id
  where (p_status='ALL' or o.status=p_status)
   and (p_from is null or coalesce(o.business_at,o.closed_at,o.opened_at)>=(p_from::timestamp at time zone 'America/Caracas'))
   and (p_to is null or coalesce(o.business_at,o.closed_at,o.opened_at)<((p_to+1)::timestamp at time zone 'America/Caracas'))
   and (trim(p_query)='' or concat_ws(' ',o.order_number,c.name,c.phone,v.plate,v.make,v.model) ilike '%'||trim(p_query)||'%')
 ) select jsonb_build_object('count',(select count(*) from rows),'rows',coalesce((select jsonb_agg(r) from (select * from rows order by sale_at desc,id limit 30 offset greatest(p_page,0)*30) r),'[]'::jsonb))
$$;

create function public.order_installment_payment_ids(p_order_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(p.id),'[]'::jsonb) from public.payments p where p.order_id=p_order_id and exists(select 1 from public.audit_events a where a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=p.id::text)
$$;

-- Expose only invoker wrappers; private helpers still perform authoritative checks.
do $$ declare r record; begin
 for r in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='lubricenter_private' or (n.nspname='public' and p.proname in ('can_administer_orders','set_order_date','create_order_dated','quick_sale_dated','cancel_order','correct_closed_order','search_order_admin','order_installment_payment_ids')) loop
  execute format('revoke all on function %I.%I(%s) from public,anon',r.nspname,r.proname,r.args);
  if r.proname not in ('capture_order_history','immutable_history','guard_closed_edits','apply_business_date') then execute format('grant execute on function %I.%I(%s) to authenticated',r.nspname,r.proname,r.args); end if;
 end loop;
end $$;



-- Use the existing internal-app authorization model without exposing a definer through the Data API.
create schema if not exists lubricenter_private;
revoke all on schema lubricenter_private from public, anon;
grant usage on schema lubricenter_private to authenticated;

create or replace function lubricenter_private.close_order_cashea(
  p_order_id uuid, p_initial_percent numeric, p_initial_payment_method text,
  p_payment_reference text default null, p_cashea_reference text default null,
  p_expected_total_ves numeric default null, p_expected_total_ref numeric default null, p_expected_bcv numeric default null
) returns uuid language plpgsql security definer set search_path = '' as $$
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
  select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates;
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
end $$;
revoke all on function lubricenter_private.close_order_cashea(uuid,numeric,text,text,text,numeric,numeric,numeric) from public,anon;
grant execute on function lubricenter_private.close_order_cashea(uuid,numeric,text,text,text,numeric,numeric,numeric) to authenticated;
create or replace function public.close_order_cashea(p_order_id uuid,p_initial_percent numeric,p_initial_payment_method text,p_payment_reference text default null,p_cashea_reference text default null,p_expected_total_ves numeric default null,p_expected_total_ref numeric default null, p_expected_bcv numeric default null)
returns uuid language sql security invoker set search_path='' as $$
  select lubricenter_private.close_order_cashea(p_order_id,p_initial_percent,p_initial_payment_method,p_payment_reference,p_cashea_reference,p_expected_total_ves,p_expected_total_ref,p_expected_bcv);
$$;
revoke all on function public.close_order_cashea(uuid,numeric,text,text,text,numeric,numeric,numeric) from public,anon;
grant execute on function public.close_order_cashea(uuid,numeric,text,text,text,numeric,numeric,numeric) to authenticated;



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
    (select coalesce(sum(value_ves),0) from public.payments where exists(select 1 from public.orders o where o.id=payments.order_id and o.status<>'CANCELLED') and (paid_at at time zone 'America/Caracas')::date=v_today),
    (select coalesce(sum(value_ref),0) from public.payments where exists(select 1 from public.orders o where o.id=payments.order_id and o.status<>'CANCELLED') and (paid_at at time zone 'America/Caracas')::date=v_today),
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
create or replace view public.maintenance_reminders_current with (security_invoker=true) as  WITH latest AS (
         SELECT DISTINCT ON (sr.vehicle_id) sr.id AS service_record_id,
            sr.vehicle_id,
            sr.customer_id,
            sr.performed_at,
            sr.odometer,
            sr.oil_brand,
            sr.oil_viscosity,
            sr.oil_filter_code,
            sr.next_service_odometer,
            sr.next_service_date,
            sr.description
           FROM service_records sr
          WHERE (sr.service_type = 'OIL_CHANGE'::text) AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id=sr.order_id AND o.status='CANCELLED')
          ORDER BY sr.vehicle_id, sr.performed_at DESC, sr.created_at DESC
        ), cutoff AS (
         SELECT COALESCE(( SELECT (TRIM(BOTH '"'::text FROM (app_settings.value)::text))::date AS btrim
                   FROM app_settings
                  WHERE (app_settings.key = 'crm_operational_start_date'::text)), '2026-09-10'::date) AS start_date
        )
 SELECT l.service_record_id,
    l.vehicle_id,
    l.customer_id,
    c.name AS customer_name,
    c.phone AS customer_phone,
    v.plate,
    v.make,
    v.model,
    v.year,
    v.current_odometer,
    l.performed_at,
    l.odometer AS service_odometer,
    l.oil_brand,
    l.oil_viscosity,
    l.oil_filter_code,
    l.next_service_odometer,
    l.next_service_date,
        CASE
            WHEN (a.status IS NOT NULL) THEN a.status
            WHEN ((l.next_service_date IS NOT NULL) AND (l.next_service_date < cutoff.start_date)) THEN 'SENT'::text
            ELSE 'PENDING'::text
        END AS reminder_status,
    a.snoozed_until,
        CASE
            WHEN (a.sent_at IS NOT NULL) THEN a.sent_at
            WHEN ((a.status IS NULL) AND (l.next_service_date IS NOT NULL) AND (l.next_service_date < cutoff.start_date)) THEN (l.next_service_date)::timestamp with time zone
            ELSE NULL::timestamp with time zone
        END AS sent_at,
        CASE
            WHEN (a.status = 'SENT'::text) THEN 'SENT'::text
            WHEN ((a.status IS NULL) AND (l.next_service_date IS NOT NULL) AND (l.next_service_date < cutoff.start_date)) THEN 'SENT'::text
            WHEN ((a.status = 'SNOOZED'::text) AND (a.snoozed_until > CURRENT_DATE)) THEN 'SNOOZED'::text
            WHEN ((l.next_service_date IS NOT NULL) AND (l.next_service_date <= CURRENT_DATE)) THEN 'DUE'::text
            WHEN ((l.next_service_odometer IS NOT NULL) AND (v.current_odometer IS NOT NULL) AND (v.current_odometer >= l.next_service_odometer)) THEN 'DUE'::text
            WHEN ((l.next_service_date IS NOT NULL) AND (l.next_service_date <= (CURRENT_DATE + 14))) THEN 'SOON'::text
            ELSE 'UPCOMING'::text
        END AS urgency
   FROM ((((latest l
     JOIN vehicles v ON ((v.id = l.vehicle_id)))
     LEFT JOIN customers c ON ((c.id = COALESCE(l.customer_id, v.customer_id))))
     LEFT JOIN maintenance_reminder_actions a ON ((a.service_record_id = l.service_record_id)))
     CROSS JOIN cutoff);



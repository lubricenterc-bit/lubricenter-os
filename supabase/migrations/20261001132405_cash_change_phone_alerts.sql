-- Tender, sale coverage and change are different facts. No historical rewrite.
create table public.order_tenders (
 id uuid primary key, order_id uuid not null references public.orders(id) on delete restrict,
 payment_id uuid not null unique references public.payments(id) on delete restrict,
 customer_id uuid references public.customers(id), customer_label text,
 method text not null, currency text not null check(currency in ('USD','VES')),
 received numeric(18,2) not null check(received>0 and received<'Infinity'::numeric),
 applied numeric(18,2) not null check(applied>0 and applied<=received),
 payment_rate numeric(18,6) not null check(payment_rate>0 and payment_rate<'Infinity'::numeric),
 change_usd numeric(18,2) not null check(change_usd>=0 and change_usd<'Infinity'::numeric),
 returned_usd numeric(18,2) not null default 0 check(returned_usd>=0 and returned_usd<=change_usd),
 change_rate numeric(18,6) not null check(change_rate>0 and change_rate<'Infinity'::numeric),
 rounding_ves numeric(18,2) not null default 0 check(rounding_ves::text not in ('NaN','Infinity','-Infinity')),
 request_payload jsonb not null, created_at timestamptz not null default now(), created_by uuid default auth.uid(),
 check(change_usd=0 or customer_id is not null or length(trim(customer_label))>=3)
);
create table public.order_change_returns (
 id uuid primary key, tender_id uuid not null references public.order_tenders(id) on delete restrict,
 currency text not null check(currency in ('USD','VES')), amount_usd numeric(18,2) not null check(amount_usd>0 and amount_usd<'Infinity'::numeric),
 amount_original numeric(18,2) not null check(amount_original>0 and amount_original<'Infinity'::numeric),
 rate numeric(18,6) not null check(rate>0 and rate<'Infinity'::numeric),
 movement_id uuid not null references public.account_movements(id) on delete restrict,
 note text not null, request_payload jsonb not null, created_at timestamptz not null default now(), created_by uuid default auth.uid()
);
alter table public.order_tenders enable row level security;
alter table public.order_change_returns enable row level security;
create policy tender_read on public.order_tenders for select to authenticated using(auth.uid() is not null);
create policy change_read on public.order_change_returns for select to authenticated using(auth.uid() is not null);
grant select on public.order_tenders,public.order_change_returns to authenticated;
alter table public.account_movements add column tender_id uuid references public.order_tenders(id) on delete restrict;
create trigger finance_audit after insert or update on public.order_tenders for each row execute function lubricenter_private.finance_audit();
create trigger finance_audit after insert on public.order_change_returns for each row execute function lubricenter_private.finance_audit();
create function public.order_change_history(p_order uuid default null,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_offset is null or p_offset<0 then raise exception 'Página inválida'; end if;
 return jsonb_build_object(
  'total',(select count(*) from public.order_tenders where p_order is null or order_id=p_order),
  'pending_usd',(select coalesce(sum(change_usd-returned_usd),0) from public.order_tenders where p_order is null or order_id=p_order),
  'rows',coalesce((select jsonb_agg(to_jsonb(t)) from (select id,order_id,customer_label,currency,received,applied,change_usd,returned_usd,change_rate,rounding_ves from public.order_tenders where p_order is null or order_id=p_order order by (change_usd>returned_usd) desc,created_at desc,id limit 20 offset p_offset)t),'[]'::jsonb)
 );
end $$;
revoke all on function public.order_change_history(uuid,integer) from public,anon;
grant execute on function public.order_change_history(uuid,integer) to authenticated;

create function lubricenter_private.return_order_change(p_request uuid,p_tender uuid,p_usd numeric,p_currency text,p_rate numeric,p_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.order_tenders; r public.order_change_returns; a uuid; m uuid; amount numeric; payload jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 payload:=jsonb_build_array(p_tender,p_usd,p_currency,p_rate,p_note);
 if p_request is null then raise exception 'Falta el identificador del cobro'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into r from public.order_change_returns where id=p_request;
 if found then
  if r.request_payload<>payload then raise exception 'Solicitud reutilizada con otros datos'; end if;
  return r.id;
 end if;
 perform pg_advisory_xact_lock(220033);
 select * into t from public.order_tenders where id=p_tender for update;
 if not found then raise exception 'Vuelto no encontrado'; end if;
 if p_usd is null or p_usd<=0 or p_usd>t.change_usd-t.returned_usd or round(p_usd,2)<>p_usd or p_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'Monto superior al vuelto pendiente o inválido'; end if;
 if p_currency is null or p_currency not in ('USD','VES') or p_rate is null or p_rate<=0 or p_rate::text in ('NaN','Infinity','-Infinity') or round(p_rate,6)<>p_rate then raise exception 'Moneda o tasa inválida'; end if;
 if length(trim(coalesce(p_note,'')))<3 then raise exception 'Confirma la entrega del vuelto con una nota'; end if;
 select id into a from public.financial_accounts where code=case when p_currency='USD' then 'CASH_USD' else 'CASH_VES' end and active and currency=p_currency and account_type='CASH';
 if a is null then raise exception 'Configura la caja de la moneda que vas a entregar'; end if;
 amount:=case when p_currency='USD' then p_usd else round(p_usd*p_rate,2) end;
 if amount<=0 then raise exception 'El vuelto redondea a cero; usa otra moneda'; end if;
 insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,finance_nature,finance_request_id,tender_id)
 values(a,'OUT','ADJUSTMENT',p_currency,amount,case when p_currency='USD' then round(amount*p_rate,2) else amount end,'Vuelto',p_note,'REFUND',p_request,t.id) returning id into m;
 insert into public.order_change_returns(id,tender_id,currency,amount_usd,amount_original,rate,movement_id,note,request_payload)
 values(p_request,t.id,p_currency,p_usd,amount,p_rate,m,p_note,payload);
 update public.order_tenders set returned_usd=returned_usd+p_usd where id=t.id;
 return p_request;
end $$;
create function public.return_order_change(p_request uuid,p_tender uuid,p_usd numeric,p_currency text,p_rate numeric,p_note text) returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.return_order_change(p_request,p_tender,p_usd,p_currency,p_rate,p_note)
$$;

create function lubricenter_private.collect_order_tender(p_request uuid,p_order uuid,p_method text,p_received numeric,p_return_usd numeric,p_return_currency text,p_change_rate numeric,p_reference text default null,p_customer_label text default null) returns uuid
language plpgsql security definer set search_path='' as $$
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
 select bcv_rate,public.order_usd_rate(p_order) into b,rate from public.current_exchange_rates;
 if b is null or b<=0 or rate is null or rate<=0 then raise exception 'Faltan tasas para cobrar'; end if;
 currency:=case when p_method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
 select coalesce(sum(charged_ves_amount),0)-(select coalesce(sum(value_ves),0) from public.payments where order_id=p_order) into remaining from public.order_items where order_id=p_order;
 if remaining<=0 then raise exception 'La orden ya está cubierta'; end if;
 -- Round the commercial USD amount once. Covered Bs are bounded to the sale,
 -- including the unavoidable sub-cent equivalence difference.
 select bool_and(price_denomination='USD') into fixed_usd from public.order_items where order_id=p_order;
 due:=case when currency='USD' then round(remaining/rate,2) when fixed_usd then round(remaining/rate*p_change_rate,2) else round(remaining,2) end;
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
end $$;
create function public.collect_order_tender(p_request uuid,p_order uuid,p_method text,p_received numeric,p_return_usd numeric,p_return_currency text,p_change_rate numeric,p_reference text default null,p_customer_label text default null) returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.collect_order_tender(p_request,p_order,p_method,p_received,p_return_usd,p_return_currency,p_change_rate,p_reference,p_customer_label)
$$;

-- Never let legacy deletion/correction silently erase a cash return or liability.
create function lubricenter_private.guard_order_tender() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='orders' then
  if new.status='CANCELLED' and old.status<>'CANCELLED' and exists(select 1 from public.order_tenders where order_id=old.id) then raise exception 'Esta venta tiene un cobro con vuelto documentado. Requiere devolución auditada antes de anular'; end if;
 elsif tg_table_name='account_movements' then
  if old.tender_id is not null then raise exception 'El movimiento pertenece a un cobro con vuelto documentado; requiere reversión auditada'; end if;
 elsif exists(select 1 from public.order_tenders where payment_id=old.id) then raise exception 'El cobro conserva dinero y vuelto documentados; no se puede borrar ni modificar con el editor anterior';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger guard_order_tender before update or delete on public.payments for each row execute function lubricenter_private.guard_order_tender();
create trigger guard_tender_cancellation before update of status on public.orders for each row execute function lubricenter_private.guard_order_tender();
create trigger guard_tender_movement before update or delete on public.account_movements for each row execute function lubricenter_private.guard_order_tender();

create table public.quick_tender_requests(id uuid primary key, payload jsonb not null, result jsonb not null,created_at timestamptz not null default now());
alter table public.quick_tender_requests enable row level security;
create function public.quick_sale_with_tender(p_request uuid,p_items jsonb,p_method text,p_received numeric,p_return_usd numeric,p_return_currency text,p_change_rate numeric,p_reference text default null,p_customer_label text default null,p_business_at timestamptz default null,p_agreed_usd numeric default null) returns jsonb
language plpgsql security definer set search_path='' as $$
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
  select bcv_rate,operative_rate into b,op from public.current_exchange_rates;
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
end $$;
revoke all on function public.quick_sale_with_tender(uuid,jsonb,text,numeric,numeric,text,numeric,text,text,timestamptz,numeric) from public,anon;
grant execute on function public.quick_sale_with_tender(uuid,jsonb,text,numeric,numeric,text,numeric,text,text,timestamptz,numeric) to authenticated;

create table public.finance_push_subscriptions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 endpoint text not null unique check(endpoint like 'https://%'), p256dh text not null, auth text not null,
 active boolean not null default true, created_at timestamptz not null default now()
);
create table public.finance_push_deliveries (
 subscription_id uuid not null references public.finance_push_subscriptions(id) on delete cascade,
 business_date date not null, status text not null check(status in ('SENDING','SENT','FAILED')),
 attempts integer not null default 1, updated_at timestamptz not null default now(), error text,
 primary key(subscription_id,business_date)
);
create table public.finance_job_runs(
 id uuid primary key default gen_random_uuid(),started_at timestamptz not null default now(),finished_at timestamptz,
 status text not null check(status in ('RUNNING','SUCCESS','PARTIAL','FAILED')),sent integer not null default 0,failed integer not null default 0,error text
);
alter table public.finance_job_runs enable row level security;
create policy job_status on public.finance_job_runs for select to authenticated using((select lubricenter_private.finance_role()) in ('ADMIN','OWNER'));
grant select on public.finance_job_runs to authenticated;
grant all on public.finance_job_runs to service_role;
alter table public.finance_push_subscriptions enable row level security;
alter table public.finance_push_deliveries enable row level security;
create policy own_push on public.finance_push_subscriptions for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy own_push_status on public.finance_push_deliveries for select to authenticated using(exists(select 1 from public.finance_push_subscriptions s where s.id=subscription_id and s.user_id=auth.uid()));
grant select,insert,update,delete on public.finance_push_subscriptions to authenticated;
grant select on public.finance_push_deliveries to authenticated;
grant all on public.finance_push_subscriptions,public.finance_push_deliveries to service_role;

-- Scheduled service-only digest uses each recipient's actual database role.
-- Never expose bank/customer detail on a phone lock screen.
create function public.finance_push_digest(p_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare cash jsonb; reports jsonb; exceptions integer:=0; missing integer:=0; refunds integer; role text; previous_sub text; today_due integer:=0; sources_needed boolean:=false;
begin
 previous_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claim.sub',p_user::text,true);
 perform lubricenter_private.finance_require('OPERATOR');
 role:=lubricenter_private.finance_role(); cash:=lubricenter_private.finance_cash_due(0);
 if cash->>'status'='ACTIVE' and extract(hour from timezone('America/Caracas',now()))>=18 and not exists(select 1 from public.cash_closings where business_date=timezone('America/Caracas',now())::date and location_id=(select id from public.locations where active order by created_at limit 1) and status='CLOSED') then today_due:=1; end if;
 if role in ('OWNER','ADMIN') then
  select count(*) into exceptions from public.reconciliation_cases where status='OPEN';
  reports:=public.finance_report_coverage((date_trunc('month',timezone('America/Caracas',now()))-interval '1 month')::date,(date_trunc('month',timezone('America/Caracas',now()))-interval '1 day')::date);
  select count(*) into missing from jsonb_array_elements(reports->'sources') s where s->>'status' not in ('COVERAGE_VERIFIED','SNAPSHOT_AVAILABLE');
  sources_needed:=jsonb_array_length(reports->'sources')=0;
 end if;
 select count(*) into refunds from public.order_tenders where change_usd>returned_usd;
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return jsonb_build_object('cash',coalesce((cash->>'total')::integer,0)+today_due,'opening_needed',cash->>'status'<>'ACTIVE','exceptions',exceptions,'reports',missing,'sources_needed',sources_needed,'refunds',refunds,'role',role);
end $$;
create function public.finance_push_claim(p_subscription uuid,p_day date) returns boolean language plpgsql security definer set search_path='' as $$
declare claimed boolean:=false;
begin
 if p_day<>timezone('America/Caracas',now())::date then raise exception 'Fecha de aviso inválida'; end if;
 insert into public.finance_push_deliveries(subscription_id,business_date,status) values(p_subscription,p_day,'SENDING')
 on conflict(subscription_id,business_date) do update set status='SENDING',attempts=public.finance_push_deliveries.attempts+1,updated_at=now(),error=null
 where public.finance_push_deliveries.status='FAILED' or (public.finance_push_deliveries.status='SENDING' and public.finance_push_deliveries.updated_at<now()-interval '10 minutes') returning true into claimed;
 return coalesce(claimed,false);
end $$;
create function public.finance_push_refresh() returns void language plpgsql security definer set search_path='' as $$
declare previous_sub text; owner_id uuid;
begin
 select id into owner_id from auth.users where lower(email)='lubricenterc@gmail.com' and email_confirmed_at is not null;
 if owner_id is null then raise exception 'Falta dueño confirmado'; end if;
 previous_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 perform lubricenter_private.finance_reconcile();
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
end $$;
revoke all on function public.finance_push_refresh() from public,anon,authenticated;
grant execute on function public.finance_push_refresh() to service_role;
revoke all on function public.finance_push_digest(uuid),public.finance_push_claim(uuid,date) from public,anon,authenticated;
grant execute on function public.finance_push_digest(uuid),public.finance_push_claim(uuid,date) to service_role;
revoke all on function lubricenter_private.guard_order_tender() from public,anon,authenticated;
revoke all on function lubricenter_private.collect_order_tender(uuid,uuid,text,numeric,numeric,text,numeric,text,text),lubricenter_private.return_order_change(uuid,uuid,numeric,text,numeric,text) from public,anon;
revoke all on function public.collect_order_tender(uuid,uuid,text,numeric,numeric,text,numeric,text,text),public.return_order_change(uuid,uuid,numeric,text,numeric,text) from public,anon;
grant execute on function lubricenter_private.collect_order_tender(uuid,uuid,text,numeric,numeric,text,numeric,text,text),lubricenter_private.return_order_change(uuid,uuid,numeric,text,numeric,text) to authenticated;
grant execute on function public.collect_order_tender(uuid,uuid,text,numeric,numeric,text,numeric,text,text),public.return_order_change(uuid,uuid,numeric,text,numeric,text) to authenticated;

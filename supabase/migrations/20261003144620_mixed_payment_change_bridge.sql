-- Cash surplus is a liability, never sale income or a commission base.
alter table public.order_tenders add column collection_quote_id uuid references public.collection_quotes(id);
alter table public.order_tenders alter column payment_rate drop not null;
alter table public.order_tenders alter column change_rate drop not null;
alter table public.order_tenders add constraint legacy_tender_rates check
 (collection_quote_id is not null or (payment_rate is not null and change_rate is not null));
alter table public.order_change_returns alter column rate drop not null;
alter table public.order_change_returns drop constraint order_change_returns_amount_usd_check;
alter table public.order_change_returns add constraint change_usd_or_native_rounding check
 (amount_usd>=0 and amount_usd<'Infinity'::numeric and
  (amount_usd>0 or (currency='VES' and request_payload->>'native_rounding_return'='true')));
create table public.collection_change_plans (
 quote_id uuid primary key references public.collection_quotes(id), payload jsonb not null,
 plans jsonb not null, created_by uuid not null default auth.uid(),created_at timestamptz not null default now()
);
alter table public.collection_change_plans enable row level security;
create policy own_change_plan on public.collection_change_plans for select to authenticated using(created_by=auth.uid());
grant select on public.collection_change_plans to authenticated;
create trigger keep_change_plan before update or delete on public.collection_change_plans for each row
 execute function lubricenter_private.keep_settlement_closure();

create function lubricenter_private.prepare_change_v3(p_quote uuid,p_plans jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.collection_quotes; o public.orders; existing public.collection_change_plans; t jsonb; plan jsonb;
 rate numeric; due numeric; give_back numeric; b numeric; label text; result jsonb:='[]'; count_plans integer:=0;
begin
 perform lubricenter_private.finance_require('OPERATOR');perform pg_advisory_xact_lock(220033);
 select * into q from public.collection_quotes where id=p_quote for update;
 if q.id is null or q.created_by<>auth.uid() then raise exception 'Cotización ajena o no encontrada'; end if;
 select * into existing from public.collection_change_plans where quote_id=q.id;
 if existing.quote_id is not null then
  if existing.payload<>p_plans then raise exception 'El vuelto revisado cambió: calcula una cotización nueva'; end if;
  return existing.plans;
 end if;
 select * into o from public.orders where id=q.order_id for update;
 if q.state<>'PREVIEW' or q.expires_at<now() or q.order_revision<>o.settlement_revision or o.status<>'OPEN' then raise exception 'La orden cambió: revisa otra vez el cobro'; end if;
 if jsonb_typeof(p_plans)<>'array' then raise exception 'Indica cómo entregar o conservar el vuelto'; end if;
 for t in select value from jsonb_array_elements(q.calculated_payload->'tenders') where (value->>'change')::numeric>0 loop
  if t->>'method' not in ('CASH_USD','CASH_VES') then raise exception 'El vuelto solo corresponde a pagos en efectivo'; end if;
  select count(*) into count_plans from jsonb_array_elements(p_plans) p where p->>'tender'=t->>'id';
  if count_plans<>1 then raise exception 'Indica una única entrega de vuelto por cobro'; end if;
  select value into plan from jsonb_array_elements(p_plans) where value->>'tender'=t->>'id';
  if plan-array['tender','rate','return_usd','return_currency','customer_label']<>'{}' then raise exception 'Datos del vuelto inválidos'; end if;
  select (value->>'bcv')::numeric into b from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=t->>'id' limit 1;
  rate:=case when nullif(plan->>'rate','') is null then b else lubricenter_private.settlement_decimal(plan->>'rate',6) end;
  give_back:=lubricenter_private.settlement_decimal(coalesce(plan->>'return_usd','0'),2,true);
  if plan->>'return_currency' is null or plan->>'return_currency' not in ('USD','VES') then raise exception 'Selecciona moneda del vuelto'; end if;
  if rate is null and (t->>'currency'='VES' or (give_back>0 and plan->>'return_currency'='VES')) then raise exception 'Indica la tasa acordada para convertir el vuelto'; end if;
  due:=case when t->>'currency'='USD' then (t->>'change')::numeric else round((t->>'change')::numeric/rate,2) end;
  if due<=0 and (t->>'currency'<>'VES' or plan->>'return_currency'<>'VES' or give_back<>0) then raise exception 'El sobrante no alcanza un centavo USD: selecciona devolución en Bs y devuelve su importe exacto'; end if;
  if give_back>due then raise exception 'El vuelto entregado supera el sobrante'; end if;
  if give_back>0 and plan->>'return_currency'='VES' and round(give_back*rate,2)<=0 then raise exception 'La entrega de vuelto redondea a cero'; end if;
  label:=nullif(trim(plan->>'customer_label'),'');
  if due>give_back and o.customer_id is null and length(coalesce(label,''))<3 then raise exception 'Identifica al cliente para conservar el vuelto pendiente'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('tender',t->>'id','rate',rate::text,'bcv',b::text,
   'change_usd',due::text,'return_usd',give_back::text,'return_currency',plan->>'return_currency',
   'customer_id',o.customer_id,'customer_label',coalesce(label,'Cliente de '||o.order_number),
   'native_return',case when due=0 and t->>'currency'='VES' then t->>'change' else null end,
   'rounding_ves',case when due>0 and t->>'currency'='VES' then round((t->>'change')::numeric-due*rate,2)::text else '0' end));
 end loop;
 if jsonb_array_length(p_plans)<>jsonb_array_length(result) then raise exception 'Hay una entrega que no corresponde a un sobrante en efectivo'; end if;
 insert into public.collection_change_plans(quote_id,payload,plans) values(q.id,p_plans,result);
 return result;
end $$;
create function public.prepare_change_v3(p_quote uuid,p_plans jsonb) returns jsonb language sql security invoker set search_path='' as $$
 select lubricenter_private.prepare_change_v3(p_quote,p_plans)
$$;

create function lubricenter_private.return_change_v3(p_request uuid,p_tender uuid,p_usd numeric,p_currency text,p_rate numeric,p_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.order_tenders; previous public.order_change_returns; payload jsonb; amount numeric; b numeric; account uuid; movement uuid;
begin
 perform lubricenter_private.finance_require('OPERATOR');perform pg_advisory_xact_lock(220033);
 payload:=jsonb_build_array(p_tender,p_usd,p_currency,p_rate,p_note);
 if p_request is null then raise exception 'Falta identificador de devolución'; end if;
 select * into previous from public.order_change_returns where id=p_request;
 if previous.id is not null then
  if previous.request_payload<>payload then raise exception 'Identificador reutilizado con otra devolución'; end if;
  return previous.id;
 end if;
 select * into t from public.order_tenders where id=p_tender for update;
 if t.id is null or t.collection_quote_id is null then raise exception 'Vuelto no encontrado en el nuevo cálculo'; end if;
 if p_usd is null or p_usd<=0 or p_usd::text in ('NaN','Infinity','-Infinity') or round(p_usd,2)<>p_usd or p_usd>t.change_usd-t.returned_usd then raise exception 'La devolución supera el vuelto pendiente'; end if;
 if p_currency is null or p_currency not in ('USD','VES') or (p_currency='VES' and p_rate is null) or
  (p_rate is not null and (p_rate<=0 or p_rate::text in ('NaN','Infinity','-Infinity') or round(p_rate,6)<>p_rate)) then raise exception 'Moneda o tasa de devolución inválida'; end if;
 if length(trim(coalesce(p_note,'')))<3 then raise exception 'Confirma la entrega con una nota'; end if;
 amount:=case when p_currency='USD' then p_usd else round(p_usd*p_rate,2) end;
 if amount<=0 then raise exception 'La devolución redondea a cero'; end if;
 select id into account from public.financial_accounts where active and currency=p_currency and account_type='CASH'
  and code=case when p_currency='USD' then 'CASH_USD' else 'CASH_VES' end;
 if account is null then raise exception 'Configura la caja para esta moneda'; end if;
 select value into b from public.exchange_rates where rate_type='BCV' and effective_at<=now() order by effective_at desc,created_at desc limit 1;
 insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,finance_nature,finance_request_id,tender_id)
 values(account,'OUT','ADJUSTMENT',p_currency,amount,case when p_currency='USD' then round(amount*b,2) else amount end,'Vuelto',p_note,'REFUND',p_request,t.id) returning id into movement;
 insert into public.order_change_returns(id,tender_id,currency,amount_usd,amount_original,rate,movement_id,note,request_payload)
 values(p_request,t.id,p_currency,p_usd,amount,p_rate,movement,p_note,payload);
 update public.order_tenders set returned_usd=returned_usd+p_usd where id=t.id;
 return p_request;
end $$;

-- Route existing refund UI through the native-money implementation for v3 only.
alter function lubricenter_private.return_order_change(uuid,uuid,numeric,text,numeric,text) rename to return_order_change_v2;
revoke all on function lubricenter_private.return_order_change_v2(uuid,uuid,numeric,text,numeric,text) from public,anon,authenticated;
create function lubricenter_private.return_order_change(p_request uuid,p_tender uuid,p_usd numeric,p_currency text,p_rate numeric,p_note text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.order_tenders where id=p_tender and collection_quote_id is not null) then
  return lubricenter_private.return_change_v3(p_request,p_tender,p_usd,p_currency,p_rate,p_note);
 end if;
 return lubricenter_private.return_order_change_v2(p_request,p_tender,p_usd,p_currency,p_rate,p_note);
end $$;
create or replace function public.return_order_change(p_request uuid,p_tender uuid,p_usd numeric,p_currency text,p_rate numeric,p_note text) returns uuid
language sql security invoker set search_path='' as $$
 select lubricenter_private.return_order_change(p_request,p_tender,p_usd,p_currency,p_rate,p_note)
$$;

create function lubricenter_private.commit_change_v3(p_quote uuid) returns void language plpgsql security definer set search_path='' as $$
declare q public.collection_quotes; o public.orders; choice jsonb; tender jsonb; plan public.collection_change_plans; account uuid; refund uuid; movement uuid;
begin
 select * into q from public.collection_quotes where id=p_quote;
 select * into o from public.orders where id=q.order_id;
 select * into plan from public.collection_change_plans where quote_id=q.id;
 if q.created_by<>auth.uid() or q.state<>'PREVIEW' then raise exception 'Cotización de vuelto no válida'; end if;
 if exists(select 1 from jsonb_array_elements(q.calculated_payload->'tenders') where (value->>'change')::numeric>0) and plan.quote_id is null then raise exception 'Revisa la entrega o el saldo pendiente del vuelto antes de confirmar'; end if;
 for choice in select value from jsonb_array_elements(coalesce(plan.plans,'[]')) loop
  if choice->>'customer_id' is distinct from o.customer_id::text then raise exception 'El cliente cambió: revisa otra vez el vuelto'; end if;
  select value into tender from jsonb_array_elements(q.calculated_payload->'tenders') where value->>'id'=choice->>'tender';
  select financial_account_id into account from public.payments where id=(choice->>'tender')::uuid;
  insert into public.order_tenders(id,order_id,payment_id,customer_id,customer_label,method,currency,received,applied,payment_rate,change_usd,change_rate,rounding_ves,request_payload,collection_quote_id)
  values((choice->>'tender')::uuid,o.id,(choice->>'tender')::uuid,o.customer_id,choice->>'customer_label',tender->>'method',tender->>'currency',
   (tender->>'received')::numeric,(tender->>'applied')::numeric,(choice->>'bcv')::numeric,(choice->>'change_usd')::numeric,(choice->>'rate')::numeric,(choice->>'rounding_ves')::numeric,choice,q.id);
  update public.account_movements set tender_id=(choice->>'tender')::uuid where source_payment_id=(choice->>'tender')::uuid;
  insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,reference,finance_nature,finance_request_id,tender_id,occurred_at)
  values(account,'IN','ADJUSTMENT',tender->>'currency',(tender->>'change')::numeric,
   case when tender->>'currency'='USD' then round((tender->>'change')::numeric*(choice->>'bcv')::numeric,2) else (tender->>'change')::numeric end,
   'Vuelto recibido','Dinero recibido que no pertenece a la venta',tender->>'reference','REFUND',(choice->>'tender')::uuid,(choice->>'tender')::uuid,q.effective_at);
  if (choice->>'return_usd')::numeric>0 then perform lubricenter_private.return_change_v3(gen_random_uuid(),(choice->>'tender')::uuid,
   (choice->>'return_usd')::numeric,choice->>'return_currency',(choice->>'rate')::numeric,'Vuelto entregado al cobrar'); end if;
  if (choice->>'native_return')::numeric>0 then
   refund:=gen_random_uuid();
   insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,finance_nature,finance_request_id,tender_id,occurred_at)
   values(account,'OUT','ADJUSTMENT','VES',(choice->>'native_return')::numeric,(choice->>'native_return')::numeric,
    'Vuelto','Sobrante devuelto exactamente en Bs','REFUND',refund,(choice->>'tender')::uuid,q.effective_at) returning id into movement;
   insert into public.order_change_returns(id,tender_id,currency,amount_usd,amount_original,rate,movement_id,note,request_payload)
   values(refund,(choice->>'tender')::uuid,'VES',0,(choice->>'native_return')::numeric,(choice->>'rate')::numeric,movement,
    'Sobrante devuelto exactamente en Bs',jsonb_build_object('native_rounding_return',true));
  end if;
 end loop;
end $$;

do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','lubricenter_private') and p.proname in ('prepare_change_v3','return_order_change') loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
revoke all on function lubricenter_private.commit_change_v3(uuid),lubricenter_private.return_change_v3(uuid,uuid,numeric,text,numeric,text) from public,anon,authenticated;

create or replace function lubricenter_private.commit_collection_v3(p_quote uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.collection_quotes; o public.orders; t jsonb; x jsonb; b numeric; pid uuid; result jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_quote is null or p_request is null then raise exception 'Falta identificador de confirmación'; end if;
 perform pg_advisory_xact_lock(220033);
 select * into q from public.collection_quotes where id=p_quote for update;
 if q.id is null or q.created_by<>auth.uid() then raise exception 'Cotización no encontrada o ajena'; end if;
 if q.state='COMMITTED' then
  if q.committed_request<>p_request then raise exception 'El cobro ya fue confirmado con otro identificador'; end if;
  return jsonb_build_object('quote_id',q.id,'request_id',p_request,'order_id',q.order_id,'state','COMMITTED');
 end if;
 if exists(select 1 from public.collection_quotes where committed_request=p_request and id<>p_quote) then raise exception 'Identificador de confirmación reutilizado'; end if;
 select * into o from public.orders where id=q.order_id for update;
 if o.status<>'OPEN' or o.settlement_version<>3 or o.settlement_revision<>q.order_revision then raise exception 'La orden cambió: vuelve a revisar el cobro'; end if;
 if q.state<>'PREVIEW' or q.expires_at<now() or q.digest<>md5(q.calculated_payload::text) then raise exception 'Cotización vencida o inconsistente'; end if;
 -- Cash change and customer balance bridges must be ready before activating v3.
 for t in select value from jsonb_array_elements(q.calculated_payload->'tenders') loop
  pid:=(t->>'id')::uuid;
  select (value->>'bcv')::numeric into b from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=pid::text limit 1;
  insert into public.payments(id,order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at,collection_quote_id)
   values(pid,q.order_id,t->>'method',t->>'currency',(t->>'applied')::numeric,b,b,
    case when t->>'currency'='VES' then (t->>'applied')::numeric else round((t->>'applied')::numeric*b,2) end,
    case when t->>'currency'='USD' then (t->>'applied')::numeric else round((t->>'applied')::numeric/b,4) end,t->>'reference',q.effective_at,q.id);
  for x in select value from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=pid::text loop
   insert into public.order_payment_applications(order_id,agreement_id,payment_id,quote_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,rounding_native,exchange_mode,bcv_rate,bcv_rate_id,acceptance_rate,exact_agreement_id,exact_native,exact_covered,commission_amount,reason,created_by)
    values(q.order_id,(x->>'component')::uuid,pid,q.id,x->>'currency',(x->>'native')::numeric,(x->>'covered')::numeric,(x->>'baseline')::numeric,(x->>'benefit')::numeric,(x->>'rounding_native')::numeric,
     x->>'mode',(x->>'bcv')::numeric,(x->>'bcv_id')::uuid,(x->>'acceptance')::numeric,(x->>'exact_id')::uuid,(x->>'exact_native')::numeric,(x->>'exact_covered')::numeric,(x->>'commission')::numeric,'Cobro por concepto confirmado',auth.uid());
  end loop;
 end loop;
 perform lubricenter_private.commit_change_v3(q.id);
 update public.collection_quotes set state='COMMITTED',committed_request=p_request where id=q.id;
 update public.orders set settlement_revision=settlement_revision+1 where id=q.order_id;
 return jsonb_build_object('quote_id',q.id,'request_id',p_request,'order_id',q.order_id,'state','COMMITTED');
end $$;

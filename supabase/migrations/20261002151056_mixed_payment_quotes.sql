-- Explicit preview only; orders remain v2 until checkout, closure and payroll integration is ready.
create function lubricenter_private.settlement_decimal(p_value text,p_places integer default 8,p_zero boolean default false)
returns numeric language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if p_value is null or p_value !~ '^[0-9]+([.][0-9]+)?$' or length(p_value)>40 then raise exception 'Monto decimal inválido'; end if;
 n:=p_value::numeric;
 if n>=1000000000000 or n<0 or (not p_zero and n=0) or round(n,p_places)<>n then raise exception 'Monto fuera de rango o precisión inválida'; end if;
 return n;
end $$;

create function lubricenter_private.prepare_collection_v3(p_order uuid,p_request uuid,p_revision integer,p_payload jsonb,p_effective_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
<<calculation>>
declare o public.orders; existing public.collection_quotes; a public.order_price_agreements; rate public.exchange_rates;
 t jsonb; target jsonb; ex jsonb; x jsonb; applications jsonb:='[]'; tenders jsonb:='[]'; response jsonb;
 coin text; method text; mode text; tender_id uuid; exact_id uuid; seen uuid[]:='{}';
 received numeric; applied numeric; amount numeric; covered numeric; baseline numeric; benefit numeric; residual numeric;
 b numeric; acceptance numeric; exact_native numeric; exact_covered numeric; factor numeric; due numeric; remaining numeric;
 used numeric; financed numeric; group_native numeric; group_covered numeric; local_native numeric; local_covered numeric;
 prior_base numeric; prior_commission numeric; commission numeric; capacity_used numeric; exact_signature jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_order is null or p_request is null or p_revision is null or p_payload is null or p_effective_at is null then raise exception 'Faltan datos de la cotización'; end if;
 if p_effective_at>now()+interval '5 minutes' then raise exception 'El pago no puede tener una fecha futura'; end if;
 if (p_effective_at at time zone 'America/Caracas')::date<>(now() at time zone 'America/Caracas')::date and lubricenter_private.finance_role() not in ('ADMIN','OWNER') then raise exception 'Los pagos atrasados requieren administración'; end if;
 if jsonb_typeof(p_payload)<>'object' or p_payload-'tenders'<>'{}' or jsonb_typeof(p_payload->'tenders') is distinct from 'array'
  or jsonb_array_length(p_payload->'tenders') not between 1 and 8 then raise exception 'Indica entre uno y ocho medios de pago'; end if;
 perform pg_advisory_xact_lock(220033);
 select * into existing from public.collection_quotes where id=p_request;
 if found then
  if existing.order_id<>p_order or existing.created_by<>auth.uid() or existing.order_revision<>p_revision or existing.request_payload<>p_payload or existing.effective_at<>p_effective_at then raise exception 'Identificador reutilizado con otros datos'; end if;
  if existing.state='EXPIRED' or existing.expires_at<now() then raise exception 'Cotización vencida: vuelve a revisar el cobro'; end if;
  response:=existing.calculated_payload;
 else
  select * into o from public.orders where id=p_order for update;
  if o.id is null or o.status<>'OPEN' or o.settlement_version<>3 then raise exception 'Orden no habilitada para cobro por concepto'; end if;
  if o.settlement_revision<>p_revision then raise exception 'La orden cambió: actualiza antes de cobrar'; end if;
  if exists(select 1 from public.order_items i where i.order_id=o.id and not exists(select 1 from public.order_price_agreements active_price where active_price.item_id=i.id and active_price.state='ACTIVE')) then raise exception 'Falta confirmar el precio por concepto de un producto o trabajo'; end if;
  select * into rate from public.exchange_rates where rate_type='BCV' and effective_at<=p_effective_at order by effective_at desc,created_at desc,id desc limit 1;
  b:=rate.value;
  for t in select value from jsonb_array_elements(p_payload->'tenders') loop
   if jsonb_typeof(t)<>'object' or t-array['id','method','received','reference','targets']<>'{}' then raise exception 'Datos de recepción inválidos'; end if;
   tender_id:=(t->>'id')::uuid;
   if tender_id is null or tender_id=any(seen) then raise exception 'Recepción duplicada o sin identificador'; end if;
   seen:=array_append(seen,tender_id);
   method:=t->>'method';
   if method is null or method not in ('CASH_USD','CASH_VES','TRANSFER_BDV','TRANSFER_BNC','ZELLE','BINANCE') then raise exception 'Método de pago inválido'; end if;
   if method in ('TRANSFER_BDV','TRANSFER_BNC') and coalesce(trim(t->>'reference'),'') !~ '^[0-9]{4,32}$' then raise exception 'Escribe los últimos 4 números de referencia'; end if;
   if jsonb_typeof(t->'received') is distinct from 'string' then raise exception 'El importe debe ser decimal exacto'; end if;
   received:=lubricenter_private.settlement_decimal(t->>'received',2);
   coin:=case when method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
   if jsonb_typeof(t->'targets') is distinct from 'array' or jsonb_array_length(t->'targets') not between 1 and 100 then raise exception 'Selecciona los conceptos del pago'; end if;
   applied:=0;
   for target in select value from jsonb_array_elements(t->'targets') loop
    if jsonb_typeof(target)<>'object' or target-array['component','amount','exchange']<>'{}' then raise exception 'Datos de aplicación inválidos'; end if;
    select * into a from public.order_price_agreements where id=(target->>'component')::uuid and order_id=p_order and state='ACTIVE';
    if a.id is null then raise exception 'Concepto ajeno a la orden o precio no activo'; end if;
    select coalesce(sum(case when direction='APPLY' then covered_amount else -covered_amount end),0) into used from public.order_payment_applications where agreement_id=a.id;
    select coalesce(sum(f.amount),0) into financed from public.order_financing_applications f where f.agreement_id=a.id and f.state='ACTIVE';
    select coalesce(sum((value->>'covered')::numeric),0) into local_covered from jsonb_array_elements(applications) where value->>'component'=a.id::text;
    remaining:=a.principal-used-financed-local_covered;
    if remaining<=0 then raise exception 'El concepto ya está cubierto o financiado'; end if;
    ex:=coalesce(target->'exchange','{"mode":"PAR"}'); mode:=ex->>'mode';
    acceptance:=null; exact_id:=null; exact_native:=null; exact_covered:=null;
    if mode='PAR' then
     if ex-'mode'<>'{}' then raise exception 'El acuerdo 1:1 no admite una tasa preferencial'; end if;
     if (coin='VES' and a.basis<>'VES_FIXED') or (coin='USD' and a.basis='VES_FIXED') then
      if b is null or b<=0 then raise exception 'Falta BCV del día de pago para convertir monedas'; end if;
      factor:=case when coin='USD' then b else 1/b end;
     else factor:=1; end if;
    elsif mode='RATE' then
     if ex-array['mode','acceptance']<>'{}' or coin<>'USD' or a.basis='USD_FIXED' then raise exception 'La tasa preferencial no cambia un precio pactado en USD'; end if;
     if b is null or b<=0 then raise exception 'Falta BCV del día de pago para aplicar la preferencia'; end if;
     acceptance:=lubricenter_private.settlement_decimal(ex->>'acceptance');
     factor:=case when a.basis='VES_FIXED' then acceptance else acceptance/b end;
    elsif mode='EXACT' then
     if ex-array['mode','id','native','covered']<>'{}' or coin<>'USD' or a.basis<>'USD_REF_BCV' then raise exception 'El acuerdo exacto requiere una deuda de referencia y recepción en USD'; end if;
     exact_id:=(ex->>'id')::uuid; if exact_id is null then raise exception 'Falta identificador del acuerdo exacto'; end if;
     exact_native:=lubricenter_private.settlement_decimal(ex->>'native',2); exact_covered:=lubricenter_private.settlement_decimal(ex->>'covered'); factor:=exact_covered/exact_native;
     if exists(select 1 from public.order_payment_applications where exact_agreement_id=exact_id and row(agreement_id,public.order_payment_applications.exact_native,public.order_payment_applications.exact_covered) is distinct from row(a.id,calculation.exact_native,calculation.exact_covered)) then raise exception 'Acuerdo exacto reutilizado con otros datos'; end if;
     for x in select value from jsonb_array_elements(applications) where value->>'exact_id'=exact_id::text loop
      if x->>'component'<>a.id::text or (x->>'exact_native')::numeric<>exact_native or (x->>'exact_covered')::numeric<>exact_covered then raise exception 'Acuerdo exacto reutilizado con otros datos'; end if;
     end loop;
    else raise exception 'Acuerdo de conversión inválido'; end if;
    due:=remaining/factor; residual:=0;
    if target->>'amount'='EXACT_DUE' then amount:=round(due,2); residual:=amount-due;
    else
     if jsonb_typeof(target->'amount') is distinct from 'string' then raise exception 'El importe aplicado debe ser decimal exacto'; end if;
     amount:=lubricenter_private.settlement_decimal(target->>'amount',2);
    end if;
    if amount<=0 or applied+amount>received then raise exception 'Las aplicaciones superan el dinero recibido o redondean a cero'; end if;
    select coalesce(sum(case when direction='APPLY' then native_amount-rounding_native else -(native_amount-rounding_native) end),0),coalesce(sum(case when direction='APPLY' then covered_amount else -covered_amount end),0)
     into group_native,group_covered from public.order_payment_applications where agreement_id=a.id and currency=coin and row(exchange_mode,bcv_rate,acceptance_rate,exact_agreement_id,public.order_payment_applications.exact_native,public.order_payment_applications.exact_covered) is not distinct from row(mode,b,acceptance,exact_id,calculation.exact_native,calculation.exact_covered);
    select coalesce(sum((value->>'native')::numeric-(value->>'rounding_native')::numeric),0),coalesce(sum((value->>'covered')::numeric),0)
     into local_native,local_covered from jsonb_array_elements(applications) where value->>'component'=a.id::text and value->>'currency'=coin
      and row(value->>'mode',(value->>'bcv')::numeric,(value->>'acceptance')::numeric,value->>'exact_id',(value->>'exact_native')::numeric,(value->>'exact_covered')::numeric) is not distinct from row(mode,b,acceptance,exact_id::text,exact_native,exact_covered);
    covered:=round((group_native+local_native+amount-residual)*factor,8)-group_covered-local_covered;
    if target->>'amount'='EXACT_DUE' then covered:=remaining; end if;
    if covered<=0 or covered>remaining or abs(residual)>0.005 then raise exception 'El importe supera el saldo del concepto o la precisión admitida'; end if;
    if mode='EXACT' then
     select coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end),0) into capacity_used from public.order_payment_applications where exact_agreement_id=exact_id;
     select capacity_used+coalesce(sum((value->>'native')::numeric),0) into capacity_used from jsonb_array_elements(applications) where value->>'exact_id'=exact_id::text;
     if capacity_used+amount>exact_native then raise exception 'El tramo de acuerdo exacto ya fue consumido'; end if;
    end if;
    baseline:=round(case when a.basis='VES_FIXED' and coin='USD' then amount*b when a.basis<>'VES_FIXED' and coin='VES' then amount/b else amount end,8);
    benefit:=case when mode='PAR' then 0 else round(amount*factor-baseline,8) end;
    select coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end),0),coalesce(sum(case when direction='APPLY' then commission_amount else -commission_amount end),0)
     into prior_base,prior_commission from public.order_payment_applications where agreement_id=a.id and currency=coin;
    select prior_base+coalesce(sum((value->>'native')::numeric),0),prior_commission+coalesce(sum((value->>'commission')::numeric),0) into prior_base,prior_commission from jsonb_array_elements(applications) where value->>'component'=a.id::text and value->>'currency'=coin;
    commission:=case when a.commission_worker is null then 0 else round((prior_base+amount)*a.commission_percent/100,2)-prior_commission end;
    applications:=applications||jsonb_build_array(jsonb_build_object('tender',tender_id,'component',a.id,'currency',coin,'native',amount::text,'covered',covered::text,'baseline',baseline::text,'benefit',benefit::text,'rounding_native',round(residual,8)::text,
     'mode',mode,'bcv',b::text,'bcv_id',rate.id,'acceptance',acceptance::text,'exact_id',exact_id,'exact_native',exact_native::text,'exact_covered',exact_covered::text,'commission',commission::text));
    applied:=applied+amount;
   end loop;
   if method not in ('CASH_USD','CASH_VES') and applied<>received then raise exception 'Exceso digital: corrige el importe o registra un anticipo'; end if;
   tenders:=tenders||jsonb_build_array(jsonb_build_object('id',tender_id,'method',method,'currency',coin,'received',received::text,'applied',applied::text,'change',(received-applied)::text,'reference',nullif(trim(t->>'reference'),'')));
  end loop;
  response:=jsonb_build_object('quote_id',p_request,'order_id',p_order,'revision',p_revision,'effective_at',p_effective_at,'applications',applications,'tenders',tenders);
  insert into public.collection_quotes(id,order_id,order_revision,effective_at,expires_at,request_payload,calculated_payload,digest,created_by)
   values(p_request,p_order,p_revision,p_effective_at,now()+interval '5 minutes',p_payload,response,md5(response::text),auth.uid());
 end if;
 -- Operators can see the collection preview without seeing payroll data.
 if lubricenter_private.finance_role() not in ('ADMIN','OWNER') then
  select coalesce(jsonb_agg(value-'commission'),'[]') into applications from jsonb_array_elements(response->'applications');
  response:=jsonb_set(response,'{applications}',applications);
 end if;
 return response;
end $$;
create function public.prepare_collection_v3(p_order uuid,p_request uuid,p_revision integer,p_payload jsonb,p_effective_at timestamptz)
returns jsonb language sql security invoker set search_path='' as $$select lubricenter_private.prepare_collection_v3(p_order,p_request,p_revision,p_payload,p_effective_at)$$;
revoke all on function lubricenter_private.settlement_decimal(text,integer,boolean) from public,anon,authenticated;
revoke all on function lubricenter_private.prepare_collection_v3(uuid,uuid,integer,jsonb,timestamptz),public.prepare_collection_v3(uuid,uuid,integer,jsonb,timestamptz) from public,anon;
grant execute on function lubricenter_private.prepare_collection_v3(uuid,uuid,integer,jsonb,timestamptz),public.prepare_collection_v3(uuid,uuid,integer,jsonb,timestamptz) to authenticated;

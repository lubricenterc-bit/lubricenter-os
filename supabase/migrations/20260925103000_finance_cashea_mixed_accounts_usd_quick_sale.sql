-- Cashea reports may contain multiple Cuenta labels and both VES/USD rows.
-- Keep each row's account as evidence and never infer ownership from it.
create or replace function lubricenter_private.finance_import(p_source_id uuid,p_name text,p_from date,p_to date,p_preview jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.external_sources; b uuid; t uuid; r jsonb; v_key text; v_fp text; v_own text; v_reason text; v_matches integer; v_sale uuid; v_bad boolean; v_time timestamptz;
begin
 perform lubricenter_private.finance_require();
 select * into s from public.external_sources where id=p_source_id and active for update;
 if not found then raise exception 'Fuente no disponible'; end if;
 if s.provider<>p_preview->>'provider' then raise exception 'Reporte incompatible con la fuente'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Selecciona un período válido, máximo un año'; end if;
 if jsonb_typeof(p_preview->'rows')<>'array' or jsonb_typeof(p_preview->'orders')<>'array' or jsonb_typeof(p_preview->'errors')<>'array' then raise exception 'Formato del reporte inválido'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')>10000 then raise exception 'Importa hasta 10000 filas por lote'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')=0 then raise exception 'El reporte está vacío'; end if;
 v_fp:=md5(jsonb_build_object('from',p_from,'to',p_to,'rows',p_preview->'rows','orders',p_preview->'orders','errors',p_preview->'errors')::text);
 select id into b from public.external_import_batches where source_id=s.id and fingerprint=v_fp;
 if b is not null then return b; end if;
 insert into public.external_import_batches(source_id,fingerprint,source_name,requested_from,requested_to,row_count,duplicate_count,balance_chain,validation,payload)
 values(s.id,v_fp,left(p_name,200),p_from,p_to,jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders'),coalesce((p_preview->>'duplicates')::integer,0),null,
 jsonb_build_object('errors',p_preview->'errors','warnings',p_preview->'warnings'),p_preview) returning id into b;
 for r in select value from jsonb_array_elements(p_preview->'rows') loop
  v_time:=(r->>'occurred_at')::timestamptz;
  if s.provider='CASHEA_ORDERS' or coalesce(r->>'reference','')!~'^\d+$' or coalesce(r->>'direction','') not in ('IN','OUT') or (s.provider='BDV' and r->>'currency'<>s.currency) or (s.provider='CASHEA_TRANSACTIONS' and r->>'currency' not in ('VES','USD')) or (r->>'amount')::numeric is null or (r->>'amount')::numeric<=0 or (r->>'amount')::numeric>='Infinity'::numeric then raise exception 'Movimiento inválido en fila %',r->>'row'; end if;
  if s.provider='BDV' and (r->>'balance') is null then raise exception 'Falta saldo BDV'; end if;
  if s.provider='CASHEA_TRANSACTIONS' and (coalesce(r->>'external_order','')!~'^\d+$' or (r->>'amount_ref') is null or (r->>'assigned_ref') is null or coalesce(trim(r->>'provider_account'),'')=''  or r->>'direction'<>'IN') then raise exception 'Reporte Cashea: revisa cuenta, orden y montos en fila %',r->>'row'; end if;
  v_key:=md5(jsonb_build_array(v_time,r->>'reference',r->>'direction',(r->>'amount')::numeric,case when s.provider='BDV' then (r->>'balance')::numeric else null end,coalesce(r->>'provider_account',''))::text);
  v_own:='OWN'; v_reason:='OWN_BANK_ACCOUNT'; v_sale:=null;
  if s.provider='CASHEA_TRANSACTIONS' then
   select count(*),(array_agg(id))[1] into v_matches,v_sale from public.cashea_sales where trim(cashea_reference)=r->>'external_order' and status<>'CANCELLED';
   v_own:=case when v_matches=1 then 'OWN' else 'UNRESOLVED' end; v_reason:=case when v_matches=1 then 'ORDER_MATCH' else 'UNKNOWN' end;
  end if;
  insert into public.external_transactions(source_id,identity_key,first_batch_id,occurred_at,reference,description,direction,currency,amount,balance,amount_ref,assigned_ref,exchange_rate,rate_date,external_order,installments,provider_account,channel_label,ownership_status,ownership_reason,ownership_evidence,raw)
  values(s.id,v_key,b,v_time,r->>'reference',r->>'description',r->>'direction',r->>'currency',(r->>'amount')::numeric,(r->>'balance')::numeric,(r->>'amount_ref')::numeric,(r->>'assigned_ref')::numeric,(r->>'rate')::numeric,(r->>'rate_date')::date,r->>'external_order',array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))),r->>'provider_account',r->>'channel_label',v_own,v_reason,jsonb_build_object('cashea_sale_id',v_sale),r->'raw')
  on conflict(source_id,identity_key) do nothing returning id into t;
  if t is null then
   select id into t from public.external_transactions where source_id=s.id and identity_key=v_key;
   if exists(select 1 from public.external_transactions where id=t and (external_order is distinct from r->>'external_order' or amount_ref is distinct from (r->>'amount_ref')::numeric or assigned_ref is distinct from (r->>'assigned_ref')::numeric or installments is distinct from array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))))) then
    perform lubricenter_private.finance_case('conflict:'||t,'SOURCE_CONFLICT','external_transaction',t,'Reporte con versiones distintas','El mismo cobro aparece con otra orden, cuota o importe. No se duplicó ni sobrescribió.',jsonb_build_object('batch_id',b,'row',r));
   end if;
  end if;
  insert into public.external_batch_transactions values(b,t,(r->>'row')::integer) on conflict do nothing;
  if (r->>'assigned_ref')::numeric-(r->>'amount_ref')::numeric>0.005 then perform lubricenter_private.finance_case('amount:'||t,'SOURCE_AMOUNT','external_transaction',t,'Revisar importe Cashea','Monto asignado supera el USD informado más allá de medio centavo; conserva ambas cifras.',r); end if;
  t:=null;
 end loop;
 for r in select value from jsonb_array_elements(p_preview->'orders') loop
  if s.provider<>'CASHEA_ORDERS' or coalesce(r->>'external_order','')!~'^\d+$' or jsonb_typeof(r->'installments')<>'array' then raise exception 'Snapshot Cashea inválido'; end if;
  insert into public.cashea_order_snapshots(batch_id,external_order,purchased_on,status,total_ref,initial_ref,installments,raw)
  values(b,r->>'external_order',(r->>'purchased_on')::date,r->>'status',(r->>'total_ref')::numeric,(r->>'initial_ref')::numeric,r->'installments',r->'raw');
 end loop;
 update public.external_import_batches set
 observed_from=(select min(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q),
 observed_to=(select max(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q)
 where id=b;
 -- Recalculate chain from persisted decimals; never trust browser's 'complete' or chain flag.
 if s.provider='BDV' then
  with ordered as (select x.*,lag(balance) over(order by x.occurred_at,case when (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') z limit 1) >= (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') with ordinality a(z,n) order by n desc limit 1) then -l.row_number else l.row_number end) prev from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b)
  select bool_or(prev is not null and balance<>prev+case when direction='IN' then amount else -amount end) into v_bad from ordered;
  update public.external_import_batches set balance_chain=not coalesce(v_bad,false) where id=b;
 end if;
 perform lubricenter_private.finance_case('batch:'||b,'COVERAGE','import_batch',b,'Confirmar cobertura del reporte','La fecha del primer y último movimiento no prueba que estén todas las páginas.',jsonb_build_object('source_name',p_name));
 return b;
end $$;
create or replace function public.complete_quick_sale(p_items jsonb, p_payment_method text, p_payment_reference text default null)
returns table(order_id uuid, order_number text, total_ves numeric, total_ref numeric)
language plpgsql security definer set search_path='public' as $function$
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
    select operative_rate into v_op from public.current_exchange_rates;
    if v_op is null or v_op <= 0 then raise exception 'No hay tasa operativa disponible'; end if;
    v_amount := v_built.total_ves / v_op;
  else
    v_amount := v_built.total_ves;
  end if;
  perform public.add_payment(v_built.order_id, v_method, v_amount, p_payment_reference);
  perform public.close_order(v_built.order_id);
  order_id := v_built.order_id;
  order_number := v_built.order_number;
  total_ves := v_built.total_ves;
  total_ref := v_built.total_ref;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('quick_sale.completed','order',v_built.order_id,jsonb_build_object('order_number',v_built.order_number,'payment_method',v_method,'total_ves',v_built.total_ves,'total_ref',v_built.total_ref));
  return next;
end;
$function$;
-- New quotes use cents, never multiples of ten Bs. Existing order items remain frozen.
insert into public.app_settings(key,value) values('price_rounding_step','0.01'::jsonb),('price_rounding_mode','"nearest"'::jsonb) on conflict(key) do update set value=excluded.value;
create or replace function lubricenter_private.collect_order_tender(p_request uuid,p_order uuid,p_method text,p_received numeric,p_return_usd numeric,p_return_currency text,p_change_rate numeric,p_reference text default null,p_customer_label text default null) returns uuid
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
end $$;

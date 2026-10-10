-- Additive owner-only administrative order correction v2.
-- Keeps v1 unchanged. Every correction is atomic, audited, cancels and supersedes the original.
-- Explicit initial percentage and USD cash commercial valuation are recorded, never silently invented.
-- Apply to a structural test database and run correction regressions before production.
CREATE OR REPLACE FUNCTION lubricenter_private.correct_closed_order_v2(p_order_id uuid, p_reason text, p_business_at timestamp with time zone, p_items jsonb, p_payments jsonb, p_customer_id uuid, p_vehicle_id uuid, p_initial_percent numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 if cs.id is not null then
  if p_initial_percent is null or p_initial_percent <= 0 or p_initial_percent > 100 or p_initial_percent::text in ('NaN','Infinity','-Infinity') then
   raise exception 'Indica el porcentaje real aprobado de inicial Cashea';
  end if;
 elsif p_initial_percent is not null then
  raise exception 'No se permite inicial Cashea en ventas sin Cashea';
 end if;
 select * into lc from public.receivables where order_id=p_order_id for update;
 perform lubricenter_private.cancel_order(p_order_id,p_reason);
 perform set_config('lubricenter.revision','yes',true);
 insert into public.orders(customer_id,vehicle_id,location_id,is_walk_in,business_at,corrects_order_id,health_status,health_notes,health_reviewed_at,crm_additional_services,crm_bonuses,crm_observations)
 values(p_customer_id,p_vehicle_id,o.location_id,o.is_walk_in,p_business_at,o.id,o.health_status,o.health_notes,o.health_reviewed_at,o.crm_additional_services,o.crm_bonuses,o.crm_observations) returning id into n;
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
  if ni.price_denomination='USD' then ni.agreed_usd:=round(ni.charged_ves_amount/ni.operative_rate_snapshot,4); end if;
  insert into public.order_items select ni.*;
 end loop;
 select sum(charged_ves_amount),sum(charged_ref_amount) into tv,tr from public.order_items where order_id=n;
 if tv<=0 then raise exception 'El total debe ser mayor que cero'; end if;
 if cs.id is not null then
  ns:=cs; ns.id:=gen_random_uuid(); ns.order_id:=n; ns.created_at:=now(); ns.created_by:=auth.uid(); ns.receivable_id:=null;
  ns.gross_ref:=tr; ns.gross_ves_snapshot:=tv; ns.initial_percent:=p_initial_percent; ns.initial_ref:=round(tr*p_initial_percent/100,4); ns.initial_ves_snapshot:=round(ns.initial_ref*cs.bcv_rate_snapshot,2);
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
   np.currency:=case when np.method in ('CASH_USD','ZELLE','BINANCE') then 'USD' else 'VES' end;
   np.financial_account_id:=null;
   if x ? 'credited_ves' and (cs.id is null or np.method <> 'CASH_USD') then
    raise exception 'La valoración manual solamente está disponible para iniciales Cashea en efectivo USD';
   end if;
   np.value_ves:=case when np.currency='USD' then
     case when cs.id is not null and np.method='CASH_USD' and x ? 'credited_ves'
       then round((x->>'credited_ves')::numeric,2)
       else round(np.amount_original*case when cs.id is not null then p.bcv_rate_snapshot else p.operative_rate_snapshot end,2)
     end
    else np.amount_original end;
   if cs.id is not null and np.method='CASH_USD' and x ? 'credited_ves' and
       (np.value_ves<=0 or np.value_ves>ns.initial_ves_snapshot or np.value_ves::text in ('NaN','Infinity','-Infinity')) then
     raise exception 'El valor aplicado en Bs al efectivo USD debe ser positivo y no superar la inicial Cashea';
   end if;
   np.value_ref:=round(np.value_ves/p.bcv_rate_snapshot,4);
  end if;
  if inst_id is null and p.receivable_id is null then np.paid_at:=p_business_at; end if;
  insert into public.payments select np.*;
  if cs.id is not null and np.method='CASH_USD' and x ? 'credited_ves' then
   insert into public.audit_events(event_type,entity_type,entity_id,data)
   values('order.cash_usd_commercial_valuation','payment',np.id,
     jsonb_build_object('original_payment_id',p.id,'amount_received_usd',np.amount_original,
       'value_ves_applied',np.value_ves,'effective_rate',round(np.value_ves/np.amount_original,6),
       'bcv_snapshot',p.bcv_rate_snapshot,'operative_snapshot',p.operative_rate_snapshot,
       'reason',p_reason,'order_id',n));
  end if;
  if inst_id is not null then
   if instmap->>inst_id::text is null then raise exception 'No se encontró la cuota original del pago'; end if;
   insert into public.audit_events(event_type,entity_type,entity_id,data) values('cashea.installment_payment_recorded','cashea_installment',(instmap->>inst_id::text)::uuid,jsonb_build_object('payment_id',np.id,'copied_from_payment_id',p.id,'value_ref',np.value_ref));
  else initial_paid:=initial_paid+np.value_ves; end if;
 end loop;
 if exists(select 1 from public.payments pay join public.audit_events a on a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=pay.id::text where pay.order_id=o.id and not exists(select 1 from jsonb_array_elements(p_payments) element where element.value->>'source_id'=pay.id::text)) then raise exception 'Conserva todos los pagos de cuotas Cashea ya recibidas'; end if;
 select coalesce(sum(value_ves),0) into pv from public.payments where order_id=n;
 if cs.id is not null then
  update public.cashea_sales set initial_payment_method=coalesce(
    (select case when count(distinct pp.method)>1 then 'MIXED' else max(pp.method) end
     from public.payments pp where pp.order_id=n
      and not exists(select 1 from public.audit_events ev where ev.event_type='cashea.installment_payment_recorded' and ev.data->>'payment_id'=pp.id::text)),
    cs.initial_payment_method) where id=new_sale;
 end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.correct_closed_order_v2(
 p_order_id uuid, p_reason text, p_business_at timestamptz, p_items jsonb, p_payments jsonb,
 p_customer_id uuid, p_vehicle_id uuid, p_initial_percent numeric
) RETURNS uuid LANGUAGE sql SET search_path TO '' AS $wrapper$
 SELECT lubricenter_private.correct_closed_order_v2(
  p_order_id,p_reason,p_business_at,p_items,p_payments,p_customer_id,p_vehicle_id,p_initial_percent);
$wrapper$;
REVOKE ALL ON FUNCTION lubricenter_private.correct_closed_order_v2(uuid,text,timestamptz,jsonb,jsonb,uuid,uuid,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.correct_closed_order_v2(uuid,text,timestamptz,jsonb,jsonb,uuid,uuid,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION lubricenter_private.correct_closed_order_v2(uuid,text,timestamptz,jsonb,jsonb,uuid,uuid,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_closed_order_v2(uuid,text,timestamptz,jsonb,jsonb,uuid,uuid,numeric) TO authenticated;

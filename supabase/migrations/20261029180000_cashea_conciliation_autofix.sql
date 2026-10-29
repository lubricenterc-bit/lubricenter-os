-- Conciliación Cashea: one-click correction of an OS payment that landed in the BNC.
-- The OS sometimes records a Cashea initial as TRANSFER_BDV, or with another reference,
-- although the BNC statement proves the money arrived at BNC ***4493. With the owner's
-- explicit confirmation this moves the payment and its cash movement to the BNC account and
-- stores the full bank reference. The amount is never changed: amount differences need a
-- human decision (overpayment, change or a wrong total) and keep the manual correction flow.
-- Additive: one new function, same guards as finance_autofix_bank_mismatches.

create or replace function lubricenter_private.cashea_conc_fix_payment(p_payment_id uuid,p_bank_line_id uuid,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype; l public.cashea_bnc_lines%rowtype; v_order public.orders%rowtype;
 v_bnc uuid; v_old_movement jsonb; v_ref text; v_paid_on date;
begin
 perform lubricenter_private.finance_require();
 perform lubricenter_private.require_order_admin();
 if p_confirmed is not true then raise exception 'Confirma la corrección'; end if;
 select * into p from public.payments where id=p_payment_id for update;
 if not found then raise exception 'Pago no encontrado'; end if;
 select * into v_order from public.orders where id=p.order_id;
 if v_order.status<>'CLOSED' then raise exception 'Solo se corrigen pagos de órdenes cerradas'; end if;
 if p.method not in ('TRANSFER_BDV','TRANSFER_BNC','MOBILE_PAYMENT') or p.currency<>'VES' then raise exception 'Solo se corrigen pagos bancarios en Bs'; end if;
 select * into l from public.cashea_bnc_lines where id=p_bank_line_id;
 if not found or l.credit<=0 then raise exception 'Abono del BNC no encontrado'; end if;
 v_ref:=regexp_replace(l.reference,'\D','','g');
 v_paid_on:=timezone('America/Caracas',p.paid_at)::date;
 if abs(l.line_date-v_paid_on)>1 then raise exception 'La fecha del banco (%) no corresponde al pago del OS (%)',l.line_date,v_paid_on; end if;
 if not (right(v_ref,4)=right(regexp_replace(coalesce(p.reference,''),'\D','','g'),4) or abs(l.credit-p.amount_original)<=0.01) then
  raise exception 'Ni la referencia ni el monto coinciden con el abono del BNC';
 end if;
 if p.method='TRANSFER_BNC' and regexp_replace(coalesce(p.reference,''),'\D','','g')=v_ref then raise exception 'El pago ya está registrado en el BNC con esta referencia'; end if;
 if exists(select 1 from public.payments z join public.financial_accounts a on a.id=z.financial_account_id and a.code='BNC'
   where z.id<>p.id and regexp_replace(coalesce(z.reference,''),'\D','','g')=v_ref) then
  raise exception 'Ese abono del BNC ya está asignado a otro pago del OS';
 end if;
 if exists(select 1 from public.reconciliation_allocations a join public.account_movements m on m.id=a.account_movement_id
   where a.reversed_at is null and m.source_payment_id=p.id) or exists(select 1 from public.order_tenders t where t.payment_id=p.id) then
  raise exception 'El pago tiene conciliación activa o vuelto auditado; revísalo manualmente';
 end if;
 select id into v_bnc from public.financial_accounts where code='BNC' and active;
 if v_bnc is null then raise exception 'La cuenta BNC no está activa'; end if;
 select to_jsonb(m) into v_old_movement from public.account_movements m where m.source_payment_id=p.id for update;
 if v_old_movement is null then raise exception 'El pago no tiene movimiento financiero asociado'; end if;
 update public.payments set method='TRANSFER_BNC',financial_account_id=v_bnc,reference=v_ref where id=p.id;
 update public.account_movements set account_id=v_bnc,reference=v_ref where source_payment_id=p.id;
 update public.cashea_sales s set initial_payment_method=
   case when (select count(distinct ip.method) from public.payments ip where ip.order_id=p.order_id and ip.receivable_id is null
      and not exists(select 1 from public.audit_events a where a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=ip.id::text))=1
    then (select min(ip.method) from public.payments ip where ip.order_id=p.order_id and ip.receivable_id is null
      and not exists(select 1 from public.audit_events a where a.event_type='cashea.installment_payment_recorded' and a.data->>'payment_id'=ip.id::text))
    else 'MIXED' end
 where s.order_id=p.order_id and s.status in ('ACTIVE','SETTLED');
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('cashea.conciliation_payment_fixed','payment',p.id,jsonb_build_object(
  'order_id',p.order_id,'order_number',v_order.order_number,'previous_payment',to_jsonb(p),'previous_movement',v_old_movement,
  'bank_line_id',l.id,'bank_date',l.line_date,'bank_reference',v_ref,'bank_amount',l.credit,
  'reason','Abono comprobado en el estado de cuenta BNC (conciliación Cashea)'));
 return jsonb_build_object('ok',true,'order_number',v_order.order_number,'method','TRANSFER_BNC','reference',v_ref);
end $$;

create or replace function public.cashea_conc_fix_payment(p_payment_id uuid,p_bank_line_id uuid,p_confirmed boolean)
returns jsonb language sql set search_path='' as $$ select lubricenter_private.cashea_conc_fix_payment(p_payment_id,p_bank_line_id,p_confirmed) $$;

revoke all on function lubricenter_private.cashea_conc_fix_payment(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function lubricenter_private.cashea_conc_fix_payment(uuid,uuid,boolean) to authenticated;
revoke all on function public.cashea_conc_fix_payment(uuid,uuid,boolean) from public,anon;
grant execute on function public.cashea_conc_fix_payment(uuid,uuid,boolean) to authenticated;

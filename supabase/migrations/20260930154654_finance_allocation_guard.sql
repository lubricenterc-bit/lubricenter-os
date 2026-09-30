-- A correction must not leave an allocation pointing to a changed financial
-- target. Reversing the allocation preserves its audit history before edit.
create function lubricenter_private.finance_guard_allocated_target()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='account_movements' then
  if (new.account_id,new.currency,new.direction,new.amount_original,new.reference,new.occurred_at,new.source_payment_id)
     is distinct from
     (old.account_id,old.currency,old.direction,old.amount_original,old.reference,old.occurred_at,old.source_payment_id)
     and exists(select 1 from public.reconciliation_allocations a
      where a.account_movement_id=old.id and a.reversed_at is null) then
   raise exception 'El movimiento tiene conciliaciones activas. Reviértelas antes de cambiar importe, cuenta, moneda, fecha o referencia';
  end if;
 elsif tg_table_name='cashea_installments' then
  if (new.cashea_sale_id,new.installment_no,new.amount_ref)
     is distinct from (old.cashea_sale_id,old.installment_no,old.amount_ref)
     and exists(select 1 from public.reconciliation_allocations a
      where a.cashea_installment_id=old.id and a.reversed_at is null) then
   raise exception 'La cuota tiene conciliaciones activas. Reviértelas antes de cambiar sus condiciones';
  end if;
 elsif tg_table_name='cashea_sales' then
  if (new.cashea_reference,new.initial_ref,new.ownership_status)
     is distinct from (old.cashea_reference,old.initial_ref,old.ownership_status)
     and exists(select 1 from public.reconciliation_allocations a
      where a.cashea_sale_id=old.id and a.reversed_at is null) then
   raise exception 'La inicial Cashea tiene conciliaciones activas. Reviértelas antes de cambiar sus condiciones';
  end if;
 end if;
 return new;
end $$;
revoke all on function lubricenter_private.finance_guard_allocated_target() from public,anon,authenticated;

create trigger finance_guard_allocated_movement
 before update on public.account_movements for each row
 execute function lubricenter_private.finance_guard_allocated_target();
create trigger finance_guard_allocated_installment
 before update on public.cashea_installments for each row
 execute function lubricenter_private.finance_guard_allocated_target();
create trigger finance_guard_allocated_initial
 before update on public.cashea_sales for each row
 execute function lubricenter_private.finance_guard_allocated_target();

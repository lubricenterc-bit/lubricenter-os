do $$
declare
  spec text[];
  specs text[][] := array[
    array['order_tenders',                'order_id'],
    array['order_tenders',                'customer_id'],
    array['order_change_returns',         'tender_id'],
    array['order_change_returns',         'movement_id'],
    array['order_items',                  'service_vehicle_id'],
    array['account_movements',            'tender_id'],
    array['customer_balance_movements',   'account_movement_id'],
    array['payroll_work_history',         'work_item_id'],
    array['payroll_work_items',           'payroll_run_id'],
    array['payroll_payments',             'account_movement_id'],
    array['cashea_payroll_policies',      'cashea_sale_id'],
    array['catalog_invoice_intake_lines', 'intake_id'],
    array['purchase_receipt_requests',    'supplier_invoice_id'],
    array['finance_cash_close_alerts',    'cash_closing_id'],
    array['finance_push_subscriptions',   'user_id'],
    array['filter_vehicle_applications',  'technical_spec_id']
  ];
begin
  foreach spec slice 1 in array specs loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = spec[1] and column_name = spec[2]
    ) then
      execute format('create index if not exists %I on public.%I (%I)',
        spec[1] || '_' || spec[2] || '_fk_idx', spec[1], spec[2]);
    end if;
  end loop;
end $$;

do $$
declare
  policies text[][] := array[
    array['crm_manual_cases',       'crm_manual_cases_staff_read',       '((select auth.uid()) is not null)', null],
    array['crm_manual_case_events', 'crm_manual_case_events_staff_read', '((select auth.uid()) is not null)', null],
    array['order_tenders',          'tender_read',                       '((select auth.uid()) is not null)', null],
    array['order_change_returns',   'change_read',                       '((select auth.uid()) is not null)', null],
    array['finance_push_subscriptions', 'own_push',
      '(user_id = (select auth.uid()))', '(user_id = (select auth.uid()))'],
    array['finance_push_deliveries', 'own_push_status',
      '(exists (select 1 from public.finance_push_subscriptions s where s.id = finance_push_deliveries.subscription_id and s.user_id = (select auth.uid())))', null],
    array['staff_users', 'staff_users_owner_or_self',
      '(lubricenter_private.staff_owner() or auth_user_id = (select auth.uid()))', null],
    array['staff_permissions', 'staff_permissions_owner_or_self',
      '(lubricenter_private.staff_owner() or exists (select 1 from public.staff_users s where s.id = staff_permissions.staff_user_id and s.auth_user_id = (select auth.uid())))', null],
    array['staff_tasks', 'staff_tasks_owner_or_self',
      '(lubricenter_private.staff_owner() or exists (select 1 from public.staff_users s where s.id = staff_tasks.staff_user_id and s.auth_user_id = (select auth.uid()) and s.active and lubricenter_private.staff_can(''tasks.view''::text)))', null]
  ];
  spec text[];
begin
  foreach spec slice 1 in array policies loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = spec[1] and policyname = spec[2]) then
      if spec[4] is null then
        execute format('alter policy %I on public.%I using %s', spec[2], spec[1], spec[3]);
      else
        execute format('alter policy %I on public.%I using %s with check %s', spec[2], spec[1], spec[3], spec[4]);
      end if;
    end if;
  end loop;
end $$;
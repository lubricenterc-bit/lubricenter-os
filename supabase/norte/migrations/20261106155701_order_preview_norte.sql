-- Adaptada para Norte (El Cují): etiqueta MOBILE_PAYMENT/TRANSFER_BDV = «Provincial · pago móvil o punto» (2 sitios). Resto idéntico a 20261105141734 order_preview de Cabudare.
-- F8 · Vista previa de órdenes: todo lo de una orden en una sola llamada.
-- public.order_preview es SECURITY INVOKER: lee con los mismos permisos (RLS)
-- con los que la persona ya ve la orden. La ganancia sale de una función privada
-- que solo responde a administración (OWNER/ADMIN, como la página Ganancias).

create or replace function lubricenter_private.order_preview_profit(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v jsonb;
begin
  if not lubricenter_private.staff_identity_allowed()
     or coalesce(lubricenter_private.finance_role(), '') not in ('OWNER', 'ADMIN') then
    return null;
  end if;
  select jsonb_build_object(
      'store_ref', round(coalesce(sum(e.revenue_ref - e.cost_ref - e.mechanics_ref - e.cashea_commission_ref)
                     filter (where e.area = 'TIENDA'), 0), 2),
      'workshop_ref', round(coalesce(sum(e.revenue_ref - e.cost_ref - e.mechanics_ref - e.cashea_commission_ref)
                     filter (where e.area = 'TALLER'), 0), 2),
      'total_ref', round(coalesce(sum(e.revenue_ref - e.cost_ref - e.mechanics_ref - e.cashea_commission_ref), 0), 2),
      'cashea_commission_ref', round(coalesce(sum(e.cashea_commission_ref), 0), 2),
      'estimated_cost', coalesce(bool_or(e.cost_estimated), false),
      'mechanics', coalesce((
        select jsonb_agg(jsonb_build_object('name', m.name, 'ref', round(m.ref, 2)) order by m.ref desc)
        from (
          select emp.name, sum(x.ref) as ref
          from (
            select i.worker_employee_id as employee_id, coalesce(i.worker_share_ref_snapshot, 0) as ref
              from public.order_items i where i.order_id = p_order_id and i.worker_employee_id is not null
            union all
            select i.assistant_bonus_employee_id, coalesce(i.assistant_bonus_ref_snapshot, 0)
              from public.order_items i where i.order_id = p_order_id and i.assistant_bonus_employee_id is not null
          ) x join public.employees emp on emp.id = x.employee_id
          group by emp.name having sum(x.ref) <> 0
        ) m), '[]'::jsonb))
  into v
  from public.order_line_economics e
  where e.order_id = p_order_id;
  return v;
end $$;

revoke all on function lubricenter_private.order_preview_profit(uuid) from public, anon;
grant execute on function lubricenter_private.order_preview_profit(uuid) to authenticated;

create or replace function public.order_preview(p_order_id uuid)
returns jsonb language plpgsql stable security invoker set search_path to '' as $$
declare
  o public.orders;
  v_lines jsonb;
  v_store jsonb;
  v_workshop jsonb;
  v_internal jsonb;
  v_store_n int;
  v_workshop_n int;
  v_total_ref numeric;
  v_total_ves numeric;
  v_collected_ref numeric;
  v_collected_ves numeric;
  v_cashea jsonb;
  v_credit jsonb;
  v_pending numeric := 0;
  v_vehicle record;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;

  with it as (
    select i.id, i.created_at, i.item_type, i.business_area, i.quantity,
      coalesce(i.list_ref_amount, i.charged_ref_amount) as total_ref,
      lubricenter_private.receipt_line_name(i.description, ii.display_name) as name,
      lubricenter_private.receipt_line_is_cashea_internal(i) as cashea_internal,
      lubricenter_private.effective_line_role(i) as role,
      coalesce(i.business_area, 'STORE') in ('WORKSHOP', 'ELECTROAUTO') as workshop,
      emp.name as mechanic
    from public.order_items i
    left join public.inventory_items ii on ii.id = i.inventory_item_id
    left join public.employees emp on emp.id = i.worker_employee_id
    where i.order_id = p_order_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
        'name', case when it.item_type = 'SERVICE' and it.business_area = 'OIL_CHANGE' and it.total_ref = 0
                     then 'Cambio de aceite (cortesía)' else it.name end,
        'qty', trim_scale(round(it.quantity, 2)),
        'unit_price_ref', case when round(it.quantity, 2) > 0 then round(it.total_ref / round(it.quantity, 2), 2) end,
        'total_ref', round(it.total_ref, 2),
        'kind', it.item_type,
        'area', coalesce(it.business_area, 'STORE'))
      order by it.created_at, it.id) filter (where not it.cashea_internal and not it.workshop), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
        'name', it.name,
        'qty', trim_scale(round(it.quantity, 2)),
        'total_ref', round(it.total_ref, 2),
        'kind', it.item_type,
        'area', it.business_area,
        'mechanic', it.mechanic)
      order by it.created_at, it.id) filter (where not it.cashea_internal and it.workshop), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
        'name', it.name,
        'total_ref', round(it.total_ref, 2),
        'role', case when it.role = 'CASHEA_SURCHARGE' then 'CASHEA_SURCHARGE' else 'MANUAL_CASHEA' end)
      order by it.created_at, it.id) filter (where it.cashea_internal), '[]'::jsonb),
    count(*) filter (where not it.cashea_internal and not it.workshop),
    count(*) filter (where not it.cashea_internal and it.workshop)
  into v_store, v_workshop, v_internal, v_store_n, v_workshop_n
  from it;

  if o.status in ('OPEN', 'CANCELLED') then
    select coalesce(sum(i.charged_ref_amount), 0), coalesce(sum(i.charged_ves_amount), 0)
      into v_total_ref, v_total_ves
    from public.order_items i where i.order_id = p_order_id;
  else
    v_total_ref := o.total_ref;
    v_total_ves := o.total_ves;
  end if;

  select coalesce(sum(coalesce(p.applied_ref, p.value_ref)), 0),
         coalesce(sum(p.amount_original) filter (where p.currency = 'VES'), 0)
    into v_collected_ref, v_collected_ves
  from public.payments p where p.order_id = p_order_id;

  select jsonb_build_object(
      'reference', nullif(btrim(cs.cashea_reference), ''),
      'initial_percent', trim_scale(cs.initial_percent),
      'initial_ref', round(cs.initial_ref, 2),
      'financed_ref', round(cs.financed_ref, 2),
      'status', cs.status,
      'installments', coalesce((select jsonb_agg(jsonb_build_object(
          'no', ci.installment_no, 'due', ci.due_date,
          'amount_ref', round(ci.amount_ref, 2), 'paid_ref', round(coalesce(ci.paid_ref, 0), 2),
          'status', ci.status,
          'overdue', ci.status <> 'PAID' and ci.due_date < (now() at time zone 'America/Caracas')::date)
        order by ci.installment_no)
        from public.cashea_installments ci where ci.cashea_sale_id = cs.id), '[]'::jsonb)),
    coalesce((select sum(greatest(ci.amount_ref - coalesce(ci.paid_ref, 0), 0))
              from public.cashea_installments ci where ci.cashea_sale_id = cs.id and ci.status <> 'PAID'), 0)
  into v_cashea, v_pending
  from public.cashea_sales cs
  where cs.order_id = p_order_id and cs.status <> 'CANCELLED'
  order by cs.created_at desc limit 1;
  v_pending := coalesce(v_pending, 0);

  select jsonb_build_object(
      'status', rv.status,
      'outstanding_ves', round(rv.outstanding_ves, 2),
      'outstanding_ref', round(coalesce(rv.principal_ref * rv.outstanding_fraction,
        rv.principal_ref * rv.outstanding_ves / nullif(rv.principal_ves, 0), 0), 2))
  into v_credit
  from public.receivables rv where rv.order_id = p_order_id
  order by (rv.status = 'OPEN') desc, rv.created_at desc limit 1;
  if v_credit is not null and v_credit->>'status' = 'OPEN' then
    v_pending := v_pending + coalesce((v_credit->>'outstanding_ref')::numeric, 0);
  end if;

  select v.id, v.plate, v.make, v.model, v.year into v_vehicle from public.vehicles v where v.id = o.vehicle_id;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', o.id,
      'number', o.order_number,
      'status', o.status,
      'at', coalesce(o.closed_at, o.business_at, o.opened_at),
      'attendant', coalesce(
        (select nullif(btrim(a.attendant), '') from public.order_attendants a where a.order_id = p_order_id),
        nullif(btrim(o.attended_by), '')),
      'kind', case when v_workshop_n > 0 and v_store_n > 0 then 'MIXED'
                   when v_workshop_n > 0 then 'WORKSHOP' else 'STORE' end,
      'payment_type', case when v_cashea is not null then 'CASHEA'
                           when v_credit is not null then 'CREDIT' else 'CASH' end,
      'cancellation_reason', o.cancellation_reason),
    'customer', (select jsonb_build_object('id', c.id, 'name', nullif(btrim(c.name), ''), 'phone', nullif(btrim(c.phone), ''))
                 from public.customers c where c.id = o.customer_id),
    'vehicle', case when v_vehicle.id is null then null else jsonb_build_object(
        'id', v_vehicle.id,
        'plate', nullif(btrim(v_vehicle.plate), ''),
        'label', nullif(btrim(concat_ws(' ', initcap(v_vehicle.make), initcap(v_vehicle.model), v_vehicle.year)), ''),
        'odometer', (select s.odometer from public.service_records s
                     where s.order_id = p_order_id and s.odometer is not null
                     order by s.performed_at desc limit 1)) end,
    'groups', jsonb_build_object(
      'store', jsonb_build_object(
        'subtotal_ref', (select round(coalesce(sum((x->>'total_ref')::numeric), 0), 2) from jsonb_array_elements(v_store) x),
        'lines', v_store),
      'workshop', jsonb_build_object(
        'subtotal_ref', (select round(coalesce(sum((x->>'total_ref')::numeric), 0), 2) from jsonb_array_elements(v_workshop) x),
        'lines', v_workshop),
      'internal', v_internal),
    'adjustments', jsonb_build_object(
      'discount_ref', round(coalesce(o.adjust_discount_ref, 0), 2),
      'discount_pct', trim_scale(coalesce(o.adjust_discount_percent, 0)),
      'discount_reason', nullif(btrim(o.adjust_discount_reason), ''),
      'owner_approved', coalesce(o.adjust_owner_approved, false),
      'rounding_ref', round(coalesce(o.adjust_rounding_ref, 0), 2)),
    'totals', jsonb_build_object(
      'ref', round(v_total_ref, 2),
      'ves', round(v_total_ves, 2),
      'bcv_rate', round(coalesce(o.sale_bcv_rate, v_total_ves / nullif(v_total_ref, 0)), 4),
      'collected_ref', round(v_collected_ref, 2),
      'collected_ves', round(v_collected_ves, 2),
      'pending_ref', round(v_pending, 2)),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'method', p.method,
        'label', case p.method
          when 'MOBILE_PAYMENT' then 'Provincial · pago móvil o punto'
          when 'TRANSFER_BDV' then 'Provincial · pago móvil o punto'
          when 'TRANSFER_BNC' then 'Pago móvil · BNC'
          when 'CASH_VES' then 'Efectivo Bs'
          when 'CASH_USD' then 'Efectivo USD'
          when 'ZELLE' then 'Zelle'
          when 'BINANCE' then 'Binance USDT'
          when 'CUSTOMER_BALANCE_USD' then 'Saldo a favor · USD'
          when 'CUSTOMER_BALANCE_BCV' then 'Saldo a favor · Bs a BCV'
          else replace(p.method, '_', ' ') end,
        'ref_tail', nullif(right(regexp_replace(coalesce(p.reference, ''), '[^0-9A-Za-z]', '', 'g'), 4), ''),
        'currency', p.currency,
        'amount', round(p.amount_original, 2),
        'equivalent_ref', round(coalesce(p.applied_ref, p.value_ref), 2),
        'paid_at', p.paid_at
      ) order by p.paid_at, p.id), '[]'::jsonb)
      from public.payments p where p.order_id = p_order_id),
    'cashea', v_cashea,
    'credit', v_credit,
    'profit', lubricenter_private.order_preview_profit(p_order_id)
  );
end $$;

revoke all on function public.order_preview(uuid) from public, anon;
grant execute on function public.order_preview(uuid) to authenticated;

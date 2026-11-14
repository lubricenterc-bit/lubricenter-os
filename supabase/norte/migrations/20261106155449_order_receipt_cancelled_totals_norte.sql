-- Adaptada para Norte (El Cují): etiqueta MOBILE_PAYMENT/TRANSFER_BDV = «Provincial · pago móvil o punto» (2 sitios). Resto idéntico a 20261104192733 order_receipt_cancelled_totals de Cabudare.
-- Recibo: las órdenes anuladas tienen total 0 en orders; el total sale de sus
-- líneas, igual que en las cotizaciones (banda «Anulada · sin validez»).

create or replace function public.order_receipt(p_order_id uuid)
returns jsonb language plpgsql stable security invoker set search_path to '' as $$
declare
  o public.orders;
  v_header jsonb;
  v_style text;
  v_extra numeric;
  v_target uuid;
  v_lines jsonb;
  v_total_ref numeric;
  v_total_ves numeric;
  v_plate text;
  r record;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Orden no encontrada'; end if;

  select s.value into v_header from public.app_settings s where s.key = 'receipt_header';
  select s.value #>> '{}' into v_style from public.app_settings s where s.key = 'receipt_total_style';
  v_header := coalesce(v_header, '{}'::jsonb) || jsonb_build_object(
    'total_style', case when v_style in ('BLOCK', 'BORDER') then v_style else 'BLOCK' end);

  -- Recargos y ajustes de Cashea: se suman a la mano de obra de mayor monto.
  select coalesce(sum(coalesce(i.list_ref_amount, i.charged_ref_amount)), 0) into v_extra
  from public.order_items i
  where i.order_id = p_order_id and lubricenter_private.receipt_line_is_cashea_internal(i);

  select i.id into v_target from public.order_items i
  where i.order_id = p_order_id and i.item_type = 'SERVICE' and i.business_area in ('WORKSHOP', 'ELECTROAUTO')
    and not lubricenter_private.receipt_line_is_cashea_internal(i)
  order by coalesce(i.list_ref_amount, i.charged_ref_amount) desc, i.created_at
  limit 1;

  with it as (
    select i.id, i.created_at, i.item_type, i.business_area, i.quantity,
      coalesce(i.list_ref_amount, i.charged_ref_amount)
        + case when i.id = v_target then v_extra else 0 end as line_total,
      lubricenter_private.receipt_line_name(i.description, ii.display_name) as name,
      ii.category, ii.unit,
      (i.item_type = 'SERVICE' and i.business_area = 'OIL_CHANGE'
        and coalesce(i.list_ref_amount, i.charged_ref_amount) = 0) as courtesy
    from public.order_items i
    left join public.inventory_items ii on ii.id = i.inventory_item_id
    where i.order_id = p_order_id and not lubricenter_private.receipt_line_is_cashea_internal(i)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', case when it.courtesy then 'Cambio de aceite' else it.name end,
      'qty', trim_scale(round(it.quantity, 2)),
      'unit_label', case
        when it.courtesy then 'Mano de obra'
        when it.unit = 'GAL' then 'galón'
        when it.category = 'Aceite Motor' then 'L'
      end,
      'unit_price_ref', case when round(it.quantity, 2) > 0 then round(it.line_total / round(it.quantity, 2), 2) end,
      'total_ref', round(it.line_total, 2),
      'kind', it.item_type,
      'courtesy', it.courtesy
    ) order by it.created_at, it.id), '[]'::jsonb)
  into v_lines
  from it;

  if v_extra <> 0 and v_target is null then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'name', 'Cargo por financiamiento', 'qty', 1, 'unit_label', null,
      'unit_price_ref', round(v_extra, 2), 'total_ref', round(v_extra, 2), 'kind', 'SERVICE', 'courtesy', false));
  end if;

  -- Abiertas y anuladas no guardan total: sale de sus líneas.
  if o.status in ('OPEN', 'CANCELLED') then
    select coalesce(sum(i.charged_ref_amount), 0), coalesce(sum(i.charged_ves_amount), 0)
      into v_total_ref, v_total_ves
    from public.order_items i where i.order_id = p_order_id;
  else
    v_total_ref := o.total_ref;
    v_total_ves := o.total_ves;
  end if;

  select v.id, v.plate, v.make, v.model into r from public.vehicles v where v.id = o.vehicle_id;
  v_plate := regexp_replace(upper(coalesce(r.plate, '')), '[[:space:]-]', '', 'g');
  if v_plate !~ '^[A-Z0-9]{5,8}$' or v_plate in ('NOTIENE', 'SINPLACA', 'NA', '0', 'S/P') then v_plate := null; end if;

  return jsonb_build_object(
    'header', v_header,
    'order', jsonb_build_object(
      'number', o.order_number,
      'status', o.status,
      'at', coalesce(o.closed_at, o.opened_at),
      'attendant', (select nullif(btrim(a.attendant), '') from public.order_attendants a where a.order_id = p_order_id)),
    'customer', (select case when c.id is null then null else jsonb_build_object(
        'name', nullif(btrim(c.name), ''),
        'phone_tail', nullif(right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 4), ''))
      end from public.customers c where c.id = o.customer_id),
    'vehicle', case when o.vehicle_id is null then null else jsonb_build_object(
        'label', nullif(btrim(concat_ws(' ', initcap(r.make), initcap(r.model))), ''),
        'plate', v_plate,
        'odometer', (select s.odometer from public.service_records s
                     where s.order_id = p_order_id and s.vehicle_id = o.vehicle_id and s.odometer is not null
                     order by s.performed_at desc limit 1))
      end,
    'lines', v_lines,
    'adjustments', jsonb_build_object(
      'discount_ref', round(coalesce(o.adjust_discount_ref, 0), 2),
      'rounding_ref', round(coalesce(o.adjust_rounding_ref, 0), 2)),
    'totals', jsonb_build_object(
      'ref', round(v_total_ref, 2),
      'ves', round(v_total_ves, 2),
      'bcv_rate', round(coalesce(o.sale_bcv_rate, v_total_ves / nullif(v_total_ref, 0)), 4)),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'label', case p.method
          when 'MOBILE_PAYMENT' then 'Provincial · pago móvil o punto'
          when 'TRANSFER_BDV' then 'Provincial · pago móvil o punto'
          when 'TRANSFER_BNC' then 'Pago móvil · BNC'
          when 'CASH_VES' then 'Efectivo Bs'
          when 'CASH_USD' then 'Efectivo USD'
          when 'ZELLE' then 'Zelle'
          when 'CUSTOMER_BALANCE_USD' then 'Saldo a favor · USD'
          when 'CUSTOMER_BALANCE_BCV' then 'Saldo a favor · Bs a BCV'
          else p.method end,
        'ref_tail', nullif(right(regexp_replace(coalesce(p.reference, ''), '[^0-9A-Za-z]', '', 'g'), 4), ''),
        'currency', p.currency,
        'amount', round(p.amount_original, 2)
      ) order by p.paid_at, p.id), '[]'::jsonb)
      from public.payments p where p.order_id = p_order_id),
    'change', (select coalesce(jsonb_agg(jsonb_build_object(
        'received', round(t.received, 2),
        'currency', t.currency,
        'returned_usd', round(coalesce(t.returned_usd, 0), 2),
        'pending_usd', round(greatest(coalesce(t.change_usd, 0) - coalesce(t.returned_usd, 0), 0), 2)
      ) order by t.created_at), '[]'::jsonb)
      from public.order_tenders t where t.order_id = p_order_id and coalesce(t.change_usd, 0) > 0),
    'cashea', (select jsonb_build_object(
        'initial_percent', trim_scale(cs.initial_percent),
        'initial_ref', round(cs.initial_ref, 2),
        'installments', (select coalesce(jsonb_agg(jsonb_build_object(
            'no', ci.installment_no, 'due', ci.due_date, 'amount_ref', round(ci.amount_ref, 2), 'status', ci.status
          ) order by ci.installment_no), '[]'::jsonb)
          from public.cashea_installments ci where ci.cashea_sale_id = cs.id))
      from public.cashea_sales cs where cs.order_id = p_order_id and cs.status <> 'CANCELLED'
      order by cs.created_at desc limit 1),
    'credit', (select jsonb_build_object(
        'outstanding_ves', round(rv.outstanding_ves, 2),
        'outstanding_ref', round(coalesce(rv.principal_ref * rv.outstanding_fraction,
          rv.principal_ref * rv.outstanding_ves / nullif(rv.principal_ves, 0), 0), 2))
      from public.receivables rv where rv.order_id = p_order_id and rv.status = 'OPEN'
      order by rv.created_at desc limit 1),
    'next_service', (select jsonb_build_object(
        'odometer', s.next_service_odometer,
        'date', s.next_service_date,
        'oil', nullif(btrim(concat_ws(' ', nullif(lubricenter_private.receipt_line_name(s.oil_brand, null), 'Producto'),
          case when s.oil_viscosity is not null
            and position(regexp_replace(upper(s.oil_viscosity), '[^A-Z0-9]', '', 'g')
                         in regexp_replace(upper(coalesce(s.oil_brand, '')), '[^A-Z0-9]', '', 'g')) = 0
            then s.oil_viscosity end)), ''),
        'filter', nullif(btrim(s.oil_filter_code), ''))
      from public.service_records s
      where s.order_id = p_order_id and s.service_type = 'OIL_CHANGE'
        and (s.next_service_odometer is not null or s.next_service_date is not null)
      order by s.performed_at desc limit 1)
  );
end $$;

revoke all on function public.order_receipt(uuid) from public, anon;
grant execute on function public.order_receipt(uuid) to authenticated;

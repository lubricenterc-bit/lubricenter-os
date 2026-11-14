-- Editar facturas de proveedor (solo la cuenta del dueño: require_order_admin).
-- Aditiva: función nueva supplier_invoice_update y supplier_invoice_detail devuelve
-- además el historial de cambios («edits»). No toca create_supplier_invoice,
-- inventory_receive_purchase ni record_supplier_payment.
--
-- Reglas:
-- * Se puede cambiar número, fechas, notas, impuesto, flete, descuento y las líneas
--   (producto, cantidad, costo, agregar y quitar).
-- * Proveedor y moneda solo si la factura no tiene pagos.
-- * El total no puede quedar por debajo de lo ya pagado.
-- * Una línea que ya ingresó al inventario no se puede quitar (su historial de
--   recepción se conserva); sí se puede corregir su producto, cantidad o costo.
--   La diferencia de existencia entra como ajuste (ADJUSTMENT) en la misma sede
--   de la recepción, y el costo promedio se recalcula quitando lo que entró con el
--   costo viejo y sumando lo que entra con el costo nuevo.
-- * Si la línea estaba recibida completa, se asume que lo recibido es la cantidad
--   corregida. Si estaba recibida a medias, lo pendiente queda para «Recibir mercancía».
-- * Cada cambio queda en audit_events (supplier_invoice.edited) con antes y después.

create or replace function lubricenter_private.supplier_invoice_update(
  p_invoice_id uuid, p_expected_updated_at timestamptz, p_supplier_id uuid, p_invoice_number text,
  p_invoice_date date, p_due_date date, p_currency text, p_items jsonb,
  p_tax numeric, p_discount numeric, p_freight numeric, p_notes text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_inv public.supplier_invoices;
  v_line public.supplier_invoice_items;
  v_entry jsonb;
  v_currency text := upper(coalesce(p_currency, ''));
  v_has_payments boolean;
  v_bcv numeric; v_op numeric;
  v_tol numeric;
  v_subtotal numeric := 0; v_total numeric;
  v_status text; v_paid numeric;
  v_line_id uuid; v_type text; v_item uuid; v_qty numeric; v_cost numeric; v_cost_ref numeric;
  v_desc text; v_cat text; v_new_recv numeric; v_loc uuid;
  v_seen uuid[] := '{}';
  v_before jsonb; v_after jsonb; v_adjust jsonb := '[]'::jsonb;
  r record;
  v_stock numeric; v_avg numeric; v_fallback numeric;
begin
  if not lubricenter_private.is_order_admin() then
    raise exception 'Solo la cuenta del dueño (lubricenterc@gmail.com) puede editar facturas de proveedor';
  end if;

  select * into v_inv from public.supplier_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Factura no encontrada'; end if;
  if v_inv.status = 'VOID' then raise exception 'La factura está anulada y no se puede editar'; end if;
  if p_expected_updated_at is not null and v_inv.updated_at is distinct from p_expected_updated_at then
    raise exception 'La factura cambió mientras la editabas. Ciérrala y vuelve a abrirla.';
  end if;

  v_has_payments := exists (select 1 from public.supplier_payments where supplier_invoice_id = p_invoice_id);
  if v_currency not in ('USD', 'VES') then raise exception 'Moneda inválida'; end if;
  if v_has_payments and p_supplier_id is distinct from v_inv.supplier_id then
    raise exception 'La factura ya tiene pagos: no se puede cambiar el proveedor';
  end if;
  if v_has_payments and v_currency <> v_inv.currency then
    raise exception 'La factura ya tiene pagos: no se puede cambiar la moneda';
  end if;
  if p_supplier_id is distinct from v_inv.supplier_id
     and not exists (select 1 from public.suppliers where id = p_supplier_id and active) then
    raise exception 'Proveedor no encontrado o inactivo';
  end if;
  if coalesce(btrim(p_invoice_number), '') = '' then raise exception 'Indica el número de factura'; end if;
  if p_invoice_date is null or p_invoice_date > timezone('America/Caracas', now())::date then raise exception 'Fecha de factura inválida'; end if;
  if p_due_date is not null and p_due_date < p_invoice_date then raise exception 'El vencimiento no puede ser anterior a la factura'; end if;
  if coalesce(p_tax, 0) < 0 or coalesce(p_discount, 0) < 0 or coalesce(p_freight, 0) < 0 then raise exception 'Impuesto, flete y descuento no pueden ser negativos'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'La factura debe tener de 1 a 100 líneas';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_supplier_id::text || '|' || upper(btrim(p_invoice_number)), 221105));
  if exists (select 1 from public.supplier_invoices si
             where si.supplier_id = p_supplier_id and si.status <> 'VOID' and si.id <> p_invoice_id
               and upper(btrim(si.invoice_number)) = upper(btrim(p_invoice_number))) then
    raise exception 'Ya existe la factura % de este proveedor.', btrim(p_invoice_number);
  end if;

  -- Tasas: se conservan salvo que cambie la fecha o la moneda.
  if p_invoice_date = v_inv.invoice_date and v_currency = v_inv.currency then
    v_bcv := v_inv.bcv_rate_snapshot; v_op := v_inv.operative_rate_snapshot;
  else
    select value into v_bcv from public.exchange_rates where rate_type = 'BCV' and timezone('America/Caracas', effective_at)::date <= p_invoice_date order by effective_at desc limit 1;
    select value into v_op from public.exchange_rates where rate_type = 'OPERATIVE' and timezone('America/Caracas', effective_at)::date <= p_invoice_date order by effective_at desc limit 1;
    if v_bcv is null or v_op is null then select bcv_rate, operative_rate into v_bcv, v_op from public.current_exchange_rates; end if;
    if v_bcv is null or v_bcv <= 0 or v_op is null or v_op <= 0 then raise exception 'No hay tasas para la fecha de la factura'; end if;
  end if;

  -- Foto de antes (para el historial).
  select to_jsonb(v_inv) || jsonb_build_object('items', coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb))
    into v_before from public.supplier_invoice_items x where x.supplier_invoice_id = p_invoice_id;

  create temp table if not exists _sie_effects(
    inventory_item_id uuid, location_id uuid, qty numeric, value_ref numeric, new_cost_ref numeric) on commit drop;
  truncate pg_temp._sie_effects;

  -- 1. Validar todas las líneas antes de cambiar nada.
  for v_entry in select value from jsonb_array_elements(p_items) loop
    v_line_id := nullif(v_entry->>'id', '')::uuid;
    v_type := upper(coalesce(v_entry->>'line_type', ''));
    v_qty := nullif(v_entry->>'quantity', '')::numeric;
    v_cost := nullif(v_entry->>'unit_cost', '')::numeric;
    if v_type not in ('INVENTORY', 'EXPENSE') then raise exception 'Tipo de línea inválido'; end if;
    if v_qty is null or v_qty <= 0 or v_cost is null or v_cost < 0 then raise exception 'Revisa cantidad y costo de cada línea'; end if;
    if v_type = 'INVENTORY' then
      v_item := nullif(v_entry->>'inventory_item_id', '')::uuid;
      if not exists (select 1 from public.inventory_items where id = v_item and active) then raise exception 'Producto de inventario no encontrado o inactivo'; end if;
    elsif coalesce(btrim(v_entry->>'description'), '') = '' then raise exception 'Describe la línea de gasto';
    end if;
    if v_line_id is not null then
      if v_line_id = any(v_seen) then raise exception 'Línea repetida'; end if;
      v_seen := array_append(v_seen, v_line_id);
      select * into v_line from public.supplier_invoice_items where id = v_line_id and supplier_invoice_id = p_invoice_id for update;
      if not found then raise exception 'La línea no pertenece a esta factura'; end if;
      if v_line.received_quantity > 0 and v_type <> 'INVENTORY' then
        raise exception '«%» ya ingresó al inventario: no puede pasar a gasto', v_line.description;
      end if;
    end if;
    v_subtotal := v_subtotal + v_qty * v_cost;
  end loop;

  for v_line in select * from public.supplier_invoice_items
                where supplier_invoice_id = p_invoice_id and not (id = any(v_seen)) loop
    if v_line.received_quantity > 0 then
      raise exception '«%» ya ingresó al inventario y no se puede quitar. Corrige su producto o su cantidad.', v_line.description;
    end if;
  end loop;

  v_total := round(v_subtotal + coalesce(p_tax, 0) + coalesce(p_freight, 0) - coalesce(p_discount, 0), 2);
  if v_total < 0 then raise exception 'El total de la factura no puede ser negativo'; end if;
  v_tol := case when v_currency = 'USD' then 0.05 else 1 end;
  if v_has_payments and v_total < v_inv.paid_original - v_tol then
    raise exception 'Ya se pagaron % de esta factura: el total no puede quedar por debajo', v_inv.paid_original;
  end if;

  -- 2. Quitar líneas sin recepción que ya no están.
  delete from public.supplier_invoice_items
  where supplier_invoice_id = p_invoice_id and not (id = any(v_seen)) and received_quantity = 0;

  -- 3. Actualizar o crear líneas y anotar el efecto en el inventario.
  for v_entry in select value from jsonb_array_elements(p_items) loop
    v_line_id := nullif(v_entry->>'id', '')::uuid;
    v_type := upper(v_entry->>'line_type');
    v_qty := (v_entry->>'quantity')::numeric;
    v_cost := (v_entry->>'unit_cost')::numeric;
    v_cost_ref := case when v_currency = 'USD' then v_cost else round(v_cost / v_bcv, 4) end;
    v_item := case when v_type = 'INVENTORY' then (v_entry->>'inventory_item_id')::uuid end;
    v_desc := btrim(coalesce(v_entry->>'description', ''));
    v_cat := nullif(btrim(coalesce(v_entry->>'expense_category', '')), '');
    if v_type = 'INVENTORY' then
      select coalesce(nullif(v_desc, ''), coalesce(nullif(btrim(display_name), ''), description)) into v_desc from public.inventory_items where id = v_item;
      v_cat := null;
    end if;

    if v_line_id is null then
      insert into public.supplier_invoice_items(supplier_invoice_id, line_type, inventory_item_id, description, expense_category,
        quantity, unit_cost_original, unit_cost_ref, line_total_original)
      values (p_invoice_id, v_type, v_item, v_desc, v_cat, v_qty, v_cost, v_cost_ref, round(v_qty * v_cost, 2));
      continue;
    end if;

    select * into v_line from public.supplier_invoice_items where id = v_line_id;
    v_new_recv := case when v_line.received_quantity <= 0 then 0
                       when v_line.received_quantity >= v_line.quantity then v_qty
                       else least(v_line.received_quantity, v_qty) end;

    if v_line.received_quantity > 0 then
      select rc.location_id into v_loc from public.supplier_receipt_items ri
        join public.supplier_receipts rc on rc.id = ri.supplier_receipt_id
      where ri.supplier_invoice_item_id = v_line.id order by rc.created_at desc limit 1;
      v_loc := coalesce(v_loc, (select id from public.locations where code = 'CABUDARE' and active limit 1));
      insert into pg_temp._sie_effects values
        (v_line.inventory_item_id, v_loc, -v_line.received_quantity, -v_line.received_quantity * v_line.unit_cost_ref, null),
        (v_item, v_loc, v_new_recv, v_new_recv * v_cost_ref, case when v_new_recv > 0 then v_cost_ref end);
    end if;

    update public.supplier_invoice_items set
      line_type = v_type, inventory_item_id = v_item, description = v_desc, expense_category = v_cat,
      quantity = v_qty, unit_cost_original = v_cost, unit_cost_ref = v_cost_ref,
      line_total_original = round(v_qty * v_cost, 2), received_quantity = v_new_recv
    where id = v_line.id;
  end loop;

  -- 4. Existencia: un ajuste por artículo y sede cuando cambia la cantidad recibida.
  for r in select e.inventory_item_id, e.location_id, sum(e.qty) as qty
           from pg_temp._sie_effects e group by 1, 2 having sum(e.qty) <> 0
           order by 1, 2 loop
    insert into public.inventory_movements(inventory_item_id, location_id, quantity_delta, movement_type, note, occurred_at)
    values (r.inventory_item_id, r.location_id, r.qty, 'ADJUSTMENT',
      'Corrección de la factura ' || btrim(p_invoice_number) || coalesce(' · ' || nullif(btrim(p_reason), ''), ''), now());
    v_adjust := v_adjust || jsonb_build_object('inventory_item_id', r.inventory_item_id, 'location_id', r.location_id, 'quantity', r.qty);
  end loop;

  -- 5. Costo promedio: quitar lo que entró al costo viejo y sumar lo que entra al costo nuevo.
  for r in select e.inventory_item_id, sum(e.qty) as qty, sum(e.value_ref) as value_ref, max(e.new_cost_ref) as new_cost_ref
           from pg_temp._sie_effects e group by 1 order by 1 loop
    if r.qty = 0 and r.value_ref = 0 then continue; end if;
    select coalesce(sum(m.quantity_delta), 0) - r.qty into v_stock          -- existencia antes del ajuste
      from public.inventory_movements m where m.inventory_item_id = r.inventory_item_id;
    select case
             when v_stock + r.qty <= 0 then coalesce(r.new_cost_ref, i.average_cost_ref)
             when v_stock <= 0 or coalesce(i.average_cost_ref, 0) <= 0 or coalesce(i.cost_missing, false)
               then coalesce(r.new_cost_ref, i.average_cost_ref)
             when v_stock * i.average_cost_ref + r.value_ref <= 0 then coalesce(r.new_cost_ref, i.average_cost_ref)
             else round((v_stock * i.average_cost_ref + r.value_ref) / (v_stock + r.qty), 4)
           end into v_avg
      from public.inventory_items i where i.id = r.inventory_item_id for update;
    -- Último costo de compra: solo si la recepción más reciente del artículo es de esta factura.
    select case when r.new_cost_ref is not null and exists (
             select 1 from (select ri.supplier_invoice_item_id from public.supplier_receipt_items ri
                            where ri.inventory_item_id = r.inventory_item_id order by ri.created_at desc limit 1) last
             join public.supplier_invoice_items ii on ii.id = last.supplier_invoice_item_id
             where ii.supplier_invoice_id = p_invoice_id) then r.new_cost_ref end into v_fallback;
    update public.inventory_items set
      average_cost_ref = coalesce(v_avg, average_cost_ref),
      cost_missing = case when coalesce(v_avg, 0) > 0 then false else cost_missing end,
      last_purchase_cost_ref = coalesce(v_fallback, last_purchase_cost_ref),
      updated_at = now()
    where id = r.inventory_item_id;
  end loop;

  -- 6. Cabecera, totales y estado del pago.
  v_paid := least(v_inv.paid_original, v_total);
  v_status := case when v_inv.paid_original <= 0 then 'OPEN'
                   when v_inv.paid_original >= v_total - v_tol then 'PAID'
                   else 'PARTIAL' end;
  if v_status = 'PAID' then v_paid := v_total; end if;
  update public.supplier_invoices set
    supplier_id = p_supplier_id, invoice_number = btrim(p_invoice_number), invoice_date = p_invoice_date,
    due_date = p_due_date, currency = v_currency, bcv_rate_snapshot = v_bcv, operative_rate_snapshot = v_op,
    subtotal_original = round(v_subtotal, 2), tax_original = coalesce(p_tax, 0), discount_original = coalesce(p_discount, 0),
    freight_original = coalesce(p_freight, 0), total_original = v_total, paid_original = v_paid, status = v_status,
    notes = nullif(btrim(p_notes), ''), updated_at = now()
  where id = p_invoice_id
  returning * into v_inv;

  select to_jsonb(v_inv) || jsonb_build_object('items', coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb))
    into v_after from public.supplier_invoice_items x where x.supplier_invoice_id = p_invoice_id;

  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('supplier_invoice.edited', 'supplier_invoice', p_invoice_id,
    jsonb_build_object('reason', nullif(btrim(p_reason), ''), 'before', v_before, 'after', v_after, 'adjustments', v_adjust));

  return jsonb_build_object('invoice_id', p_invoice_id, 'total', v_total, 'status', v_status, 'adjustments', v_adjust);
end $$;
revoke all on function lubricenter_private.supplier_invoice_update(uuid, timestamptz, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function lubricenter_private.supplier_invoice_update(uuid, timestamptz, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, text) to authenticated;

create or replace function public.supplier_invoice_update(
  p_invoice_id uuid, p_expected_updated_at timestamptz, p_supplier_id uuid, p_invoice_number text,
  p_invoice_date date, p_due_date date, p_currency text, p_items jsonb,
  p_tax numeric, p_discount numeric, p_freight numeric, p_notes text, p_reason text default null)
returns jsonb language sql security invoker set search_path to '' as $$
  select lubricenter_private.supplier_invoice_update(p_invoice_id, p_expected_updated_at, p_supplier_id, p_invoice_number,
    p_invoice_date, p_due_date, p_currency, p_items, p_tax, p_discount, p_freight, p_notes, p_reason)
$$;
revoke all on function public.supplier_invoice_update(uuid, timestamptz, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function public.supplier_invoice_update(uuid, timestamptz, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, text) to authenticated;

-- Detalle de la factura: igual que antes + historial de cambios.
create or replace function public.supplier_invoice_detail(p_invoice_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_result jsonb;
begin
  perform public.require_auth();
  select jsonb_build_object(
    'invoice',to_jsonb(i)||jsonb_build_object('supplier_name',s.name,'supplier_rif',s.rif,'outstanding_original',greatest(i.total_original-i.paid_original,0)),
    'items',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.supplier_invoice_items x where x.supplier_invoice_id=i.id),'[]'::jsonb),
    'receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.received_on desc,r.created_at desc) from public.supplier_receipts r where r.supplier_invoice_id=i.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(sp)||jsonb_build_object('account_name',fa.name) order by sp.paid_on desc,sp.created_at desc) from public.supplier_payments sp join public.financial_accounts fa on fa.id=sp.account_id where sp.supplier_invoice_id=i.id),'[]'::jsonb),
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.account_type,a.name) from public.account_balances_current a where a.active and a.account_type not in ('RELATED','CLEARING')),'[]'::jsonb),
    'locations',coalesce((select jsonb_agg(to_jsonb(l) order by l.name) from public.locations l where l.active),'[]'::jsonb),
    'edits',coalesce((select jsonb_agg(jsonb_build_object('at',e.created_at,'reason',e.data->>'reason',
        'total_before',(e.data->'before'->>'total_original')::numeric,'total_after',(e.data->'after'->>'total_original')::numeric,
        'adjustments',jsonb_array_length(coalesce(e.data->'adjustments','[]'::jsonb))) order by e.created_at desc)
      from public.audit_events e where e.entity_type='supplier_invoice' and e.entity_id=i.id and e.event_type='supplier_invoice.edited'),'[]'::jsonb)
  ) into v_result from public.supplier_invoices i join public.suppliers s on s.id=i.supplier_id where i.id=p_invoice_id;
  if v_result is null then raise exception 'Factura no encontrada'; end if;
  return v_result;
end;
$function$;

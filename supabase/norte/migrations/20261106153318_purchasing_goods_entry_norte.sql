-- Adaptada para Norte (El Cují): sede por defecto 'CABUDARE' -> 'NORTE'. Resto idéntico a 20261104195808 purchasing_goods_entry de Cabudare.
-- Ingresar mercancía: buscador de artículos por marca/proveedor, marcas que trae
-- cada proveedor y «registrar factura + ingresar al inventario» en un solo paso.
-- Reutiliza public.create_supplier_invoice y lubricenter_private.inventory_receive_purchase
-- sin cambiarlas (costo promedio, movimientos PURCHASE e idempotencia incluidos).

-- Clave de marca: sin acentos, sin símbolos y en mayúsculas («Vega» = «VEGA»).
create or replace function lubricenter_private.brand_key(p_brand text)
returns text language sql immutable set search_path to '' as $$
  select nullif(upper(regexp_replace(translate(coalesce(p_brand, ''), 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'), '[^A-Za-z0-9]', '', 'g')), '')
$$;
revoke all on function lubricenter_private.brand_key(text) from public, anon;
grant execute on function lubricenter_private.brand_key(text) to authenticated;

-- 1. Marcas que trae cada proveedor.
create table if not exists public.supplier_brands (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  brand_key text not null check (brand_key ~ '^[A-Z0-9]{1,60}$'),
  created_at timestamptz not null default now(),
  primary key (supplier_id, brand_key)
);
alter table public.supplier_brands enable row level security;
revoke all on public.supplier_brands from anon;
revoke insert, update, delete, truncate on public.supplier_brands from authenticated;
grant select on public.supplier_brands to authenticated;
drop policy if exists authenticated_read on public.supplier_brands;
create policy authenticated_read on public.supplier_brands for select to authenticated using (true);
drop policy if exists staff_identity_gate on public.supplier_brands;
create policy staff_identity_gate on public.supplier_brands as restrictive for all to authenticated
  using ((select lubricenter_private.staff_identity_allowed()));

create or replace function lubricenter_private.supplier_brands_set(p_supplier_id uuid, p_brand_keys text[])
returns void language plpgsql security definer set search_path to '' as $$
declare v_keys text[];
begin
  perform lubricenter_private.require_order_admin();
  if not exists (select 1 from public.suppliers where id = p_supplier_id) then raise exception 'Proveedor no encontrado'; end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys
  from (select lubricenter_private.brand_key(x) as k from unnest(coalesce(p_brand_keys, '{}')) x) q where k is not null;
  if cardinality(v_keys) > 80 then raise exception 'Máximo 80 marcas por proveedor'; end if;
  delete from public.supplier_brands where supplier_id = p_supplier_id and not (brand_key = any(v_keys));
  insert into public.supplier_brands(supplier_id, brand_key) select p_supplier_id, k from unnest(v_keys) k
  on conflict do nothing;
  insert into public.audit_events(event_type, entity_type, entity_id, data)
  values ('supplier.brands_set', 'supplier', p_supplier_id, jsonb_build_object('brands', v_keys));
end $$;
revoke all on function lubricenter_private.supplier_brands_set(uuid, text[]) from public, anon;
grant execute on function lubricenter_private.supplier_brands_set(uuid, text[]) to authenticated;

create or replace function public.supplier_brands_set(p_supplier_id uuid, p_brand_keys text[])
returns void language sql security invoker set search_path to '' as $$
  select lubricenter_private.supplier_brands_set(p_supplier_id, p_brand_keys)
$$;
revoke all on function public.supplier_brands_set(uuid, text[]) from public, anon;
grant execute on function public.supplier_brands_set(uuid, text[]) to authenticated;

-- Marcas del inventario (para los chips): nombre más usado por clave.
create or replace function public.purchasing_brands()
returns jsonb language sql stable security invoker set search_path to '' as $$
  with b as (
    select lubricenter_private.brand_key(i.brand) as brand_key, i.brand, count(*) as n
    from public.inventory_items i
    where i.active and i.merged_into is null and lubricenter_private.brand_key(i.brand) is not null
    group by 1, 2
  )
  select coalesce(jsonb_agg(jsonb_build_object('brand_key', x.brand_key, 'name', x.name, 'items', x.items) order by x.name), '[]'::jsonb)
  from (
    select brand_key, (array_agg(brand order by n desc, brand))[1] as name, sum(n)::int as items
    from b group by brand_key
  ) x
$$;
revoke all on function public.purchasing_brands() from public, anon;
grant execute on function public.purchasing_brands() to authenticated;

-- 2. Buscador de artículos para compras.
create or replace function public.purchasing_item_search(
  p_query text, p_supplier_id uuid default null, p_brand_keys text[] default null,
  p_categories text[] default null, p_limit int default 40)
returns jsonb language sql stable security invoker set search_path to '' as $$
  with words as (
    select lower(translate(w, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')) as w,
           upper(regexp_replace(w, '[^A-Za-z0-9]', '', 'g')) as code
    from unnest(regexp_split_to_array(btrim(coalesce(p_query, '')), '[[:space:]]+')) w
    where w <> ''
  ), bought as (
    select ii.inventory_item_id, max(si.invoice_date) as last_bought_at
    from public.supplier_invoice_items ii
    join public.supplier_invoices si on si.id = ii.supplier_invoice_id
    where p_supplier_id is not null and si.supplier_id = p_supplier_id and si.status <> 'VOID'
      and ii.inventory_item_id is not null
    group by ii.inventory_item_id
  ), items as (
    select i.id, i.sku, i.display_name, i.description, i.brand, i.category, i.unit, i.alt_codes,
      i.average_cost_ref, i.last_purchase_cost_ref,
      lubricenter_private.brand_key(i.brand) as brand_key,
      lower(translate(concat_ws(' ', i.sku, i.display_name, i.description, i.brand, array_to_string(i.alt_codes, ' ')),
        'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')) as hay,
      upper(regexp_replace(concat_ws('|', i.sku, array_to_string(i.alt_codes, '|')), '[^A-Za-z0-9|]', '', 'g')) as codes
    from public.inventory_items i
    where i.active and i.merged_into is null
      and (p_brand_keys is null or cardinality(p_brand_keys) = 0 or lubricenter_private.brand_key(i.brand) = any(p_brand_keys))
      and (p_categories is null or cardinality(p_categories) = 0 or i.category = any(p_categories))
  ), hits as (
    select it.*, b.last_bought_at,
      exists (select 1 from words) and (select bool_and(it.hay like '%' || w.w || '%' or (length(w.code) >= 3 and it.codes like '%' || w.code || '%')) from words w) as matched,
      (select count(*) from words) = 1 and ('|' || it.codes || '|') like '%|' || (select code from words limit 1) || '|%' as exact_code
    from items it left join bought b on b.inventory_item_id = it.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'sku', h.sku, 'display_name', coalesce(nullif(btrim(h.display_name), ''), h.description),
      'description', h.description, 'brand', h.brand, 'brand_key', h.brand_key, 'category', h.category, 'unit', h.unit,
      'stock', coalesce(c.quantity_on_hand, 0), 'average_cost_ref', h.average_cost_ref,
      'last_purchase_cost_ref', h.last_purchase_cost_ref, 'price_usd', c.price_usd,
      'bought_from_supplier', h.last_bought_at is not null, 'last_bought_at', h.last_bought_at)
      order by (h.last_bought_at is not null) desc, h.exact_code desc, coalesce(nullif(btrim(h.display_name), ''), h.description)), '[]'::jsonb)
  from (
    select * from hits
    where matched or (not exists (select 1 from words) and (p_brand_keys is not null and cardinality(p_brand_keys) > 0 or p_categories is not null and cardinality(p_categories) > 0))
    order by (last_bought_at is not null) desc, exact_code desc, coalesce(nullif(btrim(display_name), ''), description)
    limit greatest(least(coalesce(p_limit, 40), 200), 1)
  ) h
  left join public.inventory_current c on c.id = h.id
$$;
revoke all on function public.purchasing_item_search(text, uuid, text[], text[], int) from public, anon;
grant execute on function public.purchasing_item_search(text, uuid, text[], text[], int) to authenticated;

-- 3. Registrar factura + ingresar al inventario, idempotente por request_id.
create table if not exists public.purchase_invoice_requests (
  request_id uuid primary key,
  supplier_invoice_id uuid not null references public.supplier_invoices(id),
  receipt_id uuid,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
alter table public.purchase_invoice_requests enable row level security;
revoke all on public.purchase_invoice_requests from anon;
revoke insert, update, delete, truncate on public.purchase_invoice_requests from authenticated;
grant select on public.purchase_invoice_requests to authenticated;
drop policy if exists admin_read on public.purchase_invoice_requests;
create policy admin_read on public.purchase_invoice_requests for select to authenticated
  using ((select lubricenter_private.is_order_admin()));

create or replace function lubricenter_private.purchase_invoice_and_receive(
  p_request_id uuid, p_supplier_id uuid, p_invoice_number text, p_invoice_date date, p_due_date date,
  p_currency text, p_items jsonb, p_tax numeric, p_discount numeric, p_freight numeric, p_notes text,
  p_location_id uuid, p_receive_all boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_hash text; v_prior public.purchase_invoice_requests; v_invoice uuid; v_receipt uuid;
  v_location uuid; v_lines jsonb; v_before jsonb; v_result jsonb;
begin
  perform lubricenter_private.require_order_admin();
  if p_request_id is null then raise exception 'Falta el identificador de la solicitud'; end if;
  v_hash := md5(jsonb_build_array(p_supplier_id, upper(btrim(coalesce(p_invoice_number, ''))), p_invoice_date, p_due_date,
    upper(coalesce(p_currency, '')), p_items, coalesce(p_tax, 0), coalesce(p_discount, 0), coalesce(p_freight, 0),
    coalesce(btrim(p_notes), ''), p_location_id, coalesce(p_receive_all, true))::text);

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 221104));
  select * into v_prior from public.purchase_invoice_requests where request_id = p_request_id;
  if found then
    if v_prior.payload_hash <> v_hash then raise exception 'Esta solicitud ya se utilizó con datos distintos'; end if;
    return v_prior.result;
  end if;

  -- Una factura por número y proveedor (las anuladas no cuentan).
  perform pg_advisory_xact_lock(hashtextextended(p_supplier_id::text || '|' || upper(btrim(coalesce(p_invoice_number, ''))), 221105));
  if exists (select 1 from public.supplier_invoices si
             where si.supplier_id = p_supplier_id and si.status <> 'VOID'
               and upper(btrim(si.invoice_number)) = upper(btrim(coalesce(p_invoice_number, '')))) then
    raise exception 'Ya registraste la factura % de este proveedor.', btrim(p_invoice_number);
  end if;

  v_invoice := public.create_supplier_invoice(p_supplier_id, p_invoice_number, p_invoice_date, p_due_date,
    p_currency, p_items, coalesce(p_tax, 0), coalesce(p_discount, 0), coalesce(p_freight, 0), p_notes);

  select coalesce(jsonb_agg(jsonb_build_object('line_id', ii.id, 'quantity', ii.quantity) order by ii.id), '[]'::jsonb),
         coalesce(jsonb_object_agg(ii.inventory_item_id::text, (
           select coalesce(sum(m.quantity_delta), 0) from public.inventory_movements m where m.inventory_item_id = ii.inventory_item_id)), '{}'::jsonb)
    into v_lines, v_before
  from public.supplier_invoice_items ii
  where ii.supplier_invoice_id = v_invoice and ii.line_type = 'INVENTORY' and ii.inventory_item_id is not null;

  if coalesce(p_receive_all, true) and jsonb_array_length(v_lines) > 0 then
    v_location := coalesce(p_location_id, (select id from public.locations where code = 'NORTE' and active limit 1));
    v_receipt := lubricenter_private.inventory_receive_purchase(
      md5(p_request_id::text || ':receive')::uuid, v_invoice, v_location,
      (now() at time zone 'America/Caracas')::date,
      v_lines, 'Ingreso al registrar la factura');
  end if;

  select jsonb_build_object('invoice_id', v_invoice, 'receipt_id', v_receipt,
    'stock_after', coalesce(jsonb_agg(jsonb_build_object(
      'inventory_item_id', k.key::uuid, 'before', (k.value)::numeric,
      'after', (select coalesce(sum(m.quantity_delta), 0) from public.inventory_movements m where m.inventory_item_id = k.key::uuid),
      'average_cost_ref', (select i.average_cost_ref from public.inventory_items i where i.id = k.key::uuid))), '[]'::jsonb))
    into v_result
  from jsonb_each(v_before) k;

  insert into public.purchase_invoice_requests(request_id, supplier_invoice_id, receipt_id, payload_hash, result)
  values (p_request_id, v_invoice, v_receipt, v_hash, v_result);
  return v_result;
end $$;
revoke all on function lubricenter_private.purchase_invoice_and_receive(uuid, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, uuid, boolean) from public, anon;
grant execute on function lubricenter_private.purchase_invoice_and_receive(uuid, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, uuid, boolean) to authenticated;

create or replace function public.purchase_invoice_and_receive(
  p_request_id uuid, p_supplier_id uuid, p_invoice_number text, p_invoice_date date, p_due_date date,
  p_currency text, p_items jsonb, p_tax numeric, p_discount numeric, p_freight numeric, p_notes text,
  p_location_id uuid, p_receive_all boolean default true)
returns jsonb language sql security invoker set search_path to '' as $$
  select lubricenter_private.purchase_invoice_and_receive(p_request_id, p_supplier_id, p_invoice_number, p_invoice_date,
    p_due_date, p_currency, p_items, p_tax, p_discount, p_freight, p_notes, p_location_id, p_receive_all)
$$;
revoke all on function public.purchase_invoice_and_receive(uuid, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, uuid, boolean) from public, anon;
grant execute on function public.purchase_invoice_and_receive(uuid, uuid, text, date, date, text, jsonb, numeric, numeric, numeric, text, uuid, boolean) to authenticated;

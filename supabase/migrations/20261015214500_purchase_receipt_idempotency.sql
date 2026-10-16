-- Purchase receiving v2: immutable invoice -> audited, idempotent stock receipts.
-- No finance movements, prices or historical stock are updated by this migration.
-- Replaces the authenticated-facing legacy receiver once UI uses the new RPC.

create table if not exists public.purchase_receipt_requests (
  request_id uuid primary key,
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  payload_hash text not null,
  receipt_id uuid not null unique references public.supplier_receipts(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
alter table public.purchase_receipt_requests enable row level security;
revoke all on public.purchase_receipt_requests from public,anon,authenticated;

alter table public.supplier_receipt_items
  add column if not exists average_cost_before numeric,
  add column if not exists average_cost_after numeric,
  add column if not exists quantity_before numeric;
create unique index if not exists inventory_movement_receipt_unique
  on public.inventory_movements(supplier_receipt_item_id)
  where supplier_receipt_item_id is not null;

create or replace function lubricenter_private.inventory_receive_purchase(
  p_request_id uuid,
  p_invoice_id uuid,
  p_location_id uuid,
  p_received_on date,
  p_items jsonb,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_invoice public.supplier_invoices;
  v_line public.supplier_invoice_items;
  v_inventory public.inventory_items;
  v_entry jsonb;
  v_canonical jsonb;
  v_hash text;
  v_prior public.purchase_receipt_requests;
  v_line_id uuid;
  v_qty numeric;
  v_pending numeric;
  v_previous_qty numeric;
  v_average numeric;
  v_receipt uuid;
  v_receipt_line uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  perform lubricenter_private.require_order_admin();
  if p_request_id is null or p_invoice_id is null or p_location_id is null then
    raise exception 'Identifica solicitud, factura y ubicación';
  end if;
  if p_received_on is null or p_received_on > timezone('America/Caracas',now())::date then
    raise exception 'Fecha de recepción inválida';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Selecciona de 1 a 100 líneas a recibir';
  end if;
  if not exists (select 1 from public.locations where id=p_location_id and active) then
    raise exception 'Selecciona una ubicación activa';
  end if;
  for v_entry in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_entry) is distinct from 'object'
       or coalesce(v_entry->>'line_id','')=''
       or coalesce(v_entry->>'quantity','')='' then
      raise exception 'Cada línea debe incluir ID y cantidad';
    end if;
    v_line_id := (v_entry->>'line_id')::uuid;
    v_qty := (v_entry->>'quantity')::numeric;
    if v_qty is null or v_qty<=0
       or v_qty::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Las cantidades recibidas deben ser positivas';
    end if;
    if v_line_id=any(v_seen) then raise exception 'Línea duplicada en la recepción'; end if;
    v_seen := array_append(v_seen,v_line_id);
  end loop;

  select jsonb_agg(
    jsonb_build_object('line_id',x.line_id,'quantity',trim_scale(x.quantity))
    order by x.line_id::text
  ) into v_canonical
  from jsonb_to_recordset(p_items) as x(line_id uuid,quantity numeric);
  v_hash := md5(p_invoice_id::text||'|'||p_location_id::text||'|'||
    p_received_on::text||'|'||coalesce(trim(p_notes),'')||'|'||v_canonical::text);

  -- Serialize concurrent requests, then each invoice independently. The same
  -- request token is repeatable ONLY with exactly the same payload.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,221022));
  select * into v_prior from public.purchase_receipt_requests where request_id=p_request_id;
  if found then
    if v_prior.supplier_invoice_id<>p_invoice_id or v_prior.location_id<>p_location_id
       or v_prior.payload_hash<>v_hash then
      raise exception 'Esta solicitud ya se utilizó con datos distintos';
    end if;
    return v_prior.receipt_id;
  end if;
  select * into v_invoice from public.supplier_invoices where id=p_invoice_id for update;
  if not found or v_invoice.status='VOID' then
    raise exception 'Factura anulada o inexistente';
  end if;

  -- Validate ALL lines before applying a single mutation. A missing line,
  -- expense line or over-receipt aborts the complete transaction.
  for v_entry in select value from jsonb_array_elements(p_items) loop
    v_line_id := (v_entry->>'line_id')::uuid;
    v_qty := (v_entry->>'quantity')::numeric;
    select * into v_line from public.supplier_invoice_items
      where id=v_line_id and supplier_invoice_id=p_invoice_id for update;
    if not found or v_line.line_type<>'INVENTORY'
       or v_line.inventory_item_id is null then
      raise exception 'La línea no corresponde al inventario de esta factura';
    end if;
    v_pending := v_line.quantity-v_line.received_quantity;
    if v_pending<=0 or v_qty>v_pending then
      raise exception 'Cantidad superior a la pendiente de recibir: %',v_line.description;
    end if;
    if not exists (
      select 1 from public.inventory_items i
      where i.id=v_line.inventory_item_id and i.active
    ) then
      raise exception 'El artículo de inventario está inactivo o no existe';
    end if;
  end loop;

  insert into public.supplier_receipts(supplier_invoice_id,location_id,received_on,notes)
  values(p_invoice_id,p_location_id,p_received_on,nullif(trim(p_notes),''))
  returning id into v_receipt;

  -- Order consistently to avoid deadlocks on shared inventory SKUs.
  for v_entry in
    select x.value
    from jsonb_array_elements(p_items) x
    join public.supplier_invoice_items ii on ii.id=(x.value->>'line_id')::uuid
    order by ii.inventory_item_id,ii.id
  loop
    v_line_id := (v_entry->>'line_id')::uuid;
    v_qty := (v_entry->>'quantity')::numeric;
    select * into v_line from public.supplier_invoice_items where id=v_line_id for update;
    select * into v_inventory from public.inventory_items
      where id=v_line.inventory_item_id for update;
    select coalesce(sum(m.quantity_delta),0) into v_previous_qty
    from public.inventory_movements m
    where m.inventory_item_id=v_inventory.id;
    v_average := case when v_previous_qty>0 then
      round((v_previous_qty*v_inventory.average_cost_ref +
        v_qty*v_line.unit_cost_ref)/(v_previous_qty+v_qty),4)
      else v_line.unit_cost_ref end;

    insert into public.supplier_receipt_items(
      supplier_receipt_id,supplier_invoice_item_id,inventory_item_id,quantity,unit_cost_ref,
      average_cost_before,average_cost_after,quantity_before
    ) values(v_receipt,v_line.id,v_inventory.id,v_qty,v_line.unit_cost_ref,
      v_inventory.average_cost_ref,v_average,v_previous_qty)
    returning id into v_receipt_line;

    insert into public.inventory_movements(
      inventory_item_id,location_id,quantity_delta,movement_type,note,
      occurred_at,supplier_receipt_item_id
    ) values(
      v_inventory.id,p_location_id,v_qty,'PURCHASE',
      'Recepción de factura '||v_invoice.invoice_number,
      ((p_received_on::timestamp+time '12:00') at time zone 'America/Caracas'),
      v_receipt_line
    );
    update public.supplier_invoice_items
      set received_quantity=received_quantity+v_qty where id=v_line.id;
    update public.inventory_items
      set average_cost_ref=v_average,
          last_purchase_cost_ref=case when last_purchased_at is null or
            last_purchased_at<=((p_received_on::timestamp+time '12:00') at time zone 'America/Caracas')
            then v_line.unit_cost_ref else last_purchase_cost_ref end,
          last_purchased_at=greatest(last_purchased_at,((p_received_on::timestamp+time '12:00') at time zone 'America/Caracas')),
          cost_missing=case when v_average>0 then false else cost_missing end,
          updated_at=now()
      where id=v_inventory.id;
    v_count := v_count+1;
  end loop;

  insert into public.purchase_receipt_requests(
    request_id,supplier_invoice_id,location_id,payload_hash,receipt_id
  ) values(p_request_id,p_invoice_id,p_location_id,v_hash,v_receipt);
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('supplier_receipt.posted_v2','supplier_receipt',v_receipt,
    jsonb_build_object('request_id',p_request_id,'invoice_id',p_invoice_id,
     'location_id',p_location_id,'received_on',p_received_on,'lines',v_count,
     'quantities',v_canonical,'actor',auth.uid()));
  return v_receipt;
end
$body$;

create or replace function public.inventory_receive_purchase(p_request_id uuid,p_invoice_id uuid,p_location_id uuid,p_received_on date,p_items jsonb,p_notes text default null)
returns uuid language sql security invoker set search_path=''
as $$select lubricenter_private.inventory_receive_purchase(p_request_id,p_invoice_id,p_location_id,p_received_on,p_items,p_notes)$$;
revoke all on function lubricenter_private.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text) from public,anon;
grant execute on function lubricenter_private.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text) to authenticated;

-- Secure the callable surface. Other modules must use the new explicit,
-- idempotent RPC, never the old implicit-location receiving endpoint.
revoke all on function public.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text)
  to authenticated;
revoke all on function public.receive_supplier_invoice(uuid,date,jsonb,uuid,text)
  from public,anon,authenticated;

-- Return explicit destination and immutable cost snapshots on every receipt.
create or replace function lubricenter_private.purchase_receipt_history(p_invoice_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
 perform lubricenter_private.require_order_admin();
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'received_on',r.received_on,'location_name',l.name,'location_code',l.code,
   'notes',r.notes,'status',r.status,'created_at',r.created_at,
   'items',(select coalesce(jsonb_agg(jsonb_build_object(
     'id',ri.id,'description',ii.description,'quantity',ri.quantity,
     'unit_cost_ref',ri.unit_cost_ref,'average_before',ri.average_cost_before,
     'average_after',ri.average_cost_after,'quantity_before',ri.quantity_before
   ) order by ri.id),'[]'::jsonb)
   from public.supplier_receipt_items ri join public.supplier_invoice_items ii
     on ii.id=ri.supplier_invoice_item_id where ri.supplier_receipt_id=r.id)
 ) order by r.received_on desc,r.created_at desc)
 from public.supplier_receipts r join public.locations l on l.id=r.location_id
 where r.supplier_invoice_id=p_invoice_id),'[]'::jsonb);
end $$;
create or replace function public.purchase_receipt_history(p_invoice_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.purchase_receipt_history(p_invoice_id)$$;
revoke all on function lubricenter_private.purchase_receipt_history(uuid) from public,anon;
grant execute on function lubricenter_private.purchase_receipt_history(uuid) to authenticated;
revoke all on function public.purchase_receipt_history(uuid) from public,anon;
grant execute on function public.purchase_receipt_history(uuid) to authenticated;

create or replace function lubricenter_private.inventory_item_history(p_inventory_item_id uuid,p_location_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
 perform lubricenter_private.require_order_admin();
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.occurred_at desc,x.id desc) from (
   select m.id,m.quantity_delta,m.movement_type,m.note,m.occurred_at,l.name location_name,
     ri.unit_cost_ref,ri.average_cost_before,ri.average_cost_after,
     r.supplier_invoice_id,i.invoice_number
   from public.inventory_movements m join public.locations l on l.id=m.location_id
   left join public.supplier_receipt_items ri on ri.id=m.supplier_receipt_item_id
   left join public.supplier_receipts r on r.id=ri.supplier_receipt_id
   left join public.supplier_invoices i on i.id=r.supplier_invoice_id
   where m.inventory_item_id=p_inventory_item_id and m.location_id=p_location_id
   order by m.occurred_at desc,m.id desc limit 100
 ) x),'[]'::jsonb);
end $$;
create or replace function public.inventory_item_history(p_inventory_item_id uuid,p_location_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.inventory_item_history(p_inventory_item_id,p_location_id)$$;
revoke all on function lubricenter_private.inventory_item_history(uuid,uuid) from public,anon;
grant execute on function lubricenter_private.inventory_item_history(uuid,uuid) to authenticated;
revoke all on function public.inventory_item_history(uuid,uuid) from public,anon;
grant execute on function public.inventory_item_history(uuid,uuid) to authenticated;

-- A count names its destination and refuses to overwrite a concurrent receipt.
create or replace function lubricenter_private.inventory_set_count_at_location(
 p_inventory_item_id uuid,p_location_id uuid,p_expected_quantity numeric,p_new_count numeric,p_note text
) returns numeric language plpgsql security definer set search_path=''
as $$
declare v_current numeric; v_delta numeric;
begin
 perform lubricenter_private.require_order_admin();
 if p_new_count is null or p_new_count<0 or p_new_count::text in ('NaN','Infinity','-Infinity')
   or p_expected_quantity is null or nullif(trim(p_note),'') is null then
   raise exception 'Indica conteo válido y motivo del ajuste';
 end if;
 if not exists(select 1 from public.locations where id=p_location_id and active) then
   raise exception 'Sede no disponible';
 end if;
 perform 1 from public.inventory_items where id=p_inventory_item_id and active for update;
 if not found then raise exception 'Artículo no disponible'; end if;
 select coalesce(sum(quantity_delta),0) into v_current from public.inventory_movements
   where inventory_item_id=p_inventory_item_id and location_id=p_location_id;
 if v_current<>p_expected_quantity then
   raise exception 'Las existencias cambiaron. Actualiza antes de confirmar el conteo';
 end if;
 v_delta:=p_new_count-v_current;
 if v_delta<>0 then
   insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,note)
   values(p_inventory_item_id,p_location_id,v_delta,'ADJUSTMENT',trim(p_note));
   insert into public.audit_events(event_type,entity_type,entity_id,data)
   values('inventory.counted','inventory_item',p_inventory_item_id,jsonb_build_object(
    'location_id',p_location_id,'previous',v_current,'counted',p_new_count,'note',trim(p_note),'actor',auth.uid()));
 end if;
 update public.inventory_items set needs_review=false,updated_at=now() where id=p_inventory_item_id;
 return p_new_count;
end $$;
create or replace function public.inventory_set_count_at_location(p_inventory_item_id uuid,p_location_id uuid,p_expected_quantity numeric,p_new_count numeric,p_note text)
returns numeric language sql security invoker set search_path=''
as $$select lubricenter_private.inventory_set_count_at_location(p_inventory_item_id,p_location_id,p_expected_quantity,p_new_count,p_note)$$;
revoke all on function lubricenter_private.inventory_set_count_at_location(uuid,uuid,numeric,numeric,text) from public,anon;
grant execute on function lubricenter_private.inventory_set_count_at_location(uuid,uuid,numeric,numeric,text) to authenticated;
revoke all on function public.inventory_set_count_at_location(uuid,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.inventory_set_count_at_location(uuid,uuid,numeric,numeric,text) to authenticated;

-- Preserve each existing function signature and add the same authorization
-- gate used by receiving. No data or role memberships are changed.
do $permissions$
declare fn record; definition text;
begin
 for fn in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
    'upsert_supplier','create_supplier_invoice','record_supplier_payment','void_supplier_invoice','set_inventory_count')
 loop
   definition:=pg_get_functiondef(fn.oid);
   if definition ilike '%perform public.require_auth();%' then
     execute replace(definition,'perform public.require_auth();','perform lubricenter_private.require_order_admin();');
   end if;
 end loop;
end $permissions$;

-- Central de egresos, proveedores, compras, costos y cuadre diario.
-- Los códigos TRANSFER_BDV / TRANSFER_BNC se conservan internamente por
-- compatibilidad, pero representan pago móvil recibido en cada banco.

alter table public.payments disable trigger guard_closed_edits;

update public.payments
set method = 'TRANSFER_BDV'
where method = 'MOBILE_PAYMENT';

update public.payments p
set financial_account_id = fa.id
from public.financial_accounts fa
where p.method = 'TRANSFER_BDV' and fa.code = 'BDV'
  and p.financial_account_id is distinct from fa.id;

update public.payments p
set financial_account_id = fa.id
from public.financial_accounts fa
where p.method = 'TRANSFER_BNC' and fa.code = 'BNC'
  and p.financial_account_id is distinct from fa.id;

update public.account_movements am
set account_id = bdv.id
from public.financial_accounts mobile
cross join public.financial_accounts bdv
where mobile.code = 'MOBILE' and bdv.code = 'BDV'
  and am.account_id = mobile.id
  and am.source_payment_id is not null
  and exists (
    select 1 from public.payments p
    where p.id = am.source_payment_id and p.method = 'TRANSFER_BDV'
  );

-- Los ajustes no vinculados se conservan para no reescribir caja sin una
-- relación comprobable. Quedan visibles como histórico pendiente de revisión.
update public.financial_accounts
set name = 'Ajustes históricos de pago móvil'
where code = 'MOBILE';

alter table public.payments enable trigger guard_closed_edits;

insert into public.audit_events(event_type,entity_type,data)
values('payments.methods_normalized','payments',jsonb_build_object(
  'generic_mobile_assigned_to','BDV',
  'legacy_adjustments_preserved',true
));

alter table public.inventory_items
  add column if not exists average_cost_ref numeric not null default 0,
  add column if not exists last_purchase_cost_ref numeric,
  add column if not exists last_purchased_at timestamptz;

update public.inventory_items
set average_cost_ref = source_cost_ref
where average_cost_ref = 0 and source_cost_ref > 0;

alter table public.order_items
  add column if not exists unit_cost_ref_snapshot numeric,
  add column if not exists total_cost_ref_snapshot numeric;

alter table public.account_movements drop constraint if exists account_movements_movement_type_check;
alter table public.account_movements add constraint account_movements_movement_type_check
  check (movement_type in ('PAYMENT','EXPENSE','SUPPLIER_PAYMENT','TRANSFER','ADJUSTMENT'));

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  rif text,
  phone text,
  email text,
  address text,
  contact_name text,
  bank_details text,
  default_currency text not null default 'USD' check (default_currency in ('USD','VES')),
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 3650),
  notes text,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists suppliers_rif_unique on public.suppliers (upper(trim(rif))) where rif is not null and trim(rif) <> '';
create index if not exists suppliers_name_idx on public.suppliers (lower(name));

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  invoice_number text not null,
  invoice_date date not null,
  due_date date,
  currency text not null check (currency in ('USD','VES')),
  bcv_rate_snapshot numeric not null check (bcv_rate_snapshot > 0),
  operative_rate_snapshot numeric not null check (operative_rate_snapshot > 0),
  subtotal_original numeric not null default 0 check (subtotal_original >= 0),
  tax_original numeric not null default 0 check (tax_original >= 0),
  discount_original numeric not null default 0 check (discount_original >= 0),
  freight_original numeric not null default 0 check (freight_original >= 0),
  total_original numeric not null default 0 check (total_original >= 0),
  paid_original numeric not null default 0 check (paid_original >= 0),
  status text not null default 'OPEN' check (status in ('OPEN','PARTIAL','PAID','VOID')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text
);
create unique index if not exists supplier_invoice_number_unique
  on public.supplier_invoices (supplier_id, upper(trim(invoice_number))) where status <> 'VOID';
create index if not exists supplier_invoices_due_idx on public.supplier_invoices (status,due_date);

create table if not exists public.supplier_invoice_items (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete cascade,
  line_type text not null check (line_type in ('INVENTORY','EXPENSE')),
  inventory_item_id uuid references public.inventory_items(id) on delete restrict,
  description text not null,
  expense_category text,
  quantity numeric not null check (quantity > 0),
  unit_cost_original numeric not null check (unit_cost_original >= 0),
  unit_cost_ref numeric not null check (unit_cost_ref >= 0),
  line_total_original numeric not null check (line_total_original >= 0),
  received_quantity numeric not null default 0 check (received_quantity >= 0),
  created_at timestamptz not null default now(),
  check ((line_type='INVENTORY' and inventory_item_id is not null) or (line_type='EXPENSE')),
  check (received_quantity <= quantity)
);

create table if not exists public.supplier_receipts (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  received_on date not null,
  status text not null default 'POSTED' check (status in ('POSTED','VOID')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.supplier_receipt_items (
  id uuid primary key default gen_random_uuid(),
  supplier_receipt_id uuid not null references public.supplier_receipts(id) on delete cascade,
  supplier_invoice_item_id uuid not null references public.supplier_invoice_items(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  unit_cost_ref numeric not null check (unit_cost_ref >= 0),
  created_at timestamptz not null default now()
);

alter table public.inventory_movements
  add column if not exists supplier_receipt_item_id uuid references public.supplier_receipt_items(id) on delete restrict;
create unique index if not exists inventory_movement_receipt_unique
  on public.inventory_movements(supplier_receipt_item_id) where supplier_receipt_item_id is not null;

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete restrict,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  account_movement_id uuid not null unique references public.account_movements(id) on delete restrict,
  currency text not null check (currency in ('USD','VES')),
  amount_original numeric not null check (amount_original > 0),
  amount_applied_invoice numeric not null check (amount_applied_invoice > 0),
  value_ves numeric not null check (value_ves > 0),
  value_ref numeric not null check (value_ref > 0),
  paid_on date not null,
  reference text,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.cash_closings (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  location_id uuid not null references public.locations(id) on delete restrict,
  status text not null default 'OPEN' check (status in ('OPEN','REVIEW','CLOSED','REOPENED')),
  notes text,
  opened_by uuid default auth.uid(),
  opened_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  reopen_reason text,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_date, location_id)
);

create table if not exists public.cash_closing_accounts (
  cash_closing_id uuid not null references public.cash_closings(id) on delete cascade,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  opening_native numeric not null default 0,
  system_in_native numeric not null default 0,
  system_out_native numeric not null default 0,
  expected_native numeric not null default 0,
  actual_native numeric,
  difference_native numeric,
  explanation text,
  denomination_counts jsonb not null default '{}'::jsonb,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (cash_closing_id,account_id)
);

alter table public.suppliers enable row level security;
alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_items enable row level security;
alter table public.supplier_receipts enable row level security;
alter table public.supplier_receipt_items enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.cash_closings enable row level security;
alter table public.cash_closing_accounts enable row level security;

do $policies$
declare t text;
begin
  foreach t in array array['suppliers','supplier_invoices','supplier_invoice_items','supplier_receipts','supplier_receipt_items','supplier_payments','cash_closings','cash_closing_accounts'] loop
    execute format('drop policy if exists authenticated_read on public.%I',t);
    execute format('create policy authenticated_read on public.%I for select to authenticated using (true)',t);
  end loop;
end $policies$;

grant select on public.suppliers,public.supplier_invoices,public.supplier_invoice_items,
  public.supplier_receipts,public.supplier_receipt_items,public.supplier_payments,
  public.cash_closings,public.cash_closing_accounts to authenticated;

create or replace function public.upsert_supplier(
  p_id uuid, p_name text, p_legal_name text default null, p_rif text default null,
  p_phone text default null, p_email text default null, p_address text default null,
  p_contact_name text default null, p_bank_details text default null,
  p_default_currency text default 'USD', p_payment_terms_days integer default 0,
  p_notes text default null, p_active boolean default true
) returns uuid language plpgsql security definer set search_path=public as $function$
declare v_id uuid;
begin
  perform public.require_auth();
  if coalesce(trim(p_name),'')='' then raise exception 'El nombre del proveedor es obligatorio'; end if;
  if upper(p_default_currency) not in ('USD','VES') then raise exception 'Moneda inválida'; end if;
  if p_id is null then
    insert into public.suppliers(name,legal_name,rif,phone,email,address,contact_name,bank_details,default_currency,payment_terms_days,notes,active)
    values(trim(p_name),nullif(trim(p_legal_name),''),nullif(trim(p_rif),''),nullif(trim(p_phone),''),nullif(trim(p_email),''),nullif(trim(p_address),''),nullif(trim(p_contact_name),''),nullif(trim(p_bank_details),''),upper(p_default_currency),coalesce(p_payment_terms_days,0),nullif(trim(p_notes),''),coalesce(p_active,true)) returning id into v_id;
  else
    update public.suppliers set name=trim(p_name),legal_name=nullif(trim(p_legal_name),''),rif=nullif(trim(p_rif),''),phone=nullif(trim(p_phone),''),email=nullif(trim(p_email),''),address=nullif(trim(p_address),''),contact_name=nullif(trim(p_contact_name),''),bank_details=nullif(trim(p_bank_details),''),default_currency=upper(p_default_currency),payment_terms_days=coalesce(p_payment_terms_days,0),notes=nullif(trim(p_notes),''),active=coalesce(p_active,true),updated_at=now() where id=p_id returning id into v_id;
    if v_id is null then raise exception 'Proveedor no encontrado'; end if;
  end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values(case when p_id is null then 'supplier.created' else 'supplier.updated' end,'supplier',v_id,jsonb_build_object('name',trim(p_name),'rif',nullif(trim(p_rif),'')));
  return v_id;
end;
$function$;

create or replace function public.create_supplier_invoice(
  p_supplier_id uuid, p_invoice_number text, p_invoice_date date, p_due_date date,
  p_currency text, p_items jsonb, p_tax numeric default 0, p_discount numeric default 0,
  p_freight numeric default 0, p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $function$
declare v_id uuid; v_item jsonb; v_subtotal numeric:=0; v_total numeric; v_bcv numeric; v_op numeric; v_currency text:=upper(coalesce(p_currency,'')); v_inventory uuid; v_type text; v_qty numeric; v_cost numeric; v_description text;
begin
  perform public.require_auth();
  if not exists(select 1 from public.suppliers where id=p_supplier_id and active) then raise exception 'Proveedor no encontrado o inactivo'; end if;
  if coalesce(trim(p_invoice_number),'')='' then raise exception 'Indica el número de factura'; end if;
  if p_invoice_date is null or p_invoice_date > timezone('America/Caracas',now())::date then raise exception 'Fecha de factura inválida'; end if;
  if p_due_date is not null and p_due_date < p_invoice_date then raise exception 'El vencimiento no puede ser anterior a la factura'; end if;
  if v_currency not in ('USD','VES') then raise exception 'Moneda inválida'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Agrega al menos una línea a la factura'; end if;
  select value into v_bcv from public.exchange_rates where rate_type='BCV' and timezone('America/Caracas',effective_at)::date<=p_invoice_date order by effective_at desc limit 1;
  select value into v_op from public.exchange_rates where rate_type='OPERATIVE' and timezone('America/Caracas',effective_at)::date<=p_invoice_date order by effective_at desc limit 1;
  if v_bcv is null or v_op is null then select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates; end if;
  if v_bcv is null or v_bcv<=0 or v_op is null or v_op<=0 then raise exception 'No hay tasas para la fecha de la factura'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty:=coalesce((v_item->>'quantity')::numeric,0); v_cost:=coalesce((v_item->>'unit_cost')::numeric,-1);
    if v_qty<=0 or v_cost<0 then raise exception 'Revisa cantidad y costo de cada línea'; end if;
    v_subtotal:=v_subtotal+v_qty*v_cost;
  end loop;
  v_total:=round(v_subtotal+coalesce(p_tax,0)+coalesce(p_freight,0)-coalesce(p_discount,0),2);
  if v_total<0 then raise exception 'El total de la factura no puede ser negativo'; end if;
  insert into public.supplier_invoices(supplier_id,invoice_number,invoice_date,due_date,currency,bcv_rate_snapshot,operative_rate_snapshot,subtotal_original,tax_original,discount_original,freight_original,total_original,notes)
  values(p_supplier_id,trim(p_invoice_number),p_invoice_date,p_due_date,v_currency,v_bcv,v_op,round(v_subtotal,2),coalesce(p_tax,0),coalesce(p_discount,0),coalesce(p_freight,0),v_total,nullif(trim(p_notes),'')) returning id into v_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_type:=upper(coalesce(v_item->>'line_type','')); v_inventory:=nullif(v_item->>'inventory_item_id','')::uuid; v_qty:=(v_item->>'quantity')::numeric; v_cost:=(v_item->>'unit_cost')::numeric; v_description:=trim(coalesce(v_item->>'description',''));
    if v_type not in ('INVENTORY','EXPENSE') then raise exception 'Tipo de línea inválido'; end if;
    if v_type='INVENTORY' then
      select coalesce(nullif(v_description,''),description) into v_description from public.inventory_items where id=v_inventory and active;
      if not found then raise exception 'Producto de inventario no encontrado'; end if;
    elsif v_description='' then raise exception 'Describe la línea de gasto'; end if;
    insert into public.supplier_invoice_items(supplier_invoice_id,line_type,inventory_item_id,description,expense_category,quantity,unit_cost_original,unit_cost_ref,line_total_original)
    values(v_id,v_type,v_inventory,v_description,nullif(trim(v_item->>'expense_category'),''),v_qty,v_cost,case when v_currency='USD' then v_cost else round(v_cost/v_bcv,4) end,round(v_qty*v_cost,2));
  end loop;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('supplier_invoice.created','supplier_invoice',v_id,jsonb_build_object('supplier_id',p_supplier_id,'invoice_number',trim(p_invoice_number),'currency',v_currency,'total',v_total));
  return v_id;
end;
$function$;

create or replace function public.receive_supplier_invoice(
  p_invoice_id uuid, p_received_on date, p_items jsonb default null,
  p_location_id uuid default null, p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $function$
declare v_invoice public.supplier_invoices; v_receipt uuid; v_location uuid; v_line public.supplier_invoice_items; v_payload jsonb; v_qty numeric; v_old_qty numeric; v_old_cost numeric; v_new_cost numeric; v_receipt_item uuid; v_count integer:=0;
begin
  perform public.require_auth();
  select * into v_invoice from public.supplier_invoices where id=p_invoice_id for update;
  if not found or v_invoice.status='VOID' then raise exception 'Factura de proveedor no disponible'; end if;
  if p_received_on is null or p_received_on>timezone('America/Caracas',now())::date then raise exception 'Fecha de recepción inválida'; end if;
  if p_location_id is null then select id into v_location from public.locations where active order by created_at limit 1; else v_location:=p_location_id; end if;
  if not exists(select 1 from public.locations where id=v_location and active) then raise exception 'Ubicación no disponible'; end if;
  insert into public.supplier_receipts(supplier_invoice_id,location_id,received_on,notes) values(p_invoice_id,v_location,p_received_on,nullif(trim(p_notes),'')) returning id into v_receipt;
  for v_line in select * from public.supplier_invoice_items where supplier_invoice_id=p_invoice_id and line_type='INVENTORY' order by created_at loop
    if p_items is null then v_qty:=v_line.quantity-v_line.received_quantity;
    else select value into v_payload from jsonb_array_elements(p_items) where value->>'line_id'=v_line.id::text limit 1; v_qty:=coalesce((v_payload->>'quantity')::numeric,0); end if;
    if v_qty<=0 then continue; end if;
    if v_line.received_quantity+v_qty>v_line.quantity then raise exception 'La recepción supera la cantidad facturada para %',v_line.description; end if;
    select coalesce(sum(quantity_delta),0) into v_old_qty from public.inventory_movements where inventory_item_id=v_line.inventory_item_id;
    select average_cost_ref into v_old_cost from public.inventory_items where id=v_line.inventory_item_id for update;
    v_new_cost:=case when v_old_qty>0 then round((v_old_qty*v_old_cost+v_qty*v_line.unit_cost_ref)/(v_old_qty+v_qty),4) else v_line.unit_cost_ref end;
    update public.inventory_items set average_cost_ref=v_new_cost,last_purchase_cost_ref=v_line.unit_cost_ref,last_purchased_at=((p_received_on::timestamp+time '12:00') at time zone 'America/Caracas'),updated_at=now() where id=v_line.inventory_item_id;
    insert into public.supplier_receipt_items(supplier_receipt_id,supplier_invoice_item_id,inventory_item_id,quantity,unit_cost_ref) values(v_receipt,v_line.id,v_line.inventory_item_id,v_qty,v_line.unit_cost_ref) returning id into v_receipt_item;
    insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,note,occurred_at,supplier_receipt_item_id) values(v_line.inventory_item_id,v_location,v_qty,'PURCHASE','Recepción factura '||v_invoice.invoice_number,((p_received_on::timestamp+time '12:00') at time zone 'America/Caracas'),v_receipt_item);
    update public.supplier_invoice_items set received_quantity=received_quantity+v_qty where id=v_line.id;
    v_count:=v_count+1;
  end loop;
  if v_count=0 then delete from public.supplier_receipts where id=v_receipt; raise exception 'No hay cantidades pendientes para recibir'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('supplier_receipt.posted','supplier_receipt',v_receipt,jsonb_build_object('invoice_id',p_invoice_id,'received_on',p_received_on,'lines',v_count));
  return v_receipt;
end;
$function$;

create or replace function public.record_supplier_payment(
  p_invoice_id uuid, p_account_id uuid, p_amount numeric, p_paid_on date,
  p_reference text default null, p_note text default null
) returns uuid language plpgsql security definer set search_path=public as $function$
declare v_invoice public.supplier_invoices; v_account public.financial_accounts; v_bcv numeric; v_op numeric; v_value_ves numeric; v_value_ref numeric; v_applied numeric; v_remaining numeric; v_movement uuid; v_id uuid; v_status text;
begin
  perform public.require_auth();
  select * into v_invoice from public.supplier_invoices where id=p_invoice_id for update;
  if not found or v_invoice.status in ('VOID','PAID') then raise exception 'La factura no tiene saldo pendiente'; end if;
  select * into v_account from public.financial_accounts where id=p_account_id and active and account_type<>'RELATED';
  if not found then raise exception 'Cuenta de pago no disponible'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Monto inválido'; end if;
  if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then raise exception 'Fecha de pago inválida'; end if;
  select value into v_bcv from public.exchange_rates where rate_type='BCV' and timezone('America/Caracas',effective_at)::date<=p_paid_on order by effective_at desc limit 1;
  select value into v_op from public.exchange_rates where rate_type='OPERATIVE' and timezone('America/Caracas',effective_at)::date<=p_paid_on order by effective_at desc limit 1;
  if v_bcv is null or v_op is null then select bcv_rate,operative_rate into v_bcv,v_op from public.current_exchange_rates; end if;
  v_value_ves:=case when v_account.currency='USD' then round(p_amount*v_op,2) else round(p_amount,2) end;
  v_value_ref:=round(v_value_ves/v_bcv,4);
  v_applied:=case when v_invoice.currency='USD' then v_value_ref else v_value_ves end;
  v_remaining:=greatest(v_invoice.total_original-v_invoice.paid_original,0);
  if v_applied > (v_remaining + (case when v_invoice.currency='USD' then 0.05 else 1 end)) then raise exception 'El pago supera el saldo pendiente'; end if;
  v_applied:=least(v_applied,v_remaining);
  insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,payee,note,reference,occurred_at)
  select p_account_id,'OUT','SUPPLIER_PAYMENT',v_account.currency,p_amount,v_value_ves,'Pago a proveedor',s.name,nullif(trim(p_note),''),nullif(trim(p_reference),''),((p_paid_on::timestamp+time '12:00') at time zone 'America/Caracas') from public.suppliers s where s.id=v_invoice.supplier_id returning id into v_movement;
  insert into public.supplier_payments(supplier_invoice_id,account_id,account_movement_id,currency,amount_original,amount_applied_invoice,value_ves,value_ref,paid_on,reference,note)
  values(p_invoice_id,p_account_id,v_movement,v_account.currency,p_amount,v_applied,v_value_ves,v_value_ref,p_paid_on,nullif(trim(p_reference),''),nullif(trim(p_note),'')) returning id into v_id;
  v_status:=case when v_invoice.paid_original+v_applied >= (v_invoice.total_original - (case when v_invoice.currency='USD' then 0.05 else 1 end)) then 'PAID' else 'PARTIAL' end;
  update public.supplier_invoices set paid_original=case when v_status='PAID' then total_original else round(paid_original+v_applied,2) end,status=v_status,updated_at=now() where id=p_invoice_id;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('supplier_payment.recorded','supplier_payment',v_id,jsonb_build_object('invoice_id',p_invoice_id,'movement_id',v_movement,'amount',p_amount,'currency',v_account.currency,'applied',v_applied));
  return v_id;
end;
$function$;

create or replace function public.void_supplier_invoice(p_invoice_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $function$
begin
  perform public.require_auth();
  if not lubricenter_private.is_order_admin() then raise exception 'Solo la cuenta administradora puede anular facturas de proveedor'; end if;
  if coalesce(trim(p_reason),'')='' then raise exception 'Indica el motivo'; end if;
  if exists(select 1 from public.supplier_receipts where supplier_invoice_id=p_invoice_id and status='POSTED') or exists(select 1 from public.supplier_payments where supplier_invoice_id=p_invoice_id) then raise exception 'Esta factura ya tiene recepciones o pagos y no se puede anular directamente'; end if;
  update public.supplier_invoices set status='VOID',voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason),updated_at=now() where id=p_invoice_id and status<>'VOID';
  if not found then raise exception 'Factura no encontrada o ya anulada'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('supplier_invoice.voided','supplier_invoice',p_invoice_id,jsonb_build_object('reason',trim(p_reason)));
end;
$function$;

create or replace function public.supplier_invoice_detail(p_invoice_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $function$
declare v_result jsonb;
begin
  perform public.require_auth();
  select jsonb_build_object(
    'invoice',to_jsonb(i)||jsonb_build_object('supplier_name',s.name,'supplier_rif',s.rif,'outstanding_original',greatest(i.total_original-i.paid_original,0)),
    'items',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.supplier_invoice_items x where x.supplier_invoice_id=i.id),'[]'::jsonb),
    'receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.received_on desc,r.created_at desc) from public.supplier_receipts r where r.supplier_invoice_id=i.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(sp)||jsonb_build_object('account_name',fa.name) order by sp.paid_on desc,sp.created_at desc) from public.supplier_payments sp join public.financial_accounts fa on fa.id=sp.account_id where sp.supplier_invoice_id=i.id),'[]'::jsonb),
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.account_type,a.name) from public.account_balances_current a where a.active and a.account_type not in ('RELATED','CLEARING')),'[]'::jsonb),
    'locations',coalesce((select jsonb_agg(to_jsonb(l) order by l.name) from public.locations l where l.active),'[]'::jsonb)
  ) into v_result from public.supplier_invoices i join public.suppliers s on s.id=i.supplier_id where i.id=p_invoice_id;
  if v_result is null then raise exception 'Factura no encontrada'; end if;
  return v_result;
end;
$function$;

create or replace function public.purchasing_dashboard(p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=public as $function$
declare v_from date:=coalesce(p_from,date_trunc('month',timezone('America/Caracas',now()))::date); v_to date:=coalesce(p_to,timezone('America/Caracas',now())::date); v_result jsonb;
begin
  perform public.require_auth();
  if v_from>v_to or v_to-v_from>366 then raise exception 'Rango de fechas inválido'; end if;
  select jsonb_build_object(
    'period',jsonb_build_object('from',v_from,'to',v_to),
    'summary',jsonb_build_object(
      'invoiced_ref',coalesce((select sum(case when currency='USD' then total_original else total_original/bcv_rate_snapshot end) from public.supplier_invoices where status<>'VOID' and invoice_date between v_from and v_to),0),
      'paid_ves',coalesce((select sum(value_ves) from public.supplier_payments where paid_on between v_from and v_to),0),
      'payable_ref',coalesce((select sum(case when currency='USD' then total_original-paid_original else (total_original-paid_original)/bcv_rate_snapshot end) from public.supplier_invoices where status in ('OPEN','PARTIAL')),0),
      'overdue',coalesce((select count(*) from public.supplier_invoices where status in ('OPEN','PARTIAL') and due_date<timezone('America/Caracas',now())::date),0),
      'suppliers',coalesce((select count(*) from public.suppliers where active),0)
    ),
    'suppliers',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (select s.*,count(i.id) invoice_count,coalesce(sum(case when i.status in ('OPEN','PARTIAL') then case when i.currency='USD' then i.total_original-i.paid_original else (i.total_original-i.paid_original)/i.bcv_rate_snapshot end else 0 end),0) payable_ref from public.suppliers s left join public.supplier_invoices i on i.supplier_id=s.id group by s.id) x),'[]'::jsonb),
    'invoices',coalesce((select jsonb_agg(to_jsonb(x) order by x.invoice_date desc,x.created_at desc) from (select i.*,s.name supplier_name,greatest(i.total_original-i.paid_original,0) outstanding_original,coalesce((select sum(si.received_quantity) from public.supplier_invoice_items si where si.supplier_invoice_id=i.id and si.line_type='INVENTORY'),0) received_units,coalesce((select sum(si.quantity) from public.supplier_invoice_items si where si.supplier_invoice_id=i.id and si.line_type='INVENTORY'),0) invoiced_units from public.supplier_invoices i join public.suppliers s on s.id=i.supplier_id where i.invoice_date between v_from and v_to order by i.invoice_date desc limit 200) x),'[]'::jsonb),
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.account_type,a.name) from public.account_balances_current a where a.active and a.account_type not in ('RELATED','CLEARING')),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.snapshot_order_item_cost()
returns trigger language plpgsql security definer set search_path=public as $function$
declare v_cost numeric;
begin
  if new.movement_type='SALE' and new.order_item_id is not null then
    select average_cost_ref into v_cost from public.inventory_items where id=new.inventory_item_id;
    update public.order_items set unit_cost_ref_snapshot=coalesce(unit_cost_ref_snapshot,v_cost),total_cost_ref_snapshot=coalesce(total_cost_ref_snapshot,round(abs(new.quantity_delta)*v_cost,4)) where id=new.order_item_id;
  end if;
  return new;
end;
$function$;
drop trigger if exists snapshot_order_item_cost_trigger on public.inventory_movements;
create trigger snapshot_order_item_cost_trigger before insert on public.inventory_movements for each row execute function public.snapshot_order_item_cost();

create or replace function public.cash_close_dashboard(p_business_date date default null)
returns jsonb language plpgsql stable security definer set search_path=public as $function$
declare v_day date:=coalesce(p_business_date,timezone('America/Caracas',now())::date); v_location uuid; v_closing public.cash_closings; v_accounts jsonb;
begin
  perform public.require_auth();
  select id into v_location from public.locations where active order by created_at limit 1;
  select * into v_closing from public.cash_closings where business_date=v_day and location_id=v_location;
  with amounts as (
    select a.id,a.code,a.name,a.currency,a.account_type,
      coalesce(sum(case when m.occurred_at<((v_day::timestamp) at time zone 'America/Caracas') then case when m.direction='IN' then m.amount_original else -m.amount_original end else 0 end),0) opening_native,
      coalesce(sum(case when m.direction='IN' and timezone('America/Caracas',m.occurred_at)::date=v_day then m.amount_original else 0 end),0) system_in_native,
      coalesce(sum(case when m.direction='OUT' and timezone('America/Caracas',m.occurred_at)::date=v_day then m.amount_original else 0 end),0) system_out_native
    from public.financial_accounts a left join public.account_movements m on m.account_id=a.id
    where a.active and a.account_type not in ('RELATED','CLEARING') group by a.id
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.account_type,x.name),'[]'::jsonb) into v_accounts
  from (select a.*,a.opening_native+a.system_in_native-a.system_out_native expected_native,
    d.actual_native,d.difference_native,d.explanation,d.denomination_counts,d.updated_at counted_at
    from amounts a left join public.cash_closing_accounts d on d.cash_closing_id=v_closing.id and d.account_id=a.id) x;
  return jsonb_build_object('business_date',v_day,'location_id',v_location,'status',coalesce(v_closing.status,'OPEN'),'closing',case when v_closing.id is null then null else to_jsonb(v_closing) end,'accounts',v_accounts);
end;
$function$;

create or replace function public.save_cash_count(p_business_date date,p_account_id uuid,p_actual_native numeric,p_explanation text default null,p_denominations jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path=public as $function$
declare v_location uuid; v_closing public.cash_closings; v_open numeric; v_in numeric; v_out numeric; v_expected numeric;
begin
  perform public.require_auth();
  if p_business_date is null or p_business_date>timezone('America/Caracas',now())::date then raise exception 'Fecha de cuadre inválida'; end if;
  if p_actual_native is null or p_actual_native<0 then raise exception 'El saldo contado no puede ser negativo'; end if;
  if not exists(select 1 from public.financial_accounts where id=p_account_id and active and account_type not in ('RELATED','CLEARING')) then raise exception 'Cuenta no disponible para cuadre'; end if;
  select id into v_location from public.locations where active order by created_at limit 1;
  insert into public.cash_closings(business_date,location_id) values(p_business_date,v_location) on conflict(business_date,location_id) do nothing;
  select * into v_closing from public.cash_closings where business_date=p_business_date and location_id=v_location for update;
  if v_closing.status='CLOSED' then raise exception 'El día está cerrado. La cuenta administradora debe reabrirlo para modificarlo'; end if;
  select coalesce(sum(case when direction='IN' then amount_original else -amount_original end) filter(where occurred_at<((p_business_date::timestamp) at time zone 'America/Caracas')),0),coalesce(sum(amount_original) filter(where direction='IN' and timezone('America/Caracas',occurred_at)::date=p_business_date),0),coalesce(sum(amount_original) filter(where direction='OUT' and timezone('America/Caracas',occurred_at)::date=p_business_date),0) into v_open,v_in,v_out from public.account_movements where account_id=p_account_id;
  v_expected:=v_open+v_in-v_out;
  insert into public.cash_closing_accounts(cash_closing_id,account_id,opening_native,system_in_native,system_out_native,expected_native,actual_native,difference_native,explanation,denomination_counts,updated_by,updated_at)
  values(v_closing.id,p_account_id,v_open,v_in,v_out,v_expected,p_actual_native,p_actual_native-v_expected,nullif(trim(p_explanation),''),coalesce(p_denominations,'{}'::jsonb),auth.uid(),now())
  on conflict(cash_closing_id,account_id) do update set opening_native=excluded.opening_native,system_in_native=excluded.system_in_native,system_out_native=excluded.system_out_native,expected_native=excluded.expected_native,actual_native=excluded.actual_native,difference_native=excluded.difference_native,explanation=excluded.explanation,denomination_counts=excluded.denomination_counts,updated_by=auth.uid(),updated_at=now();
  return v_closing.id;
end;
$function$;

create or replace function public.close_cash_day(p_business_date date,p_notes text default null)
returns uuid language plpgsql security definer set search_path=public as $function$
declare v_location uuid; v_closing public.cash_closings; v_missing integer; v_unexplained integer;
begin
  perform public.require_auth();
  select id into v_location from public.locations where active order by created_at limit 1;
  select * into v_closing from public.cash_closings where business_date=p_business_date and location_id=v_location for update;
  if not found then raise exception 'Primero cuenta los saldos de cada cuenta'; end if;
  if v_closing.status='CLOSED' then return v_closing.id; end if;
  if v_closing.status='REVIEW' and not lubricenter_private.is_order_admin() then raise exception 'Este cierre cambió después de cerrarse. Solo la cuenta administradora puede revisarlo y cerrarlo otra vez'; end if;
  perform public.save_cash_count(p_business_date,a.account_id,a.actual_native,a.explanation,a.denomination_counts) from public.cash_closing_accounts a where a.cash_closing_id=v_closing.id and a.actual_native is not null;
  select count(*) into v_missing from public.financial_accounts a where a.active and a.account_type not in ('RELATED','CLEARING') and not exists(select 1 from public.cash_closing_accounts d where d.cash_closing_id=v_closing.id and d.account_id=a.id and d.actual_native is not null);
  if v_missing>0 then raise exception 'Falta contar % cuenta(s)',v_missing; end if;
  select count(*) into v_unexplained from public.cash_closing_accounts d join public.financial_accounts a on a.id=d.account_id where d.cash_closing_id=v_closing.id and abs(d.difference_native)>case when a.currency='USD' then 0.01 else 1 end and coalesce(trim(d.explanation),'')='';
  if v_unexplained>0 then raise exception 'Explica las diferencias antes de cerrar'; end if;
  update public.cash_closings set status='CLOSED',notes=nullif(trim(p_notes),''),closed_by=auth.uid(),closed_at=now(),review_reason=null,updated_at=now() where id=v_closing.id;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('cash_close.closed','cash_closing',v_closing.id,jsonb_build_object('business_date',p_business_date));
  return v_closing.id;
end;
$function$;

create or replace function public.reopen_cash_day(p_business_date date,p_reason text)
returns uuid language plpgsql security definer set search_path=public as $function$
declare v_location uuid; v_id uuid;
begin
  perform public.require_auth();
  if not lubricenter_private.is_order_admin() then raise exception 'Solo la cuenta administradora puede reabrir un cuadre'; end if;
  if coalesce(trim(p_reason),'')='' then raise exception 'Indica el motivo de reapertura'; end if;
  select id into v_location from public.locations where active order by created_at limit 1;
  update public.cash_closings set status='REOPENED',reopened_by=auth.uid(),reopened_at=now(),reopen_reason=trim(p_reason),updated_at=now() where business_date=p_business_date and location_id=v_location and status in ('CLOSED','REVIEW') returning id into v_id;
  if v_id is null then raise exception 'No hay un cuadre cerrado para reabrir'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('cash_close.reopened','cash_closing',v_id,jsonb_build_object('business_date',p_business_date,'reason',trim(p_reason)));
  return v_id;
end;
$function$;

create or replace function public.mark_cash_close_review()
returns trigger language plpgsql security definer set search_path=public as $function$
declare v_day date; v_old_day date;
begin
  if tg_op='DELETE' then v_day:=timezone('America/Caracas',old.occurred_at)::date;
  else v_day:=timezone('America/Caracas',new.occurred_at)::date; end if;
  v_old_day:=case when tg_op='UPDATE' then timezone('America/Caracas',old.occurred_at)::date else null end;
  update public.cash_closings set status='REVIEW',review_reason='Se registró o modificó un movimiento después del cierre',updated_at=now() where status='CLOSED' and business_date in (v_day,v_old_day);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$function$;
drop trigger if exists mark_cash_close_review_trigger on public.account_movements;
create trigger mark_cash_close_review_trigger after insert or update or delete on public.account_movements for each row execute function public.mark_cash_close_review();

revoke all on function public.upsert_supplier(uuid,text,text,text,text,text,text,text,text,text,integer,text,boolean) from public,anon;
revoke all on function public.create_supplier_invoice(uuid,text,date,date,text,jsonb,numeric,numeric,numeric,text) from public,anon;
revoke all on function public.receive_supplier_invoice(uuid,date,jsonb,uuid,text) from public,anon;
revoke all on function public.record_supplier_payment(uuid,uuid,numeric,date,text,text) from public,anon;
revoke all on function public.void_supplier_invoice(uuid,text) from public,anon;
revoke all on function public.supplier_invoice_detail(uuid) from public,anon;
revoke all on function public.purchasing_dashboard(date,date) from public,anon;
revoke all on function public.cash_close_dashboard(date) from public,anon;
revoke all on function public.save_cash_count(date,uuid,numeric,text,jsonb) from public,anon;
revoke all on function public.close_cash_day(date,text) from public,anon;
revoke all on function public.reopen_cash_day(date,text) from public,anon;
grant execute on function public.upsert_supplier(uuid,text,text,text,text,text,text,text,text,text,integer,text,boolean) to authenticated;
grant execute on function public.create_supplier_invoice(uuid,text,date,date,text,jsonb,numeric,numeric,numeric,text) to authenticated;
grant execute on function public.receive_supplier_invoice(uuid,date,jsonb,uuid,text) to authenticated;
grant execute on function public.record_supplier_payment(uuid,uuid,numeric,date,text,text) to authenticated;
grant execute on function public.void_supplier_invoice(uuid,text) to authenticated;
grant execute on function public.supplier_invoice_detail(uuid) to authenticated;
grant execute on function public.purchasing_dashboard(date,date) to authenticated;
grant execute on function public.cash_close_dashboard(date) to authenticated;
grant execute on function public.save_cash_count(date,uuid,numeric,text,jsonb) to authenticated;
grant execute on function public.close_cash_day(date,text) to authenticated;
grant execute on function public.reopen_cash_day(date,text) to authenticated;



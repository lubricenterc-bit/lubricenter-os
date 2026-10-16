-- Intake from supplier documents is NOT a financial supplier invoice, nor a stock receipt.
-- This staging permits catalog creation with 0 stock and pending sale pricing.
create table if not exists public.catalog_invoice_intakes(
 id uuid primary key default gen_random_uuid(),
 supplier_name text not null,
 invoice_number text not null,
 currency text not null check(currency in ('USD','VES')),
 invoice_date date,
 note text,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique(supplier_name,invoice_number)
);
create table if not exists public.catalog_invoice_intake_lines(
 id uuid primary key default gen_random_uuid(),
 intake_id uuid not null references public.catalog_invoice_intakes(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 sku text,
 quantity_in_invoice numeric not null check(quantity_in_invoice>0),
 unit_cost_original numeric not null check(unit_cost_original>=0),
 existing_catalog_product boolean not null,
 created_at timestamptz not null default now()
);
create index if not exists catalog_invoice_intake_lines_by_product
on public.catalog_invoice_intake_lines(product_id,created_at desc);
alter table public.catalog_invoice_intakes enable row level security;
alter table public.catalog_invoice_intake_lines enable row level security;
revoke all on public.catalog_invoice_intakes,public.catalog_invoice_intake_lines from public,anon,authenticated;
grant select on public.catalog_invoice_intakes,public.catalog_invoice_intake_lines to authenticated;
create policy catalog_invoice_read_owner on public.catalog_invoice_intakes
for select to authenticated using(lubricenter_private.is_order_admin());
create policy catalog_invoice_line_read_owner on public.catalog_invoice_intake_lines
for select to authenticated using(lubricenter_private.is_order_admin());

-- One transaction: duplicate invoice aborts the entire batch, no partial product additions.
-- Inventory stock and weighted costs are deliberately untouched.
create or replace function lubricenter_private.catalog_register_invoice_items(
 p_supplier_name text,p_invoice_number text,p_currency text,p_invoice_date date,
 p_lines jsonb,p_note text default null
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_intake uuid;v_row jsonb;v_name text;v_sku text;v_category text;
 v_quantity numeric;v_cost numeric;v_existing public.products%rowtype;
 v_id uuid;v_created integer:=0;v_matched integer:=0;
begin
 perform lubricenter_private.require_order_admin();
 if (select s.value#>>'{}' from public.app_settings s where key='catalog_authority')<>'LUBRICENTER_OS'
 then raise exception 'El catálogo todavía no se administra aquí'; end if;
 if length(btrim(coalesce(p_supplier_name,'')))<2 or length(btrim(p_supplier_name))>180
 or length(btrim(coalesce(p_invoice_number,'')))<1 or length(btrim(p_invoice_number))>100
 then raise exception 'Indica proveedor y número de factura'; end if;
 if p_currency not in ('USD','VES') then raise exception 'Moneda de factura inválida'; end if;
 if p_invoice_date> (now() at time zone 'America/Caracas')::date
 then raise exception 'Fecha de factura futura'; end if;
 if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)<1 or jsonb_array_length(p_lines)>150
 then raise exception 'La factura debe contener entre 1 y 150 artículos'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-native-catalog',0));
 insert into public.catalog_invoice_intakes(supplier_name,invoice_number,currency,invoice_date,note,created_by)
 values(btrim(p_supplier_name),btrim(p_invoice_number),p_currency,p_invoice_date,
  nullif(btrim(coalesce(p_note,'')),''),auth.uid()) returning id into v_intake;
 for v_row in select value from jsonb_array_elements(p_lines) loop
   v_name:=btrim(coalesce(v_row->>'name',''));
   v_category:=nullif(btrim(coalesce(v_row->>'category','')),'');
   v_sku:=nullif(btrim(coalesce(v_row->>'sku','')),'');
   if length(v_name)<2 or length(v_name)>180 or length(coalesce(v_sku,''))>100 or length(coalesce(v_category,''))>120
   then raise exception 'Una línea tiene un nombre, código o categoría inválido'; end if;
   begin
    v_quantity:=(v_row->>'quantity')::numeric;
    v_cost:=(v_row->>'unit_cost')::numeric;
   exception when others then raise exception 'Revisa las cantidades y costos numéricos de la factura'; end;
   if v_quantity is null or v_quantity<=0 or v_quantity>1000000
      or v_cost is null or v_cost<0 or v_cost>1000000
   then raise exception 'Cantidad o costo inválido en %',v_name; end if;
   select * into v_existing from public.products where lower(btrim(name))=lower(v_name) limit 1;
   if found then
     v_id:=v_existing.id;v_matched:=v_matched+1;
   else
     insert into public.products(name,category,filter_code,cash_usd_base_price,
       active,available,catalog_source,notes)
     values(v_name,v_category,v_sku,0,false,false,'Lubricenter OS',
       'Pendiente de fijar precio de venta. Captado de factura '||p_invoice_number)
     returning id into v_id;
     insert into public.catalog_product_changes(product_id,actor_id,before_state,after_state)
     select v_id,auth.uid(),null,to_jsonb(p) from public.products p where id=v_id;
     v_created:=v_created+1;
   end if;
   insert into public.catalog_invoice_intake_lines(intake_id,product_id,sku,quantity_in_invoice,unit_cost_original,existing_catalog_product)
   values(v_intake,v_id,v_sku,v_quantity,v_cost,v_existing.id is not null);
   v_existing:=null;
 end loop;
 insert into public.audit_events(event_type,entity_type,entity_id,actor_id,data)
 values('catalog.invoice_intake','catalog_invoice_intakes',v_intake,auth.uid(),
   jsonb_build_object('supplier',p_supplier_name,'invoice',p_invoice_number,
   'created',v_created,'existing',v_matched,'lines',jsonb_array_length(p_lines),
   'not_posted_to_inventory',true,'not_posted_to_accounts',true));
 return jsonb_build_object('intake_id',v_intake,'created',v_created,'matched',v_matched,
 'stock_changed',false,'prices_changed',false);
end $$;
create or replace function public.catalog_register_invoice_items(
 p_supplier_name text,p_invoice_number text,p_currency text,p_invoice_date date,
 p_lines jsonb,p_note text default null
) returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.catalog_register_invoice_items(
 p_supplier_name,p_invoice_number,p_currency,p_invoice_date,p_lines,p_note)$$;
revoke all on function public.catalog_register_invoice_items(text,text,text,date,jsonb,text) from public,anon;
revoke all on function lubricenter_private.catalog_register_invoice_items(text,text,text,date,jsonb,text) from public,anon;
grant execute on function public.catalog_register_invoice_items(text,text,text,date,jsonb,text) to authenticated;
grant execute on function lubricenter_private.catalog_register_invoice_items(text,text,text,date,jsonb,text) to authenticated;

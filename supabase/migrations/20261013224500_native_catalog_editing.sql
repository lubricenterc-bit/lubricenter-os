-- Audit native catalog editing. No direct client writes to products, stock or history.
create table if not exists public.catalog_product_changes(
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references public.products(id) on delete restrict,
 actor_id uuid not null,
 changed_at timestamptz not null default now(),
 before_state jsonb,
 after_state jsonb not null
);
create index if not exists catalog_product_changes_by_product on public.catalog_product_changes(product_id,changed_at desc);
alter table public.catalog_product_changes enable row level security;
revoke all on table public.catalog_product_changes from public,anon,authenticated;
grant select on table public.catalog_product_changes to authenticated;
create policy catalog_product_audit_owner_read on public.catalog_product_changes for select
 to authenticated using (lubricenter_private.is_order_admin());

create or replace function lubricenter_private.catalog_save_product(
 p_id uuid,p_name text,p_category text,p_filter_code text,p_usd numeric,
 p_notes text,p_image_url text,p_available boolean,p_active boolean,
 p_expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_old public.products%rowtype;v_new public.products%rowtype;
 v_name text:=btrim(coalesce(p_name,''));v_category text:=nullif(btrim(coalesce(p_category,'')),'');
 v_filter text:=nullif(btrim(coalesce(p_filter_code,'')),'');
 v_notes text:=nullif(btrim(coalesce(p_notes,'')),'');
 v_photo text:=nullif(btrim(coalesce(p_image_url,'')),'');
begin
 perform lubricenter_private.require_order_admin();
 if coalesce((select s.value #>> '{}' from public.app_settings s where s.key='catalog_authority'),'NOTION')<>'LUBRICENTER_OS'
 then raise exception 'El catálogo aún no es administrado por Lubricenter OS'; end if;
 if length(v_name)<2 or length(v_name)>180 then raise exception 'Nombre inválido: usa entre 2 y 180 caracteres'; end if;
 if length(coalesce(v_category,''))>120 or length(coalesce(v_filter,''))>100 or length(coalesce(v_notes,''))>3000
 then raise exception 'Categoría, código o descripción demasiado largos'; end if;
 if v_photo is not null and (length(v_photo)>1800 or v_photo !~* '^https://[^[:space:]]+$')
 then raise exception 'La fotografía debe tener una URL HTTPS válida'; end if;
 if p_usd is null or p_usd<0 or p_usd>1000000 or p_usd::text in ('NaN','Infinity','-Infinity')
 then raise exception 'Precio USD inválido'; end if;
 if coalesce(p_active,false) and coalesce(p_available,false) and p_usd<=0
 then raise exception 'No publiques un producto sin precio de venta'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lubricenter-native-catalog',0));
 if p_id is not null then
  select * into v_old from public.products where id=p_id for update;
  if not found then raise exception 'El producto ya no existe'; end if;
  if p_expected_updated_at is null or p_expected_updated_at is distinct from v_old.updated_at
  then raise exception 'El artículo fue modificado: actualiza la página antes de guardar'; end if;
 end if;
 if exists(select 1 from public.products p
  where lower(btrim(p.name))=lower(v_name) and (p_id is null or p.id<>p_id))
 then raise exception 'Ya existe un producto con ese nombre'; end if;
 if p_id is null then
  insert into public.products(name,category,filter_code,cash_usd_base_price,notes,image_url,
   active,available,catalog_source)
  values(v_name,v_category,v_filter,p_usd,v_notes,v_photo,
   coalesce(p_active,true),coalesce(p_active,true) and coalesce(p_available,true),'Lubricenter OS')
  returning * into v_new;
 else
  update public.products set name=v_name,category=v_category,filter_code=v_filter,
   cash_usd_base_price=p_usd,notes=v_notes,image_url=v_photo,
   active=coalesce(p_active,false),
   available=coalesce(p_active,false) and coalesce(p_available,false),
   catalog_source='Lubricenter OS'
  where id=p_id returning * into v_new;
 end if;
 insert into public.catalog_product_changes(product_id,actor_id,before_state,after_state)
 values(v_new.id,auth.uid(),case when p_id is null then null else to_jsonb(v_old) end,to_jsonb(v_new));
 insert into public.audit_events(event_type,entity_type,entity_id,actor_id,data)
 values('catalog.product_saved','products',v_new.id,auth.uid(),
   jsonb_build_object('before',case when p_id is null then null else to_jsonb(v_old) end,'after',to_jsonb(v_new)));
 return jsonb_build_object('id',v_new.id,'new',p_id is null,'active',v_new.active,'name',v_new.name);
end $$;
create or replace function public.catalog_save_product(
 p_id uuid,p_name text,p_category text,p_filter_code text,p_usd numeric,
 p_notes text,p_image_url text,p_available boolean,p_active boolean,
 p_expected_updated_at timestamptz default null
) returns jsonb language sql security invoker set search_path=''
as $$select lubricenter_private.catalog_save_product(p_id,p_name,p_category,p_filter_code,
  p_usd,p_notes,p_image_url,p_available,p_active,p_expected_updated_at)$$;
revoke all on function public.catalog_save_product(uuid,text,text,text,numeric,text,text,boolean,boolean,timestamptz) from public,anon;
revoke all on function lubricenter_private.catalog_save_product(uuid,text,text,text,numeric,text,text,boolean,boolean,timestamptz) from public,anon;
grant execute on function public.catalog_save_product(uuid,text,text,text,numeric,text,text,boolean,boolean,timestamptz) to authenticated;
grant execute on function lubricenter_private.catalog_save_product(uuid,text,text,text,numeric,text,text,boolean,boolean,timestamptz) to authenticated;

-- Existing RPC shape is preserved for other pages. While Notion is temporarily the FX source,
-- return the last rate-sync heartbeat after cutover: the legacy Edge Function uses this
-- timestamp to decide whether to fetch again; returning now() would freeze ALL rate syncs.
create or replace function public.get_pricing_sync_status()
returns table(catalog_synced_at timestamptz,catalog_products bigint,
bcv_rate numeric,bcv_effective_at timestamptz,
operative_rate numeric,operative_effective_at timestamptz)
language sql stable security definer set search_path=''
as $$
select
case when (select value#>>'{}' from public.app_settings where key='catalog_authority')='LUBRICENTER_OS'
 then (select last_verified_at from public.integration_sync_state where source_key='notion_rates')
 else coalesce((select last_verified_at from public.integration_sync_state where source_key='notion_catalog'),
        (select max(catalog_synced_at) from public.products where catalog_source='Notion · Nuestros Productos')) end,
(select count(*) from public.products where active and available),
(select value from public.exchange_rates where rate_type='BCV' order by effective_at desc,created_at desc limit 1),
coalesce((select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
 (select effective_at from public.exchange_rates where rate_type='BCV' order by effective_at desc,created_at desc limit 1)),
(select value from public.exchange_rates where rate_type='OPERATIVE' order by effective_at desc,created_at desc limit 1),
coalesce((select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
 (select effective_at from public.exchange_rates where rate_type='OPERATIVE' order by effective_at desc,created_at desc limit 1));
$$;

create or replace function public.assert_notion_pricing_fresh()
returns void language plpgsql security definer set search_path=''
as $$
declare v_catalog_sync timestamptz;v_rate_sync timestamptz;v_native boolean;
begin
 v_native:=coalesce((select value#>>'{}' from public.app_settings where key='catalog_authority'),'NOTION')='LUBRICENTER_OS';
 if v_native then
  if not exists(select 1 from public.products where active and available)
  then raise exception 'El catálogo no contiene artículos disponibles para vender'; end if;
 else
  select coalesce((select last_verified_at from public.integration_sync_state where source_key='notion_catalog'),
   (select max(catalog_synced_at) from public.products where catalog_source='Notion · Nuestros Productos'))
   into v_catalog_sync;
  if v_catalog_sync is null or v_catalog_sync<now()-interval '24 hours'
  then raise exception 'El catálogo de Notion está desactualizado'; end if;
 end if;
 -- Until BCV cutover PR#59 is verified, the existing exchange-rate safety gate remains.
 select coalesce((select last_verified_at from public.integration_sync_state where source_key='notion_rates'),
    least((select effective_at from public.exchange_rates where rate_type='BCV' order by effective_at desc limit 1),
          (select effective_at from public.exchange_rates where rate_type='OPERATIVE' order by effective_at desc limit 1)))
  into v_rate_sync;
 if v_rate_sync is null or v_rate_sync<now()-interval '3 hours'
 then raise exception 'Tasas de cambio desactualizadas: comprueba el sistema de tasas'; end if;
end $$;
-- Preparing a stock reference never imports stock or assigns a cost.
create or replace function public.catalog_prepare_inventory_item(
 p_product_id uuid,p_sku text,p_brand text default null,p_unit text default 'UND'
) returns uuid language plpgsql security definer set search_path=''
as $$
declare p public.products; item_id uuid;
begin
 perform lubricenter_private.require_order_admin();
 if not exists(select 1 from public.app_settings where key='catalog_authority' and value #>> '{}'='LUBRICENTER_OS') then
   raise exception 'La administración nativa del catálogo todavía no está activa';
 end if;
 if nullif(trim(p_sku),'') is null or length(trim(p_sku))>100
   or coalesce(p_unit,'') not in ('UND','L','GAL','KG') then
   raise exception 'Indica código y unidad válidos';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-inventory:'||lower(trim(p_sku))||':'||lower(trim(coalesce(p_brand,''))),0));
 select * into p from public.products where id=p_product_id for update;
 if not found then raise exception 'Producto no encontrado'; end if;
 select id into item_id from public.inventory_items where product_id=p_product_id limit 1;
 if item_id is not null then return item_id; end if;
 select id into item_id from public.inventory_items where lower(trim(sku))=lower(trim(p_sku))
   and lower(trim(coalesce(brand,'')))=lower(trim(coalesce(p_brand,''))) for update;
 if item_id is not null then
   if exists(select 1 from public.inventory_items where id=item_id and product_id is not null and product_id<>p_product_id) then
     raise exception 'Ese código ya está vinculado a otro producto';
   end if;
   update public.inventory_items set product_id=p_product_id,updated_at=now() where id=item_id;
 else
   insert into public.inventory_items(sku,brand,description,category,unit,product_id,
    source_cost_ref,source_stock_imported,needs_review,cost_missing,source_name)
   values(trim(p_sku),nullif(trim(p_brand),''),p.name,p.category,p_unit,p.id,0,0,true,true,'Lubricenter OS')
   returning id into item_id;
 end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('catalog.inventory_prepared','inventory_item',item_id,jsonb_build_object('product_id',p.id,'stock_changed',false,'actor',auth.uid()));
 return item_id;
end $$;
revoke all on function public.catalog_prepare_inventory_item(uuid,text,text,text) from public,anon;
grant execute on function public.catalog_prepare_inventory_item(uuid,text,text,text) to authenticated;

-- Release remains off until all checkout/closure/payroll paths are integrated.
insert into public.app_settings(key,value) values('finance_settlement_v3_ready','false') on conflict(key) do nothing;

create function lubricenter_private.set_order_price_v3(p_item uuid,p_revision integer,p_basis text,p_principal text,p_ownership text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.order_items; o public.orders; prior public.order_price_agreements; principal numeric; next_id uuid; worker uuid; snapshot jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_item is null or p_revision is null or p_basis is null or p_basis not in ('USD_FIXED','USD_REF_BCV','VES_FIXED') or p_ownership is null or p_ownership not in ('SELF','THIRD_PARTY','UNRESOLVED') then raise exception 'Selecciona base y propiedad del concepto'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Escribe la razón del precio acordado'; end if;
 principal:=lubricenter_private.settlement_decimal(p_principal,case when p_basis='USD_REF_BCV' then 8 else 2 end,true);
 perform pg_advisory_xact_lock(220033);
 select * into i from public.order_items where id=p_item;
 select * into o from public.orders where id=i.order_id for update;
 if o.id is null or o.status<>'OPEN' or o.settlement_version<>3 then raise exception 'El precio por concepto requiere una orden abierta con el nuevo cálculo'; end if;
 if o.settlement_revision<>p_revision then raise exception 'La orden cambió: vuelve a revisar el precio'; end if;
 select * into prior from public.order_price_agreements where item_id=i.id and state='ACTIVE' for update;
 if prior.id is not null then
  if prior.basis=p_basis and prior.principal=principal and prior.ownership=p_ownership then return prior.id; end if;
  -- The storage guard rejects a change with applied money or live financing.
  update public.order_price_agreements set state='SUPERSEDED' where id=prior.id;
 end if;
 select e.id into worker from public.employees e where e.id=i.worker_employee_id and e.code='CHEO' and i.business_area='WORKSHOP' and p_ownership='SELF';
 snapshot:=jsonb_build_object('quantity',i.quantity::text,'description',i.description,'source_price_denomination',i.price_denomination,'source_charged_ref',i.charged_ref_amount::text,'source_agreed_usd',i.agreed_usd::text,
  'worker_employee_id',i.worker_employee_id,'protected_worker_share',case when worker is null then i.worker_share_ref_snapshot::text else null end,
  'assistant_employee_id',i.assistant_bonus_employee_id,'protected_assistant_bonus',i.assistant_bonus_ref_snapshot::text);
 if prior.id is not null then snapshot:=prior.commercial_snapshot; end if;
 insert into public.order_price_agreements(order_id,item_id,version,basis,principal,ownership,commission_worker,commission_percent,reason,supersedes_id,commercial_snapshot,created_by)
  values(o.id,i.id,coalesce((select max(version) from public.order_price_agreements where item_id=i.id),0)+1,p_basis,principal,p_ownership,worker,case when worker is not null then 40 end,trim(p_reason),prior.id,snapshot,auth.uid()) returning id into next_id;
 return next_id;
end $$;
create function public.set_order_price_v3(p_item uuid,p_revision integer,p_basis text,p_principal text,p_ownership text,p_reason text) returns uuid
language sql security invoker set search_path='' as $$select lubricenter_private.set_order_price_v3(p_item,p_revision,p_basis,p_principal,p_ownership,p_reason)$$;

create function lubricenter_private.prepare_order_v3(p_order uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; i public.order_items; basis text; principal numeric; revision integer;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if not exists(select 1 from public.app_settings where key='finance_settlement_v3_ready' and value='true'::jsonb) then raise exception 'El nuevo cálculo aún no está habilitado para operar'; end if;
 perform pg_advisory_xact_lock(220033);
 select * into o from public.orders where id=p_order for update;
 if o.id is null or o.status<>'OPEN' then raise exception 'Solo puedes preparar una orden abierta'; end if;
 if o.settlement_version=3 then return lubricenter_private.get_order_financial_summary_v3(o.id); end if;
 if exists(select 1 from public.payments where order_id=o.id) or exists(select 1 from public.cashea_sales where order_id=o.id) or exists(select 1 from public.receivables where order_id=o.id) then raise exception 'Esta orden ya tiene cobros o financiación: necesita revisión individual, sin recalcular su historia'; end if;
 update public.orders set settlement_version=3,settlement_revision=settlement_revision+1 where id=o.id;
 for i in select * from public.order_items where order_id=o.id order by created_at,id loop
  basis:=case when i.price_denomination='USD' then 'USD_FIXED' else 'USD_REF_BCV' end;
  principal:=case when i.price_denomination='USD' then i.agreed_usd else i.charged_ref_amount end;
  if principal is null then raise exception 'Falta precio confirmado para %',i.description; end if;
  select settlement_revision into revision from public.orders where id=o.id;
  perform lubricenter_private.set_order_price_v3(i.id,revision,basis,principal::text,'SELF','Precio original confirmado al preparar la orden');
 end loop;
 return lubricenter_private.get_order_financial_summary_v3(o.id);
end $$;
create function public.prepare_order_v3(p_order uuid) returns jsonb language sql security invoker set search_path='' as $$select lubricenter_private.prepare_order_v3(p_order)$$;

create function public.create_order_finance() returns jsonb language plpgsql security definer set search_path='' as $$
declare order_id uuid; result jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 select id into order_id from public.create_order();
 if exists(select 1 from public.app_settings where key='finance_settlement_v3_ready' and value='true'::jsonb) then perform lubricenter_private.prepare_order_v3(order_id); end if;
 select jsonb_build_object('id',id,'order_number',order_number,'settlement_version',settlement_version) into result from public.orders where id=order_id;
 return result;
end $$;

create function lubricenter_private.add_product_v3(p_order uuid,p_product jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.orders; item uuid; qty numeric; unit numeric; legacy_unit numeric; b numeric; total numeric; basis text; revision integer; kind text;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if jsonb_typeof(p_product)<>'object' or p_product-array['kind','inventory_item_id','product_id','description','quantity','unit','basis']<>'{}' then raise exception 'Datos del producto inválidos'; end if;
 qty:=lubricenter_private.settlement_decimal(p_product->>'quantity',3); unit:=lubricenter_private.settlement_decimal(p_product->>'unit',8);
 basis:=p_product->>'basis'; kind:=p_product->>'kind';
 if basis is null or basis not in ('USD_FIXED','USD_REF_BCV','VES_FIXED') then raise exception 'Selecciona la base del precio'; end if;
 total:=round(qty*unit,case when basis='USD_REF_BCV' then 8 else 2 end);
 if total<=0 or total>=1000000000000 then raise exception 'Precio total fuera de rango'; end if;
 perform pg_advisory_xact_lock(220033); select * into o from public.orders where id=p_order for update;
 if o.id is null or o.status<>'OPEN' or o.settlement_version<>3 then raise exception 'La orden debe usar el nuevo cálculo y estar abierta'; end if;
 legacy_unit:=unit;
 if basis='VES_FIXED' then
  select bcv_rate into b from public.current_exchange_rates;
  if b is null or b<=0 then raise exception 'Falta BCV para registrar la valoración del producto en Bs'; end if;
  legacy_unit:=unit/b;
 end if;
 -- Existing product RPCs retain inventory/catalog provenance and cost snapshots.
 if kind='STOCK' then item:=public.add_inventory_product_item(p_order,(p_product->>'inventory_item_id')::uuid,qty,legacy_unit,'STORE');
 elsif kind='CATALOG' then item:=public.add_catalog_product_item_override(p_order,(p_product->>'product_id')::uuid,qty,legacy_unit);
 elsif kind='MANUAL' then item:=public.add_manual_product_item(p_order,p_product->>'description',qty,legacy_unit);
 else raise exception 'Selecciona inventario, catálogo o producto manual'; end if;
 select settlement_revision into revision from public.orders where id=p_order;
 perform lubricenter_private.set_order_price_v3(item,revision,basis,total::text,'SELF','Precio unitario acordado al agregar producto');
 return item;
end $$;
create function public.add_product_v3(p_order uuid,p_product jsonb) returns uuid language sql security invoker set search_path='' as $$select lubricenter_private.add_product_v3(p_order,p_product)$$;

create function lubricenter_private.add_service_v3(p_order uuid,p_area text,p_description text,p_base text,p_price text,p_basis text,p_bonus boolean default false,p_protected_worker text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare o public.orders; item uuid; base numeric; price numeric; share numeric; revision integer;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_area is null or p_area not in ('WORKSHOP','ELECTROAUTO') or p_basis is null or p_basis not in ('USD_FIXED','USD_REF_BCV') then raise exception 'Selecciona área y base del precio'; end if;
 base:=lubricenter_private.settlement_decimal(p_base); price:=lubricenter_private.settlement_decimal(p_price,case when p_basis='USD_FIXED' then 2 else 8 end,true);
 if p_area='WORKSHOP' and p_protected_worker is not null then raise exception 'Cheo recibe 40 %% del dinero real: no admite una base protegida distinta'; end if;
 share:=case when p_area='WORKSHOP' then price*0.40 when p_protected_worker is not null then lubricenter_private.settlement_decimal(p_protected_worker,8,true) else base*0.40 end;
 perform pg_advisory_xact_lock(220033);select * into o from public.orders where id=p_order for update;
 if o.id is null or o.status<>'OPEN' or o.settlement_version<>3 then raise exception 'La orden debe usar el nuevo cálculo y estar abierta'; end if;
 -- Numeric shares remain snapshots of contractual nominal values. Cheo's live
 -- commission is calculated from applications, never this legacy projection.
 item:=public.add_service_priced(p_order,p_area,p_description,base,price,share,p_bonus,'REF');
 select settlement_revision into revision from public.orders where id=p_order;
 perform lubricenter_private.set_order_price_v3(item,revision,p_basis,price::text,'SELF','Precio del servicio acordado al agregar trabajo');
 return item;
end $$;
create function public.add_service_v3(p_order uuid,p_area text,p_description text,p_base text,p_price text,p_basis text,p_bonus boolean default false,p_protected_worker text default null) returns uuid language sql security invoker set search_path='' as $$select lubricenter_private.add_service_v3(p_order,p_area,p_description,p_base,p_price,p_basis,p_bonus,p_protected_worker)$$;

do $$declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','lubricenter_private') and p.proname in ('set_order_price_v3','prepare_order_v3','create_order_finance','add_product_v3','add_service_v3') loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

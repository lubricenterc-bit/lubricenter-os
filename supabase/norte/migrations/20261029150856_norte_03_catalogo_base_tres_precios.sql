alter table public.inventory_items
  add column if not exists price_cashea_usd numeric(14,4),
  add column if not exists price_divisas_usd numeric(14,4);
alter table public.inventory_items drop constraint if exists inventory_items_three_prices_check;
alter table public.inventory_items add constraint inventory_items_three_prices_check
  check ((price_cashea_usd is null or price_cashea_usd >= 0) and (price_divisas_usd is null or price_divisas_usd >= 0));
comment on column public.inventory_items.price_usd is 'Norte: precio de contado (USD)';
comment on column public.inventory_items.price_cashea_usd is 'Norte: precio Cashea (USD)';
comment on column public.inventory_items.price_divisas_usd is 'Norte: precio en divisas (USD)';

with r as (select content from extensions.http_get('https://raw.githubusercontent.com/lubricenterc-bit/lubricenter-os/cf5a05275687a4e8468a79d4779b5141a535ae1a/supabase/norte/catalogo_base_norte.json'))
insert into public.inventory_items(sku,brand,description,category,unit,display_name,alt_codes,image_url,active,source_name,source_stock_imported,source_cost_ref,cost_missing)
select e->>'sku', e->>'brand', e->>'description', e->>'category', coalesce(e->>'unit','UND'), e->>'display_name',
  coalesce(array(select jsonb_array_elements_text(e->'alt_codes')),'{}'), e->>'image_url', true, 'Catálogo base Norte 2026-10-29', 0, 0, true
from r, jsonb_array_elements(r.content::jsonb) e
on conflict (sku,brand) do nothing;
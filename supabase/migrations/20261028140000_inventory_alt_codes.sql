-- Códigos alternos de inventario: el código que está en la etiqueta o en el conteo físico
-- (por ejemplo CC006 para el filtro de cabina Toyota) cuando no coincide con el SKU del sistema.
-- Se exponen en inventory_current y get_inventory_snapshot para que la búsqueda los encuentre.

alter table public.inventory_items
  add column if not exists alt_codes text[] not null default '{}';

comment on column public.inventory_items.alt_codes is
  'Otros códigos o nombres con los que se busca este artículo (etiqueta, conteo físico, vehículo).';

create or replace view public.inventory_current with (security_invoker = true) as
 WITH stock AS (
         SELECT inventory_movements.inventory_item_id,
            inventory_movements.location_id,
            sum(inventory_movements.quantity_delta) AS quantity_on_hand
           FROM inventory_movements
          GROUP BY inventory_movements.inventory_item_id, inventory_movements.location_id
        )
 SELECT i.id,
    i.sku,
    i.brand,
    i.description,
    i.category,
    i.unit,
    i.source_cost_ref,
    i.source_stock_imported,
    i.source_alert,
    i.source_price_status,
    i.needs_review,
    i.cost_missing,
    i.product_id,
    l.id AS location_id,
    l.code AS location_code,
    l.name AS location_name,
    COALESCE(s.quantity_on_hand, (0)::numeric) AS quantity_on_hand,
    GREATEST(COALESCE(s.quantity_on_hand, (0)::numeric), (0)::numeric) AS sellable_quantity,
    pc.name AS catalog_product_name,
    pc.cash_usd_base_price,
    pc.current_price_ves,
    pc.current_ref_bcv,
    i.imported_at,
    i.updated_at,
    i.alt_codes
   FROM (((inventory_items i
     CROSS JOIN locations l)
     LEFT JOIN stock s ON (((s.inventory_item_id = i.id) AND (s.location_id = l.id))))
     LEFT JOIN product_catalog_current pc ON ((pc.id = i.product_id)))
  WHERE ((i.active = true) AND (l.active = true));

drop function if exists public.get_inventory_snapshot(text);
create function public.get_inventory_snapshot(p_location_code text DEFAULT 'CABUDARE'::text)
returns table(id uuid, sku text, brand text, description text, category text, unit text, source_cost_ref numeric,
  source_alert text, needs_review boolean, cost_missing boolean, location_code text, quantity_on_hand numeric,
  sellable_quantity numeric, product_id uuid, catalog_product_name text, current_price_ves numeric,
  current_ref_bcv numeric, alt_codes text[])
language sql
security definer
set search_path to 'public'
as $$
  select i.id,i.sku,i.brand,i.description,i.category,i.unit,i.source_cost_ref,i.source_alert,
         i.needs_review,i.cost_missing,i.location_code,i.quantity_on_hand,i.sellable_quantity,
         i.product_id,i.catalog_product_name,i.current_price_ves,i.current_ref_bcv,i.alt_codes
  from public.inventory_current i
  where i.location_code = p_location_code
  order by i.category nulls last, i.brand nulls last, i.sku;
$$;
revoke all on function public.get_inventory_snapshot(text) from public, anon;
grant execute on function public.get_inventory_snapshot(text) to authenticated, service_role;

-- Códigos del conteo físico del 15-oct-2026 que no coinciden con el SKU.
update public.inventory_items i
set alt_codes = v.codes, updated_at = now()
from (values
  ('22-22002WIRE', array['22-22002Y']),
  ('7591806000613', array['010615']),
  ('ACDEL-GENE', array['CC013','cabina']),
  ('AF-1408', array['AFK1408']),
  ('AF-2D000', array['AF2000']),
  ('AFC-5738', array['AF5738']),
  ('CHEV-CORS-FILHABI', array['CC008','cabina']),
  ('CHEV-LDMAX-FILHABI', array['CC010','cabina']),
  ('CHEV-OPT-FILHABI', array['CC003','cabina']),
  ('CHEV-SPARK-FILHABI', array['CC011','cabina']),
  ('COS10575', array['CO510575']),
  ('FIAT-FIRE-FILHABI', array['cabina']),
  ('FIAT-SIENA-FILHABI', array['CC016','cabina']),
  ('FORD-FIES16-FILHABI', array['CC002','cabina']),
  ('FORD-FIESM-FILHABI', array['CC004','cabina']),
  ('FORD-FIESP-FILHABI', array['CC001','cabina']),
  ('G-66020', array['MF66020']),
  ('GL-3593', array['6L3593']),
  ('GL-3807', array['6L3807']),
  ('GL-3900', array['693900','GL-39']),
  ('GL-3980', array['6L3980']),
  ('HY-ELA-FILHABI', array['CC014','cabina']),
  ('KIA-SEDO-FILHABI', array['CC012','cabina']),
  ('MG0991', array['M60991']),
  ('MG4143', array['M64143']),
  ('TOY-KAVAK-FILHABI', array['CC006','Rav4','cabina']),
  ('TOY-NSENSAC-FILHABI', array['CC009','Sensación','cabina']),
  ('TOY-T4RF-FILHABI', array['CC007','4Runner','Fortuner','Tundra','cabina']),
  ('UK-1661', array['VK1661']),
  ('UK-2000', array['VK2000']),
  ('VF-0578', array['BF0578']),
  ('VF-5000', array['BF5000']),
  ('WOL-FOX-FILHABI', array['CC017','Volkswagen','cabina']),
  ('WOL-GOL-FILHABI', array['CC015','Volkswagen','cabina']),
  ('X1-3682', array['XI3682']),
  ('LIR-SEM-15W40G', array['LIR-SEM-15W40'])
) v(sku, codes)
where i.sku = v.sku;

-- Los avisos "REABASTECER" de la importación vieja marcaban needs_review, que impide vender el
-- artículo. El conteo físico ya verificó estos artículos; el aviso de reabastecer no es una revisión.
update public.inventory_items
set needs_review = false, updated_at = now()
where needs_review and source_alert = 'REABASTECER' and last_counted_at is not null;

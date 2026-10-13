-- Technical classification independent from Notion pricing and physical stock.
-- A specification applies to exactly one commercial product OR inventory SKU.
-- Empty fields mean "not classified"; no classification is inferred from names.
create table if not exists public.catalog_technical_specs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid unique references public.products(id) on delete cascade,
  inventory_item_id uuid unique references public.inventory_items(id) on delete cascade,
  family text check (family in ('OIL','FILTER','OTHER')),
  brand text,
  viscosity text,
  lubricant_base text check (lubricant_base in ('MINERAL','SEMI','FULL')),
  lubricant_system text check (lubricant_system in ('ENGINE','MANUAL_GEARBOX','ATF','CVT','DCT','DIFFERENTIAL','HYDRAULIC','POWER_STEERING','MOTORCYCLE','OTHER')),
  fuel_application text check (fuel_application in ('GASOLINE','DIESEL','BOTH','NA')),
  volume_liters numeric check (volume_liters>0 and volume_liters<=1000),
  oil_api text,
  oil_acea text,
  oil_jaso text,
  oil_oem_approvals text,
  lubricant_spec text,
  filter_type text check (filter_type in ('OIL','ENGINE_AIR','FUEL','CABIN','TRANSMISSION','HYDRAULIC','OTHER')),
  filter_design text check (filter_design in ('SPIN_ON','CARTRIDGE','PANEL','CYLINDRICAL','INLINE','OTHER')),
  filter_thread text,
  filter_height_mm numeric check(filter_height_mm>0 and filter_height_mm<10000),
  filter_outer_diameter_mm numeric check(filter_outer_diameter_mm>0 and filter_outer_diameter_mm<10000),
  filter_inner_diameter_mm numeric check(filter_inner_diameter_mm>0 and filter_inner_diameter_mm<10000),
  filter_length_mm numeric check(filter_length_mm>0 and filter_length_mm<10000),
  filter_width_mm numeric check(filter_width_mm>0 and filter_width_mm<10000),
  filter_gasket_inner_mm numeric check(filter_gasket_inner_mm>0 and filter_gasket_inner_mm<10000),
  filter_gasket_outer_mm numeric check(filter_gasket_outer_mm>0 and filter_gasket_outer_mm<10000),
  filter_media text check (filter_media in ('PAPER','SYNTHETIC','CARBON','OTHER')),
  filter_connector text,
  filter_water_separator boolean,
  millard_reference text,
  oem_reference text,
  fitment_notes text,
  additional_tags text[] not null default '{}',
  evidence_source text,
  verification_status text not null default 'PENDING' check(verification_status in ('PENDING','DOCUMENTED','VERIFIED')),
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_technical_spec_single_target check (
    (product_id is not null and inventory_item_id is null)
    or (product_id is null and inventory_item_id is not null)
  ),
  constraint catalog_technical_spec_family_attrs check (
    (family='OIL' or (lubricant_base is null and lubricant_system is null and viscosity is null))
    and (family='FILTER' or (filter_type is null and filter_design is null and filter_thread is null and millard_reference is null))
  )
);
create index if not exists catalog_technical_specs_facets_idx
  on public.catalog_technical_specs(family,viscosity,lubricant_base,lubricant_system,fuel_application,filter_type);
create index if not exists catalog_technical_specs_millard_idx
  on public.catalog_technical_specs(upper(trim(millard_reference)))
  where millard_reference is not null;
create index if not exists catalog_technical_specs_tags_gin_idx
  on public.catalog_technical_specs using gin(additional_tags);

-- Millard/competitor/OEM references are non-authoritative until verified.
-- Future vehicle fitment can link to this same stable technical_spec id.
create table if not exists public.filter_cross_references (
 id uuid primary key default gen_random_uuid(),
 technical_spec_id uuid not null references public.catalog_technical_specs(id) on delete cascade,
 reference_brand text not null check(length(trim(reference_brand))>0),
 reference_code text not null check(length(trim(reference_code))>0),
 reference_kind text not null default 'COMPETITOR' check(reference_kind in ('MILLARD','COMPETITOR','OEM')),
 verification_status text not null default 'PENDING' check(verification_status in ('PENDING','DOCUMENTED','VERIFIED')),
 evidence_source text,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 unique(technical_spec_id,reference_brand,reference_code)
);
create index if not exists filter_cross_reference_lookup_idx on public.filter_cross_references(upper(trim(reference_code)));
create table if not exists public.filter_vehicle_applications (
 id uuid primary key default gen_random_uuid(),
 technical_spec_id uuid not null references public.catalog_technical_specs(id) on delete cascade,
 vehicle_make text not null,
 vehicle_model text not null,
 vehicle_engine text,
 year_from int check (year_from between 1900 and 2200),
 year_to int check (year_to between 1900 and 2200),
 fuel_application text check (fuel_application in ('GASOLINE','DIESEL','BOTH','NA')),
 verification_status text not null default 'PENDING' check(verification_status in ('PENDING','DOCUMENTED','VERIFIED')),
 evidence_source text,
 created_at timestamptz not null default now(),
 constraint vehicle_year_order check(year_from is null or year_to is null or year_from<=year_to)
);
create index if not exists filter_vehicle_applications_search_idx
 on public.filter_vehicle_applications(lower(vehicle_make),lower(vehicle_model),year_from,year_to);

-- Only add a catalog annotation audit; never touch inventory_movements or prices.
create or replace function public.catalog_technical_specs_touch()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  new.updated_at:=now();
  new.updated_by:=auth.uid();
  return new;
end $$;
create trigger technical_specs_touch before update on public.catalog_technical_specs
for each row execute function public.catalog_technical_specs_touch();

alter table public.catalog_technical_specs enable row level security;
alter table public.filter_cross_references enable row level security;
alter table public.filter_vehicle_applications enable row level security;

create policy technical_spec_read on public.catalog_technical_specs
 for select to authenticated using ((select auth.uid()) is not null);
create policy technical_spec_insert on public.catalog_technical_specs
 for insert to authenticated with check ((select auth.uid()) is not null and verification_status='PENDING');
create policy technical_spec_update on public.catalog_technical_specs
 for update to authenticated using ((select auth.uid()) is not null)
 with check ((select auth.uid()) is not null and verification_status='PENDING');

create policy filter_crossref_read on public.filter_cross_references
 for select to authenticated using ((select auth.uid()) is not null);
create policy filter_crossref_insert on public.filter_cross_references
 for insert to authenticated with check ((select auth.uid()) is not null and verification_status='PENDING');
create policy filter_crossref_update on public.filter_cross_references
 for update to authenticated using ((select auth.uid()) is not null)
 with check ((select auth.uid()) is not null and verification_status='PENDING');

create policy filter_fitment_read on public.filter_vehicle_applications
 for select to authenticated using ((select auth.uid()) is not null);
create policy filter_fitment_insert on public.filter_vehicle_applications
 for insert to authenticated with check ((select auth.uid()) is not null and verification_status='PENDING');
create policy filter_fitment_update on public.filter_vehicle_applications
 for update to authenticated using ((select auth.uid()) is not null)
 with check ((select auth.uid()) is not null and verification_status='PENDING');

grant select,insert,update on public.catalog_technical_specs to authenticated;
grant select,insert,update on public.filter_cross_references to authenticated;
grant select,insert,update on public.filter_vehicle_applications to authenticated;

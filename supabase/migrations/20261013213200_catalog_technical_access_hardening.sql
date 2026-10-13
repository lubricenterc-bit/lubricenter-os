-- Follow-up hardening for legacy Supabase projects that auto-grant anon privileges.
revoke all on table public.catalog_technical_specs from public, anon, authenticated;
revoke all on table public.filter_cross_references from public, anon, authenticated;
revoke all on table public.filter_vehicle_applications from public, anon, authenticated;
grant select,insert,update on table public.catalog_technical_specs to authenticated;
grant select,insert,update on table public.filter_cross_references to authenticated;
grant select,insert,update on table public.filter_vehicle_applications to authenticated;
revoke all on function public.catalog_technical_specs_touch() from public, anon, authenticated;

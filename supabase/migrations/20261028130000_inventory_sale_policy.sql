-- Le dice a la interfaz si el inventario estricto está activo y si el usuario puede vender sin inventario,
-- para no ofrecer opciones que la base va a rechazar.
create or replace function public.inventory_sale_policy()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'strict', coalesce((select value #>> '{}' from public.app_settings where key = 'inventory_strict_mode'), 'false') = 'true',
    'can_override', lubricenter_private.staff_can('inventory.override')
  )
$$;
revoke all on function public.inventory_sale_policy() from public, anon;
grant execute on function public.inventory_sale_policy() to authenticated;

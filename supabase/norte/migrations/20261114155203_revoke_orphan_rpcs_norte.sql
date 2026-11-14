-- El Cují (Norte) · equivalente de 20261102152000_revoke_orphan_rpcs de Cabudare.
--
-- Funciones que ninguna pantalla, edge function, script ni prueba de la rama `norte` llama
-- (revisado el 14 nov 2026) seguían siendo ejecutables por cualquier usuario autenticado.
-- Varias son SECURITY DEFINER y escriben (tasas, conteos de inventario, cliente/vehículo de
-- una orden, gastos).
--
-- Diferencias con Cabudare:
--  * get_inventory_snapshot(text) NO se toca: la pantalla de Inventario de `norte` todavía la
--    llama. Se revoca cuando entre el código nuevo de `main` (paso 6 del plan de El Cují).
--  * apply_legacy_service_import ya estaba revocada en Norte.
--  * norte_08 solo restauró permisos de funciones de lubricenter_private; no cruza con esta lista.
--
-- No se borran: solo se quita el permiso de ejecución a anon/authenticated. Las funciones que
-- las llaman internamente (SECURITY DEFINER) y service_role siguen funcionando.
-- Revertir: grant execute on function public.<nombre>(<args>) to authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'add_oil_change_package',
        'add_oil_change_package_with_type',
        'apply_legacy_service_import',
        'close_order_with_cashea',
        'create_weekly_payroll_run',
        'dashboard_today',
        'get_inventory_snapshot_v2',
        'get_oil_change_inventory',
        'record_account_expense_v2',
        'search_order_admin',
        'set_exchange_rates',
        'set_inventory_count',
        'set_order_customer_vehicle'
      ])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

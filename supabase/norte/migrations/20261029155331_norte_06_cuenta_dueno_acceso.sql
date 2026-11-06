-- La cuenta del dueño de Norte opera con todos los permisos (como las cuentas existentes de Cabudare)
insert into lubricenter_private.staff_existing_accounts(user_id)
select id from auth.users where lower(email)='lubricenternorte@gmail.com'
on conflict do nothing;
-- Dueño responsable de la caja de la sede Norte
insert into public.finance_cash_owner_locations(location_id,user_id)
select l.id, u.id from public.locations l cross join auth.users u
where l.code='NORTE' and lower(u.email)='lubricenternorte@gmail.com'
on conflict do nothing;
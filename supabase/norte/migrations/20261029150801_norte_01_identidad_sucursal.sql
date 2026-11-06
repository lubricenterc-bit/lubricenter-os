-- Serie de órdenes de Norte
alter table public.orders alter column order_number set expression as ('NT-'::text || lpad((order_seq)::text, 6, '0'::text));

-- Funciones: ubicación, dueño, serie, empleados y punto de venta
do $$
declare r record; d text; nd text;
begin
  for r in select p.oid from pg_proc p where p.pronamespace in ('public'::regnamespace,'lubricenter_private'::regnamespace) loop
    d := pg_get_functiondef(r.oid);
    nd := d;
    nd := replace(nd, '''CABUDARE''', '''NORTE''');
    nd := replace(nd, 'lubricenterc@gmail.com', 'lubricenternorte@gmail.com');
    nd := replace(nd, '''^OS-[0-9]+$''', '''^NT-[0-9]+$''');
    nd := replace(nd, '''OS-''||lpad', '''NT-''||lpad');
    nd := replace(nd, 'Cabudare', 'Norte');
    nd := replace(nd, 'code=''CHEO''', 'code=''ALFREDO''');
    nd := replace(nd, 'code=''ALEXIS''', 'code=''ALEJANDRO''');
    nd := replace(nd, 'compensation_value(''CHEO''', 'compensation_value(''ALFREDO''');
    nd := replace(nd, 'compensation_value(''ALEXIS''', 'compensation_value(''ALEJANDRO''');
    nd := replace(nd, 'when ''MOBILE_PAYMENT'' then ''MOBILE''', 'when ''MOBILE_PAYMENT'' then ''BDV''');
    if nd <> d then execute nd; end if;
  end loop;
end $$;

-- Ubicación
insert into public.locations(code,name,active) values ('NORTE','Lubricenter Norte',true) on conflict (code) do update set name=excluded.name, active=true;

-- Cuentas (el código BDV es el banco principal: en Norte es Provincial)
insert into public.financial_accounts(code,name,currency,account_type,active) values
 ('CASH_VES','Caja Bs','VES','CASH',true),
 ('CASH_USD','Caja USD','USD','CASH',true),
 ('BDV','Banco Provincial','VES','BANK',true),
 ('BNC','BNC · Cashea','VES','BANK',true),
 ('ZELLE','Zelle','USD','BANK',true),
 ('BINANCE','Binance · USD','USD','CLEARING',true)
on conflict (code) do update set name=excluded.name, currency=excluded.currency, account_type=excluded.account_type, active=true;

-- Configuración del negocio
insert into public.app_settings(key,value) values
 ('oil_change_default_km','5000'::jsonb),
 ('oil_change_default_months','3'::jsonb),
 ('crm_operational_start_date','"2026-10-29"'::jsonb),
 ('cashea_commission_percent','4'::jsonb),
 ('cashea_minimum_ref','25'::jsonb),
 ('crm_post_service_template', to_jsonb(E'Hola *{{nombre}}* 👋\n\nGracias por confiar en *Lubricenter Norte*. Te compartimos un resumen de tu visita:\n\n{{vehiculo_bloque}}\n\n{{resumen_bloque}}\n\n{{adicionales_bloque}}\n\n{{bonificaciones_bloque}}\n\n{{observaciones_bloque}}\n\n{{estado_bloque}}\n\n{{proximo_servicio_bloque}}\n\n💬 Si tienes alguna duda sobre el servicio, escríbenos por aquí.\n\n*Lubricenter Norte*'::text)),
 ('price_rounding_step','0.01'::jsonb),
 ('price_rounding_mode','"nearest"'::jsonb),
 ('exchange_rate_authority','"NOTION"'::jsonb),
 ('catalog_authority','"LUBRICENTER_OS"'::jsonb),
 ('inventory_strict_mode','false'::jsonb),
 ('cashea_financing_days','45'::jsonb),
 ('cashea_opportunity_monthly_percent','5'::jsonb),
 ('discount_free_limit_percent','10'::jsonb),
 ('store_markup_percent','35'::jsonb),
 ('oil_labor_free_threshold_percent','85'::jsonb)
on conflict (key) do update set value=excluded.value, updated_at=now();

-- Empleados de Norte
insert into public.employees(code,name,active) values
 ('ALFREDO','Alfredo',true),('ALEJANDRO','Alejandro',true),('WILFREDO','Wilfredo',true)
on conflict (code) do update set name=excluded.name, active=true;
insert into public.compensation_rules(employee_id,rule_type,value,valid_from,note)
select id,'WORKSHOP_PERCENT',40,'2026-10-29','Mecánico de taller (por confirmar)' from public.employees where code='ALFREDO'
and not exists(select 1 from public.compensation_rules c join public.employees e on e.id=c.employee_id where e.code='ALFREDO' and c.rule_type='WORKSHOP_PERCENT');
insert into public.compensation_rules(employee_id,rule_type,value,valid_from,note)
select id,'ASSISTANT_BONUS_PERCENT',0,'2026-10-29','Ayudante: bonos de rendimiento manuales' from public.employees where code='ALEJANDRO'
and not exists(select 1 from public.compensation_rules c join public.employees e on e.id=c.employee_id where e.code='ALEJANDRO' and c.rule_type='ASSISTANT_BONUS_PERCENT');

-- Fuentes externas (Cashea y banco principal)
insert into public.external_sources(provider,name,account_id,external_account,currency,active)
select 'BDV','Banco Provincial · movimientos',(select id from public.financial_accounts where code='BDV'),'BDV','VES',true
where not exists(select 1 from public.external_sources where provider='BDV');
insert into public.external_sources(provider,name,external_account,currency,active)
select v.p,v.n,v.p,'USD',true from (values ('CASHEA_ORDERS','Cashea · órdenes'),('CASHEA_TRANSACTIONS','Cashea · cobros (export.xlsx)')) v(p,n)
where not exists(select 1 from public.external_sources s where s.provider=v.p);

-- Contador de órdenes
insert into lubricenter_private.order_number_counter(singleton,last_number) values (true,0) on conflict do nothing;
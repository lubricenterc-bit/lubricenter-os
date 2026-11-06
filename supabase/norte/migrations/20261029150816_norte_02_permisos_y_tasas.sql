insert into public.staff_permission_catalog(key,area,label,explanation,recommended,sort_order) values
('orders.view','Ventas y órdenes','Consultar órdenes','Ver órdenes abiertas y cerradas',true,10),
('orders.create','Ventas y órdenes','Crear órdenes','Recibir vehículos y registrar servicios',true,11),
('orders.edit','Ventas y órdenes','Editar órdenes','Modificar datos y avance de una orden',true,12),
('orders.cancel','Ventas y órdenes','Anular órdenes','Cancelar órdenes, con trazabilidad y motivo',false,13),
('payments.view','Ventas y órdenes','Consultar cobros','Ver métodos de pago y movimientos',true,14),
('payments.manage','Ventas y órdenes','Registrar cobros','Agregar o corregir movimientos de pago',false,15),
('customers.view','Clientes y CRM','Consultar clientes','Ver vehículos e historial del cliente',true,20),
('customers.manage','Clientes y CRM','Editar clientes','Registrar y modificar clientes y vehículos',true,21),
('crm.manage','Clientes y CRM','Gestionar CRM','Casos manuales y seguimientos',true,22),
('inventory.view','Inventario y compras','Consultar inventario','Consultar productos y existencias',true,30),
('inventory.count','Inventario y compras','Ajustar inventario','Registrar movimientos y conteos físicos',true,31),
('catalog.manage','Inventario y compras','Modificar catálogo','Crear y cambiar productos y precios',false,32),
('purchases.manage','Inventario y compras','Registrar compras','Recepciones y compras de proveedores',false,33),
('inventory.override','Inventario y compras','Vender sin inventario','Registrar una línea escrita a mano que no descuenta stock, con auditoría',false,34),
('finance.view','Caja y finanzas','Consultar finanzas','Acceder a resultados y cuentas permitidos',true,40),
('cash.manage','Caja y finanzas','Movimientos de caja','Registrar movimientos bancarios y de efectivo',false,41),
('cash.close','Caja y finanzas','Cierre diario','Registrar y presentar arqueos de caja',true,42),
('finance.reconcile','Caja y finanzas','Conciliación bancaria','Revisar y conciliar extractos',false,43),
('cashea.manage','Caja y finanzas','Gestionar Cashea','Gestionar pagos y cuotas de Cashea',true,44),
('receivables.manage','Caja y finanzas','Cuentas por cobrar','Gestionar anticipos, abonos y créditos',false,45),
('payroll.view','Personal y control','Consultar nómina','Ver liquidaciones y compensación',false,50),
('payroll.manage','Personal y control','Modificar nómina','Ajustes, descuentos, bonos y pagos',false,51),
('settings.manage','Personal y control','Modificar configuración','Cambiar tasas y parámetros del negocio',false,52),
('tasks.view','Personal y control','Ver sus tareas','Consultar tareas asignadas y vencimientos',true,53),
('tasks.complete','Personal y control','Completar sus tareas','Marcar tareas asignadas como resueltas',true,54)
on conflict (key) do nothing;

insert into public.exchange_rates(rate_type,value,effective_at,source) values
 ('BCV',888.8909,'2026-10-29T11:45:02Z','Notion · Tasas (arranque Norte)'),
 ('OPERATIVE',1061.32,'2026-10-29T11:45:02Z','Notion · Tasas (arranque Norte)');

insert into lubricenter_private.bcv_official_observer_state(id) values (true) on conflict do nothing;
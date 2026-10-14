# CRM manual — servicios pagados pero pendientes, con o sin orden

## Contrato del módulo

Un **registro de CRM manual** no es una venta, una factura, un abono, una deuda contable ni prueba automática de que el servicio se realizó. Sirve para organizar y rastrear compromisos de mantenimiento.

El registro tiene:
- Propietario del vehículo (beneficiario y destinatario CRM).
- Pagador opcional (puede ser otra persona).
- Orden de venta anterior opcional si existe y está CERRADA.
- Referencia de pago: **no verificado**, **reportado fuera del sistema**, **orden anterior vinculada** o **sin cobro**.
- Agenda y próximo contacto, historial de auditoría y estado PENDIENTE / AGENDADO / REALIZADO / ANULADO.
- Kilometraje, aceite, viscosidad, filtro y fecha/km próximos solamente al confirmar REALIZADO.

### Caso habitual: dos cambios de aceite en Cashea y el segundo será después

1. Cobrar la venta aprobada mediante el flujo financiero normal, **una sola vez**.
2. Dar de alta la ficha manual del segundo vehículo. Seleccionar su propietario real. Indicar como pagador al cliente de la venta original.
3. Registrar `ORDER_LINKED` y buscar su número OS, si está disponible, o `REPORTED_EXTERNALLY` con una nota si el pago fue realizado fuera del sistema.
4. El segundo vehículo se mantiene PENDIENTE / AGENDADO; **no se crea `service_records`**.
5. Cuando el carro venga, abrir esa ficha y completar el servicio real: kilometraje, aceite, filtro, próximos km/fecha.
6. Se crea **un solo** historial de aceite con importe cero, para evitar una segunda facturación. Aparecerá en los recordatorios del vehículo y su propietario.
7. Si se quiere avisar por WhatsApp, comprobar consentimiento OPT_IN, copiar el mensaje y marcar enviado únicamente tras realizarlo.

## Controles de integridad

- El RPC valida que el vehículo tiene propietario; una orden anterior debe ser CLOSED y su pagador coincide con el registrado en la ficha.
- El formulario nunca escribe `orders`, `payments`, `cashea_sales`, `receivables`, `account_movements` ni `inventory_movements`.
- Un pendiente no altera el kilometraje ni los recordatorios de mantenimiento.
- Completar el pendiente está protegido por transacción e idempotencia: si ya se creó el registro, devolverá su ID, sin duplicar.
- Se bloquea registrar un segundo cambio de aceite del **mismo vehículo y fecha** dentro de una misma orden anterior. Visitas legítimas en fechas posteriores siguen siendo posibles.
- La ficha registra todas las revisiones con versión para evitar sobrescrituras simultáneas.
- Solo el administrador autorizado puede crear, editar, completar o anular; otros usuarios autenticados pueden consultar.
- Se prohíbe escribir directamente en las tablas. La exposición a authenticated es lectura controlada por RLS.
- No se envía ningún WhatsApp automáticamente. Se requiere autorización OPT_IN y texto de envío registrado.

## Validación y publicación

Workflow CI: `Manual CRM prepaid and deferred services`. Requiere TypeScript, pruebas PGlite, navegación, pruebas del CRM existente, flujos multivehículo, y build de Next.

La migración `20261014190000_manual_crm_deferred_service_cases.sql` **solo crea** dos tablas y cuatro funciones. No cambia objetos existentes ni reescribe registros anteriores. Para contención, deshabilitar el enlace `/crm/manual` si la página produce error. Conservar filas existentes y auditoría; nunca borrar fichas de compromisos prepagados para revertir la UI.

Comprobación de producción previa/posterior: contar Cashea, pagos, account_movements, inventory_movements, service_records y CRM followups. Tras instalar la migración deben ser exactamente iguales. Crear un caso de prueba real **sin vinculación financiera**; verificar que no altere historial. Anularlo registrando el motivo. No crear pagos ni servicios de prueba en el ambiente real.

### Límites

El módulo no concilia ni confirma si un pago reportado realmente entró al banco; eso se hace en Finanzas. Tampoco registra automáticamente la obligación contable de servicios prepagados o reserva stock. Para flujos con facturación formal, revisar el tratamiento de anticipos con un contador. El CRM es una herramienta operativa.

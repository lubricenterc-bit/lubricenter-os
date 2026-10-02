# Pagos por concepto: integración de almacenamiento, cotización y cobro

Estado: desarrollo en `codex/mixed-payment-storage`, dependiente del motor del PR #20. **No habilitado para producción.** Todas las órdenes existentes conservan versión 2; estas migraciones no convierten órdenes ni recalculan nómina histórica.

## Reglas confirmadas

- Saldos de referencia permanecen en USD; cada abono en Bs usa el BCV de su fecha. Pagos anteriores conservan sus tasas.
- Cheo recibe 40 % del dinero efectivamente aplicado a su mano de obra en cada moneda. Cobertura preferencial, tienda, financiación y sobrantes no son su base.
- El aceite externo del ejemplo es compra/reventa propia de Lubricenter. USD 7 son venta propia; costo/proveedor se registran por separado y no se infieren de los REF 8 mencionados.

## Implementado

Tres migraciones aditivas generadas con CLI: acuerdos comerciales inmutables/versionados, cotizaciones de cinco minutos, aplicaciones por concepto y reservas de contratos Cashea/LC. FK impiden cruzar órdenes; límites impiden aplicar más dinero o deuda de lo disponible. Reservas tampoco exceden capacidad del contrato externo.

`prepare_collection_v3` carga precios, saldos, trabajadores y BCV desde la base de datos. Acepta medios de pago con asignaciones por concepto y condición 1:1, tasa preferencial o acuerdo exacto limitado por ID. Rechaza metadatos económicos aportados por el navegador, exceso digital, referencias bancarias incompletas, conceptos ajenos y revisiones desactualizadas. Selecciona BCV a la fecha del pago; fechas atrasadas necesitan administración. Escribe una cotización, no dinero.

`commit_collection_v3` confirma una cotización protegida y vigente. Guarda pagos/aplicaciones en una única transacción, reutiliza el movimiento de caja existente y permite reintentar con el mismo identificador. `value_ves` representa dinero real valorado a BCV, nunca cobertura comercial preferencial. USD nativos sin BCV conservan su importe y valoración pendiente, sin inventar tasas. Un fallo revierte el lote completo. El navegador no dispone de escritura directa sobre pagos.

El resumen comparte principal/cobertura/financiación por concepto y cobros nativos. Administración ve comisiones; operadores reciben la vista sin datos de nómina. Lecturas no crean auditoría. Aplicaciones son inmutables: compensaciones conservan proporcionalidad, tasas y capacidad originales.

La pantalla `ComponentSettlement`, conectada a `OrderWorkspace` únicamente para versión 3, permite seleccionar destinos, abonos, preferencias y revisar el cálculo autoritativo antes de confirmar. Evita repetir una confirmación tras una respuesta incierta. Las órdenes versión 2 conservan su interfaz anterior.

Cambios de productos/acuerdos invalidan cotizaciones. Los importes/trabajadores de conceptos ya acordados requieren cambio de acuerdo. El cliente autenticado no puede cambiar directamente la versión de cálculo. El cierre antiguo está bloqueado para v3: sumar `value_ves` ya no prueba que se cubrió cada concepto.

## Integración pendiente: NO activar todavía

1. Creación y edición de acuerdos por línea en todos los formularios; venta rápida y aceite. La activación debe exigir todos los conceptos vinculados y evitar adopción automática de pagos anteriores.
2. Vuelto/anticipo/saldo del cliente: actualmente la vista previa distingue sobrante, pero este commit lo rechaza hasta completar su puente y devolución. No duplicar caja.
3. Cashea parcial y Crédito LC, con sus iniciales/cuotas y aplicaciones posteriores. Las reservas existen, los flujos completos todavía no.
4. Cierre v3 con inventario/CRM, comisión elegible según aplicaciones, nómina y reversión posterior al pago; reglas de otros empleados y bonos. Sueldos fijos sin cambios.
5. Recibo 58 mm y reportes/Finance Inbox con valoración pendiente; períodos históricos y correcciones individuales con evidencia.
6. Pruebas PostgreSQL con conexiones realmente concurrentes, recorrido de PC/móvil y despliegue completo aprobado. PGlite verifica transacciones, permisos y estados, **no demuestra concurrencia entre conexiones de producción**.

No hay permiso nuevo para integrar a main/desplegar esta entrega. No se aplicaron estas migraciones en Supabase productivo ni se registraron operaciones reales.

## Verificación

Fixtures sintéticos prueban USD 355 propios con comisión USD 120; USD 200 que cancelan REF 240 con comisión USD 80; BCV entre días; residual firmado; contrato Cashea limitado; exacto por ID con uso acumulado; permisos; reintentos; rollback del lote; revisiones; valoración pendiente sin tasas falsas y protección de activación. Tests, lint y build deben mantenerse verdes al completar las etapas pendientes.

Se revisó el [changelog de Supabase](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes) y documentación de RLS antes de preparar las migraciones. Esta entrega no introduce `ltree`, índices GiST sobre floats, cifrado PGP ni operadores personalizados.

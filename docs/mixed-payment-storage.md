# Pagos por concepto: integración de almacenamiento, cotización y cobro

Estado: desarrollo en `codex/mixed-payment-storage`, dependiente del motor del PR #20. **No habilitado para producción.** Todas las órdenes existentes conservan versión 2; estas migraciones no convierten órdenes ni recalculan nómina histórica.

## Reglas confirmadas

- Saldos de referencia permanecen en USD; cada abono en Bs usa el BCV de su fecha. Pagos anteriores conservan sus tasas.
- Cheo recibe 40 % del dinero efectivamente aplicado a su mano de obra en cada moneda. Cobertura preferencial, tienda, financiación y sobrantes no son su base.
- El aceite externo del ejemplo es compra/reventa propia de Lubricenter. USD 7 son venta propia; costo/proveedor se registran por separado y no se infieren de los REF 8 mencionados.

## Implementado

Seis migraciones aditivas generadas con CLI: acuerdos comerciales inmutables/versionados, cotizaciones de cinco minutos, aplicaciones por concepto, reservas de contratos Cashea/LC, creación de precios, cierre por conceptos y vuelto. FK impiden cruzar órdenes; límites impiden aplicar más dinero o deuda de lo disponible. Reservas tampoco exceden capacidad del contrato externo.

`prepare_collection_v3` carga precios, saldos, trabajadores y BCV desde la base de datos. Acepta medios de pago con asignaciones por concepto y condición 1:1, tasa preferencial o acuerdo exacto limitado por ID. Rechaza metadatos económicos aportados por el navegador, exceso digital, referencias bancarias incompletas, conceptos ajenos y revisiones desactualizadas. Selecciona BCV a la fecha del pago; fechas atrasadas necesitan administración. Escribe una cotización, no dinero.

`commit_collection_v3` confirma una cotización protegida y vigente. Guarda pagos/aplicaciones en una única transacción, reutiliza el movimiento de caja existente y permite reintentar con el mismo identificador. `value_ves` representa dinero real valorado a BCV, nunca cobertura comercial preferencial. USD nativos sin BCV conservan su importe y valoración pendiente, sin inventar tasas. Un fallo revierte el lote completo. El navegador no dispone de escritura directa sobre pagos.

El resumen comparte principal/cobertura/financiación por concepto y cobros nativos. Administración ve comisiones; operadores reciben la vista sin datos de nómina. Lecturas no crean auditoría. Aplicaciones son inmutables: compensaciones conservan proporcionalidad, tasas y capacidad originales.

La pantalla `ComponentSettlement`, conectada a `OrderWorkspace` únicamente para versión 3, permite seleccionar destinos, abonos, preferencias y revisar el cálculo autoritativo antes de confirmar. Evita repetir una confirmación tras una respuesta incierta. Las órdenes versión 2 conservan su interfaz anterior.

Cambios de productos/acuerdos invalidan cotizaciones. Los importes/trabajadores de conceptos ya acordados requieren cambio de acuerdo. El cliente autenticado no puede cambiar directamente la versión de cálculo. El cierre antiguo deriva al cierre por conceptos para v3: sumar `value_ves` ya no prueba que se cubrió cada concepto.

`create_order_finance` conserva versión 2 mientras el interruptor de entrega siga apagado. La preparación de una orden anterior rechaza pagos o contratos existentes. Servicios/productos nuevos usan precio USD pactado, referencia BCV o Bs pactados; los precios anteriores se versionan y no se sustituyen si tienen dinero o financiación aplicada. Cinco litros a USD 9 producen USD 45, sin multiplicarlos por la tasa operativa.

`close_order_v3` exige igualdad exacta de cobertura y financiación por concepto y la revisión vigente. Conserva inventario, validación de atención y eventos CRM existentes, sin repetir caja ni crear nómina nominal antigua. Guarda un resumen inmutable; un reintento del operador vuelve a ocultar la información de nómina aunque el cierre lo haya hecho el dueño. Los totales de orden son proyecciones comerciales brutas; los beneficios negociados y cobros reales siguen separados. Falta de valoración Bs conserva NULL/PENDING, nunca una tasa ficticia.

Nómina v3 incorpora el 40% real de cada aplicación de mano de obra de Cheo, en la moneda recibida. Sincronizar de nuevo no duplica trabajo. Una reversión reduce trabajo aún no liquidado; si hubo ajuste manual, lo deja en revisión. Después de liquidar conserva el recibo y genera una corrección con origen estable. Las decisiones de pago/monto conservan historial. Este puente todavía no cubre los derechos protegidos de otros empleados ni bonos; **no activar hasta completar esos casos**. Sueldo fijo y su pago a BCV del día permanecen en su flujo existente.

`prepare_change_v3` congela la entrega elegida después de cotizar: devolver USD/Bs con tasa acordada, devolver una parte o conservar vuelto identificado. `commit_collection_v3` exige ese plan para un sobrante y lo guarda junto con cobro/aplicaciones en la misma transacción. Reutiliza `order_tenders`, `order_change_returns` y sus movimientos. USD50 para una ventaUSD40 registra entrada50, devolución10, venta40 y comisión16. El sobrante no se convierte en ingreso ni comisión.

La tasa acordada convierte la obligación de vuelto; el movimiento de USD se valora contablemente al BCV, separado de esa preferencia. Los USD recibidos/devueltos sin BCV conservan valoración pendiente y monto nativo correcto. Una entrega posterior conserva el mismo identificador ante reintentos. La UI solo muestra configuración de vuelto para efectivo y enseña lo entregado y pendiente antes de confirmar. El redondeo de Bs a USD queda en `rounding_ves`. Un sobrante de Bs inferior a un centavo USD se devuelve exactamente en Bs con su propio movimiento, sin perder dinero ni inventar obligación en USD.

## Integración pendiente: NO activar todavía

1. Llevar creación y edición de acuerdos a venta rápida y cambio de aceite completo. La orden estándar ya tiene el puente; todos los formularios deben exigir conceptos vinculados y evitar adopción automática de pagos anteriores.
2. Anticipo/saldo del cliente y conversión explícita de vuelto pendiente a saldo a favor. Vuelto estándar ya tiene puente, entrega inmediata/posterior y reintentos sin duplicar caja. Completar fechas retroactivas de devoluciones inmediatas.
3. Cashea parcial y Crédito LC, con sus iniciales/cuotas y aplicaciones posteriores. Las reservas existen, los flujos completos todavía no.
4. Completar reglas de otros empleados y bonos, redondeo agregado de correcciones múltiples de nómina, devoluciones reales y rectificación de órdenes cerradas. El cierre v3 y el puente de Cheo ya están implementados. Sueldos fijos sin cambios.
5. Recibo 58 mm y reportes/Finance Inbox con valoración pendiente; períodos históricos y correcciones individuales con evidencia.
6. Pruebas PostgreSQL con conexiones realmente concurrentes, recorrido de PC/móvil y despliegue completo aprobado. PGlite verifica transacciones, permisos y estados, **no demuestra concurrencia entre conexiones de producción**.

No hay permiso nuevo para integrar a main/desplegar esta entrega. No se aplicaron estas migraciones en Supabase productivo ni se registraron operaciones reales.

## Verificación

Fixtures sintéticos prueban USD 355 propios con comisión USD 120; USD 200 que cancelan REF 240 con comisión USD 80; BCV entre días; residual firmado; contrato Cashea limitado; exacto por ID con uso acumulado; permisos; reintentos; rollback del lote; revisiones; valoración pendiente sin tasas falsas y protección de activación. Tests, lint y build deben mantenerse verdes al completar las etapas pendientes.

Se revisó el [changelog de Supabase](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes) y documentación de RLS antes de preparar las migraciones. Esta entrega no introduce `ltree`, índices GiST sobre floats, cifrado PGP ni operadores personalizados.

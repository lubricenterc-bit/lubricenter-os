# Finance Core v2.2 — auditoría previa

Fecha: 2026-09-23. Base: `main@289a9d58c9691d492df2ef575de01759dd40ac67`.
Fuentes: código y migraciones; catálogo de funciones, tablas, índices y políticas de Supabase (solo lectura); conversación «Soluciones conciliación bancaria»; `export.xlsx`, `ordenes (5).xlsx` y texto BDV entregados en esa conversación. Los documentos privados no se incluyen en Git.

## Hallazgos que condicionan la implementación

| Prioridad | Hallazgo verificable | Decisión |
|---|---|---|
| Crítica | Una fila externa no es una venta ni un ingreso nuevo. `payments` ya genera `account_movements` mediante trigger. | Importar exclusivamente evidencia. La conciliación enlaza registros existentes; no inserta pagos ni ingresos. |
| Crítica | Los XLSX no contienen caja/POS. `export.xlsx` contiene 303 filas, todas de una misma cuenta compartida; ausencia de orden interna no demuestra otro local. | `UNRESOLVED` por defecto. Propiedad solo con orden interna inequívoca o decisión administrativa auditada. Nunca inferir Caja 2 del sufijo del nombre de cuenta. |
| Alta | Export tiene 7 filas multicuota. El monto asignado supera levemente el USD informado en 4 filas. Los montos tienen más de dos decimales. | Conservar ambos valores, ocho decimales, sin repartir arbitrariamente una fila entre cuotas ni convertir diferencias comerciales en redondeos. |
| Alta | Órdenes: 81 filas, 75 IN PROGRESS, 5 CANCELLED, 1 CLOSED; 11 cuotas parcialmente pagadas. | Snapshot externo versionado, separado del saldo operativo. Canceladas y cuotas futuras no se convierten en cobros pendientes. |
| Crítica | La muestra BDV repite una fila en el salto de página y reutiliza referencias de tarjeta en distintos movimientos. | Identidad compuesta (cuenta, fecha, dirección, importe, referencia y saldo), deduplicación de páginas y comprobación de cadena de saldos. La referencia sola nunca es clave única. |
| Crítica | Fechas mínima/máxima, una suma que cuadra o una declaración del usuario no prueban por sí solas que se descargó el período completo. | Cobertura explícita con controles independientes. Lotes incompletos conservan evidencia y una sola excepción de cobertura; no generan cientos de falsos faltantes. |
| Crítica | `require_auth()` no distingue empleados de administradores; existen RPC SECURITY DEFINER públicas históricas. | Roles persistidos fuera del JWT editable. RPC nuevas: invoker público, definer privado, permisos explícitos. No afirmar que esto endurece todas las funciones antiguas. |
| Alta | Referencias de banco y Cashea hoy opcionales; múltiples rutas de cobro. | Validación en base de datos para nuevas operaciones y ayuda visible en formularios. No invalidar histórico ni corregirlo inventando referencias. |
| Alta | `record_cashea_installment_payment` usa margen de 0,05 REF y fuerza PAID; puede ocultar remanentes. | Evidencia y asignaciones nuevas con capacidad exacta. No reutilizar este RPC para importaciones ni forzar cuotas pagadas. Auditoría de diferencia separada. |
| Alta | Cierre actual exige bancos y deriva apertura de todo el historial, aunque nunca se hizo conteo inicial. | Cierre físico USD/Bs, activación con saldo real y fecha de corte. Bancos por conciliación independiente. Conservar cierres anteriores. |
| Alta | `mark_cash_close_review` no propaga cambios antiguos a cierres posteriores. | Invalidar conteos afectados y pedir revisión; no alterar contabilidad silenciosamente. |
| Alta | Egresos son EXPENSE + categoría libre; retiro, activo o compra podrían distorsionar resultados. | Naturaleza antes de categoría. Proveedor/inventario/transferencia usan sus flujos existentes. Desconocido queda en revisión, sin impedir operaciones. |
| Alta | Historial local de migraciones no corresponde uno a uno con versiones registradas en producción. | Una migración aditiva nueva y prueba contra copia estructural sin datos. No ejecutar `db push` del historial entero. |
| Alta | El stress test del chat fue una simulación narrada, no una suite ejecutada. | Crear escenarios reproducibles y separar las cifras ilustrativas de los resultados realmente comprobados. |

## Contrato de seguridad contable

- Importaciones y snapshots no modifican ingresos, caja, cartera ni inventario.
- Dinero nativo y USD atribuido son dimensiones distintas: no se suman. Una asignación usa la moneda de su obligación y conserva su evidencia de conversión.
- Asignaciones reversibles por compensación auditada, con bloqueo de filas, capacidad en ambos extremos y clave de idempotencia.
- Orden, pago, movimiento, obligación, archivo y caso conservan sus IDs; no se reconstruyen tablas operativas.
- Match automático exige referencia, cuenta, moneda, dirección, ventana temporal y unicidad en ambos extremos. Tolerancia = menor de límite absoluto y relativo. Diferencias no desaparecen.
- Reglas explícitas, versionadas y aprobadas; ninguna IA decide ni escribe automáticamente en este alcance.
- Estado desconocido significa pendiente administrativo, nunca una prohibición de vender.

## Despliegue y límites

La rama no se fusiona ni se aplica en producción sin revisión. Primera activación: revisar roles, asignar cuenta externa, importar períodos de prueba y establecer apertura física. El libro mayor de doble partida y cierre fiscal mensual no se presumen existentes: cualquier preparación o prueba de invariantes de esa capa debe identificarse como tal, sin presentar resultados fiscales como definitivos.

Integración del 24-09-2026: la migración de USD pactado y nómina ya está en producción. Las pruebas de Finance Core aplican primero esa migración y después las tres de Finance Core. La conciliación conserva abiertos los casos que siguen vigentes sin añadir eventos de auditoría por cada recarga; solo resuelve los que dejaron de aplicar. La copia estructural de prueba está comprimida y no incluye datos de clientes ni los reportes privados.

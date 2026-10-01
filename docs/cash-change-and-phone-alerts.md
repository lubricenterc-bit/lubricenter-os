# Cobro, vuelto y avisos financieros

Estado: incremento en desarrollo sobre el PR #15. No aplicado en producción.

## Precio y equidad

El precio explícitamente pactado en USD conserva su valor. $40 pagados con un billete de $50 producen $10 de vuelto. La equivalencia interna congelada en Bs sirve para cubrir la orden existente, no para cambiar el precio comercial.

Si toda la orden está pactada en USD, el pago en Bs se calcula con la tasa acordada del cobro. Una orden de $40, valuada internamente a 850, queda cubierta al recibir Bs 32.000 si el cliente y el comercio acordaron 800. La caja recibe realmente Bs 32.000; no Bs 34.000. El valor de cobertura de `payments.value_ves` y el efectivo de `account_movements` son hechos diferentes en ese caso. Las pantallas/recibos muestran el total USD.

Una cotización REF conserva su precio y tasa actuales; no se cambia todo el catálogo a USD retrospectivamente. Las órdenes mixtas REF/USD conservan el comportamiento existente y requieren una revisión específica de la asignación por línea si se desea negociar una nueva tasa global. No certificar ese caso como resuelto.

En venta rápida puede indicarse un total pactado USD. Se reparte proporcionalmente entre productos, con último residual exacto. Los servicios conservan su opción USD existente.

Recibido, aplicado a la venta, vuelto y devolución son hechos separados. El pago solo cubre el precio o el abono. El sobrante recibido entra a la cuenta real y no aumenta la venta ni su comisión. Entregar vuelto crea salida `ADJUSTMENT` de naturaleza `REFUND`; no un gasto operativo. El pendiente es una obligación en USD, no un cobro futuro, y no equivale a saldo a favor reutilizable del cliente.

Se puede entregar parte en USD y otra en Bs mediante entregas sucesivas. Cada entrega en Bs conserva su propia tasa acordada; no altera la deuda USD restante. La moneda y las cantidades de caja son nativas. Todos los importes se redondean a centavos mediante decimal; en conversiones Bs/USD puede existir un residual inferior a medio centavo USD. El residual firmado en Bs se conserva en `rounding_ves` y se muestra antes de confirmar; no se incluye en ingreso de ventas. Sigue pendiente clasificar estos ajustes en el futuro libro mayor fiscal.

Los billetes USD y Bs tienen atajos de suma; el recibido en efectivo empieza vacío, no simula que se recibió el importe exacto. Los atajos no demuestran disponibilidad física de billetes para devolver: el operador confirma lo que entregó. Una deuda de vuelto requiere cliente asociado o una identificación breve del cliente de mostrador.

## Integridad

- Cobro y vuelto inmediato en una sola transacción; venta rápida también se cierra dentro de esa transacción.
- UUID de solicitud y payload comparado: reintento no duplica dinero, reutilización con distinto contenido falla.
- Bloqueo de orden y de caja; entregas bloquean el mismo tender. No se puede devolver más que el pendiente.
- UUID estable para cobro y entregas; historial de auditoría. Totales SQL completos, paginación de 20 y pendientes primero.
- Los editores anteriores no pueden borrar el pago, alterar sus movimientos ni anular una venta con tender. Falta un flujo dedicado de reversión/devolución completa por corrección; el bloqueo evita perder historia, pero limita esa operación hasta implementarlo.
- Pagos a Crédito LC y cuotas Cashea mantienen sus formularios anteriores. Todavía falta incorporar recibido/vuelto allí; no afirmar que todos los cobros ya están cubiertos.

## Automatización real

`POST /api/jobs/finance` recompone las coincidencias/excepciones sobre evidencia ya importada. No descarga reportes del banco o Cashea y no puede certificar un mes sin reportes completos. Subir el archivo sigue siendo necesario; descarga automática exige API o integración autorizada adicional.

El programador propuesto es Supabase Cron, infraestructura ya usada para el catálogo. Cada 15 minutos invoca el endpoint protegido. No usa ChatGPT ni agentes para ejecutar el trabajo diario. Desde las 18:00 Caracas envía como máximo un resumen por teléfono/día si existen tareas. Incluye apertura/caja, excepciones/reportes del mes anterior para administración y vueltos pendientes; no incluye nombres ni montos en la pantalla bloqueada. Operadores no reciben información bancaria administrativa.

Entrega persistida: `SENDING`, `SENT`, `FAILED`, reintento tras fallo o bloqueo vencido. `SENT` significa aceptado por el proveedor push, no leído ni recibido físicamente. Un fallo entre envío y persistencia puede causar reintento; la notificación tiene un tag diario para reemplazarse. Suscripciones expiradas 404/410 se desactivan. Historial de ejecución, no indicador verde ficticio: sin trabajo reciente se muestra la falta de verificación. La suscripción requiere sesión verificada y permiso mediante botón; el servidor solo usa proveedores push conocidos.

## Activación pendiente

1. Revisar/aprobar integración de la rama y dependencias; aplicar migraciones en orden y desplegar juntos.
2. Generar claves con `node scripts/generate-push-config.mjs`. Escribe `.env.push.local`, ignorado por Git; no imprime secretos. Configurar en Railway `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`, `FINANCE_JOB_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` y las dos variables públicas Supabase existentes. La clave de servicio jamás lleva prefijo `NEXT_PUBLIC_`.
3. Guardar en Vault `finance_job_url` (URL de producción + `/api/jobs/finance`) y `finance_job_secret` (el mismo secreto de Railway). Activar con `scripts/activate-finance-job.sql` una vez listo el endpoint. Verificar respuesta de `net.http_post`, `finance_job_runs` y una ejecución reciente.
4. En el teléfono: Ajustes o Pendientes → Avisos → Activar → Enviar prueba. Verificar físicamente la recepción. En iPhone usar la app agregada a inicio; [requisito de WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
5. Confirmar conteo de apertura real y ambos cierres. No usar Bs 50 mencionados anteriormente como conteo actual.

Las claves push y el secreto de invocación fueron generados localmente en el archivo ignorado `.env.push.local`. No se enviaron avisos reales ni se activó Cron en esta sesión. Quedan pendientes despliegue, secretos y prueba con el teléfono. Esto no garantiza integridad del Finance Core completo ni sustituye el cierre mensual.

## Simulación automatizada

Casos: $40/$50 con vuelto USD o Bs; $10 pendientes y entregas parciales; Bs recibidos y USD devueltos; USD pactado pagado en Bs con tasa acordada; abonos mixtos; sobrante sin cliente; exceso de devolución; reintentos y payload distinto; edición/anulación antigua; permisos de operador/administración/servicio; propiedad de dispositivos y entrega diaria sin duplicación concurrente de la solicitud. Pruebas SQL sobre estructura real en PGlite y datos sintéticos, no sobre ventas de clientes.

Verificación local del 01-10-2026: 101 pruebas aprobadas en 7 archivos, incluida simulación de 30 ventas mensuales por seis métodos y comprobación de totales/paginación de 31 cobros. Lint/TypeScript y build Next aprobados. Build con variables públicas ficticias: confirma compilación, no autenticación de producción. Railway verificado sin cambios: despliegue SUCCESS del 28-09 desde `main`; sin variables push ni programador financiero. En Supabase solo se consultaron cron, definiciones y configuración; no se aplicó la migración.

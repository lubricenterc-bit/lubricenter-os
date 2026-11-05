# Recibo de 58 mm

El recibo que se entrega al cliente se imprime desde una página propia, sin el menú del OS.

## Cómo se imprime

- **Ruta:** `/print/receipt/[id]`. Con `?auto=1` abre el diálogo de impresión cuando cargan las fuentes.
- **Desde dónde se abre:**
  - el botón «Imprimir 58 mm» de `/orders/[id]/receipt`;
  - «Imprimir recibo» en la pantalla de éxito de Venta rápida;
  - «Recibo» en la vista previa de órdenes.
- **Fuera del menú:** la página está fuera del `AppShell` (`components/app-shell.tsx`, prefijo `/print/`). `AuthGuard` la sigue protegiendo.
- **Estilos:** `app/print/receipt/receipt-print.css`, todo bajo `.lc-receipt`.
  - 48 mm de contenido y `@page { size: 58mm auto; margin: 0 }`;
  - solo negro y blanco: los grises salen tramados en papel térmico;
  - fuente Switzer y logo monocromo en `public/brand/lubricenter-mono.svg`.
- **Recibo de nómina:** no cambia. Sigue en `app/payroll/[id]/receipt`, con `ReceiptPrintButton` y `.receipt-58`.

## De dónde salen los datos

`public.order_receipt(order_id)` es `security invoker`: lo lee quien ya puede ver la orden.

- **Nombres de las líneas** (`lubricenter_private.receipt_line_name`):
  - el nombre comercial del artículo (`display_name`);
  - si no lo hay, la descripción sin el prefijo de código (`FAN-FULL-5W40 · …`) ni «Compra para el trabajo:».
- **Líneas internas de Cashea** (recargo y ajustes, `receipt_line_is_cashea_internal`): no salen solas. Su monto se suma a la mano de obra de mayor monto; si no hay mano de obra, sale como «Cargo por financiamiento».
- **Cortesía:** un servicio de cambio de aceite en 0 sale como «Cambio de aceite · Mano de obra».
- **Total:** siempre cuadra con `orders.total_ref`. Las órdenes abiertas y las anuladas toman el total de sus líneas y llevan una banda: «Cotización · venta abierta» o «Anulada · sin validez».
- **Placa:** se omite si no es válida (`^[A-Z0-9]{5,8}$`, y no NOTIENE, SINPLACA…).

## Configuración

Está en **Configuración → Recibo de 58 mm** (`components/receipt-settings.tsx`). Se guarda con `set_receipt_settings`, que pide administración de órdenes o el permiso `settings.manage`.

| Clave en `app_settings` | Qué guarda |
|---|---|
| `receipt_header` | `branch`, `address`, `whatsapp`, `instagram`, `rif`, `legend`. Un campo vacío no se imprime. |
| `receipt_total_style` | `BLOCK` (bloque negro) o `BORDER` (borde de 0,6 mm). |

La leyenda por defecto es «Nota de entrega · Documento no fiscal».

# Estado de implementación · 5 nov 2026 (plan maestro F0–F9)

Texto para pegar en `claude/estado-implementacion.md` del proyecto «Lubricenter OS». Solo Cabudare: Supabase `ysvcbbnwandoizczehtk` y Railway «Lubricenter OS Dev» / `lubricenter-web`.

## En producción

| Fase | Qué quedó | PR |
|---|---|---|
| F1 | La placa se exige solo cuando hubo cambio de aceite (servicio de cambio, o 4 L o más de aceite de motor con filtro). Los litros sueltos no bloquean. | lubricenter-os#89 |
| F2 | `<NumberField>` en toda la app: las flechas y la rueda nunca ponen decimales; los decimales se escriben con coma o con punto. | lubricenter-os#90 |
| F3 | Recibo de 58 mm en `/print/receipt/[id]`: sin menú, solo negro y blanco, sin líneas internas y con el total que cuadra. | lubricenter-os#91 |
| F4 | Las cuotas de Cashea se marcan pagadas solo con verificación al 100 %: regla A (export de órdenes) o regla B (export de pagos + línea del BNC). Lo demás queda «Por confirmar», con su motivo. | lubricenter-os#92 |
| F5 | La pestaña «Recuperar» en Seguimiento: vencidos por tramo, valor histórico, contacto por tramo con el tope diario y «Ya volvió». | lubricenter-os#93 |
| F6 | «Ingresar mercancía»: buscador escribible por marca y rubro, artículo nuevo sin salir, y factura más entrada al inventario en un paso. | lubricenter-os#94 |
| F7 | «← Volver a …» con los mismos filtros y el mismo scroll, y Alt + ←. Los filtros van en la URL en Órdenes, Inventario, Cashea, Clientes, Compras, Crédito LC y Seguimiento. | lubricenter-os#95 |
| F6-a | Marcas unificadas (11 artículos, con auditoría), costo promedio sin dilución cuando el artículo no tenía costo, e Historial de mantenimiento con el diseño del OS. | lubricenter-os#96 |
| F8 | Vista previa de órdenes: panel con lo vendido (tienda y taller), el pago con las cuotas, el cliente y los ajustes; ↑/↓, Esc y `?preview=` en la URL. La ganancia solo la ve administración. También en Cashea, Crédito LC y la ficha del cliente. | lubricenter-os#97 |
| F9 | Documentación: `docs/receipt.md`, `docs/number-field.md`, `docs/purchasing.md` y este archivo. | lubricenter-os#97 |

## Migraciones aplicadas (nombre en `supabase_migrations`)

`crm_capture_only_oil_change`, `order_receipt`, `order_receipt_cancelled_totals`, `cashea_sync_verificada`, `crm_recovery`, `crm_queue_item`, `purchasing_goods_entry`, `inventory_brand_cleanup`, `purchase_cost_no_dilution`, `order_preview`.

Cada archivo de `supabase/migrations/` es idéntico a lo aplicado: se comparó el md5 de cada uno.

## Comprobado en producción (5 nov)

- **CRM:**
  - los 39 vehículos con cambio en los últimos 30 días ya usan su cambio nuevo, y ninguno sigue en la cola ni vencido;
  - un carro que vuelve antes de tiempo arranca un ciclo nuevo;
  - las órdenes anuladas no cuentan.
- **Vista previa:** las 100 últimas órdenes cerradas cuadran con su total, con un máximo de 98 ms. La cuenta OPERATOR no recibe la ganancia.
- **Costo:** con un artículo sin costo (7 u), una compra de 5 u a $6 deja el costo en $6. Antes habría quedado en $2,50. La prueba se hizo en un bloque revertido.

## Decisiones tomadas con el default

- **P-02:** el tope diario se queda en 15.
- **P-05 y P-06:** encabezado del recibo y leyenda «Nota de entrega · Documento no fiscal»; un campo vacío no se imprime.
- **P-07:** el total del recibo sale en bloque negro.
- **P-08:** la ganancia en la vista previa la ve solo administración (OWNER/ADMIN), igual que la página Ganancias.

## Pendientes y cosas vistas fuera de alcance

1. **Repo público:** la auditoría del 2 nov lo marcó como público y con datos sensibles. Lo hace privado el dueño, en GitHub.
2. **`finance_profit_report` se puede llamar desde la cuenta OPERATOR.** Solo exige sesión iniciada. La página Ganancias está oculta para esa cuenta, pero la API responde. Para cerrarlo basta un `finance_require('ADMIN')`.
3. **Los permisos por persona no aplican todavía.** Las 2 cuentas son «existentes» y `staff_can()` les da todos los permisos (hay 0 `staff_users`). Edgar y Ender ven lo mismo que la cuenta con la que entran.
4. **505 de 547 artículos no tienen costo.** Desde ahora, la primera compra les fija el costo real.
5. **«BANDOL» / «Bandol»:** la variante en mayúsculas es de un artículo inactivo. No sale en las listas.
6. **GCR36P tiene dos registros de servicio idénticos** de la misma orden (OS del 6/10). No afecta al CRM.
7. **CI:** el 5 nov un `release-check` quedó «en curso» más de 30 min, aunque su límite es de 25; se destrabó con un commit nuevo. Conviene marcar **«CI completa»** (`ci.yml`) como check obligatorio en `main`.
8. **Ramas ya fusionadas** que se pueden borrar: `claude/f2-number-field`, `claude/f3-recibo-58`, `claude/f4-cashea-sync-verificada`, `claude/f5-crm-recuperar`, `claude/f6-ingresar-mercancia` y `claude/crm-semiautomatico`.
9. **Railway** avisa `npm warn config production Use --omit=dev`. Es inofensivo.

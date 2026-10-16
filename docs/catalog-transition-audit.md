# Auditoría de transición del catálogo de Lubricenter OS

**Estado:** cambio propuesto en PR #60, sin aplicar a producción. **No fusionar este PR sin completar la lista de aceptación.**

## Principio de autoridad

- **Notion** contiene los artículos, precios y fotos originales; tras la transición queda como archivo histórico.
- **Lubricenter OS / public.products** pasa a ser la fuente oficial de artículos, categorías, códigos, disponibilidad y precios.
- **Inventario físico** sigue en `inventory_items` y `inventory_movements`; el antiguo Excel es una referencia de códigos y NO una fuente válida de cantidades.
- La sincronización Notion programada seguirá consultando la tasa BCV y la tasa operativa hasta activar, verificar y reconciliar PR #59. Una sincronización de tasas jamás debe actualizar productos.
- Las órdenes ya cerradas conservan precios, tasas y cantidades históricas. No se regeneran facturas.

## Qué cambia

1. `20261013224000_native_catalog_cutover.sql`: guarda un snapshot privado completo de `products`, activa `catalog_authority=LUBRICENTER_OS` y protege los artículos de escrituras de Notion y del importador masivo antiguo. Conserva por ahora las tasas Notion.
2. `20261013224500_native_catalog_editing.sql`: altas y cambios de nombre, categoría, código, precio USD, notas, fotografía HTTPS, disponibilidad y archivo con auditoría, propietario exclusivo y detección de conflicto de modificaciones.
3. `20261013225000_catalog_invoice_intake.sql`: registra fuente de proveedor, factura, moneda, fecha, líneas/costos/cantidades documentales y crea artículos nuevos **sin precio para publicar ni movimientos físicos**. Identifica existentes y rechaza facturas duplicadas.
4. `/catalog/manage`: búsquedas/edición, creación de artículos e ingreso manual de líneas de factura copiadas desde Excel o transcritas de PDF/WhatsApp. **No extrae archivos PDF o mensajes WhatsApp automáticamente.**

## Evidencia de pruebas

El workflow `Native catalog two-month simulation audit` ejecuta **tres ciclos independientes de 60 días** sobre una instancia de PGlite en memoria; ningún ciclo toca la base de producción.
Cada ciclo reproduce 76 artículos iniciales de Notion, 2 muestras archivadas, 433 inventarios (64 vinculados), movimientos económicos y precios históricos simulados, sincronizaciones hostiles de Notion, nuevas facturas semanales, alta de borradores, 60 modificaciones, 60 ventas simuladas y fallos esperados.
Rechazos cubiertos: precio cero disponible al público, factura duplicada, línea con cantidades inválidas, cambio concurrente obsoleto, usuario no autorizado, sobrescritura desde Notion. Comprobar en la salida de CI que se ejecutan y pasan los tres ciclos de 60 días, `npm run lint`, las pruebas adicionales y `npm run build`.

**Límite:** simulaciones representan reglas y datos sintéticos; no son pruebas end-to-end sobre la aplicación desplegada ni acreditan la exactitud del conteo físico o de todas las importaciones reales.

## Resultado de ejecución reproducible (13 de octubre de 2026)

- Workflow de auditoría del catálogo: **SUCCESS**, run [38470813676](https://github.com/lubricenterc-bit/lubricenter-os/actions/runs/38470813676).
- Tres escenarios de 60 días por separado: **ciclo 1 PASS, ciclo 2 PASS y ciclo 3 PASS**. Cada ciclo incluye 60 cambios de precio, 60 snapshots de órdenes, 9 facturas de captura (18 renglones, 9 nuevos borradores), 6 reintentos de sincronización de catálogo desde Notion y comprobación de rechazos esperados.
- Pruebas de catálogo general y catálogo técnico: **PASS**. TypeScript lint y Next.js producción: **PASS**.
- UI de catálogo corregida para mostrar la fuente oficial una vez activado el cambio, y seguir indicando Notion en producción hasta entonces.
- El workflow general preexistente **Cash close checks** sigue en rojo por fixtures ajenos a este PR (entre otros, `public.finance_role` faltante y columna `created_at` en tests de terceros). Estaba fallando en cambios anteriores; debe investigarse como deuda técnica separada antes de cualquier despliegue financiero. No se ha marcado como prueba aprobada.

## Checklist previo a la activación

- [ ] Confirmar conteo real del equipo, y mantener todas las existencias fuera de la migración.
- [ ] Comprobar que los 76 artículos activos, los 2 inactivos y sus UUID, precios y fotos coinciden antes y después del snapshot.
- [ ] Confirmar seguridad: `products` sin escritura directa de usuarios, RPC editor restringido al propietario, auditoría privada, captura de factura restringida y prohibición de escritura de Notion sobre productos.
- [ ] Confirmar ejecución de los tres ciclos independientes de 60 días y todos los trabajos de CI aplicables (o documentar fallas heredadas no relacionadas).
- [ ] Resolver el orden de despliegue respecto a PR #59 (tasas). Ambas migraciones cambian `get_pricing_sync_status` y `assert_notion_pricing_fresh`; deben consolidarse para que una no sobrescriba la otra.
- [ ] Verificar que la sincronización de tasas continúa funcionando sin sobrescribir nombres/precios de productos tras cortar el catálogo.
- [ ] Hacer snapshot SQL completo y exportación externa antes de aplicar las tres migraciones. Guardar conteos, UUID, imágenes, costos y la última tasa.
- [ ] Publicar backend (migraciones) y luego frontend, comprobar sesión de propietario y usuario operador.
- [ ] Hacer una alta, edición, archivo, captura de factura con código ya existente y captura de nueva referencia. Verificar que stock, facturas históricas y asientos financieros NO cambian.
- [ ] Verificar búsqueda en catálogo, venta rápida, presupuesto, órdenes completas y cambios de aceite con precios actuales y controles vigentes.
- [ ] Comprobar mediante ejecuciones reales que Notion puede sincronizar tasas sin reescribir artículo alguno durante al menos 2 ciclos Cron.

## Rollback / contención

1. **Antes de activar:** dejar PR en borrador y NO ejecutar migraciones. Producción sigue en su comportamiento actual.
2. **Si falla la aplicación después de activar:** deshabilitar edición y captura temporalmente, identificar el fallo y registrar todos los cambios posteriores al snapshot; no sobrescribir con Notion ni reconstruir cantidades.
3. Los snapshots privados están en `lubricenter_private.catalog_cutover_backups`, protegidos. Nunca reponerlos ciegamente porque podrían borrar cambios legítimos posteriores.
4. Para revertir las funciones o `catalog_authority`, preparar una migración de reversión revisada que preserve modificaciones posteriores al cutover y no reactive importaciones masivas hasta reconciliar precios.
5. Conservar el historial de auditoría y capturas de facturas incluso al revertir una UI.

## Después de la activación

- Fase aparte: asociar artículos comerciales a cada SKU de inventario conforme al conteo, registrar equivalencias Millard verificadas, e integrar la creación de artículos a la contabilidad formal de facturas/recepciones. La captura de factura de catálogo no es una compra contabilizada.
- A futuro: importación de CSV/Excel adjunto, extracción de PDF/WhatsApp con revisión humana antes de aprobar costos.

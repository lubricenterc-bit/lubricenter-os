# Plan de arquitecto: poner El Cují (Norte) al día con Cabudare

> Fase 0 · 6 nov 2026 · solo lectura (no se cambió nada en ninguna base ni en Railway).
> Destino: rama `norte`, Supabase `yfkotqmccrmlhxmybhps`, Railway «Lubricenter del Norte» → `norte-web`.
> Origen (solo lectura): rama `main`, Supabase `ysvcbbnwandoizczehtk`.

**Fuentes no disponibles:** los documentos del proyecto «Lubricenter OS» (`claude/norte-implementacion.md`, `claude/estado-implementacion.md`, `claude/plan-arquitecto-claude-code.md`, etc.) no están en el repo ni a mi alcance. Este plan se construyó con el repo, las dos bases y Railway. Si alguno de esos documentos contradice algo de aquí, avísame.

---

## a) Hechos confirmados y diferencias con la sección 3 del prompt

### Confirmados
| Hecho | Resultado |
|---|---|
| Brecha de migraciones | **Exactamente las 22** de la tabla 3.4. Cabudare no tiene nada después de `20261105152210 crm_tunnel_fixes`. Norte solo tiene `norte_00…09`. |
| Ninguna de las 22 entró en el clon | Confirmado. En Norte no existen `in_catalog`, `inventory_save_item_full`, `order_receipt`, `order_preview`, `crm_board`, `crm_recovery_list`, `purchase_invoice_and_receive`, `brand_key`, `cashea_conc_dataset` ni las tablas `cashea_bnc_lines`, `cashea_branches`, `crm_message_templates`, `crm_send_attempts`, `crm_customer_flags`, `crm_capture_skips`, `supplier_brands` y `purchase_invoice_requests`. |
| Base de El Cují | Ubicación única `NORTE` («Lubricenter Norte»). `inventory_strict_mode = false`. Empleados ALFREDO, ALEJANDRO y WILFREDO (los tres activos). 1 cuenta de personal. |
| Ramas de Supabase | `list_branches` de Norte devuelve vacío. No pude ver el plan desde el conector, pero el sustituto propuesto (bloque `do` revertido) vale en cualquier caso. |
| Railway | `norte-web` despliega desde la rama `norte`. Solo tiene las variables `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| Repo | merge-base `fa50fdc`. `main` tiene 17 commits que `norte` no tiene; `norte` tiene 7 propios. |

### Conteos actuales de El Cují (6 nov)
| | Cantidad |
|---|---|
| Órdenes (total / cerradas) | 0 / 0. El contador `NT-` está sin usar |
| Clientes / vehículos / registros de servicio | 0 / 0 / 0 |
| Pagos / cuotas Cashea | 0 / 0 |
| Artículos (total / con precio contado / con precio Cashea) | 207 / **0** / 0 |
| Artículos con existencia ≠ 0 / movimientos de inventario | 0 / 0 |
| Préstamos de mercancía | 0 |
| Proveedores / facturas de proveedor | 0 / 0 |
| Marcas distintas en artículos | 12 |

**Consecuencia:** El Cují todavía no tiene operación real, así que el riesgo sobre los datos es mínimo. El riesgo real está en **romper pantallas** y en **pisar funciones propias de El Cují**.

### Diferencias con lo que decía el prompt (corrígelas en tus notas)
1. **Migración 11 (`crm_capture_sin_editar_venta`) no usa el correo de Cabudare.** `guard_closed_edits` solo aparece en un comentario y la migración no lo recrea. El correo vive en `lubricenter_private.is_order_admin()`, que en Norte ya dice `lubricenternorte@gmail.com` y ninguna de las 22 toca. → **TAL CUAL.**
2. **Migración 19 (`inventory_brand_cleanup`) no crea ninguna tabla.** `inventory_brands` no existe ni en Cabudare. La migración es solo un `update` de marcas con nombres e **IDs fijos de artículos de Cabudare**. `brand_key` y `supplier_brands` vienen de la 18. → **OMITIR completa**; la propuesta de marcas de El Cují va aparte (P-04).
3. **Migración 21 (`order_preview`) no tiene «Cheo» ni «Alexis» escritos.** Toma los nombres de `public.employees`, que en El Cují son Alfredo, Alejandro y Wilfredo. → **TAL CUAL.**
4. **Migración 10 (`crm_semiauto`) no marca 224 vehículos.** Lo único ligado a Cabudare es el ajuste `crm_legacy_bulk_date = 2026-09-10` (fecha de la importación masiva de Cabudare) y un `update` de `customer_followups` pendientes, que en El Cují no hace nada porque hay 0 filas. Lo que sí hay que adaptar son **las plantillas de mensajes**, que dicen «*Lubricenter Cabudare*». Lo mismo vale para la 22.
5. **`get_catalog_snapshot` en Norte es distinto al de Cabudare:** solo muestra artículos con existencia > 0 de `NORTE`. La migración 3 lo reemplaza (ver mapa de funciones en riesgo).
6. **La migración 7 (`revoke_orphan_rpcs`) sí rompe El Cují si va en F1:** la pantalla `/inventory` de la rama `norte` llama a `get_inventory_snapshot`, que esa migración revoca. En `main` esa pantalla ya usa `get_inventory_full`. → **Se mueve a F6**, después del despliegue del código nuevo.
7. **Archivos del repo y SQL aplicado en Cabudare** (comparados sin espacios ni comentarios):
   - 14 de las 22 son idénticas byte a byte (sin contar espacios): 1, 2, 3, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 y 22.
   - 4, 5, 6, 7, 8 y 11 solo difieren en comentarios.
   - **9 (`inventory_save_item_cost_zero`) no tiene archivo en el repo**, y su código es idéntico a la 8 tal como quedó aplicada. El archivo `20261102130000_inventory_save_item_cost_fix.sql` ya contiene la versión final.
   - **10 (`crm_semiauto`):** las mismas sentencias, con un bloque de 4 en otro orden. **La fuente para El Cují será el SQL aplicado en Cabudare** (`supabase_migrations.schema_migrations.statements`), no el archivo.
   - Los nombres de archivo del repo tienen otra versión (fecha y hora) que la aplicada. Es solo cosmético.
8. **Las migraciones `norte_00…09` no están en el repo.** `supabase/norte/` solo tiene la instantánea, el script y el catálogo. En F1 se crea `supabase/norte/migrations/` y se guardan también `norte_00…09`, leídas de la base.
9. **Railway despliega sin esperar a la CI** (`checkSuites: false`). Fusionar un PR a `norte` despliega aunque la CI esté roja. Ver riesgos.

---

## b) Tabla final de las 22 migraciones

| # | Migración | Clasificación final | Qué se cambia / por qué | Fase |
|---|---|---|---|---|
| 1 | `cashea_branch_conciliation_20261029` | **OMITIR** (P-02) | La conciliación BNC compartida se hace en la base de Cabudare. Nada más depende de ella | — |
| 2 | `cashea_conciliation_autofix_20261029` | **OMITIR** (P-02) | Depende de la 1 | — |
| 3 | `inventory_two_views` | **ADAPTAR** → `inventory_two_views_norte` | `'CABUDARE'` → `'NORTE'` en 3 sitios (`get_catalog_snapshot`, valores por defecto de `get_catalog_view` y `get_inventory_full`). El arranque `in_catalog = price_usd > 0` marca 0 artículos (no hay precios). Ver mapa de riesgo | F2 |
| 4 | `performance_fk_indexes_rls_initplan` | **TAL CUAL** | Índices con `if exists` y `alter policy` sobre políticas que existen igual en Norte | F1 |
| 5 | `rls_policy_initplan_staff_gates` | **TAL CUAL** | Es genérica: reescribe toda política que use las funciones de permiso. En Norte toca **121 políticas**, incluidas las de préstamos y equipo de `norte_07` | F1 |
| 6 | `reminder_forecast_materialized_ctes` | **TAL CUAL** | Vista recreada y tarea de cron de limpieza | F1 |
| 7 | `revoke_orphan_rpcs` | **TAL CUAL, pero en F6** | Revoca 14 RPC. De ellas, `get_inventory_snapshot` la usa la `/inventory` actual de Norte. Después de F6 ninguna pantalla llama a esas 14 (verificado en `main`) | F6 (después del despliegue) |
| 8 | `inventory_save_item_cost_fix` | **TAL CUAL** | Recrea `inventory_save_item_full`, que nace en la 3. No toca los tres precios | F2 |
| 9 | `inventory_save_item_cost_zero` | **TAL CUAL** | Mismo código que la 8. Se aplica igual para que `list_migrations` quede paralelo; sin efecto adicional | F2 |
| 10 | `crm_semiauto` | **ADAPTAR** → `crm_semiauto_norte` | Las plantillas PRE, DUE, RECOVERY y RECONNECT dicen «Lubricenter Cabudare» → nombre de El Cují (P-06). `crm_legacy_bulk_date` se deja (sin efecto: no hay servicios ese día). Fuente: SQL aplicado | F4 |
| 11 | `crm_capture_sin_editar_venta` | **TAL CUAL** | No contiene correo (ver «Diferencias», punto 1) | F4 |
| 12 | `crm_capture_only_oil_change` | **TAL CUAL** | — | F4 |
| 13 | `order_receipt` | **ADAPTAR** → `order_receipt_norte` | `receipt_header.branch` = «El Cují» y demás campos según P-03 | F3 |
| 14 | `order_receipt_cancelled_totals` | **TAL CUAL** | — | F3 |
| 15 | `cashea_sync_verificada` | **OMITIR** (P-02) | Recrea `cashea_conc_sync_installments` (de la 1). La pantalla `/cashea` de `main` llama a `cashea_tracking_status` y a `…_v2`, pero **tolera el error** y oculta esa sección (verificado en el código) | — |
| 16 | `crm_recovery` | **TAL CUAL** | — | F4 |
| 17 | `crm_queue_item` | **TAL CUAL** | — | F4 |
| 18 | `purchasing_goods_entry` | **ADAPTAR** → `purchasing_goods_entry_norte` | La sede por defecto de `purchase_invoice_and_receive`, `'CABUDARE'`, pasa a `'NORTE'`. No toca los tres precios: entra existencia y costo, no precios de venta | F2 |
| 19 | `inventory_brand_cleanup` | **OMITIR** | Solo datos de Cabudare, con IDs fijos. Se reemplaza por la propuesta P-04 | — |
| 20 | `purchase_cost_no_dilution` | **TAL CUAL** | Con existencia anterior ≤ 0 (posible en modo no estricto) usa el costo de la factura: `case when v_previous_qty > 0 …`. Es correcto para El Cují | F2 |
| 21 | `order_preview` | **TAL CUAL** | Los nombres salen de `employees` (ver «Diferencias», punto 3) | F3 |
| 22 | `crm_tunnel_fixes` | **ADAPTAR** → `crm_tunnel_fixes_norte` | Las plantillas AGREED y SECOND dicen «Lubricenter Cabudare» → nombre de El Cují (P-06) | F4 |

Resumen: **12 TAL CUAL, 5 ADAPTAR, 4 OMITIR** (1, 2, 15 y 19), y la 7 va TAL CUAL pero en F6. En total se aplican 18.

---

## c) Mapa de funciones en riesgo

**Método:** se comparó `pg_get_functiondef` de cada función de `public` y `lubricenter_private` en Norte con la instantánea de Cabudare del clon (`supabase/norte/schema_snapshot_20261029.json`), normalizando espacios.

**Funciones que El Cují cambió (20)**, la lista que hay que revisar en cada sincronización:

| Esquema | Funciones |
|---|---|
| `lubricenter_private` | `crm_attribute_oil_campaign_conversion`, `finance_role`, `is_order_admin`, `order_integrity_audit`, `require_order_admin` |
| `public` | `add_inventory_bonus_item`, `add_inventory_product_item`, `add_service_item`, `assign_payment_account`, `consume_inventory_on_order_close`, `create_order`, `finance_followup`, `finance_push_refresh`, `finance_tasks`, `get_catalog_snapshot`, `get_inventory_snapshot`, `get_inventory_snapshot_v2`, `get_oil_change_inventory`, `set_inventory_count`, `sync_notion_pricing_service` |

**Funciones propias de El Cují (13, no existen en Cabudare):** `employee_save`, `employee_set_rule`, `employees_admin`, `inventory_set_tier_prices`, `loan_register`, `loan_settle` (las seis en `public` y en `lubricenter_private`) y `lubricenter_private.require_payroll_admin`. Ninguna de las 22 las toca.

**Funciones que las 18 migraciones a aplicar recrean y que El Cují cambió:**

| Función | Migración | Norte hoy | Cabudare (la 3) | Estrategia |
|---|---|---|---|---|
| `public.get_catalog_snapshot()` | 3 | `location_code = 'NORTE' and quantity_on_hand > 0`; `available = quantity_on_hand > 0` | `location_code = 'CABUDARE' and in_catalog and merged_into is null`; `available = true` | Se toma la de Cabudare con `'NORTE'`. Encaja mejor con «se vende sin existencia», porque el catálogo ya no esconde lo que tiene existencia 0. ⚠️ **Efecto:** el catálogo queda vacío hasta que cada artículo tenga precio y esté marcado «en catálogo». Hoy también está vacío (0 con existencia), así que nadie pierde nada. Ver P-07 |

**Funciones que la migración 7 revoca y que El Cují cambió:** `get_inventory_snapshot`, `get_inventory_snapshot_v2`, `get_oil_change_inventory` y `set_inventory_count`. Tras F6 no las llama ninguna pantalla; las versiones de Norte quedan en la base, sin permiso para `authenticated`. Se mantiene la regla de Cabudare.

Ninguna otra función del cuadro de 20 la recrea alguna de las 18 migraciones. Las demás funciones que las 18 recrean están idénticas en Norte y en la instantánea, así que el resultado será igual al de Cabudare.

### Permisos
- Los privilegios por defecto (`pg_default_acl`) de `public` son **iguales** en las dos bases: las funciones nuevas nacen ejecutables por `anon`. Cada migración ya hace `revoke … from public, anon` y `grant … to authenticated` en lo suyo, así que el resultado es el de Cabudare (por ejemplo, `crm_board` queda sin `anon`).
- **`norte_08`** concede `execute … to public` a 16 funciones de `lubricenter_private` (`staff_can`, `staff_identity_allowed`, `staff_owner`, `staff_write_guard`, `setting_number`, etc.). **Ninguna de las 22 revoca esas 16.** La 7 solo toca 14 funciones de `public`, sin cruce. La 5 solo envuelve sus llamadas en `(select …)` dentro de las políticas.
- La prueba revertida de cada fase llama, como `authenticated`, a `staff_can('…')`, `inventory_set_tier_prices`, `loan_register` y `employees_admin`, para confirmar que siguen funcionando.

### Línea base de `get_advisors` (seguridad, Norte)
6 INFO `rls_enabled_no_policy` (incluido `_norte_bootstrap`), 136 WARN `authenticated_security_definer_function_executable` y 1 WARN `auth_leaked_password_protection`. **Criterio de aceptación:** ningún aviso nuevo que no sea de la misma clase y que no venga también en Cabudare.

---

## d) Conflictos de código y cómo se resuelven

Prueba en seco: `git merge --no-commit --no-ff origin/main` sobre `origin/norte`, en una rama desechable ya borrada. Hubo **13 conflictos**; 186 archivos más se fusionan solos.

| Archivo | `main` trae | `norte` conserva | Resolución |
|---|---|---|---|
| `app/layout.tsx` | Metadatos nuevos (+18 −3) | Títulos «Lubricenter Norte» | Lo de `main` con los títulos de Norte |
| `app/more/page.tsx` | Rediseño (−44) | «Alfredo, Alejandro, Wilfredo y ajustes» | Lo de `main` con el texto de Norte |
| `app/orders/[id]/correct/page.tsx` | `canAdministerOrders()` | Mensaje con lubricenternorte@gmail.com | Lo de `main` con el correo de Norte |
| `app/orders/[id]/oil-change/page.tsx` | Cambios grandes (+67 −38) | `manualAllowed = false`: descuenta del inventario aunque la existencia sea 0 | Lo de `main` y se vuelve a aplicar la regla de Norte a mano. **Hay prueba en F7** |
| `app/orders/[id]/receipt/page.tsx` | Recibo de 58 mm nuevo | Etiqueta «Provincial · pago móvil o punto» (el resto son líneas en blanco) | Lo de `main` con las etiquetas de Provincial |
| `app/inventory/page.tsx` | Dos vistas (`get_inventory_full`) | `NORTE` en lugar de `CABUDARE` | Lo de `main` con `NORTE` (4 sitios, más el texto «Cabudare») |
| `components/order-builder.tsx` y `components/order-builder-v2.tsx` | **Borrados** (código muerto) | Nombres Alfredo/Alejandro y Provincial | Se aceptan los borrados. Esos textos ya están en `order-workspace.tsx` |
| `lib/crm-retention.ts` | **Borrado** (el CRM pasó a la base) | Saludo «Lubricenter Norte» | Se acepta el borrado. El saludo va en las plantillas de la base (10 y 22) |
| `components/order-workspace.tsx` | +37 −20 | Alfredo y Alejandro, Provincial, filtro `NORTE` | Lo de `main` con los textos y la sede de Norte |
| `components/payroll-review.tsx` | +5 −4 | Ejemplos con Alfredo y Alejandro | Lo de `main` con los nombres de Norte |
| `components/quick-sale-screen.tsx` | +26 −33 (NumberField, captura de placa) | **Tres precios** (selector Contado/Divisas/Cashea), venta sin tope de existencia, Provincial, `NORTE` | Base de `norte`, con lo nuevo de `main` encima línea por línea. Es el archivo más delicado |
| `lib/navigation.ts` | +41 −6 (Compras, CRM y Ayuda) | `/inventory/prices`, `/inventory/loans`, `/payroll/employees` y la palabra «Provincial» | Unión de los dos; se quita `/cashea/conciliacion` (P-02) |

### Textos y valores de Cabudare que entran con `main` en archivos sin conflicto (se sustituyen en F6)
- `CABUDARE` como sede: `app/catalog/page.tsx`, `components/order-bonus-product.tsx`, `components/purchase-receive-sheet.tsx`, `components/quick-sale-screen.tsx`, `components/order-workspace.tsx` y `app/orders/[id]/oil-change/page.tsx`.
- «Cabudare»: `components/app-shell.tsx` (2), `components/receipt-settings.tsx` (2), `lib/receipt.ts`, `lib/oil-quote.ts` (2 mensajes de WhatsApp) y `app/inventory/page.tsx`.
- «Cheo» y «Alexis»: `components/os-home.tsx` (2), `lib/help-topics.ts` (2) y `components/order-workspace.tsx`.
- «Banco de Venezuela»: `app/orders/page.tsx`, `app/finance/inbox/page.tsx` (2), `app/orders/[id]/receipt/page.tsx` y `components/order-workspace.tsx`.
- `lubricenterc@gmail.com`: `app/orders/[id]/correct/page.tsx`.
- Pantallas de conciliación Cashea (`app/cashea/conciliacion`, `lib/cashea-conciliation/*`): se ocultan en la navegación (P-02); no se reescriben.
- `app/design-lab/page.tsx` es una página de muestras. Se deja, pero sale del menú si aparece.
- No hay prefijo `OS-` fijo en `app`, `components` ni `lib`.
- Al final de F6, `git grep -nE "Cabudare|CABUDARE|Cheo|Alexis|lubricenterc@|Banco de Venezuela"` sobre `app components lib` debe dar 0, salvo los archivos de conciliación ocultos y los comentarios.

---

## e) Orden de fases propuesto

| # | Fase | Contenido | Cambio frente al prompt |
|---|---|---|---|
| F1 | Rendimiento | 4, 5 y 6 (TAL CUAL, un solo GATE). Crear `supabase/norte/migrations/` con `norte_00…09` | **La 7 sale de aquí** |
| F2 | Inventario y compras | 3 (adaptada), 8, 9, 18 (adaptada) y 20. Propuesta de marcas de El Cují (P-04) | La 19 se omite |
| F3 | Recibo y vista previa | 13 (adaptada), 14 y 21 | — |
| F4 | CRM | 10 (adaptada), 11, 12, 16, 17 y 22 (adaptada) | 11 y 21 pasan a TAL CUAL |
| F5 | Cashea | Nada en la base. Solo se decide la navegación (va en F6) | — |
| F6 | Código | Fusión de `main` en `claude/cuji-f6-merge-main`, textos de El Cují y CI verde. PR → `norte`. **Tras el despliegue: migración 7** con su prueba y su GATE | La 7 entra aquí |
| F7 | Verificación en producción | Recorrido completo y simulación revertida (sección 8 del prompt) | — |
| F8 | Cierre | `docs/sync-norte.md`, texto para `claude/norte-implementacion.md` y la propuesta multisucursal | — |

**Por qué F2 a F4 antes del código:** las funciones nuevas no rompen la rama `norte` actual, porque nadie las llama, con una sola excepción: la migración 3 cambia `get_catalog_snapshot`, que usan `/catalog`, `/quote` y `/inventory` de Norte. La firma es la misma y el contenido es equivalente (hoy vacío), así que no se rompe nada.

**Ramas:** la de esta fase es `claude/jolly-volta-4xh8e8` (la que asignó la sesión) en lugar de `claude/cuji-f0-plan`. Desde F1 uso `claude/cuji-<fase>-<slug>` desde `norte`, como pide el protocolo, si la sesión lo permite.

---

## f) Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| **Railway despliega aunque la CI esté roja** (`checkSuites: false`) | Fusionar solo con `norte.yml` en verde. Recomiendo activar «Wait for CI» en `norte-web`, pero solo con tu «sí»: es un cambio en Railway |
| La migración 7 rompe `/inventory` antes de F6 | Se movió a F6, después del despliegue |
| La 3 vacía el catálogo de cotizadores hasta marcar artículos | Hoy ya está vacío. Se explica en el GATE de F2 y P-07 propone cómo marcarlos |
| `quick-sale-screen.tsx` pierde los tres precios o la venta sin existencia | Resolución a mano sobre la base de `norte`; pruebas de F7 (contado sin existencia, divisas y Cashea) |
| `oil-change/page.tsx` vuelve a bloquear la venta con existencia 0 | Se vuelve a aplicar `manualAllowed = false`; está en el recorrido de F7 |
| Textos de Cabudare en pantallas o mensajes de WhatsApp | La lista del punto d) y el `git grep` final con 0 resultados |
| Diferencias entre el repo y lo aplicado en Cabudare | Fuente = `schema_migrations.statements` de Cabudare (lectura). El archivo guardado en `supabase/norte/migrations/` es idéntico a lo aplicado en Norte |
| Sin ramas de Supabase | Cada migración se prueba en un bloque `do $$ … raise exception 'RESULTADO %' … $$` que revierte todo, con las pruebas como `authenticated` dentro. Luego `get_advisors` y ⛔ GATE antes de `apply_migration` |
| Tocar Cabudare por error | En Cabudare solo `select`, `list_migrations` y `list_tables`, siempre con `project_id = ysvcbbnwandoizczehtk`. Todo lo que escribe usa el conector «Supabase Norte» |
| La fusión de un PR a `norte` despliega a producción | Ningún PR se fusiona sin tu «sí» |

---

## g) Preguntas al dueño, con mi recomendación

| ID | Pregunta | Recomendación |
|---|---|---|
| **P-01** | ¿Entra el CRM ya, con la captura de placa en Venta rápida activa? | **Sí** (el DEFAULT). No hay clientes que dañar y así se empiezan a juntar desde la primera venta |
| **P-02** | ¿Se omiten en El Cují las migraciones de conciliación Cashea (1, 2 y 15) y se oculta `/cashea/conciliacion`? | **Sí** (el DEFAULT). Nada más depende de ellas y `/cashea` funciona sin ellas: la sección de verificación simplemente no aparece |
| **P-03** | Encabezado del recibo: sucursal, dirección, WhatsApp, Instagram y RIF | «El Cují» y lo demás vacío, hasta que me pases los datos. Se pueden cambiar después desde Ajustes del recibo, sin migración |
| **P-04** | Unificación de marcas de El Cují | Te llevo en F2 la lista de las 12 marcas actuales con una propuesta de agrupación; no se aplica nada sin tu «sí» |
| **P-05** | ¿Se acepta el diseño que trae `main`? | **Sí**, con los textos de El Cují |
| **P-06** (nueva) | ¿Con qué nombre firman los mensajes de WhatsApp del CRM y la cotización de aceite: «Lubricenter Norte» (como hoy) o «Lubricenter El Cují»? | **«Lubricenter Norte»**, lo que ya ven los clientes hoy, salvo que prefieras «El Cují» |
| **P-07** (nueva) | Al guardar precios en `/inventory/prices`, ¿el artículo entra solo al catálogo? | **Sí, como ajuste pequeño de El Cují:** `inventory_set_tier_prices` marca `in_catalog = true` cuando el precio contado es > 0. Si no, hay que marcarlos uno por uno o en lote en Inventario. Sin tu «sí», el DEFAULT es no cambiar `inventory_set_tier_prices` y marcar en lote |

---

## h) Tiempo estimado por fase (trabajo de sesión, sin contar la espera de tus «sí»)

| Fase | Estimado |
|---|---|
| F1 | 30–45 min |
| F2 | 1,5–2 h (incluye la propuesta de marcas) |
| F3 | 45 min |
| F4 | 1–1,5 h |
| F5 | 10 min (decisión) |
| F6 | 2,5–3,5 h (13 conflictos, sustitución de textos, CI) + migración 7 (20 min) |
| F7 | 1–1,5 h |
| F8 | 1 h |
| **Total** | **≈ 9–11 h** |

---

## Recordatorios (fuera de alcance)
- **`NOTION_API_TOKEN` no está en Supabase Norte:** las tasas automáticas no corren. Hay una tarea de cron `notion-pricing-sync-15m` programada que fallará hasta que se cargue el secreto.
- **El repo es público y contiene datos sensibles** (auditoría del 2 nov). No lo cambié.
- Siguen ahí `public._norte_bootstrap` y la extensión `http` (requieren confirmación aparte).
- `get_advisors` avisa que la protección contra contraseñas filtradas está apagada en la autenticación de Norte.

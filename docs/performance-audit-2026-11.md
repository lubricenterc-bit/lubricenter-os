# Auditoría de rendimiento — noviembre 2026

Método: medir primero (build, tests, advisors de Supabase), corregir solo lo que
tiene impacto medible y no tocar la lógica de dinero. Nada de esto cambia
reglas de negocio, montos ni permisos.

## Línea base

- `next build`: 103 kB de JS compartido; páginas entre 170 y 217 kB. No hay un
  "bundle.js gigante": cada ruta ya se divide sola.
- Tests: 365/368 en `main`. Las 3 fallas ya existían (ver abajo).
- Advisors de Supabase: 41 FK sin índice, 9 políticas RLS que evalúan
  `auth.uid()` por fila, 97 índices "sin uso".

## Qué se cambió

| Problema | Dónde | Arreglo |
|---|---|---|
| Peticiones en cascada | `order-workspace` (pantalla de orden) | De hasta 5 viajes en fila a 2. Las tasas de la orden salen con la orden; validación y candidatos de aceite salen con cliente y vehículo; inventario y orden en paralelo. |
| Peticiones en cascada | `finance/inbox` | Rol y caja pendiente en paralelo. |
| La misma consulta de permisos en cada pantalla | 18 pantallas pedían `finance_role` / `can_administer_orders` | `lib/session-cache.ts`: una petición por sesión, deduplicada, TTL de 5 min, se vacía al cerrar sesión y nunca guarda errores. Solo identidad; nunca tasas ni saldos. |
| Escritura a medias | `finance/reconcile` → guardar saldos finales | Antes guardaba cuenta por cuenta y, si la tercera estaba vacía, las dos primeras quedaban guardadas. Ahora valida todo primero y luego escribe en paralelo. |
| Sondeo derrochador | Estado de precios y alertas del encabezado | `lib/use-visible-polling.ts`: no consulta con la app en segundo plano, una sola consulta al volver (antes `focus` + `visibilitychange` duplicaban) y el temporizador de alertas ya no se rehace en cada navegación. |
| Pantalla en blanco al recargar | Orden, inicio, venta rápida, inventario, cuentas por cobrar | El "Cargando…" solo aparece en la primera carga; los refrescos mantienen los datos visibles. |
| Estáticos siempre por red | `public/sw.js` | Archivos con hash (`/_next/static`): cache-first, sobreviven despliegues, máximo 300 entradas. Logos/iconos: stale-while-revalidate. HTML sigue network-first para que un despliegue nunca quede oculto. |
| Service worker que se reinstalaba | `finance-notifications` registraba `/sw.js` sin `?v=` | URL única en `lib/sw-url.ts`. |
| Cabeceras HTTP | `next.config.ts` | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `noindex`, sin `X-Powered-By`, `sw.js` sin caché, logos con caché de un día. |
| Sin 404 / mismo título | `app/not-found.tsx`, `app/robots.ts`, `AppShell` | Página 404 en español, `robots.txt` que bloquea todo (sistema interno), título por pantalla en la pestaña. |
| BD | `supabase/migrations/20261102120000_performance_fk_indexes_rls_initplan.sql` | 16 índices para FK de lectura frecuente y 9 políticas con `(select auth.uid())`. Aditiva e idempotente. **Pendiente de aplicar en producción.** |

## Lo que se decidió NO hacer, y por qué

- **Optimistic UI en operaciones de dinero** (cobrar, cerrar orden, pagos,
  nómina): la pantalla no debe mostrar un cobro que la base todavía puede
  rechazar (stock, tasas, versiones). Se mantiene "confirmar en el servidor y
  luego mostrar", pero sin vaciar la pantalla mientras tanto.
- **Exportación 100 % estática**: `/api/jobs/finance`, `/api/notifications` y
  `/api/campaigns` necesitan servidor (web-push, secretos). Las 55 pantallas sin
  `[id]` ya se pre-renderizan como estáticas y los assets van por CDN.
- **SEO de la lista de TikTok** (sitemap, llms.txt, OG image, datos
  estructurados): es para sitios públicos. Aquí lo correcto es lo contrario:
  `noindex` y `robots.txt` bloqueando todo.
- **Borrar los 97 índices "sin uso"**: las estadísticas del proyecto conectado
  muestran 0 filas, así que "sin uso" no significa nada todavía.
- **Paralelizar las importaciones de Cashea/BDV**: deduplican entre archivos;
  el orden importa. Se quedan en secuencia a propósito.
- **Reformatear archivos de una sola línea**: mejora la lectura, pero en un
  cambio de rendimiento solo añadiría miles de líneas de diff sin efecto. Mejor
  en un PR aparte, archivo por archivo.

## Tests

- Nuevos: `tests/session-cache.test.ts`, `tests/performance-migration.test.ts`
  (PGlite: la política da el mismo acceso, `with check` sigue bloqueando y es
  idempotente), y 5 casos más en `tests/service-worker.test.ts`.
- Fallas que ya existían en `main` y siguen igual:
  - `payroll-cashea-commission` (2): dependen de la fecha ("Selecciona un
    sábado de nómina todavía abierto").
  - `order-extras` (1): verifica el orden de un texto en el código fuente que
    ya había cambiado.

## Hallazgo para revisar

`staff_users`, `staff_permissions` y `staff_tasks` existen en producción pero
no aparecen en ninguna migración del repo (se crearon por fuera). Conviene
traer su DDL a una migración para que el repo vuelva a describir la base real.

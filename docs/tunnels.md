# Modo túnel

El modo túnel guía un proceso **una decisión a la vez**, a pantalla completa. El sistema hace el trabajo pesado y la persona solo aprueba, elige, escribe un dato, explica o aparta. Es opcional: cada proceso conserva su vista manual y el túnel lee y escribe los mismos datos.

- `/tunnels`: Túneles pendientes (decisiones pendientes, tiempo estimado, último cierre, «Continuar»).
- `/tunnels/<key>`: el túnel a pantalla completa, fuera del shell.
- `/tunnels/rules`: Reglas aprendidas (ver, editar, desactivar, aprobar y borrar).

## Cómo está armado

| Pieza | Dónde | Qué hace |
|---|---|---|
| Contrato | `lib/tunnels/types.ts` | `TunnelDefinition`, `TunnelCase`, `TunnelAction`, reglas, cuadre |
| Motor puro | `lib/tunnels/engine.ts` | Diapositivas, lotes, progreso, deshacer, reabrir y recalcular reglas |
| Reglas | `lib/tunnels/rules.ts` | Evalúa condiciones sobre `facts`; las reglas son del **proceso** |
| Backends | `lib/tunnels/backend.ts` | Supabase (RPC `tunnel_*`) o memoria (demo y pruebas) |
| IA | `lib/tunnels/ai.ts`, `ai-server.ts`, `app/api/tunnels/[key]/explain` | «No → explicar», con herramientas de solo lectura |
| Pantalla | `components/tunnel/*`, `app/tunnel.css` | Diapositivas, teclado, gestos, modo noche |
| Registro | `lib/tunnels/registry.ts` | Agregar un túnel = agregar su definición |
| Datos | `supabase/migrations/20261031120000_tunnels_engine.sql` | Sesiones, decisiones, reglas, corridas de IA y registro de acciones |

### Escalera de esfuerzo

Cada caso declara `level`:

- `auto`: alta confianza y con `proposal`. Se agrupa por `batchGroup` en una diapositiva de lote («Casé 75 abonos, ¿los apruebo?»), con «Revisar uno por uno».
- `confirm`: sí o no sobre `proposal`.
- `choice`: de 2 a 4 `options`.
- `input`: pide un dato (`money`, `text` o `select`) y ejecuta `input.action` con `{ ...basePayload, value }`.

Siempre existe «No sé, apartar» (respuesta `SKIP`, sin efecto).

### Acciones reversibles (transaccionales)

Cada tipo de acción se registra en `lubricenter_private.tunnel_action_handlers` con dos funciones:

- `apply_fn(payload jsonb) returns jsonb`: aplica y devuelve lo necesario para revertir.
- `revert_fn(revert jsonb) returns void`: revierte. Si ya no es posible (otro proceso cambió el dato), debe lanzar una excepción con un mensaje claro. El RPC deshace todo y no deja nada a medias.

`tunnel_decide` aplica la acción y guarda la decisión en la misma transacción. `tunnel_undo` revierte y marca `undone_at`. Los lotes viajan como `tunnel.batch` y se revierten en orden inverso. Las funciones de los handlers no se exponen: solo las llama el despachador (`security definer`).

### Reglas aprendidas

- Nacen en «Explícale a la IA qué pasa» con la casilla «Recordar esto como regla» (marcada por defecto). Quedan `ACTIVE` de inmediato; la descripción son las palabras de la persona.
- La condición es `{ all: [{ fact, op, value }] }` sobre `TunnelCase.facts`. Operadores: `eq`, `neq`, `in`, `contains`, `startsWith`, `gte`, `lte`, `between`. Comparan sin mayúsculas ni acentos.
- El resultado (`outcome.action`) nunca guarda los identificadores del registro: lo que va en `TunnelCase.subject` (por ejemplo `{ line_id }`) se toma del caso al que se aplica.
- Una regla solo cambia la propuesta; nunca aplica sola. La vista manual del proceso debe usar `matchRule`/`applyRules` con los mismos `facts`.
- Modo «requiere aprobación del dueño»: preparado y apagado (`tunnel_settings.rules_require_approval`). Quien no tenga `tunnels.rules.manage` crea reglas `PENDING_APPROVAL`.

### IA

- `POST /api/tunnels/<key>/explain` con la sesión del usuario (cabecera `Authorization`). Guarda la explicación como decisión `NO` (`tunnel_explain`), corre la IA y registra la corrida en `tunnel_ai_runs` (sin claves).
- Variables en Railway: `ANTHROPIC_API_KEY` (obligatoria para la IA) y `TUNNEL_AI_MODEL` (por defecto `claude-sonnet-5-5`). Tiene activado el reintento del servidor con otro modelo si este rechaza el caso (`fallbacks: "default"`).
- Máximo 3 rondas de herramientas y 30 s. La respuesta llega por la herramienta estricta `proponer_solucion` y se valida: una acción que el caso no permite se descarta.
- El system prompt deja claro que las descripciones bancarias, los nombres y las facturas son datos, no instrucciones.
- Sin clave o con error: «No pude buscar una solución. Elige o escribe la respuesta», y se ofrecen las opciones o el dato del caso.

## Ejemplo mínimo

```ts
// lib/tunnels/precios.ts
import type { TunnelDefinition } from "./types";

export const preciosTunnel: TunnelDefinition = {
  key: "precios",
  title: "Precios faltantes",
  description: "Artículos con existencia y sin precio",
  permission: "tunnels.precios",
  manualHref: "/inventory",
  coverTitle: "Vamos a ponerle precio a lo que falta",
  backend: "supabase",
  async coverLines(ctx) { return ["Revisé el inventario con existencia."]; },
  async buildCases(ctx) {
    const { data } = await ctx.supabase!.rpc("articulos_sin_precio");
    return (data || []).map((a: { id: string; nombre: string; sugerido: number }) => ({
      id: `precio:${a.id}`, level: "confirm", confidence: 0.8,
      eyebrow: a.nombre, headline: `${a.sugerido} USD`, question: "¿Le pongo este precio?",
      context: ["Costo × 1,35"], facts: { nombre: a.nombre }, subject: { item_id: a.id },
      proposal: { type: "precios.set_price", payload: { item_id: a.id, price: a.sugerido }, label: "Sí, poner el precio" },
      input: { label: "Precio en USD", type: "money", action: "precios.set_price", basePayload: { item_id: a.id } },
    }));
  },
  async balance(ctx) { return { ok: true, title: "Artículos sin precio", total: "0", rows: [] }; },
  aiInstructions: "Ayudas a poner precios a artículos del inventario.",
  aiTools: [],
};
```

```sql
-- Migración aditiva del proceso
create function lubricenter_private.precios_set_price(p jsonb) returns jsonb ...;   -- devuelve {item_id, previous, version}
create function lubricenter_private.precios_unset_price(r jsonb) returns void ...;  -- falla si la versión cambió
revoke all on function lubricenter_private.precios_set_price(jsonb), lubricenter_private.precios_unset_price(jsonb) from public, anon, authenticated;
insert into lubricenter_private.tunnel_action_handlers(action_type, tunnel_key, apply_fn, revert_fn, permission)
values ('precios.set_price', 'precios', 'lubricenter_private.precios_set_price', 'lubricenter_private.precios_unset_price', 'catalog.manage');
insert into public.staff_permission_catalog(key, area, label, explanation, recommended, sort_order)
values ('tunnels.precios', 'Túneles', 'Túnel de precios faltantes', 'Poner precios desde el túnel', false, 63) on conflict do nothing;
```

Luego se agrega `preciosTunnel` en `lib/tunnels/registry.ts`.

## Lista de verificación para un túnel nuevo

1. Migración aditiva (skill `supabase-migracion-segura`): handlers `apply`/`revert` que validan el permiso del proceso y fallan con un mensaje claro si el revert ya no es posible. Se aplica primero en una rama, luego `get_advisors`, y después producción.
2. Permiso `tunnels.<key>` en `staff_permission_catalog`.
3. `buildCases` devuelve casos con `id` estable, el escalón más bajo posible, `facts` para reglas y `subject` con los identificadores. Un caso ya resuelto no vuelve a salir.
4. `balance` termina en un número de control; si no cuadra, `diff` en rojo (no se puede cerrar sin explicar).
5. `aiTools` de solo lectura (nada de SQL libre) y `aiInstructions` cortas.
6. La vista manual del proceso usa las mismas reglas (`applyRules`).
7. Pruebas: unitarias del generador de casos y prueba PGlite de los handlers (aplicar, revertir y revert imposible).
8. Revisar en un teléfono de 390 px y en PC, en modo claro y noche.

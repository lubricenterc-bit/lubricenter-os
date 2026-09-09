# Lubricenter OS — Build 0.1

Primer build funcional del núcleo operativo de Lubricenter.

## Qué incluye

- PWA mobile-first en Next.js.
- Login con Supabase Auth.
- Órdenes automáticas `OS-000001`, `OS-000002`, etc.
- Una orden puede mezclar productos, taller, electroauto y otros servicios.
- Productos con doble valoración:
  - precio interno en USD físico;
  - precio comercial en Bs usando tasa operativa/P2P;
  - REF calculado usando BCV.
- El precio especial en USD físico queda oculto por defecto y solo se revela cuando se activa explícitamente.
- Pagos mixtos en VES y USD físico.
- Taller:
  - Cheo 40% estructural;
  - Lubricenter 60%;
  - bono meritorio Alexis 5% opcional, financiado por Lubricenter.
- Electroauto:
  - Alexis 40%;
  - Lubricenter 60%.
- Deducciones de nómina modificables: insumos, adelanto, deuda u otro.
- Sueldo fijo semanal de Alexis versionado como regla (seed actual: $60).
- Las reglas se guardan por vigencia; no están hardcodeadas en la interfaz.
- Cierre de orden transaccional en PostgreSQL.
- Outbox `integration_events`: n8n se ejecuta después de la transacción y no puede romper caja/nómina.
- Historial inmutable de tasas y snapshots monetarios por item/pago.
- Tests de reglas de precio y reparto.

## Lo que NO debe reemplazarse todavía

Este build es paralelo al sistema actual. No apagues Google Forms, Sheets, Notion, catálogo GitHub ni workflows n8n de producción.

## 1. Preparar Supabase

Ya debes tener un proyecto nuevo de Supabase para desarrollo.

### Ejecuta la migración

En **Supabase → SQL Editor → New query**, copia y ejecuta:

`supabase/migrations/001_core.sql`

Luego ejecuta:

`supabase/seed.sql`

El seed crea:

- Santiago, Cheo y Alexis;
- reglas actuales de Cheo/Alexis;
- tasas demo basadas en el ejemplo usado durante el diseño;
- tres productos de prueba.

**Antes de usar datos reales**, entra a Configuración dentro de la app y coloca las tasas reales del día.

## 2. Crear tu usuario

En **Supabase → Authentication → Users**, crea tu usuario de prueba con email y contraseña.

No pongas credenciales dentro del repositorio.

## 3. Variables de entorno

Copia:

```bash
cp .env.example .env.local
```

Completa solo:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Usa la **anon/publishable key**, nunca la `service_role` en el frontend.

## 4. Ejecutar la app

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## 5. Primera prueba recomendada

Entra a **Config** y confirma tasas.

Luego crea una orden con:

1. Producto Bandol de prueba.
2. Trabajo Taller de $100 con bono Alexis activo.
3. Trabajo Electroauto de $40.
4. Agrega pagos hasta cubrir exactamente el total.
5. Presiona **Cobrar y cerrar**.

Resultado esperado:

- orden queda `CLOSED`;
- Cheo obtiene 40% del trabajo de taller;
- Alexis obtiene 5% opcional del taller y 40% del electroauto;
- se crean devengos pendientes en Nómina;
- se crea un evento `order.closed` en `integration_events`;
- el cambio posterior de tasas no modifica la orden.

## Modelo monetario del build

### Producto

```text
precio USD físico interno
        × tasa operativa
        ↓
precio Bs
        ÷ BCV
        ↓
REF comercial
```

La cotización normal muestra **REF + Bs**. El valor USD físico interno no se muestra a menos que se active explícitamente.

### Pago

- VES conserva el monto original en Bs.
- USD físico se valora a la tasa operativa vigente en el momento del pago.
- El pago conserva tasa, moneda y monto originales.

## Regla de taller

Base estándar:

```text
Cheo         40%
Lubricenter  60%
```

Bono opcional de Alexis:

```text
Cheo         40%
Alexis        5%
Lubricenter  55%
```

El bono de Alexis se puede apagar sin modificar la parte de Cheo.

Si un descuento invade la participación protegida de Cheo, la app obliga a abrir **Ajustar reparto excepcional** y registrar una parte de Cheo menor de forma explícita.

## Regla de electroauto

```text
Alexis       40%
Lubricenter  60%
```

Los trabajos de Alexis como ayudante mecánico no generan ese 40%.

## Nómina

Los trabajos cerrados generan `payroll_accruals`. Una liquidación semanal consume solo los devengos y ajustes que aún no han sido liquidados. Además, el sistema bloquea períodos de nómina solapados para evitar pagar dos veces el sueldo fijo.

Deducciones actuales:

- insumos;
- adelanto / préstamo;
- deuda;
- otro.

## Seguridad de Build 0.1

- Tablas financieras: lectura autenticada.
- Escrituras críticas: solo mediante funciones RPC transaccionales.
- No se expone `service_role`.
- n8n no participa en el cierre financiero.

## Próximo build (0.2)

1. Cliente + vehículo en la orden sin volverlos obligatorios.
2. Crédito LC con historial de abonos, no eliminación de deuda.
3. Cashea y sus 3 cuotas quincenales hacia BNC.
4. Caja y cuentas bancarias.
5. Importador de catálogo real.
6. Edición visual versionada de reglas de compensación.
7. Sincronización opcional a una hoja `OS_EXPORT` para comparar contra el legacy.

## Estructura

```text
app/                    PWA / pantallas
components/             UI funcional
lib/domain/             reglas puras y testeables
supabase/migrations/    esquema versionado
supabase/seed.sql       datos demo
public/                 manifest + service worker
tests/                  pruebas de reglas y regresión
```

## Regla de operación durante el piloto

**Lubricenter OS no sustituye todavía al sistema anterior.** Primero se prueba con órdenes falsas y luego con un piloto paralelo. El cambio a producción solo ocurre cuando caja y nómina cuadren contra el sistema actual.

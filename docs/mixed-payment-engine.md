# Motor de pagos mixtos: entrega 1

Estado: implementación aislada en rama `codex/mixed-payment-engine`. No está conectado a cobros ni desplegado. Los cobros productivos conservan el comportamiento anterior hasta completar la integración SQL, formularios y nómina.

## Contrato implementado

`lib/finance/settlement.ts` calcula únicamente con Decimal y strings:

- Componentes USD_FIXED, USD_REF_BCV y VES_FIXED, con principal, cobertura y financiación separados.
- Múltiples recepciones USD/Bs asignadas a componentes concretos; ninguna tasa global operativa.
- Acuerdo 1:1, tasa preferencial congelada o intercambio exacto con ID y capacidad de uso acumulada.
- Recibido, aplicado y sobrante por moneda; excess digital rechazado con mensaje de anticipo explícito.
- Comisión de Cheo: 40 % del dinero aplicado a su mano de obra, en la moneda recibida; acumulación evita ganancia por fragmentación.
- Cobertura acumulada por grupo de conversión para evitar sumar redondeos de fragmentos.
- Cierre de importe exacto a centavos con residual firmado separado del beneficio comercial.
- Reserva de financiación sin entrada de dinero; propuesta Cashea de inicial y cuotas con último residual exacto.
- Resumen con cantidades nativas, bases contractuales distintas y propiedad propia/tercero/sin resolver.

`quoteCollection` es una función pura: devuelve nuevo estado y aplicaciones; no escribe ni muta sus entradas. No es una autorización para registrar dinero. `commissionPaid` expresa la comisión acumulada calculada por el motor, no prueba que el trabajador ya recibió su pago. Al integrar SQL debe mapearse a acumulado devengado y conservar pagos/liquidaciones aparte.

## Confianza y persistencia al integrar

El cliente no puede proporcionar su propio principal, saldo, clasificación o trabajador al confirmar. El servidor carga componentes, capacidad utilizada, tasas y reglas desde filas protegidas. `CHEO_COLLECTION` solo puede asignarse al empleado identificado por el código CHEO existente y a sus servicios; los productos no obtienen comisión por portar un campo del cliente.

El servidor debe persistir las aplicaciones y sus grupos acumulados en la misma transacción con dinero/financiación, o reconstruirlos desde aplicaciones vigentes. No confiar en balances cacheados enviados por el navegador. `exactAgreements` devuelve utilización total por ID, incluida la previa; no sumar otra vez esa cifra a la utilización existente. La comparación de solicitud se hace con payload canónico y versión de orden/tasa/acuerdo.

Las fechas y fuentes de tasas, permissions/RLS, reservas concurrentes, idempotencia, regresiones de caja/inventario, reversión y clasificación económica son responsabilidades de la siguiente entrega. No afirmar que este módulo las garantiza por sí solo. Rechazar excepciones laborales protegidas ajenas al modo CHEO hasta incorporar su política explícita.

## Siguiente entrega

1. Resolver política de saldo REF entre días. Producto externo confirmado como compra/reventa propia: registrar costo por separado. No volver a preguntar esa clasificación ni la regla de Cheo.
2. Crear migración aditiva de acuerdos/aplicaciones/financiación/cotizaciones con constraints y FK del contrato aprobado.
3. Implementar cotización autoritativa y confirmación atómica con permisos, UUID, versiones y auditoría; paridad SQL/Decimal y pruebas de dos conexiones PostgreSQL.
4. Conectar creación por línea, cobro por destino, Cashea parcial, Crédito LC, recibo y nómina a una proyección única.
5. Habilitar v3 solo con todas sus rutas críticas listas; preservar historia, impedir endpoints legados sobre órdenes v3. Pruebas operativas PC/móvil y aprobación de entrega antes de main/despliegue.

Los datos bancarios y de clientes no aparecen en fixtures. Las tasas 100/120/130 de pruebas son sintéticas; 40 % de Cheo está confirmado por el dueño. Build con valores públicos ficticios acredita compilación, no conexión/auth de producción.

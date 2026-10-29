# Conciliación Cashea por sucursal

Ruta: `/cashea/conciliacion` (solo dueño y administrador). Reemplaza el Excel `Cashea_Cabudare_vs_Afuera.xlsx`.

## Problema
Cashea tiene una sola tienda para todas las sucursales (Cabudare, Norte, La Morán y otras) y las cuotas, más algunas iniciales, caen en la cuenta BNC ***4493. Cada pocos días se retira dinero. El módulo dice, desde el último **cero** (saldo BNC < 10.000 Bs después de un retiro), cuánto entró de cada sucursal, cuánto retiró cada una y cuánto le toca hoy.

## Uso (cada ~3 días)
1. Subir juntos: estado de cuenta BNC (`Rpt*.xls`, Excel 97), export de pagos Cashea (`export_*.xlsx`) y export de órdenes (`ordenes_*.xlsx`). Opcional: pegar el texto del BDV de Cabudare.
2. **Cargar reportes**. Los archivos pueden solaparse: las líneas BNC se identifican por (fecha, referencia sin ceros, debe, haber, saldo) y las órdenes Cashea quedan con su versión más reciente.
3. Revisar corte, por cobrar y excepciones; reasignar a mano lo necesario.
4. **Actualizar el OS**: marca en finanzas los cobros de otras sucursales (`OTHER_LOCATION`, cierra los casos de propiedad en la siguiente reconciliación), marca pagadas/parciales las cuotas de Cabudare según el export de órdenes (sin crear pagos: el dinero está en el BNC) y ejecuta `finance_reconcile`.
5. Cuando un retiro deja el BNC por debajo de 10.000 Bs, **Marcar nuevo cero**. El resumen del período se guarda y el siguiente arranca desde ahí. **Exportar Excel** baja Resumen, Pagos BNC, Retiros, Órdenes, Excepciones y BDV.

## Reglas de propiedad (en orden; la reasignación manual gana siempre)
1. `# Orden` está en `cashea_sales.cashea_reference` → Cabudare (manda sobre la factura).
2. Factura `OS-` → Cabudare. 3. Factura de 5 dígitos 01975–02109 → Cabudare.
4. `NT…` → Norte; `LM…` → La Morán.
5. Facturas 2007/2008, o sin factura antes del 22/09 → Por confirmar.
6. Lo demás → Afuera (sin nomenclatura).

## Cómo se identifica cada abono del BNC
1. Referencia bancaria = `# Referencia` del export de pagos (sin ceros a la izquierda). Si una transferencia paga varias órdenes, se reparte por monto.
2. Pago del OS (transferencia) con los últimos 4 dígitos, ±1 día → inicial de Cabudare (excepción si el OS lo registró como BDV o con otro monto).
3. `Pago en caja` (USD) × tasa Cashea del día ≈ monto (±0,5 USD), ±1 día de la compra.
4. "GRUPO CASHEA" → liquidación sin desglose (Por confirmar).
5. Resto → sin identificar (Por confirmar).

Retiros: por cédula del destino (tabla editable; V-30881436 → Cabudare, V-12306298 → Afuera sin asignar). La comisión sigue al retiro con la misma referencia. Los pagos a otras sucursales desde el BDV de Cabudare se registran como **ajuste entre sucursales** (a favor de Cabudare, a cargo de quien recibió).

## Correcciones con un "Sí"
Cada excepción corregible muestra lo que va a cambiar y se aplica solo después de **Sí, corregir** (auditado):
- **Corregir** (pago del OS que cayó en el BNC, o con otra referencia): mueve el pago y su movimiento a la cuenta BNC y guarda la referencia completa del banco. Exige que coincidan la fecha (±1 día) y la referencia (últimos 4) o el monto exacto. El monto no cambia (`cashea_conc_fix_payment`).
- **Vincular**: corrige la referencia Cashea de la venta del OS.
- **Asignar**: asigna la orden Cashea a la sucursal sugerida.
- **Revisar** (monto del OS distinto al del banco): abre la corrección manual, porque hay que decidir si es sobrepago, vuelto o un total mal cargado.

## Control
La fila de control compara: saldo del cero + Σ(le toca) = saldo BNC del último movimiento. Una diferencia (en rojo) significa que falta un reporte o hay un salto en la cadena de saldos.

## Datos
Tablas nuevas: `cashea_branches`, `cashea_bnc_lines`, `cashea_conc_imports`, `cashea_ownership_overrides`, `cashea_branch_adjustments`, `cashea_cutoffs`, `cashea_withdrawal_destinations`. Pagos y órdenes de Cashea y el BDV siguen entrando por `finance_import` (`external_transactions`, `cashea_order_snapshots`). La clasificación vive en `lib/cashea-conciliation/engine.ts` (pura, con pruebas). Las correcciones de método o monto de una inicial usan la pantalla existente `/orders/[id]/correct-payment`; la corrección de referencia Cashea queda auditada (`cashea.reference_corrected`).

## Recomendación operativa
Pedir a cada sucursal que escriba la factura en Cashea con su prefijo exacto (`OS-000xxx`, `NT-`, `LM`) y registrar en el OS los iniciales que caen en el BNC como `TRANSFER_BNC`.

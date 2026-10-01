# Balance comercial Cashea

## Hechos distintos

1. La venta conserva su importe íntegro. `cashea_sales.commission_ref` es una expectativa contractual sin IVA; no prueba facturación ni descuento.
2. La factura de servicio registra período, ventas informadas, porcentaje, servicio, IVA, ISLR retenido y total a descontar. No crea pagos ni movimientos bancarios.
3. El balance comercial registra apertura, cuotas asumidas por Cashea, descuentos documentados, transferencias al comercio y ajustes. Una factura no genera un descuento automáticamente.
4. El abono bancario es evidencia independiente. Un comprobante de Cashea sin enlace bancario conserva el estado pendiente de banco.

Los pagos de clientes no pierden automáticamente el 4 %. El balance documentado se calcula como apertura + créditos de Cashea − descuentos de servicio − transferencias al comercio ± ajustes documentados. Se mantiene en referencia USD; no se suma dinero nativo Bs a USD.

## Reglas y controles

- El porcentaje y los importes reales se conservan. La interfaz sugiere 4 % y 16 % de IVA; el usuario confirma los valores del documento. El IVA queda separado del servicio: esta capa no decide si es gasto o crédito fiscal.
- Variaciones de cálculo mayores de USD 0,02 generan una excepción estable en Finance Inbox; no se sobrescribe ni se descarta el comprobante. La tolerancia cubre diferencias pequeñas de redondeo documental.
- La factura inicia con propiedad sin resolver. Se puede atribuir a Lubricenter o indicar cuenta compartida con motivo auditado; no se reparte entre locales sin evidencia.
- El descuento vinculado coincide exactamente con el total de la factura vigente. Se permite un único descuento activo por factura y una única apertura activa.
- Una apertura representa el saldo al inicio de su fecha. Los movimientos anteriores quedan en el historial y se excluyen del balance anclado. Sin apertura, el resumen se presenta como parcial.
- El resumen se calcula sobre todas las filas en SQL. El historial visible usa páginas de 25 facturas y 50 movimientos, con orden estable.
- Un enlace a banco exige ingreso propio, fuente bancaria, referencia y fecha coincidentes y equivalente USD con diferencia máxima de un centavo. Una fila del reporte de cobros Cashea no sirve como evidencia bancaria.
- Solicitudes repetidas conservan el mismo ID. Reutilizar una solicitud con otros datos se rechaza; duplicados económicos se previenen con índices únicos.
- Admin y dueño registran y revisan; solo el dueño establece aperturas, ajustes y reversiones. Operador no accede a esta evidencia.
- Correcciones conservan el registro y el motivo. Antes de anular una factura debe revertirse el descuento activo que la utiliza. Una anulación libera el registro económico para una versión corregida.

## Alcance del incremento

Ruta `/cashea/balance`, con acceso desde Cashea y Central financiera. La migración es aditiva y depende de Finance Core existente. No introduce ni altera datos financieros históricos en producción. Las muestras privadas no se guardan en Git; las pruebas usan identificadores sintéticos.

Esta capa conserva documentos y balance del aliado. No es un libro mayor fiscal ni publica asientos automáticos de gasto, cuentas por pagar o IVA. Los pagos directos de facturas deben reutilizar proveedores/egresos existentes cuando se añada su vinculación, evitando registrar también una salida ficticia por compensación.

Pendiente para el siguiente incremento: importador BNC del `.xls` real, vinculación posterior del comprobante de transferencia al banco, conciliación completa de liquidaciones y detalles de cuotas asumidas; importación de documentos PDF, controles del balance mensual y atribución de costos a ventas/locales. El cierre de septiembre se realizará cuando el usuario lo solicite, con reportes completos y corte respaldado.

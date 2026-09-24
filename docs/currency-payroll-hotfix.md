# Precio pactado y revisión de nómina

Rama aislada de Finance Core. No modifica liquidaciones históricas.

- Un servicio distingue REF BCV de USD pactado. Base y reparto usan la misma denominación; se conserva el equivalente contable y las tasas originales.
- La comisión corresponde proporcionalmente a los cobros de la orden, en la moneda de cada pago. No se atribuye arbitrariamente un pago a un servicio cuando una orden contiene varios ítems.
- Cada trabajo/cobro tiene identidad estable. Se puede pagar, posponer o excluir; cualquier ajuste requiere motivo e historial. Una liquidación conserva una copia del monto original y final.
- Los sueldos fijos y las deducciones existentes siguen separados en REF. No se suman Bs y USD como si fueran la misma moneda.
- Una anulación o eliminación de un cobro origina una reversión de la comisión liquidada, en su moneda original, en vez de borrar el recibo anterior.
- Revisar antes de publicar: cobros mixtos, crédito parcial, reintentos, concurrencia, tasas diferentes, permisos, cancelación, y recibos de 58 mm.

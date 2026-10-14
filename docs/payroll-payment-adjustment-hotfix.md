# Nómina: liquidación, pago, ajustes y reasignación auditada

## Fallas verificadas (producción, 14/10/2026)
- `public.payroll_review_adjustment` y `public.payroll_record_payment` son funciones públicas invoker que llaman funciones privadas cuyo permiso EXECUTE estaba revocado a `authenticated`. Guardar ediciones o registrar el pago terminaba en `permission denied for function`.
- La pantalla `/payroll` mostraba «liquidar» y ocultaba «pagar» en el recibo, aunque `payroll_runs.status='SETTLED'` no implica un pago real.
- Un ajuste positivo +$10 de Cheo, concepto «error en cobro de alternador», existía como no liquidado; no fue cambiado automáticamente por el hotfix.

## Controles
- Los tres wrappers existentes se cambian a `SECURITY DEFINER`; cada función interna valida `lubricenter_private.require_order_admin()`. Helpers privados permanecen sin permisos directos para anon/authenticated.
- **Bono:** importe positivo. **Descuento:** importe negativo con motivo y revisión legal. Ambos pueden editarse y dejarse en HOLD o EXCLUDE sin borrar el histórico.
- **Transferencia propuesta:** dos ajustes vinculados Cheo −$10 / Alexis +$10 se crean ambos en HOLD por defecto, sin impacto en la nómina ni caja. Se pueden aprobar o descartar *los dos a la vez*, con evidencia, autorización administrativa y comprobación de procedencia legal. No se permite editar unilateralmente uno.
- `LIQUIDAR`: fija obligaciones por empleado, sin mover dinero. `REGISTRAR PAGO`: desde el recibo, selecciona cuenta, fecha, importe parcial o total y referencia; hace un movimiento de caja real solo al confirmar.
- Todas las acciones modificatorias están auditadas. Las liquidaciones históricas y pagos reales no son reescritos.

## Caso Cheo/Alexis
Trabajo valorado en $40, cobro real $30, diferencia $10. Esta diferencia *es inicialmente un asunto comercial y de facturación*, no una deuda salarial automática del empleado. La LOTTT protege salarios y comisiones. Consultar con asesor laboral antes de convertirlo en descuento. Si no procede, se puede pagar el bono a Alexis como gasto de la empresa y mantener la diferencia fuera del salario de Cheo.

## Verificación y despliegue
1. Confirmar copia/snapshot de payroll_adjustments, payroll_runs y payroll_payments antes de migrar.
2. Ejecutar migration `20261014193000_payroll_adjustments_payment_facades.sql`.
3. Verificar SECURITY DEFINER y GRANT en wrappers, RLS y permiso de ejecución de funciones internas.
4. Comprobar que el conteo de adjustments, payroll_runs, payroll_payments y account_movements no cambió por el despliegue.
5. En interfaz, crear/editar/excluir un **borrador de prueba en un entorno de pruebas**; liquidar un período terminado con importes aprobados; registrar pago solamente en banco de prueba.
6. Probar ajuste vinculado HOLD con cantidad $10, neto cero; no aplicarlo a empleados reales sin revisión.
7. Mantener separadas las fallas de tests/currency-payroll.test.ts y las pruebas históricas de caja: algunas usan fixtures obsoletas (created_at).

## Rollback
La migración no crea movimientos financieros ni altera registros de nóminas previas. No revertir indiscriminadamente las nuevas columnas `transfer_id` si ya existen propuestas. Ante fallas, deshabilitar UI de nuevas transferencias, corregir wrappers y preservar evidencia y auditoría.

# Campos numéricos: `<NumberField>`

Todos los números de la app se escriben en `components/number-field.tsx`. Queda prohibido `type="number"`: `tests/no-native-number-inputs.test.ts` falla si aparece uno en `app/` o `components/`.

## Reglas (decisión del dueño D-01)

- **Flechas, botones y rueda:**
  - ↑/↓ suben o bajan de **1 en 1**, o de 10 en 10 con Shift;
  - los botones − / + hacen lo mismo y se activan con `steppers`;
  - nunca ponen decimales: 1,5 + 1 = 2,5;
  - la rueda del ratón no cambia el valor, porque el campo es `type="text" inputMode="decimal"`.
- **Decimales:** solo entran escritos, con coma o con punto (`lib/number-input.ts`, `parseLocaleNumber`):
  - `1.234,56` y `1,234.56` → 1234,56: el último separador que aparece es el decimal;
  - `12,5` → 12,5;
  - `1.500` → 1500: un punto seguido de grupos de 3 cifras es de miles;
  - `17.5` → 17,5;
  - se ignoran `$`, `Bs`, `%` y los espacios.
- **Mientras escribes y al salir:** con el foco se ve lo que escribes; al salir del campo se formatea en es-VE y se guarda redondeado.
- **Valor inválido:** si es inválido o está fuera de `min`/`max`, el borde se pone rojo, aparece un mensaje y no se guarda.

## Qué `kind` usar

| `kind` | Para | Decimales |
|---|---|---|
| `qty` (por defecto) | Cantidades, litros, kilómetros, días | 3 |
| `money` | Montos en $ o Bs | 2 |
| `rate` | Tasas de cambio | 4 |
| `percent` | Porcentajes (descuento, recargo) | 2 |

Para años o códigos usa `grouping={false}`, que quita el separador de miles. En el cobro y el vuelto (`components/tender-fields.tsx`) solo cambió el campo: la validación de montos es la misma de antes.

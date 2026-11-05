# Ingresar mercancía

La factura del proveedor y la entrada al inventario se registran en un solo paso.

## Dónde está

- **Inventario:** el botón principal «Ingresar mercancía».
- **Compras y proveedores** (`/expenses`): la pestaña Facturas.
- **Ficha del proveedor** (`/suppliers/[id]`): la sección «Marcas que trae», que guarda las marcas del proveedor con `supplier_brands_set`.

## Pasos (`components/purchasing/goods-entry-sheet.tsx`)

1. **Proveedor:** se busca, o se crea con «+ Nuevo proveedor». Se ven sus marcas.
2. **Factura:** número, fecha, vencimiento y moneda (por defecto, la del proveedor).
3. **Líneas:** el buscador `item-picker` es un combobox escribible, nunca un `<select>`. Llama a `purchasing_item_search` y:
   - busca sin acentos ni mayúsculas en código, nombre, descripción, marca y códigos alternos, con todas las palabras;
   - arriba muestra los chips de las marcas del proveedor y, debajo, los de rubro;
   - marca con «Ya se lo compraste» lo que ya se le compró a ese proveedor;
   - si no encuentra nada, ofrece «+ Crear artículo», que crea el artículo con `needs_review`.
4. **Totales:** impuesto, flete y descuento.
5. **«La mercancía ya llegó completa»:** viene marcada, con la sede.
6. **Confirmación:** muestra «+12 Valvoline 15W-40 (de 3 a 15)» y el total, y registra.

Si se cierra la hoja, el borrador queda en `sessionStorage`.

## Qué hace la base

`public.purchase_invoice_and_receive` (privada, con `require_order_admin`):

- **Idempotente:** el mismo `request_id` con los mismos datos devuelve el mismo resultado; con otros datos, da error (`purchase_invoice_requests`).
- **Factura repetida:** rechaza el mismo número de factura del mismo proveedor (no anulada).
- **Recepción:** con «ya llegó completa», recibe todas las líneas de inventario con `inventory_receive_purchase`. Escribe movimientos `PURCHASE` y actualiza el costo promedio y el último costo.

## Costo promedio

- **Con costo conocido:** promedio ponderado `(existencia × costo actual + cantidad × costo de factura) / total`.
- **Sin costo conocido** (costo 0 o marcado sin costo): el costo promedio pasa a ser **el costo de la factura**. Antes se promediaba con cero; se corrigió el 5 nov 2026 (`purchase_cost_no_dilution`).
- La recepción parcial posterior sigue en la factura (`purchase-receive-sheet.tsx`) y prellena la cantidad pendiente.

## Marcas

- La lista sale de los artículos (`purchasing_brands`), agrupada por `lubricenter_private.brand_key`: mayúsculas, sin acentos y sin símbolos.
- El 5 nov 2026 se unificaron Fanfaro, Lirax, Millard, Vega y Voltex, y FILTRO/REFRIGERANTE pasaron a Qualid/Servilub (`inventory_brand_cleanup`, con auditoría).

/**
 * Ayuda para el equipo: «¿Cómo hago…?» con el camino exacto y un botón que lleva a la función.
 * Cada `href` es una pantalla real (lo comprueba tests/help-topics.test.ts).
 */
export type HelpArea = "venta" | "ordenes" | "taller" | "cobros" | "clientes" | "inventario" | "caja" | "dueno" | "app";

export type HelpTopic = {
  id: string;
  area: HelpArea;
  question: string;
  /** Pasos cortos, en el orden en que se hacen. */
  steps: string[];
  href: string;
  cta: string;
  /** Palabras con las que alguien lo buscaría. */
  keywords: string;
  ownerOnly?: boolean;
  shortcut?: string;
};

export const HELP_AREAS: { id: HelpArea; label: string }[] = [
  { id: "venta", label: "Vender y cotizar" },
  { id: "ordenes", label: "Órdenes y cambio de aceite" },
  { id: "taller", label: "Taller" },
  { id: "cobros", label: "Cobros, Cashea y crédito" },
  { id: "clientes", label: "Clientes y seguimiento" },
  { id: "inventario", label: "Inventario y compras" },
  { id: "caja", label: "Caja y cierre" },
  { id: "dueno", label: "Administración" },
  { id: "app", label: "Usar la app" },
];

export const HELP_TOPICS: HelpTopic[] = [
  // Vender y cotizar
  { id: "venta-rapida", area: "venta", question: "¿Cómo hago una venta de mostrador?", shortcut: "F2", href: "/quick-sale", cta: "Abrir Venta rápida",
    keywords: "vender venta mostrador ticket producto cobrar facturar",
    steps: ["Presiona F2 o toca Vender en el inicio.", "Busca por nombre, código, marca o viscosidad; Enter agrega el primero.", "Ajusta cantidad o precio en el ticket si hace falta.", "Elige la forma de pago, escribe la referencia si es pago móvil y marca «Confirmo que recibí el pago».", "Toca «Registrar y cerrar venta»."] },
  { id: "vuelto", area: "venta", question: "¿Cómo cobro en efectivo y registro el vuelto?", href: "/quick-sale", cta: "Abrir Venta rápida",
    keywords: "vuelto cambio efectivo billetes dolares bolivares precio pactado usd",
    steps: ["Arma el ticket en Venta rápida.", "Elige Efectivo Bs o Efectivo USD y toca «Cobro con vuelto o precio pactado USD».", "Escribe lo recibido o toca los billetes (+5, +10…).", "Indica el vuelto que entregas y en qué moneda; si queda vuelto pendiente, escribe a quién.", "Marca la confirmación y toca «Cobrar y cerrar venta»."] },
  { id: "cotizar", area: "venta", question: "¿Cómo hago una cotización sin crear una orden?", shortcut: "F4", href: "/quote", cta: "Abrir el cotizador",
    keywords: "cotizar cotizacion presupuesto precio whatsapp compartir cliente",
    steps: ["Presiona F4 o toca Cotizar en el inicio.", "Agrega productos y servicios; el total sale en Bs, REF y divisas.", "Toca «Compartir con el cliente» para enviarla por WhatsApp.", "Cuando acepte: «Pasar a venta rápida» o «Continuar como orden»."] },
  { id: "comparar-aceites", area: "venta", question: "¿Cómo comparo aceites para un cliente?", href: "/quote/oil", cta: "Abrir el comparador",
    keywords: "aceite comparar viscosidad mineral semisintetico sintetico litros galon marcas",
    steps: ["Entra a Ventas › Comparador de aceites.", "Elige viscosidad, tecnología y litros.", "Muestra al cliente las marcas lado a lado y pasa la elegida a la cotización."] },
  { id: "descuento", area: "venta", question: "¿Cómo aplico un descuento o redondeo el total?", href: "/quick-sale", cta: "Abrir Venta rápida",
    keywords: "descuento rebaja redondeo redondear entero pin dueño",
    steps: ["Con productos en el ticket, busca «Ajustar el total en $».", "Redondea hacia abajo, a 0,50 o hacia arriba con un toque.", "Para un descuento, elige el porcentaje y el motivo.", "Si supera el tope permitido, el sistema pide el PIN del dueño."] },
  { id: "cotizacion-a-venta", area: "venta", question: "¿Cómo paso una cotización a venta?", href: "/quote", cta: "Abrir el cotizador",
    keywords: "cotizacion convertir pasar venta orden",
    steps: ["Arma la cotización en el cotizador.", "Toca «Pasar a venta rápida», o «Continuar como orden» si hay vehículo o trabajo de taller.", "Revisa los precios actuales y cobra como siempre: nada se registra hasta que confirmes."] },

  // Órdenes y cambio de aceite
  { id: "cambio-aceite", area: "ordenes", question: "¿Cómo registro un cambio de aceite?", href: "/orders/new?start=oil", cta: "Nuevo cambio de aceite",
    keywords: "cambio aceite filtro vehiculo placa kilometraje crm",
    steps: ["En el inicio toca «Cambio de aceite».", "Busca o crea el cliente y su vehículo (la placa se pide cuando hay cambio de aceite).", "Toca «+ Cambio de aceite · seleccionar vehículo» y elige aceite, litros y filtro del inventario.", "Si el cliente trae su aceite o filtro, márcalo: la mano de obra sale gratis solo si compra aquí al menos el 85 % del cambio.", "Cobra y cierra; el cambio entra solo al seguimiento del cliente."] },
  { id: "orden-taller", area: "ordenes", question: "¿Cómo abro una orden de taller o electroauto?", shortcut: "F3", href: "/orders/new?start=workshop", cta: "Nueva orden de taller",
    keywords: "orden taller mecanica electroauto cheo alexis mano de obra recibir vehiculo",
    steps: ["En el inicio toca «Trabajo de taller» (Cheo) o «Electroauto» (Alexis). F3 abre una orden en blanco.", "Asocia el cliente y el vehículo.", "Toca «+ Taller / electroauto» para la mano de obra y «+ Aceite / producto» para lo que se use.", "Si compraste algo afuera para el trabajo, usa «+ Compré algo para este trabajo»: el cliente lo paga y solo el recargo es ganancia."] },
  { id: "buscar-orden", area: "ordenes", question: "¿Cómo encuentro una orden?", href: "/orders", cta: "Abrir Órdenes",
    keywords: "buscar orden numero placa cliente telefono consultar historial dia periodo",
    steps: ["Entra a Ventas › Órdenes.", "Elige el período (Hoy, Ayer, Esta semana…) y escribe número, nombre, teléfono o placa.", "Toca una orden para verla al instante; con ↑ y ↓ pasas a la siguiente.", "Al abrirla y volver, la lista queda donde la dejaste."] },
  { id: "convertir-cambio", area: "ordenes", question: "Vendí aceite y filtro sueltos y era un cambio de aceite, ¿qué hago?", href: "/orders", cta: "Abrir Órdenes",
    keywords: "convertir cambio aceite suelto filtro orden error",
    steps: ["Abre la orden.", "Si detecta aceite de motor y filtro, ofrece «Registrar como cambio de aceite».", "Confirma: las líneas se reemplazan sin duplicar el stock y el cambio entra al seguimiento al cerrar."] },
  { id: "recibo", area: "ordenes", question: "¿Cómo imprimo el recibo de 58 mm?", href: "/orders", cta: "Abrir Órdenes",
    keywords: "recibo imprimir ticket 58 mm nota entrega impresora",
    steps: ["Abre la orden cerrada.", "Toca «Ver / imprimir recibo».", "Imprime: sale solo lo del cliente, en blanco y negro, sin menú."] },
  { id: "corregir-orden", area: "ordenes", question: "¿Cómo corrijo una orden ya cerrada?", href: "/orders", cta: "Abrir Órdenes",
    keywords: "corregir error cobro pago servicio rectificar anular",
    steps: ["Abre la orden cerrada.", "Usa «Corrección financiera de venta» para montos y pagos, o «Corregir servicio / CRM sin tocar cobros» para el servicio.", "Cada corrección queda en el historial de movimientos de la orden."] },
  { id: "anular-venta", area: "ordenes", question: "¿Cómo anulo una venta?", href: "/orders", cta: "Abrir Órdenes", ownerOnly: true,
    keywords: "anular devolver devolucion cancelar venta reverso reembolso arrepintio",
    steps: ["En Órdenes busca la venta y toca «Anular».", "Indica qué pasó con el dinero: se le devolvió al cliente o se queda como saldo a favor.", "Escribe el motivo y confirma: el inventario y el dinero se revierten solos.", "Si la venta se cobró con vuelto en efectivo, el sistema todavía no deja anularla: avísale al dueño."] },

  // Taller
  { id: "mover-vehiculo", area: "taller", question: "¿Cómo paso un vehículo a la siguiente etapa?", shortcut: "F6", href: "/workshop", cta: "Abrir el taller",
    keywords: "taller etapa diagnostico trabajo listo repuesto mover tablero",
    steps: ["Presiona F6 o toca Taller.", "En la tarjeta del vehículo toca el paso natural: «Pasar a diagnóstico», «Empezar trabajo», «Marcar listo» o «Llegó el repuesto».", "Para otra etapa, usa el selector de la tarjeta.", "En el teléfono, toca la etapa arriba o desliza de lado."] },
  { id: "entregar", area: "taller", question: "¿Qué hago cuando un vehículo está listo?", href: "/workshop#etapa-READY", cta: "Ver los listos",
    keywords: "listo entregar cliente avisar cobrar cerrar",
    steps: ["Avísale al cliente.", "En la columna Listos toca «Abrir orden».", "Cobra y cierra la orden: el vehículo sale solo del tablero como entregado."] },

  // Cobros
  { id: "cashea", area: "cobros", question: "¿Cómo cobro con Cashea?", href: "/quick-sale", cta: "Abrir Venta rápida",
    keywords: "cashea inicial cuotas financiar",
    steps: ["Cashea acepta compras desde REF 25.", "En Venta rápida elige «Cashea tradicional» y toca «Obtener número de orden para Cashea» (en una orden: «Cobrar con Cashea»).", "Usa ese número en Cashea antes de que el cliente pague.", "Registra la inicial recibida: la venta queda cobrada y las cuotas se siguen en Órdenes Cashea.", "El recargo de Cashea se agrega solo, sobre la mano de obra; no se escribe a mano."] },
  { id: "credito-lc", area: "cobros", question: "¿Cómo dejo un saldo a Crédito LC?", href: "/quick-sale", cta: "Abrir Venta rápida",
    keywords: "credito lc fiado deuda abono saldo pendiente",
    steps: ["En Venta rápida toca «Abono + saldo a Crédito LC» (en una orden: «Abono + saldo a Crédito LC»).", "Busca o crea el cliente que llevará la deuda.", "Registra lo que pagó hoy; el resto queda en REF BCV o en $ divisas según cómo pague.", "Confirma que recibiste el abono y cierra."] },
  { id: "abono", area: "cobros", question: "¿Cómo registro un abono de una deuda?", href: "/receivables", cta: "Abrir Crédito LC",
    keywords: "abono deuda credito pagar cuota cobrar recordar whatsapp",
    steps: ["Entra a Finanzas › Crédito LC.", "Busca al cliente y toca «Registrar abono» (o «La mitad»).", "Si pagó en Bs, baja la deuda en REF al BCV del día; si pagó en divisas, la baja en $.", "Para recordarle, usa «Recordar por WhatsApp»."] },
  { id: "pago-mixto", area: "cobros", question: "¿Cómo cobro con dos o más formas de pago?", href: "/orders", cta: "Abrir Órdenes",
    keywords: "pago mixto dos formas parcial combinado saldo a favor",
    steps: ["Desde Venta rápida toca «Saldo a favor / pago mixto / Crédito LC → continuar como orden».", "En la orden usa «+ Agregar pago» por cada forma de pago.", "Cuando lo pagado cubra el total, toca «Cerrar orden pagada»."] },
  { id: "saldo-favor", area: "cobros", question: "¿Cómo uso el saldo a favor de un cliente?", href: "/customer-balances", cta: "Ver saldos de clientes",
    keywords: "saldo a favor anticipo devolucion credito cliente",
    steps: ["Con el cliente asociado a la orden, elige «Saldo a favor · Bs a BCV» o «Saldo a favor · divisas».", "Toca «Aplicar saldo a la orden» y completa el pago si falta.", "Los anticipos y devoluciones se consultan en Finanzas › Saldos de clientes."] },
  { id: "vuelto-pendiente", area: "cobros", question: "¿Dónde veo los vueltos que quedaron pendientes?", href: "/change", cta: "Ver vueltos pendientes",
    keywords: "vuelto pendiente deber entregar cliente",
    steps: ["Entra a Finanzas › Vueltos pendientes.", "Ahí está cada vuelto por entregar con el nombre o teléfono del cliente."] },

  // Clientes y seguimiento
  { id: "buscar-cliente", area: "clientes", question: "¿Cómo busco un cliente o su vehículo?", href: "/customers", cta: "Abrir Clientes",
    keywords: "cliente buscar telefono cedula rif placa vehiculo historial ficha",
    steps: ["Entra a Clientes › Directorio.", "Escribe nombre, teléfono, cédula, RIF, placa, marca o modelo.", "Abre la ficha para ver vehículos, órdenes y saldo."] },
  { id: "seguimiento", area: "clientes", question: "¿A quién le escribo hoy?", href: "/crm", cta: "Abrir Seguimiento",
    keywords: "seguimiento crm whatsapp mensaje postservicio recordatorio hoy contactar",
    steps: ["Entra a Clientes › Seguimiento: el sistema elige a quién escribir hoy y prepara el mensaje.", "Toca «Abrir chat» y envíalo por WhatsApp.", "Anota qué pasó: «Sí, lo envié» o «No se envió»; si agenda, «Guardar cita».", "En «Esperando respuesta» quedan los que no han contestado."] },
  { id: "recuperar", area: "clientes", question: "¿Cómo recupero clientes que no han vuelto?", href: "/crm?tab=recover", cta: "Abrir Recuperar",
    keywords: "recuperar vencido no volvio cliente perdido tramo",
    steps: ["En Seguimiento abre la pestaña «Recuperar».", "Elige el tramo de días vencidos y toca contactar ese tramo (hay un tope diario).", "Cuando vuelva, marca «Ya volvió»."] },
  { id: "historial-servicio", area: "clientes", question: "¿Cómo veo los servicios anteriores de un vehículo?", href: "/service-history", cta: "Abrir el historial",
    keywords: "historial mantenimiento servicio anterior aceite placa factura vieja",
    steps: ["Entra a Clientes › Historial de mantenimiento.", "Busca por placa o cliente: salen los cambios del OS y los antiguos de Sheets."] },

  // Inventario y compras
  { id: "ingresar-mercancia", area: "inventario", question: "¿Cómo ingreso mercancía que llegó?", href: "/inventory", cta: "Abrir Inventario",
    keywords: "mercancia compra factura proveedor entrada llegada stock recibir",
    steps: ["Entra a Inventario y toca «Ingresar mercancía».", "Busca cada artículo por marca o rubro; si no existe, créalo ahí mismo.", "Escribe cantidad y costo, y la factura del proveedor.", "Guarda: la factura y la entrada al inventario quedan en un solo paso."] },
  { id: "nuevo-articulo", area: "inventario", question: "¿Cómo creo un artículo nuevo o le pongo precio?", href: "/inventory", cta: "Abrir Inventario",
    keywords: "articulo nuevo producto precio editar catalogo foto nombre",
    steps: ["En Inventario toca «Nuevo artículo», o «Editar» en uno existente.", "Escribe el nombre de venta, el precio en divisas y la foto si la tienes.", "Para varios a la vez, selecciónalos y toca «Poner precio».", "Con «Poner en el catálogo» aparece en el catálogo y en las cotizaciones."] },
  { id: "stock-insuficiente", area: "inventario", question: "Dice «Stock insuficiente» pero el producto está en el estante", href: "/inventory", cta: "Abrir Inventario",
    keywords: "stock insuficiente existencia no deja vender conteo ajustar negativo",
    steps: ["El sistema tiene menos unidades de las que hay.", "Si llegó mercancía, regístrala con «Ingresar mercancía».", "Si el conteo está mal, corrígelo desde el artículo en Inventario.", "Vuelve a cobrar."] },
  { id: "proveedores", area: "inventario", question: "¿Dónde veo compras, facturas y deudas con proveedores?", href: "/expenses", cta: "Abrir Compras",
    keywords: "proveedor factura compra deuda pagar egreso",
    steps: ["Entra a Inventario › Compras y proveedores.", "Ahí están las facturas, la mercancía recibida y lo que se debe."] },
  { id: "pagar-proveedor", area: "inventario", question: "¿Cómo pago una factura de un proveedor?", href: "/expenses", cta: "Abrir Compras", ownerOnly: true,
    keywords: "pagar proveedor factura abono abonar saldo dolares efectivo caja usd divisas",
    steps: ["Entra a Inventario › Compras y proveedores y abre la factura.", "Toca «+ Registrar pago» y elige la cuenta que paga.", "Toca «Usar este monto» para saldarla. Con dólares de caja el monto es menor que el saldo: los dólares se valoran a la tasa operativa y la factura va en REF a tasa BCV.", "Si pagas solo una parte, la pantalla te dice cuánto queda pendiente."] },

  // Caja y cierre
  { id: "cierre", area: "caja", question: "¿Cómo cierro la caja del día?", href: "/cash-close", cta: "Abrir el cierre",
    keywords: "cierre caja cuadre arqueo conteo efectivo dolares bolivares final del dia",
    steps: ["Entra a Finanzas › Cierre diario.", "Cuenta los dólares y bolívares físicos y toca «Guardar conteo».", "Toca «Cerrar con los conteos guardados».", "Si hace falta, «Imprimir resumen 58 mm». Bancos y Cashea se revisan aparte."] },
  { id: "salida-caja", area: "caja", question: "¿Cómo registro una salida o transferencia de caja?", href: "/cash", cta: "Abrir Caja",
    keywords: "salida egreso gasto transferencia caja cuenta movimiento",
    steps: ["Entra a Finanzas › Caja y movimientos.", "Elige la cuenta y registra la salida o la transferencia con su motivo."] },

  // Administración (dueño)
  { id: "ganancias", area: "dueno", question: "¿Cuánto ganó la tienda y cuánto el taller?", href: "/finance/profit", cta: "Abrir Ganancias", ownerOnly: true,
    keywords: "ganancia utilidad margen tienda taller hoy semana mes",
    steps: ["En el inicio, «Ganancia de hoy» muestra tienda y taller.", "Para otro período entra a Finanzas › Ganancias y elige Hoy, Semana, Mes o un rango.", "Toca cada área para ver de dónde salió."] },
  { id: "ventas-viejas", area: "dueno", question: "¿Cómo reviso ventas viejas mal clasificadas?", href: "/finance/profit/review", cta: "Revisar ventas viejas", ownerOnly: true,
    keywords: "revisar ventas viejas reclasificar linea tienda taller",
    steps: ["Entra a Finanzas › Ganancias › Revisar ventas viejas.", "Reclasifica cada línea sin tocar montos ni nómina."] },
  { id: "tasas", area: "dueno", question: "¿Cómo reviso las tasas BCV y operativa?", href: "/settings", cta: "Abrir Configuración", ownerOnly: true,
    keywords: "tasa bcv operativa dolar precios configuracion",
    steps: ["Entra a Administración › Configuración y precios.", "Revisa las tasas del día y su historial; las de Notion se sincronizan solas.", "Si arriba dice «Revisar precios», algo no se actualizó."] },
  { id: "nomina", area: "dueno", question: "¿Cómo pago la nómina de Cheo y Alexis?", href: "/payroll", cta: "Abrir Nómina", ownerOnly: true,
    keywords: "nomina pagar cheo alexis comision anticipo liquidar",
    steps: ["Entra a Finanzas › Nómina.", "Revisa los trabajos y anticipos del período.", "Registra el pago con su referencia bancaria. La comisión de Cashea es costo del negocio, no del mecánico."] },
  { id: "conciliacion", area: "dueno", question: "¿Cómo concilio el banco y Cashea?", href: "/finance/reconcile", cta: "Abrir Conciliación", ownerOnly: true,
    keywords: "conciliacion banco bnc bdv cashea semanal",
    steps: ["Entra a Finanzas › Conciliación semanal para el banco.", "Para Cashea usa Finanzas › Conciliación Cashea: las cuotas se marcan pagadas solo con verificación al 100 %."] },

  // Usar la app
  { id: "quien-atiende", area: "app", question: "¿Cómo marco quién está atendiendo?", href: "/", cta: "Ir al inicio",
    keywords: "quien atiende edgar ender santiago nombre",
    steps: ["Arriba a la derecha toca «Atiende» y elige tu nombre.", "Se recuerda en este equipo y cada venta guarda quién la atendió."] },
  { id: "volver", area: "app", question: "¿Cómo vuelvo a la pantalla anterior sin perder lo que estaba viendo?", href: "/", cta: "Ir al inicio",
    keywords: "volver atras regresar anterior filtros lista",
    steps: ["Toca «← Volver a …» arriba de la pantalla (o Alt + ← en la computadora).", "Regresas con los mismos filtros y en el mismo lugar de la lista."] },
  { id: "buscar-funcion", area: "app", question: "¿Cómo encuentro cualquier función rápido?", href: "/", cta: "Ir al inicio",
    keywords: "buscar funcion ctrl k atajos teclado f2 f3 f4 f6",
    steps: ["Presiona Ctrl K (o toca la lupa) y escribe lo que buscas: «cierre», «vuelto», «Cashea»…", "Atajos: F2 Venta rápida, F3 Nueva orden, F4 Cotizar, F6 Taller."] },
  { id: "instalar", area: "app", question: "¿Cómo instalo Lubricenter en el teléfono?", href: "/", cta: "Ir al inicio",
    keywords: "instalar telefono celular app pantalla inicio icono",
    steps: ["En Android: toca «Instalar» en el aviso del inicio (o el menú de Chrome › Instalar app).", "En iPhone: abre en Safari, toca Compartir y luego «Agregar a inicio».", "Se abre como una app, a pantalla completa."] },
  { id: "actualizar", area: "app", question: "¿Cómo actualizo la pantalla en el teléfono?", href: "/", cta: "Ir al inicio",
    keywords: "actualizar refrescar recargar datos nuevos telefono",
    steps: ["En la parte de arriba de cualquier pantalla, desliza el dedo hacia abajo y suelta cuando diga «Suelta para actualizar»."] },
  { id: "menos-movimiento", area: "app", question: "Las animaciones me marean, ¿se pueden reducir?", href: "/", cta: "Ir al inicio",
    keywords: "animacion movimiento tranquilo reducir mareo",
    steps: ["Abre el menú (las tres rayas) y activa «Animación tranquila».", "Se recuerda en este equipo."] },
];

function normalize(text: string) {
  return text.toLocaleLowerCase("es-VE").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Temas que coinciden con lo que se escribió; todas las palabras deben aparecer. */
export function searchHelp(query: string, owner: boolean, limit = 50): HelpTopic[] {
  const words = normalize(query).split(/\s+/).filter(word => word.length > 1);
  const visible = HELP_TOPICS.filter(topic => owner || !topic.ownerOnly);
  if (!words.length) return visible.slice(0, limit);
  return visible
    .map(topic => {
      const haystack = normalize(`${topic.question} ${topic.keywords} ${topic.steps.join(" ")}`);
      const title = normalize(topic.question + " " + topic.keywords);
      if (!words.every(word => haystack.includes(word))) return null;
      return { topic, score: words.filter(word => title.includes(word)).length };
    })
    .filter((x): x is { topic: HelpTopic; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.topic);
}

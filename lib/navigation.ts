import type { OsIconName } from "@/components/os-icon";

export type NavigationRole = "OWNER" | "ADMIN" | "OPERATOR";
export type NavItem = {
  href: string;
  label: string;
  description: string;
  ownerOnly?: boolean;
  keywords?: string;
};
export type NavModule = {
  id: string;
  label: string;
  icon: OsIconName;
  defaultHref: string;
  links: readonly NavItem[];
};

/** One navigational home per activity. Links preserve their existing app URLs. */
export const NAV_MODULES: readonly NavModule[] = [
  { id: "home", label: "Inicio", icon: "home", defaultHref: "/", links: [
    { href: "/", label: "Mi jornada", description: "Acciones de hoy y pendientes" }
  ] },
  { id: "sales", label: "Ventas", icon: "sale", defaultHref: "/quick-sale", links: [
    { href: "/quick-sale", label: "Venta rápida", description: "Cotizar y cobrar al mostrador", keywords: "facturar cobrar" },
    { href: "/orders", label: "Órdenes", description: "Consultar órdenes abiertas y cerradas" },
    { href: "/orders/new", label: "Nueva orden", description: "Crear una orden de servicio o cambio de aceite", keywords: "recibir vehículo" }
  ] },
  { id: "workshop", label: "Taller", icon: "workshop", defaultHref: "/workshop", links: [
    { href: "/workshop", label: "Tablero de vehículos", description: "Recepción, reparación y entrega", keywords: "mecánica avance" }
  ] },
  { id: "customers", label: "Clientes", icon: "customers", defaultHref: "/customers", links: [
    { href: "/customers", label: "Directorio", description: "Clientes, vehículos e historial" },
    { href: "/reminders", label: "Recordatorios", description: "Cambios de aceite y seguimiento", keywords: "mantenimiento" },
    { href: "/campaigns", label: "Campañas", description: "Promociones y contacto con clientes" }
  ] },
  { id: "inventory", label: "Inventario", icon: "inventory", defaultHref: "/inventory", links: [
    { href: "/inventory", label: "Existencias y catálogo", description: "Productos, códigos y stock" },
    { href: "/expenses", label: "Compras y proveedores", description: "Facturas, mercancía, deudas y pagos", keywords: "egresos" }
  ] },
  { id: "finance", label: "Finanzas", icon: "finance", defaultHref: "/cash-close", links: [
    { href: "/finance", label: "Resumen financiero", description: "Ventas, cobros y obligaciones", ownerOnly: true },
    { href: "/cash-close", label: "Cierre diario", description: "Conteo físico, historial y correcciones", keywords: "arqueo cuadre" },
    { href: "/cash", label: "Caja y movimientos", description: "Cuentas, salidas y transferencias", keywords: "gastos egresos" },
    { href: "/finance/reconcile", label: "Conciliación semanal", description: "Banco y control del período", ownerOnly: true, keywords: "BDV" },
    { href: "/finance/inbox", label: "Revisión financiera", description: "Casos, importaciones y reportes", ownerOnly: true },
    { href: "/cashea", label: "Órdenes Cashea", description: "Cobros y cuotas de Cashea" },
    { href: "/cashea/balance", label: "Balance Cashea", description: "Liquidaciones, facturas y comisiones", ownerOnly: true },
    { href: "/receivables", label: "Crédito LC", description: "Cuentas por cobrar y abonos" },
    { href: "/customer-balances", label: "Saldos de clientes", description: "Anticipos y devoluciones" },
    { href: "/change", label: "Vueltos pendientes", description: "Vueltos por entregar" },
    { href: "/payroll", label: "Nómina", description: "Liquidaciones y pagos al equipo", ownerOnly: true }
  ] },
  { id: "admin", label: "Administración", icon: "settings", defaultHref: "/settings", links: [
    { href: "/settings", label: "Configuración y precios", description: "Tasas, sincronización y reglas" },
    { href: "/more", label: "Directorio de herramientas", description: "Accesos a funciones anteriores" }
  ] }
];

export function canShowItem(item: NavItem, role: NavigationRole) {
  return !item.ownerOnly || role === "OWNER" || role === "ADMIN";
}

export function linksForModule(module: NavModule, role: NavigationRole) {
  return module.links.filter(link => canShowItem(link, role));
}

const exceptions: readonly [string, string][] = [
  ["/orders", "sales"], ["/vehicles", "customers"],
  ["/suppliers", "inventory"], ["/purchases", "inventory"],
  ["/promociones", "customers"]
];

export function moduleForPath(path: string): NavModule {
  const candidates = NAV_MODULES.flatMap(module =>
    module.links.map(link => ({ module, href: link.href }))
      .filter(item => item.href !== "/" && (path === item.href || path.startsWith(item.href + "/")))
  ).sort((a, b) => b.href.length - a.href.length);
  if (candidates.length) return candidates[0].module;
  const byPrefix = exceptions.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));
  if (byPrefix) return NAV_MODULES.find(item => item.id === byPrefix[1]) || NAV_MODULES[0];
  return NAV_MODULES[0];
}

export function pageLabelForPath(path: string) {
  const current = NAV_MODULES.flatMap(m => m.links)
    .filter(link => path === link.href || (link.href !== "/" && path.startsWith(link.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return current?.label || moduleForPath(path).label;
}

export function navigationSearch(query: string, role: NavigationRole) {
  const normalized = query.trim().toLocaleLowerCase("es-VE");
  if (!normalized) return [];
  return NAV_MODULES.flatMap(module =>
    linksForModule(module, role).map(item => ({ ...item, module: module.label, icon: module.icon }))
  ).filter(item =>
    [item.label, item.module, item.description, item.keywords || ""]
      .join(" ").toLocaleLowerCase("es-VE").includes(normalized)
  ).slice(0, 10);
}

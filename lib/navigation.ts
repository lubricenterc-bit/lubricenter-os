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
    { href: "/quote", label: "Cotizador general", description: "Cotizar productos, servicios y compartir; pasar directo a venta u orden", keywords: "cotizar presupuesto aceite filtro productos cliente whatsapp" },
    { href: "/quote/oil", label: "Comparador de aceites", description: "Cotizar varias marcas por viscosidad, tecnología y litros", keywords: "mineral semisintetico full sintetico galon aceite" },
    { href: "/orders", label: "Órdenes", description: "Consultar órdenes abiertas y cerradas" },
    { href: "/orders/new", label: "Nueva orden", description: "Crear una orden de servicio o cambio de aceite", keywords: "recibir vehículo" }
  ] },
  { id: "workshop", label: "Taller", icon: "workshop", defaultHref: "/workshop", links: [
    { href: "/workshop", label: "Tablero de vehículos", description: "Recepción, reparación y entrega", keywords: "mecánica avance" }
  ] },
  { id: "customers", label: "Clientes", icon: "customers", defaultHref: "/customers", links: [
    { href: "/customers", label: "Directorio", description: "Clientes y vehículos" },
    { href: "/crm/manual", label: "CRM manual", description: "Pendientes, servicios prepagados y mantenimiento sin orden obligatoria", keywords: "prepago cashea diferido agenda recordatorio servicio manual" },
    { href: "/service-history", label: "Historial de mantenimiento", description: "Cambios de aceite y servicios antiguos de Sheets y del OS", keywords: "servicio anterior histórico aceite placa factura mantenimiento" },
    { href: "/reminders", label: "Recordatorios", description: "Cambios de aceite y seguimiento", keywords: "mantenimiento" },
    { href: "/campaigns", label: "Campañas", description: "Promociones y contacto con clientes" }
  ] },
  { id: "inventory", label: "Inventario", icon: "inventory", defaultHref: "/inventory", links: [
    { href: "/inventory", label: "Inventario físico", description: "Existencias, códigos y conteos" },
    { href: "/catalog", label: "Catálogo de precios", description: "Fotografías y precios en Bs, $ BCV y divisas", keywords: "notion foto productos catalogo lista" },
    { href: "/catalog/manage", label: "Administrar catálogo", description: "Crear, editar y auditar artículos", ownerOnly: true, keywords: "precios productos factura compras" },
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
  { id: "team", label: "Equipo", icon: "customers", defaultHref: "/my-tasks", links: [
    { href: "/my-tasks", label: "Mis tareas", description: "Asignaciones y fechas de cumplimiento" },
    { href: "/team", label: "Usuarios y permisos", description: "Gestionar accesos, actividad y tareas", ownerOnly: true }
  ] },
  { id: "admin", label: "Administración", icon: "settings", defaultHref: "/settings", links: [
    { href: "/settings", label: "Configuración y precios", description: "Tasas, sincronización y reglas" },
    { href: "/more", label: "Directorio de herramientas", description: "Accesos a funciones anteriores" }
  ] }
];

export function canShowItem(item: NavItem, role: NavigationRole) {
  return !item.ownerOnly || role === "OWNER" || role === "ADMIN";
}

/** UI affordance only; database RLS and triggers are the actual authorization boundary. */
export function permissionForPath(path: string): string | null {
  const exact: Record<string, string> = {
    "/quick-sale": "payments.manage", "/quote": "orders.view", "/quote/oil": "inventory.view",
    "/orders": "orders.view", "/orders/new": "orders.create", "/workshop": "orders.view",
    "/customers": "customers.view", "/crm/manual": "crm.manage", "/service-history": "customers.view",
    "/reminders": "crm.manage", "/campaigns": "crm.manage",
    "/inventory": "inventory.view", "/catalog": "inventory.view", "/catalog/manage": "catalog.manage",
    "/expenses": "purchases.manage", "/finance": "finance.view", "/cash-close": "cash.close",
    "/cash": "cash.manage", "/finance/reconcile": "finance.reconcile",
    "/finance/inbox": "finance.reconcile", "/cashea": "cashea.manage",
    "/cashea/balance": "cashea.manage", "/receivables": "receivables.manage",
    "/customer-balances": "receivables.manage", "/change": "cash.manage",
    "/payroll": "payroll.view", "/settings": "settings.manage",
    "/more": "settings.manage", "/my-tasks": "tasks.view",
  };
  const key = Object.keys(exact).sort((a,b)=>b.length-a.length)
    .find(href => path === href || path.startsWith(href+"/"));
  return key ? exact[key] : null;
}

export function linksForModule(module: NavModule, role: NavigationRole, permissions?: readonly string[] | null) {
  return module.links.filter(link =>
    canShowItem(link, role) && (permissions == null ||
      permissionForPath(link.href) === null || permissions.includes(permissionForPath(link.href)!))
  );
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
  if(path.startsWith("/purchases/"))return "Factura de proveedor";
  if(path.startsWith("/suppliers/"))return "Proveedor";
  const current = NAV_MODULES.flatMap(m => m.links)
    .filter(link => path === link.href || (link.href !== "/" && path.startsWith(link.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return current?.label || moduleForPath(path).label;
}

export function navigationSearch(query: string, role: NavigationRole, permissions?: readonly string[] | null) {
  const normalized = query.trim().toLocaleLowerCase("es-VE");
  if (!normalized) return [];
  return NAV_MODULES.flatMap(module =>
    linksForModule(module, role, permissions).map(item => ({ ...item, module: module.label, icon: module.icon }))
  ).filter(item =>
    [item.label, item.module, item.description, item.keywords || ""]
      .join(" ").toLocaleLowerCase("es-VE").includes(normalized)
  ).slice(0, 10);
}

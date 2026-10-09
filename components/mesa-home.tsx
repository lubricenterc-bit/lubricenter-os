"use client";

import Link from "next/link";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import { fmtRef, fmtVes } from "@/lib/format";

export type MesaDashboard = {
  localDate: string; closedOrdersToday: number; salesRefToday: number; collectedRefToday: number;
  openOrders: number; activeVehicles: number; received: number; diagnosis: number; inProgress: number;
  waitingParts: number; ready: number; postService: number; maintenanceDue: number; maintenanceSoon: number;
  receivablesOpen: number; receivablesOutstandingVes: number; payrollPendingRef: number;
  inventoryReview: number; inventoryNegative: number; bcv: number; operative: number;
};

export type MesaHomeProps = {
  data: MesaDashboard; owner: boolean; locationName: string; loading: boolean; error: string;
  onRefresh: () => void; onNavigate?: (href: string) => void;
};

export function MesaHome({ data, owner, locationName, loading, error, onRefresh, onNavigate }: MesaHomeProps) {
  const count = (value: number) => loading ? "—" : String(value).padStart(2, "0");
  const money = (value: number) => loading ? "—" : fmtRef(value);
  const date = data.localDate ? new Date(data.localDate + "T12:00:00").toLocaleDateString("es-VE", { weekday: "long", day: "numeric", month: "long" }) : "Actividad actual";
  function go(href: string) { return onNavigate ? (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onNavigate(href); } : undefined; }
  const tools: Array<{ href: string; icon: OsIconName; title: string; note: string }> = owner ? [
    { href: "/finance/reconcile", icon: "shield", title: "Conciliación semanal", note: "Verificar bancos y movimientos" },
    { href: "/finance/inbox", icon: "alert", title: "Casos financieros", note: "Reportes e incidencias pendientes" },
    { href: "/expenses", icon: "inventory", title: "Compras y proveedores", note: "Facturas y cuentas por pagar" },
    { href: "/cash-close", icon: "cash", title: "Cerrar caja", note: "Contar y cerrar la jornada" },
  ] : [
    { href: "/receivables", icon: "credit", title: "Crédito LC", note: "Consultar y cobrar abonos" },
    { href: "/customers", icon: "customers", title: "Buscar cliente", note: "Historial y vehículos" },
    { href: "/cash", icon: "cash", title: "Movimientos de caja", note: "Egresos y transferencias" },
    { href: "/cash-close", icon: "check", title: "Cerrar caja", note: "Contar y cerrar la jornada" },
  ];
  return <main className="container mesa-home">
    <header className="mesa-home-intro">
      <div><span className="mesa-home-kicker">TU MESA DE TRABAJO / {locationName}</span><p>{date}</p></div>
      <button className="mesa-home-refresh" onClick={onRefresh} disabled={loading}><OsIcon name="refresh" size={16}/>{loading ? "Actualizando…" : "Actualizar"}</button>
    </header>
    {error && <div className="error" role="alert">No fue posible cargar el resumen: {error} <button className="btn btn-ghost" onClick={onRefresh}>Reintentar</button></div>}
    <div className="mesa-home-desk">
      <section className="mesa-home-document" aria-labelledby="mesa-home-quote-title">
        <header className="mesa-home-document-head"><h1 id="mesa-home-quote-title"><span>01 /</span> Cotizar.</h1><span className="mesa-home-stamp"><i/> LISTO PARA EMPEZAR</span></header>
        <p className="mesa-home-document-sub">PRODUCTOS, ACEITES Y SERVICIOS</p>
        <div className="mesa-home-welcome"><span className="mesa-home-round"><OsIcon name="receipt" size={27}/></span><div><strong>Una buena atención empieza aquí.</strong><p>Encuentra la opción indicada y arma la próxima cotización.</p></div></div>
        <div className="mesa-home-document-labels"><span>HERRAMIENTA</span><span>SIGUIENTE PASO</span></div>
        <div className="mesa-home-document-links">
          <Link href="/quote" onClick={go("/quote")}><span className="mesa-home-product-icon"><OsIcon name="receipt" size={28}/></span><div><strong>Cotizador general</strong><p>Productos y servicios en una sola cotización</p></div><span className="mesa-home-row-action">Armar <OsIcon name="arrow" size={19}/></span></Link>
          <Link href="/quote/oil" onClick={go("/quote/oil")}><span className="mesa-home-product-icon"><OsIcon name="layers" size={28}/></span><div><strong>Comparador de aceites</strong><p>Compara alternativas para cada vehículo</p></div><span className="mesa-home-row-action">Comparar <OsIcon name="arrow" size={19}/></span></Link>
          <Link href="/catalog" onClick={go("/catalog")}><span className="mesa-home-product-icon"><OsIcon name="inventory" size={28}/></span><div><strong>Catálogo Notion</strong><p>Consulta productos y precios disponibles</p></div><span className="mesa-home-row-action">Explorar <OsIcon name="arrow" size={19}/></span></Link>
        </div>
        <footer className="mesa-home-document-footer"><div><OsIcon name="car" size={21}/><p>¿Llegó un vehículo?<Link href="/orders/new" onClick={go("/orders/new")}>Recibir y abrir orden <OsIcon name="arrow" size={15}/></Link></p></div><Link href="/quote" onClick={go("/quote")} className="mesa-home-pill">Nueva cotización <OsIcon name="arrow" size={20}/></Link></footer>
      </section>
      <aside className="mesa-home-right">
        <section className="mesa-home-sell" aria-labelledby="mesa-home-sell-title">
          <div className="mesa-home-sell-top"><span>VENTA RÁPIDA / MOSTRADOR</span><OsIcon name="sale" size={26}/></div>
          <h2 id="mesa-home-sell-title">Vender<span>.</span></h2>
          <p>Del mostrador a la próxima venta.</p>
          <div className="mesa-home-sell-inset"><span><OsIcon name="inventory" size={25}/></span><div><strong>Productos y servicios</strong><small>Busca en inventario o catálogo y arma tu carrito.</small></div><OsIcon name="arrow" size={21}/></div>
          <Link href="/quick-sale" onClick={go("/quick-sale")} className="mesa-home-pill mesa-home-pill-dark">Abrir venta <OsIcon name="arrow" size={23}/></Link>
          <span className="mesa-home-sell-foot">ÁGIL EN EL MOSTRADOR. CLARO AL COBRAR.</span>
        </section>
        <section className="mesa-home-orders" aria-labelledby="mesa-home-orders-title"><header><h2 id="mesa-home-orders-title">ÓRDENES ABIERTAS</h2><Link href="/orders" onClick={go("/orders")}>Ver todas <OsIcon name="arrow" size={15}/></Link></header><div className="mesa-home-orders-main"><strong>{count(data.openOrders)}</strong><div><Link href="/workshop" onClick={go("/workshop")}><span><i className="mesa-dot-ready"/>Listos para entregar</span><b>{count(data.ready)}</b></Link><Link href="/workshop" onClick={go("/workshop")}><span><i className="mesa-dot-wait"/>Esperando repuestos</span><b>{count(data.waitingParts)}</b></Link></div></div></section>
      </aside>
    </div>
    <section className="mesa-home-figures" aria-label={owner ? "Actividad del negocio" : "Actividad del taller"}>
      {(owner ? [
        { label: "Ventas cerradas", value: money(data.salesRefToday), note: count(data.closedOrdersToday) + " órdenes cerradas", href: "/finance" },
        { label: "Cobros registrados", value: money(data.collectedRefToday), note: "Incluye abonos; no es saldo bancario", href: "/finance" },
        { label: "Crédito LC pendiente", value: loading ? "—" : fmtVes(data.receivablesOutstandingVes), note: count(data.receivablesOpen) + " cuentas abiertas", href: "/receivables" },
      ] : [
        { label: "Vehículos activos", value: count(data.activeVehicles), note: "Dentro del flujo operativo", href: "/workshop" },
        { label: "En servicio", value: count(data.inProgress), note: "Trabajos en curso", href: "/workshop" },
        { label: "Listos para entregar", value: count(data.ready), note: "Confirmar entrega al cliente", href: "/workshop" },
      ]).map(item => <Link key={item.label} href={item.href} onClick={go(item.href)}><span>{item.label}<OsIcon name="arrow" size={16}/></span><strong>{item.value}</strong><small>{item.note}</small></Link>)}
    </section>
    <div className="mesa-home-bottom">
      <section className="mesa-home-followup"><header><span className="mesa-home-kicker">QUE NADA QUEDE PENDIENTE</span><h2>Dar seguimiento.</h2></header><Link href="/reminders" onClick={go("/reminders")}><OsIcon name="bell"/><div><strong>Mantenimiento vencido</strong><small>Clientes que necesitan un recordatorio</small></div><b>{count(data.maintenanceDue)}</b><OsIcon name="arrow"/></Link><Link href="/orders" onClick={go("/orders")}><OsIcon name="orders"/><div><strong>Órdenes sin finalizar</strong><small>Revisar avances y pagos</small></div><b>{count(data.openOrders)}</b><OsIcon name="arrow"/></Link></section>
      <section className="mesa-home-tools"><header><span className="mesa-home-kicker">{owner ? "CONTROL Y SUPERVISIÓN" : "TU DÍA A DÍA"}</span><h2>A mano.</h2></header><div>{tools.map(tool => <Link key={tool.href} href={tool.href} onClick={go(tool.href)}><OsIcon name={tool.icon}/><span><strong>{tool.title}</strong><small>{tool.note}</small></span><OsIcon name="arrow" size={17}/></Link>)}</div></section>
    </div>
    {owner && <div className="mesa-home-rates"><span>TASAS OPERATIVAS · NOTION</span><span>BCV <b>{loading ? "—" : data.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</b></span><span>Operativa <b>{loading ? "—" : data.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</b></span><Link href="/settings" onClick={go("/settings")}>Ver configuración <OsIcon name="arrow" size={14}/></Link></div>}
    <p className="mesa-home-footnote">Los indicadores provienen de las operaciones registradas. Los saldos bancarios requieren conciliación independiente.</p>
  </main>;
}

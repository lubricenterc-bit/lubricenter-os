"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import { useAppSession } from "@/components/app-session-context";

type Dashboard = {
  localDate: string;
  closedOrdersToday: number;
  salesRefToday: number;
  collectedRefToday: number;
  openOrders: number;
  activeVehicles: number;
  received: number;
  diagnosis: number;
  inProgress: number;
  waitingParts: number;
  ready: number;
  postService: number;
  maintenanceDue: number;
  maintenanceSoon: number;
  receivablesOpen: number;
  receivablesOutstandingVes: number;
  payrollPendingRef: number;
  inventoryReview: number;
  inventoryNegative: number;
  bcv: number;
  operative: number;
};
const INITIAL: Dashboard = {
  localDate: "", closedOrdersToday: 0, salesRefToday: 0, collectedRefToday: 0,
  openOrders: 0, activeVehicles: 0, received: 0, diagnosis: 0, inProgress: 0,
  waitingParts: 0, ready: 0, postService: 0, maintenanceDue: 0, maintenanceSoon: 0,
  receivablesOpen: 0, receivablesOutstandingVes: 0, payrollPendingRef: 0,
  inventoryReview: 0, inventoryNegative: 0, bcv: 0, operative: 0,
};
type Action = { href: string; title: string; detail: string; icon: OsIconName; primary?: boolean };

const quickActions: Action[] = [
  { href: "/quick-sale", title: "Venta rápida", detail: "Cotizar y cobrar", icon: "sale", primary: true },
  { href: "/orders/new", title: "Recibir vehículo", detail: "Crear orden de servicio", icon: "car" },
  { href: "/workshop", title: "Abrir taller", detail: "Trabajos en curso", icon: "workshop" },
  { href: "/cash-close", title: "Cerrar caja", detail: "Contar efectivo del día", icon: "cash" },
];

function localDateLabel(value: string) {
  if (!value) return "Actividad actual";
  return new Date(value + "T12:00:00").toLocaleDateString("es-VE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

function Metric({ icon, title, value, note, href, important = false }: {
  icon: OsIconName; title: string; value: string; note: string; href: string; important?: boolean;
}) {
  return <Link href={href} className={"os-home-metric" + (important ? " is-important" : "")}>
    <div className="os-home-metric-head"><span>{title}</span><OsIcon name={icon} size={18}/></div>
    <strong>{value}</strong><small>{note}</small>
  </Link>;
}

export default function HomePage() {
  const { role, roleLoaded, locationName } = useAppSession();
  const owner = roleLoaded && (role === "OWNER" || role === "ADMIN");
  const [data, setData] = useState<Dashboard>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    const result = await supabase.rpc("dashboard_overview");
    if (result.error) { setError(result.error.message); setLoading(false); return; }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (row) setData({
      localDate: row.local_date ?? "",
      closedOrdersToday: Number(row.closed_orders_today ?? 0),
      salesRefToday: Number(row.sales_ref_today ?? 0),
      collectedRefToday: Number(row.collected_ref_today ?? 0),
      openOrders: Number(row.open_orders ?? 0),
      activeVehicles: Number(row.vehicles_active ?? row.active_vehicles ?? 0),
      received: Number(row.vehicles_received ?? 0),
      diagnosis: Number(row.vehicles_diagnosis ?? 0),
      inProgress: Number(row.vehicles_in_progress ?? 0),
      waitingParts: Number(row.vehicles_waiting_parts ?? 0),
      ready: Number(row.vehicles_ready ?? 0),
      postService: Number(row.post_service_action ?? 0),
      maintenanceDue: Number(row.maintenance_due ?? 0),
      maintenanceSoon: Number(row.maintenance_soon ?? 0),
      receivablesOpen: Number(row.receivables_open ?? 0),
      receivablesOutstandingVes: Number(row.receivables_outstanding_ves ?? 0),
      payrollPendingRef: Number(row.payroll_pending_ref ?? 0),
      inventoryReview: Number(row.inventory_review ?? 0),
      inventoryNegative: Number(row.inventory_negative ?? 0),
      bcv: Number(row.bcv_rate ?? 0),
      operative: Number(row.operative_rate ?? 0),
    });
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const number = (value: number) => loading ? "—" : String(value);
  const totalPending = data.openOrders + data.waitingParts + data.ready;
  const money = (value: number) => loading ? "—" : fmtRef(value);

  return <main className="container os-home">
    <header className="os-home-heading">
      <div>
        <p className="os-home-eyebrow"><span className="os-status-dot"/> OPERACIÓN · {locationName.toUpperCase()}</p>
        <h1>{owner ? "Centro de control" : "Mi jornada"}</h1>
        <p className="os-home-subtitle">{localDateLabel(data.localDate)} · {owner
          ? "Visión general y decisiones que requieren atención."
          : "Todo lo necesario para atender y cerrar el día."}</p>
      </div>
      <button className="os-home-reload" onClick={() => void load()} disabled={loading}>
        <OsIcon name="refresh" size={17}/>{loading ? "Actualizando..." : "Actualizar"}
      </button>
    </header>
    {error && <div className="error os-home-error" role="alert">No fue posible cargar el resumen: {error} <button onClick={() => void load()}>Reintentar</button></div>}

    <section className="os-home-primary" aria-labelledby="home-actions">
      <div className="os-home-section-heading"><div><span className="os-home-eyebrow">ACCESOS DIRECTOS</span><h2 id="home-actions">¿Qué necesitas hacer?</h2></div><p>Las tareas más frecuentes, siempre a un clic.</p></div>
      <div className="os-home-actions">
        {quickActions.map(action => <Link key={action.href} href={action.href}
          className={"os-home-action" + (action.primary ? " os-home-action-primary" : "")}>
          <span className="os-home-action-icon"><OsIcon name={action.icon} size={23}/></span>
          <span className="os-home-action-copy"><strong>{action.title}</strong><small>{action.detail}</small></span>
          <OsIcon name="arrow" size={17}/>
        </Link>)}
      </div>
    </section>

    {owner ? <>
      <section className="os-home-owner-stats" aria-labelledby="home-figures">
        <div className="os-home-section-heading"><div><span className="os-home-eyebrow">RESUMEN DE HOY</span><h2 id="home-figures">Actividad del negocio</h2></div><Link href="/finance">Ver finanzas <OsIcon name="arrow" size={15}/></Link></div>
        <div className="os-home-metrics">
          <Metric icon="trend" title="Ventas cerradas" value={money(data.salesRefToday)}
            note={number(data.closedOrdersToday) + " órdenes cerradas"} href="/finance" important/>
          <Metric icon="cash" title="Cobros registrados" value={money(data.collectedRefToday)}
            note="Incluye abonos; no es saldo bancario" href="/finance"/>
          <Metric icon="orders" title="Órdenes abiertas" value={number(data.openOrders)}
            note="Pendientes de finalizar" href="/orders"/>
          <Metric icon="credit" title="Crédito LC pendiente" value={loading ? "—" : fmtVes(data.receivablesOutstandingVes)}
            note={number(data.receivablesOpen) + " cuentas abiertas"} href="/receivables"/>
        </div>
      </section>
    </> : <>
      <section className="os-home-owner-stats" aria-labelledby="home-progress">
        <div className="os-home-section-heading"><div><span className="os-home-eyebrow">OPERACIÓN DE HOY</span><h2 id="home-progress">En el taller</h2></div><Link href="/workshop">Ver tablero <OsIcon name="arrow" size={15}/></Link></div>
        <div className="os-home-metrics">
          <Metric icon="car" title="Vehículos activos" value={number(data.activeVehicles)} note="Dentro del flujo operativo" href="/workshop" important/>
          <Metric icon="orders" title="Órdenes abiertas" value={number(data.openOrders)} note="Pendientes por cerrar" href="/orders"/>
          <Metric icon="clock" title="Esperando repuestos" value={number(data.waitingParts)} note="Necesitan seguimiento" href="/workshop"/>
          <Metric icon="check" title="Listos" value={number(data.ready)} note="Revisar para entrega" href="/workshop"/>
        </div>
      </section>
    </>}

    <div className="os-home-columns">
      <section className="os-home-panel" aria-labelledby="home-attention">
        <div className="os-home-panel-heading">
          <div><span className="os-home-eyebrow">A SEGUIR</span><h2 id="home-attention">Pendientes importantes</h2></div>
          <span className="os-home-tag">{loading ? "Actualizando" : totalPending + " referencias operativas"}</span>
        </div>
        <div className="os-home-tasks">
          <Link href="/orders" className="os-home-task">
            <span className="os-home-task-symbol"><OsIcon name="orders" size={19}/></span>
            <span><strong>Órdenes sin finalizar</strong><small>Consulta sus avances y pagos</small></span>
            <span className="os-home-task-count">{number(data.openOrders)}</span>
          </Link>
          <Link href="/workshop" className="os-home-task">
            <span className="os-home-task-symbol"><OsIcon name="workshop" size={19}/></span>
            <span><strong>Vehículos esperando repuestos</strong><small>Dar seguimiento en el taller</small></span>
            <span className="os-home-task-count">{number(data.waitingParts)}</span>
          </Link>
          <Link href="/workshop" className="os-home-task">
            <span className="os-home-task-symbol"><OsIcon name="check" size={19}/></span>
            <span><strong>Vehículos listos</strong><small>Confirmar entrega al cliente</small></span>
            <span className="os-home-task-count">{number(data.ready)}</span>
          </Link>
          <Link href="/reminders" className="os-home-task">
            <span className="os-home-task-symbol"><OsIcon name="bell" size={19}/></span>
            <span><strong>Mantenimiento vencido</strong><small>Clientes a contactar</small></span>
            <span className="os-home-task-count">{number(data.maintenanceDue)}</span>
          </Link>
        </div>
      </section>
      <aside className="os-home-panel os-home-secondary" aria-labelledby="home-shortcuts">
        <div className="os-home-panel-heading"><div><span className="os-home-eyebrow">HERRAMIENTAS</span><h2 id="home-shortcuts">{owner ? "Control y supervisión" : "Tu día a día"}</h2></div></div>
        <div className="os-home-tool-links">
          {(owner ? [
            { href: "/finance/reconcile", icon: "shield" as OsIconName, title: "Conciliación semanal", note: "BDV y movimientos por verificar" },
            { href: "/finance/inbox", icon: "alert" as OsIconName, title: "Casos financieros", note: "Incidencias y reportes pendientes" },
            { href: "/expenses", icon: "inventory" as OsIconName, title: "Compras y proveedores", note: "Facturas, abonos y cuentas por pagar" },
          ] : [
            { href: "/receivables", icon: "credit" as OsIconName, title: "Crédito LC", note: "Cobrar abonos pendientes" },
            { href: "/customers", icon: "customers" as OsIconName, title: "Buscar cliente", note: "Historial y vehículos" },
            { href: "/cash", icon: "cash" as OsIconName, title: "Movimientos de caja", note: "Egresos y transferencias" },
          ]).map(tool => <Link href={tool.href} key={tool.href} className="os-home-tool">
            <span className="os-home-tool-icon"><OsIcon name={tool.icon} size={19}/></span>
            <span><strong>{tool.title}</strong><small>{tool.note}</small></span><OsIcon name="right" size={16}/>
          </Link>)}
        </div>
        {owner && <div className="os-home-rate">
          <span>TASAS OPERATIVAS · NOTION</span>
          <div><strong>BCV</strong><b>{loading ? "—" : data.bcv.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</b></div>
          <div><strong>Operativa</strong><b>{loading ? "—" : data.operative.toLocaleString("es-VE", { maximumFractionDigits: 4 })}</b></div>
          <Link href="/settings">Ver configuración <OsIcon name="arrow" size={14}/></Link>
        </div>}
      </aside>
    </div>
    <p className="os-home-footnote">Los indicadores provienen de las operaciones registradas en Lubricenter OS. Los saldos bancarios requieren conciliación independiente.</p>
  </main>;
}

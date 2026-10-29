"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AttendantPicker, useAttendant } from "@/components/attendant-picker";
import { BrandIcon, Gotin, replay, useLive } from "@/components/gotin";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import type { BrandIconName } from "@/lib/brand-art";
import { fmtRef, fmtVes } from "@/lib/format";

export type HomeDashboard = {
  localDate: string; closedOrdersToday: number; salesRefToday: number; collectedRefToday: number;
  openOrders: number; activeVehicles: number; received: number; diagnosis: number; inProgress: number;
  waitingParts: number; ready: number; postService: number; maintenanceDue: number; maintenanceSoon: number;
  receivablesOpen: number; receivablesOutstandingVes: number; payrollPendingRef: number;
  inventoryReview: number; inventoryNegative: number; bcv: number; operative: number;
};

export type HomeBoardRow = {
  id: string; order_number: string; workflow_status: string; workflow_updated_at: string;
  plate: string | null; make: string | null; model: string | null; is_walk_in: boolean;
  customer_name: string | null; service_areas: string | null;
};

export type OsHomeProps = {
  data: HomeDashboard; board: HomeBoardRow[]; owner: boolean; locationName: string;
  loading: boolean; error: string; onRefresh: () => void; onNavigate?: (href: string) => void;
};

const STAGES: { key: string; title: string; icon: BrandIconName; count: (d: HomeDashboard) => number; busy?: boolean }[] = [
  { key: "RECEIVED", title: "Recibidos", icon: "car", count: d => d.received },
  { key: "DIAGNOSIS", title: "Diagnóstico", icon: "lens", count: d => d.diagnosis },
  { key: "IN_PROGRESS", title: "En trabajo", icon: "wrench", count: d => d.inProgress, busy: true },
  { key: "WAITING_PART", title: "Esperando repuesto", icon: "hourglass", count: d => d.waitingParts, busy: true },
  { key: "READY", title: "Listos", icon: "flag", count: d => d.ready },
];

function age(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
function plural(n: number, one: string, many: string) { return `${n} ${n === 1 ? one : many}`; }
function greeting(date: Date) {
  const h = date.getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

export function OsHome({ data, board, owner, locationName, loading, error, onRefresh, onNavigate }: OsHomeProps) {
  const attendant = useAttendant();
  const heroLive = useLive<HTMLDivElement>();
  const lanesLive = useLive<HTMLDivElement>();
  const todoLive = useLive<HTMLUListElement>();
  const footLive = useLive<HTMLElement>();
  const gotinRef = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState(0);
  const [bubbleKey, setBubbleKey] = useState(0);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); }, []);

  function go(href: string) {
    return onNavigate ? (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onNavigate(href); } : undefined;
  }
  const n = (value: number) => loading ? "—" : String(value);
  const money = (value: number) => loading ? "—" : fmtRef(value);
  const dateText = data.localDate
    ? new Date(data.localDate + "T12:00:00").toLocaleDateString("es-VE", { weekday: "long", day: "numeric", month: "long" })
    : "";
  const dateLabel = dateText.charAt(0).toUpperCase() + dateText.slice(1);
  const who = attendant || (owner ? "equipo" : "equipo");

  const tips = useMemo(() => {
    const list = [
      `${now ? greeting(now) : "Hola"}, ${who}. Presiona F2 en cualquier pantalla y abro la venta al instante.`,
      "La mano de obra del cambio de aceite sale gratis si el cliente compra aquí al menos el 85% del cambio.",
      "Cashea acepta compras desde REF 25. Primero guardas la orden y luego registras la inicial.",
      "Ctrl K busca cualquier sección: cierre, Cashea, clientes o proveedores.",
    ];
    if (!loading && data.ready > 0) list.splice(1, 0, `Hay ${plural(data.ready, "vehículo listo", "vehículos listos")} para entregar. ¡Avísale al cliente!`);
    if (!loading && data.maintenanceDue > 0) list.splice(2, 0, `${plural(data.maintenanceDue, "cliente tiene", "clientes tienen")} el mantenimiento vencido. Un recordatorio hoy es una venta mañana.`);
    return list;
  }, [now, who, loading, data.ready, data.maintenanceDue]);
  const bubble = tips[tip % tips.length];
  function nextTip() {
    setTip(value => value + 1);
    setBubbleKey(value => value + 1);
    replay(gotinRef.current?.querySelector("svg"), "jump", 750);
  }

  const lede = loading ? "Cargando la jornada…" : owner
    ? `Van ${plural(data.closedOrdersToday, "venta cerrada", "ventas cerradas")} por ${fmtRef(data.salesRefToday)} y ${fmtRef(data.collectedRefToday)} cobrados.`
    : `Hay ${plural(data.activeVehicles, "vehículo", "vehículos")} en el taller: ${data.inProgress} en trabajo y ${data.ready} ${data.ready === 1 ? "listo" : "listos"} para entregar.`;
  const alert = loading ? "" : data.waitingParts > 0
    ? `${plural(data.waitingParts, "vehículo espera", "vehículos esperan")} repuesto.`
    : data.maintenanceDue > 0 ? `${plural(data.maintenanceDue, "cliente tiene", "clientes tienen")} el mantenimiento vencido.` : "";

  const actions: { href: string; key: string; title: string; note: string; icon: BrandIconName; main?: boolean }[] = [
    { href: "/quick-sale", key: "F2", title: "Vender", note: "Productos y servicios al ticket", icon: "can", main: true },
    { href: "/orders/new", key: "F3", title: "Recibir", note: "Vehículo, cliente y trabajo", icon: "car" },
    { href: "/quote", key: "F4", title: "Cotizar", note: "Aceites, filtros y servicios", icon: "clip" },
    { href: "/workshop", key: "F6", title: "Taller", note: loading ? "Tablero por etapas" : `${plural(data.activeVehicles, "vehículo", "vehículos")}, ${data.ready} ${data.ready === 1 ? "listo" : "listos"}`, icon: "wrench" },
  ];
  const starts: [string, string][] = [
    ["/orders/new?start=oil", "Cambio de aceite"], ["/orders/new?start=workshop", "Trabajo de taller"],
    ["/orders/new?start=electro", "Electroauto"], ["/quote/oil", "Comparar aceites"], ["/catalog", "Catálogo"],
  ];

  const figures = owner ? [
    { label: "Ventas cerradas", value: money(data.salesRefToday), unit: "", note: plural(data.closedOrdersToday, "orden cerrada", "órdenes cerradas"), href: "/finance" },
    { label: "Cobros registrados", value: money(data.collectedRefToday), unit: "", note: "Incluye abonos; no es saldo bancario", href: "/finance" },
    { label: "Crédito LC pendiente", value: loading ? "—" : fmtVes(data.receivablesOutstandingVes), unit: "", note: plural(data.receivablesOpen, "cuenta abierta", "cuentas abiertas"), href: "/receivables" },
  ] : [
    { label: "Vehículos activos", value: n(data.activeVehicles), unit: "", note: "Dentro del flujo del taller", href: "/workshop" },
    { label: "En trabajo", value: n(data.inProgress), unit: "", note: "Trabajos en curso", href: "/workshop" },
    { label: "Listos para entregar", value: n(data.ready), unit: "", note: "Confirmar entrega al cliente", href: "/workshop" },
  ];

  const pending: { href: string; icon: BrandIconName; level: "Urgente" | "Hoy" | "Esta semana"; title: string; note: string; count: number; on?: boolean }[] = [];
  if (data.maintenanceDue > 0) pending.push({ href: "/reminders", icon: "clock", level: "Urgente", title: "Mantenimiento vencido", note: "Clientes que necesitan un recordatorio", count: data.maintenanceDue, on: true });
  if (data.inventoryNegative > 0) pending.push({ href: "/inventory", icon: "tag", level: "Urgente", title: "Existencias negativas", note: "Productos vendidos sin stock registrado", count: data.inventoryNegative, on: true });
  if (data.openOrders > 0) pending.push({ href: "/orders", icon: "clip", level: "Hoy", title: "Órdenes sin finalizar", note: "Revisar avances y pagos", count: data.openOrders });
  if (data.postService > 0) pending.push({ href: "/reminders", icon: "car", level: "Hoy", title: "Seguimiento después del servicio", note: "Clientes por contactar tras su visita", count: data.postService });
  if (data.inventoryReview > 0) pending.push({ href: "/inventory", icon: "tag", level: "Hoy", title: "Inventario por revisar", note: "Códigos o conteos pendientes", count: data.inventoryReview });
  if (data.maintenanceSoon > 0) pending.push({ href: "/reminders", icon: "cal", level: "Esta semana", title: "Mantenimiento próximo", note: "Clientes a los que les toca pronto", count: data.maintenanceSoon });
  if (owner && data.payrollPendingRef > 0) pending.push({ href: "/payroll", icon: "cal", level: "Esta semana", title: "Nómina por liquidar", note: fmtRef(data.payrollPendingRef) + " pendientes", count: 1 });

  const tools: { href: string; icon: OsIconName; title: string; note: string }[] = owner ? [
    { href: "/cash-close", icon: "cash", title: "Cerrar caja", note: "Contar y cerrar la jornada" },
    { href: "/finance/reconcile", icon: "shield", title: "Conciliación semanal", note: "Verificar bancos y movimientos" },
    { href: "/finance/inbox", icon: "alert", title: "Casos financieros", note: "Reportes e incidencias pendientes" },
    { href: "/expenses", icon: "inventory", title: "Compras y proveedores", note: "Facturas y cuentas por pagar" },
  ] : [
    { href: "/cash-close", icon: "check", title: "Cerrar caja", note: "Contar y cerrar la jornada" },
    { href: "/receivables", icon: "credit", title: "Crédito LC", note: "Consultar y cobrar abonos" },
    { href: "/customers", icon: "customers", title: "Buscar cliente", note: "Historial y vehículos" },
    { href: "/cash", icon: "cash", title: "Movimientos de caja", note: "Egresos y transferencias" },
  ];

  const plates = (stage: string) => board.filter(row => row.workflow_status === stage).slice(0, 3);
  const rate = (value: number) => loading ? "—" : value.toLocaleString("es-VE", { maximumFractionDigits: 2 });

  return <main className="container os-home">
    <section className="os-home-hero" ref={heroLive}>
      <div className="os-home-lead">
        <h1>¿Qué hacemos ahora, <span>{who}</span>?</h1>
        <p className="os-home-lede">
          {dateLabel && <span className="os-home-date">{dateLabel}, {locationName}. </span>}
          {lede} {alert && <strong className="os-home-alert">{alert}</strong>}
        </p>
        {!attendant && <AttendantPicker />}
        <div className="os-home-actions">
          <h2 className="sr-only">Acciones rápidas</h2>
          {actions.map((action, index) => <Link key={action.href} href={action.href} onClick={go(action.href)}
            className={"os-act hov" + (action.main ? " is-main" : "")} style={{ animationDelay: index * 60 + "ms" }}>
            <kbd>{action.key}</kbd>
            <span><strong>{action.title}</strong><small>{action.note}</small></span>
            <BrandIcon name={action.icon} className="os-act-icon" />
          </Link>)}
        </div>
        <div className="os-home-starts" aria-label="Registrar">
          <span>Registrar</span>
          {starts.map(([href, label]) => <Link key={href} href={href} onClick={go(href)}>{label}</Link>)}
        </div>
      </div>

      <div className="os-home-stage">
        <button ref={gotinRef} type="button" className="os-home-gotin" onClick={nextTip} aria-label="Gotín. Toca para otro consejo">
          <Gotin pose="hold" />
        </button>
        <p key={bubbleKey} className="os-bubble" aria-live="polite">{bubble}</p>
        <section className="os-day" aria-labelledby="os-day-title">
          <header><h2 id="os-day-title">{owner ? "El día en cifras" : "El taller hoy"}</h2>
            <button type="button" className="os-refresh" onClick={onRefresh} disabled={loading} aria-label="Actualizar el resumen">
              <OsIcon name="refresh" size={16} className={loading ? "is-spinning" : undefined} />{loading ? "Actualizando…" : "Actualizar"}</button></header>
          <dl>
            {figures.map(item => <Link key={item.label} href={item.href} onClick={go(item.href)}>
              <dt>{item.label}<small>{item.note}</small></dt><dd>{item.value}</dd>
            </Link>)}
          </dl>
          <footer>
            <span>BCV <b>{rate(data.bcv)}</b></span><span>Operativa <b>{rate(data.operative)}</b></span>
            {owner && <Link href="/settings" onClick={go("/settings")}>Tasas y precios <OsIcon name="arrow" size={14} /></Link>}
          </footer>
        </section>
      </div>
    </section>

    {error && <div className="error" role="alert">No fue posible cargar el resumen: {error} <button className="btn btn-ghost" onClick={onRefresh}>Reintentar</button></div>}

    <section aria-labelledby="os-lanes-title">
      <div className="os-section-head"><h2 id="os-lanes-title">El taller, ahora<span>{loading ? "" : plural(data.activeVehicles, "vehículo", "vehículos")}</span></h2>
        <Link className="os-link" href="/workshop" onClick={go("/workshop")}>Abrir el taller <OsIcon name="arrow" size={17} /></Link></div>
      <div className="os-lanes" ref={lanesLive}>
        {STAGES.map(stage => {
          const count = stage.count(data);
          const rows = plates(stage.key);
          return <Link key={stage.key} href="/workshop" onClick={go("/workshop")}
            className={"os-lane hov" + (stage.key === "IN_PROGRESS" ? " is-flow" : "") + (stage.busy && count > 0 ? " on" : "")}>
            <span className="os-lane-head"><BrandIcon name={stage.icon} /><b>{n(count)}</b></span>
            <strong>{stage.title}</strong>
            <ul>
              {rows.map(row => <li key={row.id}>
                {row.plate ? <span className="os-plate"><small>VENEZUELA</small><b>{row.plate}</b></span> : <span className="os-plate is-walkin"><b>{row.order_number}</b></span>}
                <span>{[row.make, row.model].filter(Boolean).join(" ") || row.customer_name || "Servicio rápido"}</span>
                <small>{age(row.workflow_updated_at)} en esta etapa</small>
              </li>)}
              {!rows.length && <li className="os-lane-none">{count > 0 ? "Ver en el tablero" : "Nadie en esta etapa"}</li>}
              {count > rows.length && rows.length > 0 && <li className="os-lane-more">y {count - rows.length} más</li>}
            </ul>
          </Link>;
        })}
      </div>
    </section>

    <div className="os-home-low">
      <section aria-labelledby="os-todo-title">
        <div className="os-section-head"><h2 id="os-todo-title">Pendientes<span>{loading ? "" : pending.length ? plural(pending.length, "tema abierto", "temas abiertos") : "Todo al día"}</span></h2></div>
        <ul className="os-todo" ref={todoLive}>
          {pending.map(item => <li key={item.title} className={"hov" + (item.on ? " on" : "")}>
            <Link href={item.href} onClick={go(item.href)}>
              <BrandIcon name={item.icon} className="os-todo-icon" />
              <span><em className={"is-" + (item.level === "Urgente" ? "urgent" : item.level === "Hoy" ? "today" : "week")}>{item.level}</em><strong>{item.title}</strong><small>{item.note}</small></span>
              <b>{item.count}</b><OsIcon name="arrow" size={18} />
            </Link>
          </li>)}
          {!loading && !pending.length && <li className="os-todo-clear"><Gotin pose="cheer" /><span><strong>Todo al día.</strong><small>No hay recordatorios, órdenes ni inventario pendientes.</small></span></li>}
          {loading && <li className="os-todo-clear"><span><small>Buscando pendientes…</small></span></li>}
        </ul>
      </section>
      <section className="os-tools-panel" aria-labelledby="os-tools-title">
        <h2 id="os-tools-title">A mano</h2>
        {tools.map(tool => <Link key={tool.href} href={tool.href} onClick={go(tool.href)}>
          <span className="os-tool-icon"><OsIcon name={tool.icon} size={20} /></span><span><strong>{tool.title}</strong><small>{tool.note}</small></span><OsIcon name="arrow" size={17} />
        </Link>)}
      </section>
    </div>

    <footer className="os-colophon" ref={footLive}>
      <span className="os-seal" aria-hidden="true">
        <svg viewBox="0 0 104 104"><defs><path id="os-seal-path" d="M52 52 m-38 0 a38 38 0 1 1 76 0 a38 38 0 1 1 -76 0" /></defs>
          <circle cx="52" cy="52" r="50" fill="#161616" />
          <g className="os-seal-text"><text fontSize="10.5" fontWeight="700" letterSpacing="2.6" fill="#fff"><textPath href="#os-seal-path">CUIDAMOS LO QUE TE MUEVE • LUBRICENTER •</textPath></text></g>
          <path d="M52 34 C57 43 64 49 64 57 A12 12 0 0 1 40 57 C40 49 47 43 52 34 Z" fill="#FF5D15" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
        </svg>
      </span>
      <p><strong>Lubricenter {locationName}.</strong> Los indicadores provienen de las operaciones registradas. Los saldos bancarios requieren conciliación independiente.</p>
    </footer>
  </main>;
}

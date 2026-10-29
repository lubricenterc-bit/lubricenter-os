"use client";

import { useEffect, useRef, useState } from "react";
import { BrandIcon, Gotin, useLive } from "@/components/gotin";
import { OsHome, type HomeBoardRow, type HomeDashboard } from "@/components/os-home";
import { OsDock, OsHeader, OsSubnav } from "@/components/os-navigation";
import { OsIcon } from "@/components/os-icon";
import { BRAND_ICONS, type BrandIconName, type GotinPose } from "@/lib/brand-art";

const PREVIEW: HomeDashboard = {
  localDate: "2026-10-28", closedOrdersToday: 6, salesRefToday: 1284.5, collectedRefToday: 1098,
  openOrders: 8, activeVehicles: 11, received: 3, diagnosis: 2, inProgress: 4,
  waitingParts: 1, ready: 1, postService: 3, maintenanceDue: 5, maintenanceSoon: 8,
  receivablesOpen: 4, receivablesOutstandingVes: 43820, payrollPendingRef: 0,
  inventoryReview: 2, inventoryNegative: 0, bcv: 218.45, operative: 262,
};

const SAMPLE: [string, string, string | null, string | null, string | null, number][] = [
  ["RECEIVED", "OS-000341", "AB123CD", "Toyota", "Corolla", 12],
  ["RECEIVED", "OS-000342", "AF908KL", "Chery", "Orinoco", 25],
  ["RECEIVED", "OS-000343", null, null, null, 4],
  ["DIAGNOSIS", "OS-000336", "AC456EF", "Chevrolet", "Aveo", 48],
  ["DIAGNOSIS", "OS-000338", "AE771PR", "Ford", "Fiesta", 31],
  ["IN_PROGRESS", "OS-000330", "AG220TX", "Toyota", "Hilux", 95],
  ["IN_PROGRESS", "OS-000332", "AA314MN", "Hyundai", "Getz", 40],
  ["IN_PROGRESS", "OS-000333", "AD657WE", "Mitsubishi", "Lancer", 22],
  ["IN_PROGRESS", "OS-000335", "AH009BC", "Kia", "Rio", 9],
  ["WAITING_PART", "OS-000321", "AB880QS", "Renault", "Logan", 1460],
  ["READY", "OS-000327", "AF145ZD", "Fiat", "Palio", 18],
];

const LABELS: Record<string, string> = {
  "/": "Inicio", "/quote": "Cotizar", "/quote/oil": "Comparar aceites", "/quick-sale": "Venta rápida",
  "/orders/new": "Recibir vehículo", "/orders": "Órdenes", "/workshop": "Taller", "/catalog": "Catálogo",
  "/customers": "Clientes", "/cash-close": "Cerrar caja", "/finance": "Finanzas", "/settings": "Tasas y precios",
  "/receivables": "Crédito LC", "/reminders": "Recordatorios", "/expenses": "Compras",
  "/finance/reconcile": "Conciliación", "/finance/inbox": "Casos financieros", "/inventory": "Inventario",
};

const POSES: [GotinPose, string][] = [
  ["wave", "Saluda al entrar"], ["hold", "Acompaña el inicio"], ["can", "Vende el aceite"], ["clip", "Cotiza"],
  ["point", "Señala lo que falta"], ["flag", "Avisa que está listo"], ["cheer", "Celebra la venta"],
  ["shrug", "No encontró nada"], ["idle", "Espera"],
];

const ICONS = Object.keys(BRAND_ICONS) as BrandIconName[];

export default function DesignLabPage() {
  const [pathname, setPathname] = useState("/");
  const [notice, setNotice] = useState("");
  const [board, setBoard] = useState<HomeBoardRow[]>([]);
  const timer = useRef(0);
  const posesLive = useLive<HTMLDivElement>();

  // Las horas de ejemplo se calculan al montar para que el servidor y el navegador coincidan.
  useEffect(() => {
    const now = Date.now();
    setBoard(SAMPLE.map(([status, number, plate, make, model, minutes], index) => ({
      id: String(index), order_number: number, workflow_status: status,
      workflow_updated_at: new Date(now - minutes * 60000).toISOString(),
      plate, make, model, is_walk_in: !plate, customer_name: plate ? null : "Servicio rápido", service_areas: "OIL_CHANGE",
    })));
  }, []);

  function say(text: string) {
    setNotice(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(""), 3600);
  }
  function preview(href: string) {
    const top = "/" + (href.split("/")[1] ?? "");
    setPathname(top === "/" ? "/" : top);
    say(`${LABELS[href] ?? href}: en la aplicación abre la pantalla real.`);
  }

  return <div className="shell os-theme os-shell os-lab">
    <div className="os-lab-ribbon"><strong>Vitrina de marca</strong><span>Datos de ejemplo. La aplicación conserva tus datos, flujos y reglas.</span></div>
    <div className="os-workspace">
      <OsHeader pathname={pathname} role="ADMIN" roleLoaded unread={2} onNavigate={preview}
        onSearch={() => say("Ctrl K abre el buscador de funciones.")} onMenu={() => say("El menú reúne todos los módulos y la sesión.")} />
      <OsSubnav pathname={pathname} role="ADMIN" onNavigate={preview} />
      <div className="os-workspace-content">
        <OsHome data={PREVIEW} board={board} owner locationName="Cabudare" loading={false} error=""
          onRefresh={() => say("Resumen actualizado para la demostración.")} onNavigate={preview} />

        <section className="container os-lab-brand" aria-labelledby="os-lab-title">
          <div className="os-section-head"><h2 id="os-lab-title">Gotín y sus piezas<span>La gota del logo, con guantes blancos y ojos de pastel</span></h2></div>
          <div className="os-lab-poses" ref={posesLive}>
            {POSES.map(([pose, label]) => <figure key={pose}>
              <Gotin pose={pose} />
              <figcaption><b>{pose}</b>{label}</figcaption>
            </figure>)}
          </div>
          <div className="os-lab-icons">
            {ICONS.map(name => <span key={name} className="hov" title={name}><BrandIcon name={name} /><small>{name}</small></span>)}
          </div>
        </section>
      </div>
      <OsDock pathname={pathname} onNavigate={preview}
        onSearch={() => say("Ctrl K abre el buscador de funciones.")} onMenu={() => say("El menú reúne todos los módulos y la sesión.")} />
    </div>
    {notice && <div className="os-lab-toast" role="status"><OsIcon name="check" size={18} />{notice}
      <button type="button" onClick={() => setNotice("")} aria-label="Cerrar"><OsIcon name="close" size={16} /></button></div>}
  </div>;
}

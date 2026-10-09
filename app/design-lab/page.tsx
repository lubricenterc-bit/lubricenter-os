"use client";

import { useState } from "react";
import { MesaHome, type MesaDashboard } from "@/components/mesa-home";
import { MesaDock, MesaHeader } from "@/components/mesa-navigation";
import { OsIcon } from "@/components/os-icon";

const PREVIEW: MesaDashboard = {
  localDate: "2026-10-09", closedOrdersToday: 6, salesRefToday: 1284.5, collectedRefToday: 1098,
  openOrders: 8, activeVehicles: 11, received: 3, diagnosis: 2, inProgress: 4,
  waitingParts: 2, ready: 2, postService: 3, maintenanceDue: 5, maintenanceSoon: 8,
  receivablesOpen: 4, receivablesOutstandingVes: 43820, payrollPendingRef: 0,
  inventoryReview: 2, inventoryNegative: 0, bcv: 246.62, operative: 288.4,
};

const LABELS: Record<string, string> = {
  "/": "Inicio", "/quote": "Cotizador general", "/quote/oil": "Comparador de aceites",
  "/quick-sale": "Venta rápida", "/orders/new": "Recibir vehículo", "/orders": "Órdenes",
  "/workshop": "Taller", "/catalog": "Catálogo Notion", "/customers": "Clientes",
  "/cash-close": "Caja", "/finance": "Finanzas", "/settings": "Configuración",
  "/receivables": "Crédito LC", "/reminders": "Recordatorios", "/expenses": "Compras",
  "/finance/reconcile": "Conciliación", "/finance/inbox": "Casos financieros",
};

export default function DesignLabPage() {
  const [notice, setNotice] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  function preview(href: string) {
    setNotice(`${LABELS[href] ?? href}: este acceso abre la pantalla real al entrar al sistema.`);
    window.setTimeout(() => setNotice(""), 3600);
  }
  return <div className="mesa-theme mesa-shell mesa-preview">
    <div className="mesa-preview-ribbon"><strong>VISTA PREVIA · MESA LC</strong><span>Datos de ejemplo; la aplicación real conserva tus datos y flujos.</span></div>
    <MesaHeader pathname="/" role="ADMIN" roleLoaded locationName="Cabudare" unread={2}
      onSearch={() => setSearchOpen(true)} onMenu={() => setMenuOpen(true)} onNavigate={preview}/>
    <div className="mesa-workspace-content">
      <MesaHome data={PREVIEW} owner locationName="Cabudare" loading={false} error=""
        onRefresh={() => setNotice("Resumen actualizado para la demostración.")} onNavigate={preview}/>
    </div>
    <MesaDock pathname="/" onSearch={() => setSearchOpen(true)} onMenu={() => setMenuOpen(true)} onNavigate={preview}/>
    {notice && <div className="mesa-preview-toast" role="status"><OsIcon name="check" size={18}/>{notice}<button onClick={() => setNotice("")} aria-label="Cerrar"><OsIcon name="close" size={16}/></button></div>}
    {searchOpen && <div className="mesa-preview-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
      <section className="mesa-preview-modal" role="dialog" aria-modal="true" aria-label="Buscar una función">
        <header><span><OsIcon name="search"/> Buscar una función</span><button onClick={() => setSearchOpen(false)} aria-label="Cerrar"><OsIcon name="close"/></button></header>
        <input autoFocus placeholder="Prueba con cotizar, taller, caja…"/>
        <div>{["Cotizador general", "Venta rápida", "Recibir vehículo", "Comparador de aceites"].map(item => <button key={item} onClick={() => { setSearchOpen(false); setNotice(`${item}: acceso disponible en la aplicación real.`); }}>{item}<OsIcon name="arrow" size={17}/></button>)}</div>
      </section>
    </div>}
    {menuOpen && <div className="mesa-preview-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>
      <section className="mesa-preview-menu" role="dialog" aria-modal="true" aria-label="Todos los módulos">
        <header><div><small>MESA DE TRABAJO</small><h2>Todos los módulos.</h2></div><button onClick={() => setMenuOpen(false)} aria-label="Cerrar"><OsIcon name="close"/></button></header>
        <div>{["Ventas", "Taller", "Clientes y CRM", "Inventario", "Finanzas", "Administración"].map((item, index) => <button key={item} onClick={() => { setMenuOpen(false); setNotice(`${item}: módulo disponible según el rol del usuario.`); }}><span>0{index + 1}</span>{item}<OsIcon name="arrow" size={17}/></button>)}</div>
        <footer>Administración · Cabudare</footer>
      </section>
    </div>}
  </div>;
}

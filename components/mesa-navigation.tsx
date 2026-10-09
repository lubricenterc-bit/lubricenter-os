"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import { NAV_MODULES, linksForModule, type NavigationRole } from "@/lib/navigation";

type MesaNavigationProps = {
  pathname: string;
  onSearch: () => void;
  onMenu: () => void;
  /** Intercepts navigation only when a presentation preview supplies it. */
  onNavigate?: (href: string) => void;
  menuOpen?: boolean;
};

export type MesaHeaderProps = MesaNavigationProps & {
  role?: NavigationRole;
  roleLoaded?: boolean;
  locationName?: string;
  unread?: number;
  children?: ReactNode;
};

function previewNavigation(event: MouseEvent<HTMLAnchorElement>, href: string, onNavigate?: (href: string) => void) {
  if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate(href);
}

function activePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

/** The real application masthead; also used by the isolated visual preview. */
export function MesaHeader({
  pathname, onSearch, onMenu, onNavigate, menuOpen = false,
  role = "OPERATOR", roleLoaded = true, locationName = "Cabudare", unread = 0, children,
}: MesaHeaderProps) {
  const owner = role === "OWNER" || role === "ADMIN";
  const allowed = new Set(NAV_MODULES.flatMap(module => linksForModule(module, role).map(link => link.href)));
  const links: { href: string; label: string; icon: OsIconName }[] = [
    { href: "/customers", label: "Clientes", icon: "customers" },
    { href: "/workshop", label: "Taller", icon: "workshop" },
    { href: "/cash-close", label: "Caja", icon: "cash" },
  ];

  return <header className="mesa-masthead">
    <Link href="/" className="mesa-lockup" aria-label="Lubricenter OS, inicio" onClick={event => previewNavigation(event, "/", onNavigate)}>
      <span className="mesa-monogram" aria-hidden="true">LC</span>
      <span className="mesa-lockup-name">LUBRICENTER OS</span>
    </Link>
    <div className="mesa-workspace-label">MESA DE TRABAJO<span>{locationName}</span></div>
    <button type="button" className="mesa-search" onClick={onSearch} aria-label="Buscar una función, Control K">
      <OsIcon name="search" size={20} />
      <span>Buscar una función…</span>
      <kbd>Ctrl K</kbd>
    </button>
    <nav className="mesa-masthead-links" aria-label="Áreas principales">
      {links.filter(link => allowed.has(link.href)).map(link => <Link key={link.href} href={link.href}
        className={activePath(pathname, link.href) ? "is-active" : undefined}
        aria-current={activePath(pathname, link.href) ? "page" : undefined}
        onClick={event => previewNavigation(event, link.href, onNavigate)}>
        <OsIcon name={link.icon} size={20} /><span>{link.label}</span>
      </Link>)}
    </nav>
    <div className="mesa-session-tools">
      {children && <div className="mesa-pricing">{children}</div>}
      {owner && <Link href="/finance" className="mesa-notifications" title="Avisos financieros"
        aria-label={"Avisos financieros, " + unread + " pendientes"}
        onClick={event => previewNavigation(event, "/finance", onNavigate)}>
        <OsIcon name="bell" size={19} />{unread > 0 && <span>{unread > 9 ? "9+" : unread}</span>}
      </Link>}
      <button type="button" className="mesa-profile" onClick={onMenu} aria-label="Abrir perfil y todos los módulos"
        aria-expanded={menuOpen} aria-controls="mesa-modules" aria-haspopup="dialog">
        <span className="mesa-profile-avatar">{!roleLoaded ? "…" : owner ? "AD" : "OP"}</span>
        <OsIcon name="down" size={16} />
      </button>
    </div>
  </header>;
}

export function MesaDock({ pathname, onSearch, onMenu, onNavigate, menuOpen = false }: MesaNavigationProps) {
  const links: { href: string; label: string; detail: string; icon: OsIconName }[] = [
    { href: "/quote", label: "Cotizar", detail: "Nueva cotización", icon: "receipt" },
    { href: "/quick-sale", label: "Vender", detail: "Venta rápida", icon: "sale" },
    { href: "/orders/new", label: "Recibir", detail: "Vehículo", icon: "car" },
  ];
  return <nav className="mesa-dock" aria-label="Accesos de la mesa de trabajo">
    <Link href="/" className={"mesa-dock-utility" + (pathname === "/" ? " is-active" : "")}
      aria-label="Inicio" aria-current={pathname === "/" ? "page" : undefined}
      onClick={event => previewNavigation(event, "/", onNavigate)}><OsIcon name="home" size={21} /></Link>
    {links.map(link => <Link key={link.href} href={link.href}
      className={"mesa-dock-action" + (activePath(pathname, link.href) ? " is-active" : "")}
      aria-current={activePath(pathname, link.href) ? "page" : undefined}
      onClick={event => previewNavigation(event, link.href, onNavigate)}>
      <span className="mesa-dock-icon"><OsIcon name={link.icon} size={25} /></span>
      <span className="mesa-dock-copy"><strong>{link.label}</strong><small>{link.detail}</small></span>
    </Link>)}
    <button type="button" className="mesa-dock-action" onClick={onSearch} aria-label="Buscar una función">
      <span className="mesa-dock-icon"><OsIcon name="search" size={25} /></span>
      <span className="mesa-dock-copy"><strong>Buscar</strong><small>Módulos y herramientas</small></span>
    </button>
    <button type="button" className="mesa-dock-utility" onClick={onMenu} aria-label="Todos los módulos"
      aria-expanded={menuOpen} aria-controls="mesa-modules" aria-haspopup="dialog"><OsIcon name="menu" size={21} /></button>
  </nav>;
}

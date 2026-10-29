"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import { ATTENDANTS, useAttendant, writeAttendant } from "@/components/attendant-picker";
import { BrandIcon, replay } from "@/components/gotin";
import { NAV_MODULES, linksForModule, moduleForPath, type NavigationRole } from "@/lib/navigation";

type NavigationProps = {
  pathname: string;
  onSearch: () => void;
  onMenu: () => void;
  /** Solo la vitrina de marca intercepta la navegación. */
  onNavigate?: (href: string) => void;
  menuOpen?: boolean;
};

export type OsHeaderProps = NavigationProps & {
  role?: NavigationRole;
  roleLoaded?: boolean;
  unread?: number;
  children?: ReactNode;
};

function intercept(event: MouseEvent<HTMLAnchorElement>, href: string, onNavigate?: (href: string) => void) {
  if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate(href);
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Cabecera de la aplicación: logo, módulos con la gota que marca dónde estás, buscador y quién atiende. */
export function OsHeader({ pathname, onSearch, onMenu, onNavigate, menuOpen = false, role = "OPERATOR", roleLoaded = true, unread = 0, children }: OsHeaderProps) {
  const owner = role === "OWNER" || role === "ADMIN";
  const current = moduleForPath(pathname);
  const modules = NAV_MODULES.filter(module => linksForModule(module, role).length > 0);
  const navRef = useRef<HTMLElement>(null);
  const dropRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  const moveDrop = useCallback(() => {
    const nav = navRef.current, drop = dropRef.current;
    const active = nav?.querySelector<HTMLAnchorElement>('a[data-current="true"]');
    if (!nav || !drop || !active) { if (drop) drop.style.opacity = "0"; return; }
    const x = active.offsetLeft + active.offsetWidth / 2 - 6;
    if (!placed.current) drop.style.transition = "none";
    drop.style.transform = `translateX(${x}px)`;
    drop.style.opacity = "1";
    if (!placed.current) { void drop.offsetWidth; drop.style.transition = ""; placed.current = true; }
    else window.setTimeout(() => replay(drop, "is-landing", 600), 320);
  }, []);
  useIsoLayoutEffect(() => { moveDrop(); }, [current.id, moveDrop]);
  useEffect(() => {
    const onResize = () => { placed.current = false; moveDrop(); };
    window.addEventListener("resize", onResize);
    document.fonts?.ready.then(onResize).catch(() => undefined);
    return () => window.removeEventListener("resize", onResize);
  }, [moveDrop]);

  return <header className="os-masthead">
    <div className="os-masthead-in">
      <Link href="/" className="os-lockup" aria-label="Lubricenter OS, inicio" onClick={event => intercept(event, "/", onNavigate)}>
        <span className="os-wordmark" aria-hidden="true" />
      </Link>
      <nav ref={navRef} className="os-modules" aria-label="Módulos">
        {modules.map(module => {
          const active = module.id === current.id;
          return <Link key={module.id} href={module.defaultHref} data-current={active}
            aria-current={active ? "page" : undefined} className={active ? "is-active" : undefined}
            onClick={event => intercept(event, module.defaultHref, onNavigate)}>{module.label}</Link>;
        })}
        <span ref={dropRef} className="os-nav-drop" aria-hidden="true"><BrandIcon name="drop" /></span>
      </nav>
      <div className="os-tools">
        <button type="button" className="os-find" onClick={onSearch} aria-label="Buscar una función, Control K">
          <OsIcon name="search" size={19} /><span>Buscar</span><kbd>Ctrl K</kbd>
        </button>
        {children && <div className="os-pricing-slot">{children}</div>}
        {owner && <Link href="/finance" className="os-bell" title="Avisos financieros"
          aria-label={"Avisos financieros, " + unread + " pendientes"} onClick={event => intercept(event, "/finance", onNavigate)}>
          <OsIcon name="bell" size={19} />{unread > 0 && <span>{unread > 9 ? "9+" : unread}</span>}
        </Link>}
        <AttendantMenu />
        <button type="button" className="os-profile" onClick={onMenu} aria-label="Abrir todos los módulos y la sesión"
          aria-expanded={menuOpen} aria-controls="os-modules-drawer" aria-haspopup="dialog">
          <span className="os-mono">{!roleLoaded ? "…" : owner ? "AD" : "OP"}</span>
          <OsIcon name="menu" size={18} />
        </button>
      </div>
    </div>
  </header>;
}

/** Accesos de la sección actual, siempre a la vista bajo la cabecera. */
export function OsSubnav({ pathname, role = "OPERATOR", onNavigate }: { pathname: string; role?: NavigationRole; onNavigate?: (href: string) => void }) {
  const module = moduleForPath(pathname);
  const links = linksForModule(module, role);
  if (module.id === "home" || links.length < 2) return null;
  const active = links.filter(link => pathname === link.href || pathname.startsWith(link.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return <nav className="os-subnav" aria-label={"Secciones de " + module.label}>
    <div className="os-subnav-in">
      {links.map(link => <Link key={link.href} href={link.href} title={link.description}
        className={link.href === active ? "is-active" : undefined} aria-current={link.href === active ? "page" : undefined}
        onClick={event => intercept(event, link.href, onNavigate)}>{link.label}</Link>)}
    </div>
  </nav>;
}

/** Quién atiende: se recuerda en este equipo y cada venta lo guarda. */
export function AttendantMenu() {
  const current = useAttendant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return <div className="os-who" ref={ref}>
    <button type="button" className="os-who-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className={"os-mono" + (current ? "" : " is-empty")}>{current ? current.slice(0, 2).toUpperCase() : "?"}</span>
      <span className="os-who-copy"><small>Atiende</small>{current || "Elegir"}</span>
    </button>
    {open && <div className="os-who-menu" role="menu" aria-label="Quién atiende">
      {ATTENDANTS.map(name => <button key={name} type="button" role="menuitemradio" aria-checked={current === name}
        onClick={() => { writeAttendant(name); setOpen(false); }}>
        <span className="os-mono">{name.slice(0, 2).toUpperCase()}</span>{name}
      </button>)}
      <p>Se recuerda en este equipo y queda guardado en cada venta.</p>
    </div>}
  </div>;
}

/** Barra inferior en el teléfono: las cuatro acciones del mostrador y el menú. */
export function OsDock({ pathname, onSearch, onMenu, onNavigate, menuOpen = false }: NavigationProps) {
  const links: { href: string; label: string; icon: OsIconName }[] = [
    { href: "/", label: "Inicio", icon: "home" },
    { href: "/quick-sale", label: "Vender", icon: "sale" },
    { href: "/orders/new", label: "Recibir", icon: "car" },
    { href: "/workshop", label: "Taller", icon: "workshop" },
  ];
  const active = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
  return <nav className="os-dock" aria-label="Accesos rápidos">
    {links.map(link => <Link key={link.href} href={link.href} className={active(link.href) ? "is-active" : undefined}
      aria-current={active(link.href) ? "page" : undefined} onClick={event => intercept(event, link.href, onNavigate)}>
      <OsIcon name={link.icon} size={22} /><span>{link.label}</span>
    </Link>)}
    <button type="button" onClick={onSearch} aria-label="Buscar una función"><OsIcon name="search" size={22} /><span>Buscar</span></button>
    <button type="button" onClick={onMenu} aria-label="Todos los módulos" aria-expanded={menuOpen} aria-controls="os-modules-drawer" aria-haspopup="dialog">
      <OsIcon name="menu" size={22} /><span>Menú</span>
    </button>
  </nav>;
}

/** Atajos del mostrador: F2 vender, F3 recibir, F4 cotizar, F6 taller. */
export const SHORTCUTS: Record<string, string> = { F2: "/quick-sale", F3: "/orders/new", F4: "/quote", F6: "/workshop" };

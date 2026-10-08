"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { PricingStatus } from "@/components/pricing-status";
import { OsIcon } from "@/components/os-icon";
import { AppSessionProvider } from "@/components/app-session-context";
import {
  NAV_MODULES, linksForModule, moduleForPath, navigationSearch, pageLabelForPath,
  type NavigationRole,
} from "@/lib/navigation";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const currentModule = moduleForPath(pathname);
  const currentPage = pageLabelForPath(pathname);
  const [role, setRole] = useState<NavigationRole>("OPERATOR");
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [locationName, setLocationName] = useState("Cabudare");
  const [otherLocations, setOtherLocations] = useState(false);
  const [expanded, setExpanded] = useState(currentModule.id);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [unread, setUnread] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const owner = role === "OWNER" || role === "ADMIN";
  const results = useMemo(() => navigationSearch(search, role), [search, role]);

  useEffect(() => {
    let active = true;
    async function loadIdentity() {
      const [member, locations] = await Promise.all([
        supabase.rpc("finance_role"),
        supabase.from("locations").select("id,name").eq("active", true).order("created_at").limit(2),
      ]);
      if (!active) return;
      const value = member.data;
      setRole(value === "OWNER" || value === "ADMIN" ? value : "OPERATOR");
      setRoleLoaded(true);
      if (!locations.error && locations.data?.length) {
        setLocationName(locations.data[0].name.replace(/^Lubricenter\s*/i, "") || "Cabudare");
        setOtherLocations(locations.data.length > 1);
      }
    }
    void loadIdentity();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setExpanded(moduleForPath(pathname).id);
    setMobileMenu(false);
    setSearchOpen(false);
    setSearch("");
  }, [pathname]);

  useEffect(() => {
    if (!owner || pathname === "/login") return;
    let active = true;
    async function refresh() {
      const { count, error } = await supabase.from("finance_cash_close_alerts")
        .select("id", { count: "exact", head: true }).is("read_at", null);
      if (active && !error) setUnread(count || 0);
    }
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [owner, pathname]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(value => !value);
      }
      if (event.key === "Escape") { setSearchOpen(false); setMobileMenu(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  async function signOut() {
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          await supabase.from("finance_push_subscriptions").delete().eq("endpoint", sub.endpoint);
          await sub.unsubscribe();
        }
      }
    } catch { /* Logout must continue if push cleanup is unavailable. */ }
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (pathname === "/login") return <>{children}</>;

  function linkActive(href: string) {
    if (href === "/") return pathname === "/";
    if (pathname === href) return true;
    if (!pathname.startsWith(href + "/")) return false;
    return !currentModule.links.some(link => link.href !== href && link.href.startsWith(href + "/") &&
      (pathname === link.href || pathname.startsWith(link.href + "/")));
  }

  return (
    <AppSessionProvider value={{ role, roleLoaded, locationName }}>
      <div className="shell os-layout">
        {mobileMenu && <button className="os-sidebar-scrim" aria-label="Cerrar menú" onClick={() => setMobileMenu(false)} />}
        <aside className={"os-sidebar" + (mobileMenu ? " is-open" : "")} aria-label="Panel de navegación">
          <div className="os-sidebar-brand">
            <Link href="/" className="os-brand" onClick={() => setMobileMenu(false)}>
              <img src="/lubricenter-lc-isotipo.png" alt="" />
              <span>Lubricenter <b>OS</b><small>WORKSPACE</small></span>
            </Link>
            <button className="os-sidebar-close" onClick={() => setMobileMenu(false)} aria-label="Cerrar menú"><OsIcon name="close"/></button>
          </div>
          <div className="os-location" title={otherLocations ? "El cambio de sucursal se habilitará cuando sus datos estén aislados." : "Sucursal operativa actual"}>
            <span className="os-location-mark"><OsIcon name="layers" size={17}/></span>
            <span><small>SUCURSAL ACTUAL</small><strong>{locationName}</strong></span>
            {otherLocations && <span className="os-location-lock" aria-label="Cambio de sucursal no disponible"><OsIcon name="shield" size={15}/></span>}
          </div>
          <nav className="os-navigation" aria-label="Módulos">
            <div className="os-nav-heading">ESPACIO DE TRABAJO</div>
            {NAV_MODULES.map(module => {
              const links = linksForModule(module, role);
              if (!links.length) return null;
              const isExpanded = expanded === module.id;
              const isCurrent = currentModule.id === module.id;
              return <div className="os-nav-group" key={module.id}>
                <button className={"os-nav-parent" + (isCurrent ? " is-current" : "")}
                  onClick={() => {
                    if (module.id === "home") { router.push("/"); setMobileMenu(false); }
                    else setExpanded(isExpanded ? "" : module.id);
                  }}
                  aria-expanded={module.id === "home" ? undefined : isExpanded}
                  aria-controls={module.id === "home" ? undefined : "os-nav-" + module.id}>
                  <OsIcon name={module.icon} size={19}/>
                  <span>{module.label}</span>
                  {module.id !== "home" && <OsIcon name="down" size={15} className={"os-nav-arrow" + (isExpanded ? " is-open" : "")}/>}
                </button>
                {module.id !== "home" && isExpanded && <div className="os-nav-children" id={"os-nav-" + module.id}>
                  {links.map(link => <Link key={link.href} href={link.href}
                    aria-current={linkActive(link.href) ? "page" : undefined}
                    className={"os-nav-child" + (linkActive(link.href) ? " is-active" : "")}
                    title={link.description} onClick={() => setMobileMenu(false)}>
                    {link.label}
                  </Link>)}
                </div>}
              </div>;
            })}
          </nav>
          <div className="os-sidebar-footer">
            <div className="os-sidebar-person">
              <span className="os-avatar"><OsIcon name="user" size={18}/></span>
              <span><strong>{!roleLoaded ? "Cargando..." : owner ? "Administración" : "Operación"}</strong>
                <small>{locationName}</small></span>
            </div>
            <button className="os-logout" onClick={signOut} title="Cerrar sesión"><OsIcon name="logout" size={17}/> Salir</button>
          </div>
        </aside>

        <div className="os-workspace">
          <header className="os-topbar">
            <div className="os-topbar-leading">
              <button className="os-icon-button os-mobile-menu" onClick={() => setMobileMenu(true)} aria-label="Abrir menú de módulos"><OsIcon name="menu"/></button>
              <div className="os-breadcrumb"><span>{currentModule.label}</span><OsIcon name="right" size={14}/><strong>{currentPage}</strong></div>
            </div>
            <div className="os-topbar-actions">
              <button className="os-search-trigger" onClick={() => setSearchOpen(true)} aria-label="Buscar una sección">
                <OsIcon name="search" size={18}/><span>Buscar función...</span><kbd>Ctrl K</kbd>
              </button>
              <div className="os-pricing"><PricingStatus /></div>
              {owner && <Link href="/finance" className="os-icon-button os-notification-button" title="Avisos financieros" aria-label={"Avisos financieros, " + unread + " pendientes"}><OsIcon name="bell" size={19}/>{unread > 0 && <span className="os-notification-count">{unread > 9 ? "9+" : unread}</span>}</Link>}
              <Link href="/orders/new" className="os-topbar-secondary"><OsIcon name="car" size={18}/> Nueva orden</Link>
              <Link href="/quick-sale" className="os-topbar-primary"><OsIcon name="plus" size={18}/> Venta rápida</Link>
            </div>
          </header>
          <div className="os-workspace-content">{children}</div>
        </div>

        <nav className="os-mobile-bottom" aria-label="Accesos principales">
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}><OsIcon name="home"/><span>Inicio</span></Link>
          <Link href="/quick-sale" aria-current={pathname === "/quick-sale" ? "page" : undefined}><OsIcon name="sale"/><span>Vender</span></Link>
          <Link href="/workshop" aria-current={currentModule.id === "workshop" ? "page" : undefined}><OsIcon name="workshop"/><span>Taller</span></Link>
          <Link href="/cash-close" aria-current={pathname.startsWith("/cash-close") ? "page" : undefined}><OsIcon name="cash"/><span>Caja</span></Link>
          <button onClick={() => setMobileMenu(true)} aria-label="Todos los módulos"><OsIcon name="menu"/><span>Menú</span></button>
        </nav>

        {searchOpen && <div className="os-command-scrim" onMouseDown={e => { if (e.target === e.currentTarget) setSearchOpen(false); }}>
          <section className="os-command" role="dialog" aria-modal="true" aria-label="Buscar función">
            <div className="os-command-input"><OsIcon name="search"/><input ref={searchRef} value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar módulo o herramienta..." aria-label="Buscar módulo o herramienta"
              onKeyDown={e => { if (e.key === "Enter" && results[0]) { e.preventDefault(); router.push(results[0].href); setSearchOpen(false); } }}/><button onClick={() => setSearchOpen(false)} aria-label="Cerrar buscador"><OsIcon name="close" size={18}/></button></div>
            <div className="os-command-results">
              {search.trim() === "" && <p className="os-command-hint">Prueba con «cierre», «Cashea», «clientes» o «proveedores».</p>}
              {search.trim() !== "" && !results.length && <p className="os-command-hint">No se encontraron secciones. Intenta con otra palabra.</p>}
              {results.map(item => <Link href={item.href} key={item.href} className="os-command-result" onClick={() => setSearchOpen(false)}>
                <span className="os-command-result-icon"><OsIcon name={item.icon}/></span>
                <span><strong>{item.label}</strong><small>{item.module} · {item.description}</small></span>
                <OsIcon name="arrow" size={17}/>
              </Link>)}
            </div>
            <footer className="os-command-footer">Enter para abrir el primer resultado · Esc para cerrar</footer>
          </section>
        </div>}
      </div>
    </AppSessionProvider>
  );
}

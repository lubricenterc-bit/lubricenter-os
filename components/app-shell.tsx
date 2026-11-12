"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAdministerOrders, clearSessionCache, financeRole, myProfile } from "@/lib/session-cache";
import { canOpenPath, firstName, homeFor, isSensitivePath, PROFILE_LABEL, type MyProfile } from "@/lib/profile";
import { SensitiveGate } from "@/components/sensitive-gate";
import { MechanicShell } from "@/components/mechanic/mechanic-shell";
import { ATTENDANTS, readAttendant, writeAttendant } from "@/components/attendant-picker";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { PricingStatus } from "@/components/pricing-status";
import { OsIcon } from "@/components/os-icon";
import { OsDock, OsHeader, OsSubnav, SHORTCUTS } from "@/components/os-navigation";
import { BrandIcon, Gotin, useLive } from "@/components/gotin";
import { AppSessionProvider } from "@/components/app-session-context";
import { BackButton } from "@/components/back-button";
import { PageStage, PullToRefresh, useScrollChrome } from "@/components/mobile-shell";
import { searchHelp } from "@/lib/help-topics";
import {
  NAV_MODULES, linksForModule, moduleForPath, navigationSearch, pageLabelForPath,
  type NavigationRole,
} from "@/lib/navigation";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicDesignLab = pathname === "/design-lab" && process.env.NEXT_PUBLIC_DESIGN_LAB_PUBLIC === "1";
  const router = useRouter();
  const currentModule = moduleForPath(pathname);
  const [role, setRole] = useState<NavigationRole>("OPERATOR");
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  // Edgar: hasta cuándo está abierto el módulo sensible actual (se cierra al salir de él).
  const [unlockedUntil, setUnlockedUntil] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [locationName, setLocationName] = useState("Cabudare");
  const [otherLocations, setOtherLocations] = useState(false);
  const [expanded, setExpanded] = useState(currentModule.id);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [unread, setUnread] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const commandRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [calm, setCalm] = useState(false);
  const commandLive = useLive<HTMLDivElement>();
  // Teléfono: la cabecera se esconde al bajar, y deslizar hacia abajo vuelve a cargar la pantalla.
  const shellRef = useRef<HTMLDivElement>(null);
  useScrollChrome(shellRef);
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshScreen = useCallback(() => setRefreshKey(value => value + 1), []);
  const owner = role === "OWNER" || role === "ADMIN";
  const staffProfile = profile?.profile;
  // Menú: Edgar ve también los módulos del dueño (le piden PIN al entrar).
  const navRole: NavigationRole = staffProfile === "ADMIN" ? "ADMIN" : role;
  const canOpen = useCallback((href: string) => canOpenPath(staffProfile, href), [staffProfile]);
  const results = useMemo(() => navigationSearch(search, navRole).filter(item => canOpen(item.href)), [search, navRole, canOpen]);
  const needsPin = staffProfile === "ADMIN" && isSensitivePath(pathname) && (unlockedUntil == null || unlockedUntil <= Date.now());
  const initials = profile && staffProfile !== "SHARED" ? firstName(profile.name).slice(0, 2).toUpperCase() : owner ? "AD" : "OP";
  const personLabel = profile && staffProfile !== "SHARED" ? `${firstName(profile.name)} · ${PROFILE_LABEL[profile.profile]}` : owner ? "Administración" : "Operación";
  // El buscador también responde «¿cómo hago…?» con los temas de la Ayuda.
  const helpResults = useMemo(() => search.trim().length > 1 ? searchHelp(search, role === "OWNER" || role === "ADMIN", 4) : [], [search, role]);

  useEffect(() => {
    let stored = false;
    try { stored = window.localStorage.getItem("lubricenter:calm-motion") === "1"; } catch { /* sin almacenamiento */ }
    setCalm(stored);
    document.documentElement.classList.toggle("calm-motion", stored);
  }, []);
  function toggleCalm() {
    const next = !calm;
    setCalm(next);
    document.documentElement.classList.toggle("calm-motion", next);
    try { window.localStorage.setItem("lubricenter:calm-motion", next ? "1" : "0"); } catch { /* sin almacenamiento */ }
  }

  useEffect(() => {
    if (publicDesignLab) return;
    let active = true;
    async function loadIdentity() {
      // Calienta la caché de sesión: las páginas que piden rol/permiso lo
      // reciben de memoria en vez de hacer otro viaje antes de cargar datos.
      const [member, locations, , me] = await Promise.all([
        financeRole(),
        supabase.from("locations").select("id,name").eq("active", true).order("created_at").limit(2),
        canAdministerOrders(),
        myProfile(),
      ]);
      if (!active) return;
      // Si la RPC falla (p. ej. la base aún no tiene la migración), todo sigue como antes.
      const person = me.data ?? null;
      setProfile(person);
      setProfileLoaded(true);
      if (person && (person.profile === "ADMIN" || person.profile === "RECEPTION")) {
        const name = firstName(person.name);
        if ((ATTENDANTS as readonly string[]).includes(name) && readAttendant() !== name) writeAttendant(name);
      }
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
  }, [publicDesignLab]);

  useEffect(() => {
    if (publicDesignLab) return;
    setExpanded(moduleForPath(pathname).id);
    setMobileMenu(false);
    setSearchOpen(false);
    setSearch("");
  }, [pathname, publicDesignLab]);

  // Cada perfil solo abre sus pantallas; lo demás lo lleva a su inicio.
  useEffect(() => {
    if (publicDesignLab || !profileLoaded || pathname === "/login") return;
    if (!canOpenPath(staffProfile, pathname)) router.replace(homeFor(staffProfile));
  }, [pathname, profileLoaded, staffProfile, publicDesignLab, router]);

  // Al salir de los módulos del dueño se cierran: la próxima entrada vuelve a pedir el PIN.
  useEffect(() => {
    if (staffProfile !== "ADMIN" || isSensitivePath(pathname) || unlockedUntil == null) return;
    setUnlockedUntil(null);
    clearSessionCache();
    void supabase.rpc("lock_sensitive");
  }, [pathname, staffProfile, unlockedUntil]);
  // Al vencer los 30 minutos, se vuelve a pedir.
  useEffect(() => {
    if (unlockedUntil == null) return;
    const wait = unlockedUntil - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => { clearSessionCache(); setTick(value => value + 1); }, wait + 500);
    return () => window.clearTimeout(timer);
  }, [unlockedUntil]);

  const alertsEnabled = !publicDesignLab && owner && pathname !== "/login";
  const refreshUnread = useCallback(async () => {
    const { count, error } = await supabase.from("finance_cash_close_alerts")
      .select("id", { count: "exact", head: true }).is("read_at", null);
    if (!error) setUnread(count || 0);
  }, []);
  // Sondeo de alertas: solo con la app visible y sin rehacer el temporizador en cada navegación.
  useVisiblePolling(refreshUnread, 60_000, { enabled: alertsEnabled, immediate: false });
  // Al cambiar de pantalla (p. ej. después de leer alertas) basta con un recuento puntual.
  useEffect(() => { if (alertsEnabled) void refreshUnread(); }, [pathname, alertsEnabled, refreshUnread]);

  useEffect(() => {
    if (publicDesignLab || pathname === "/login") return;
    const label = pageLabelForPath(pathname);
    document.title = label && label !== "Lubricenter OS" ? `${label} · Lubricenter OS` : "Lubricenter OS";
  }, [pathname, publicDesignLab]);

  useEffect(() => {
    if (publicDesignLab) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileMenu(false);
        setSearchOpen(value => !value);
      }
      if (event.key === "Escape") { setSearchOpen(false); setMobileMenu(false); }
      const target = SHORTCUTS[event.key];
      if (target && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setSearchOpen(false); setMobileMenu(false);
        router.push(target);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [publicDesignLab, router]);

  useEffect(() => {
    if (publicDesignLab || (!mobileMenu && !searchOpen)) return;
    const dialog = searchOpen ? commandRef.current : drawerRef.current;
    if (!dialog) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const workspace = workspaceRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    workspace?.setAttribute("inert", "");
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    )).filter(element => element.getClientRects().length > 0);
    (searchOpen ? searchRef.current : focusable()[0])?.focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const targets = focusable();
      if (!targets.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
      workspace?.removeAttribute("inert");
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [mobileMenu, searchOpen, publicDesignLab]);

  if (publicDesignLab) return <>{children}</>;

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
  // Páginas de impresión (recibo 58 mm): sin menú; AuthGuard sigue protegiéndolas.
  if (pathname.startsWith("/print/")) return <>{children}</>;
  // Cheo y Alexis: su propia app, sin el menú del mostrador.
  if (staffProfile === "MECHANIC" && profile) return <MechanicShell profile={profile} onSignOut={signOut}>
    {canOpenPath(staffProfile, pathname) ? children : null}</MechanicShell>;
  // Hasta saber quién es (una consulta), no se monta la pantalla: así un mecánico o la
  // tablet nunca ven por un instante algo que no les toca.
  const blocked = !profileLoaded || !canOpenPath(staffProfile, pathname);

  function linkActive(href: string) {
    if (href === "/") return pathname === "/";
    if (pathname === href) return true;
    if (!pathname.startsWith(href + "/")) return false;
    return !currentModule.links.some(link => link.href !== href && link.href.startsWith(href + "/") &&
      (pathname === link.href || pathname.startsWith(link.href + "/")));
  }

  return (
    <AppSessionProvider value={{ role, roleLoaded, locationName, profile }}>
      <div ref={shellRef} className="shell os-theme os-shell">
        <div ref={workspaceRef} className="os-workspace">
          <a className="os-skip-link" href="#os-main">Ir al contenido</a>
          <OsHeader pathname={pathname} onSearch={() => setSearchOpen(true)} onMenu={() => setMobileMenu(true)}
            role={navRole} roleLoaded={roleLoaded} unread={unread} menuOpen={mobileMenu}
            initials={profile && staffProfile !== "SHARED" && staffProfile !== "OWNER" ? initials : undefined} canOpen={canOpen}>
            <PricingStatus />
          </OsHeader>
          <OsSubnav pathname={pathname} role={navRole} canOpen={canOpen} />
          <div id="os-main" className="os-workspace-content" tabIndex={-1}>
            <Suspense fallback={null}><BackButton /></Suspense>
            <PageStage refreshKey={refreshKey}>{blocked ? null : needsPin
              ? <SensitiveGate key={pathname} unlockedUntil={unlockedUntil} onUnlock={setUnlockedUntil} moduleName={pageLabelForPath(pathname) || "Módulo del dueño"} />
              : children}</PageStage>
          </div>
          <PullToRefresh onRefresh={refreshScreen} />
          <OsDock pathname={pathname} onSearch={() => setSearchOpen(true)} onMenu={() => setMobileMenu(true)} menuOpen={mobileMenu} reception={staffProfile === "RECEPTION"} />
        </div>

        {mobileMenu && <div className="os-drawer-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setMobileMenu(false); }}>
          <section ref={drawerRef} className="os-drawer" id="os-modules-drawer" role="dialog" aria-modal="true" aria-labelledby="os-modules-title" tabIndex={-1}>
            <div className="os-drawer-heading">
              <div><h2 id="os-modules-title">Todos los módulos</h2><p>{locationName}{otherLocations ? ", otras sucursales se habilitan cuando sus datos estén aislados" : ""}</p></div>
              <button type="button" className="os-close" onClick={() => setMobileMenu(false)} aria-label="Cerrar menú"><OsIcon name="close"/></button>
            </div>
            <nav className="os-drawer-nav" aria-label="Todos los módulos">
            {NAV_MODULES.map(module => {
              const links = linksForModule(module, navRole).filter(link => canOpen(link.href));
              if (!links.length) return null;
              const isExpanded = expanded === module.id;
              const isCurrent = currentModule.id === module.id;
              return <div className="os-drawer-group" key={module.id}>
                <button type="button" className={"os-drawer-parent" + (isCurrent ? " is-current" : "")}
                  onClick={() => {
                    if (module.id === "home") { router.push("/"); setMobileMenu(false); }
                    else setExpanded(isExpanded ? "" : module.id);
                  }}
                  aria-expanded={module.id === "home" ? undefined : isExpanded}
                  aria-controls={module.id === "home" ? undefined : "os-nav-" + module.id}>
                  <OsIcon name={module.icon} size={20}/>
                  <span>{module.label}</span>
                  {module.id !== "home" && <OsIcon name="down" size={16} className={"os-drawer-arrow" + (isExpanded ? " is-open" : "")}/>}
                </button>
                {module.id !== "home" && isExpanded && <div className="os-drawer-children" id={"os-nav-" + module.id}>
                  {links.map(link => <Link key={link.href} href={link.href}
                    aria-current={linkActive(link.href) ? "page" : undefined}
                    className={"os-drawer-child" + (linkActive(link.href) ? " is-active" : "")}
                    title={link.description} onClick={() => setMobileMenu(false)}>
                    <span>{link.label}<small>{link.description}</small></span><OsIcon name="arrow" size={16}/>
                  </Link>)}
                </div>}
              </div>;
            })}
            </nav>
            <div className="os-drawer-footer">
              <label className="os-calm-toggle"><input type="checkbox" checked={calm} onChange={toggleCalm}/><span><strong>Animación tranquila</strong><small>Reduce el movimiento de Gotín y de los iconos en este equipo.</small></span></label>
              <div className="os-drawer-person"><span className="os-mono">{initials}</span><span><strong>{!roleLoaded ? "Cargando…" : personLabel}</strong><small>{locationName}</small></span>
                <button type="button" className="btn btn-ghost" onClick={signOut}><OsIcon name="logout" size={17}/> Salir</button></div>
            </div>
          </section>
        </div>}

        {searchOpen && <div className="os-command-scrim" onMouseDown={e => { if (e.target === e.currentTarget) setSearchOpen(false); }}>
          <section ref={commandRef} className="os-command" role="dialog" aria-modal="true" aria-label="Buscar función" tabIndex={-1}>
            <div className="os-command-input"><OsIcon name="search"/><input ref={searchRef} value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar módulo o herramienta…" aria-label="Buscar módulo o herramienta"
              onKeyDown={e => {
                const first = results[0]?.href ?? (helpResults[0] ? "/ayuda#" + helpResults[0].id : null);
                if (e.key === "Enter" && first) { e.preventDefault(); router.push(first); setSearchOpen(false); }
              }}/><button onClick={() => setSearchOpen(false)} aria-label="Cerrar buscador"><kbd>Esc</kbd></button></div>
            <div className="os-command-results" ref={commandLive}>
              {search.trim() === "" && <div className="os-command-start">
                <p>Atajos del mostrador</p>
                {([["F2", "Venta rápida", "/quick-sale", "can"], ["F3", "Recibir vehículo", "/orders/new", "car"], ["F4", "Cotizar", "/quote", "clip"], ["F6", "Taller", "/workshop", "wrench"]] as const).filter(([, , href]) => canOpen(href)).map(([key, label, href, icon]) =>
                  <Link key={href} href={href} className="os-command-result hov" onClick={() => setSearchOpen(false)}>
                    <span className="os-command-result-icon"><BrandIcon name={icon}/></span><span><strong>{label}</strong><small>Atajo {key}</small></span><kbd>{key}</kbd>
                  </Link>)}
                <p className="os-command-hint">También puedes escribir «cierre», «Cashea», «clientes» o «proveedores».</p>
              </div>}
              {search.trim() !== "" && !results.length && !helpResults.length && <div className="os-command-empty"><Gotin pose="shrug" className="os-command-gotin"/><p>No encontré «{search.trim()}». Intenta con otra palabra.</p></div>}
              {results.map(item => <Link href={item.href} key={item.href} className="os-command-result" onClick={() => setSearchOpen(false)}>
                <span className="os-command-result-icon"><OsIcon name={item.icon}/></span>
                <span><strong>{item.label}</strong><small>{item.module}. {item.description}</small></span>
                <OsIcon name="arrow" size={17}/>
              </Link>)}
              {helpResults.length > 0 && <p className="os-command-section">En la ayuda</p>}
              {helpResults.map(topic => <Link href={"/ayuda#" + topic.id} key={"ayuda-" + topic.id} className="os-command-result" onClick={() => setSearchOpen(false)}>
                <span className="os-command-result-icon"><OsIcon name="help"/></span>
                <span><strong>{topic.question}</strong><small>{topic.steps[0]}</small></span>
                <OsIcon name="arrow" size={17}/>
              </Link>)}
            </div>
            <footer className="os-command-footer"><span><kbd>Enter</kbd> abre el primero</span><span><kbd>Esc</kbd> cierra</span></footer>
          </section>
        </div>}
      </div>
    </AppSessionProvider>
  );
}

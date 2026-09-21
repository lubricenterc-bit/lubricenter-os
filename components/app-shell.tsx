"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { PricingStatus } from "@/components/pricing-status";

const nav = [
  ["/", "⌂", "Inicio"],
  ["/quick-sale", "▣", "Vender"],
  ["/orders", "▤", "Órdenes"],
  ["/workshop", "⚒", "Taller"],
  ["/customers", "◎", "Clientes"],
  ["/receivables", "◌", "Cobros"],
  ["/finance", "▥", "Finanzas"],
  ["/more", "•••", "Más"],
] as const;

const financePaths = ["/finance", "/receivables", "/cash", "/cashea", "/expenses", "/suppliers", "/purchases", "/cash-close"];
const morePaths = ["/inventory", "/payroll", "/settings", "/more"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return <>{children}</>;

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    if (href === "/quick-sale") return pathname.startsWith("/quick-sale");
    if (href === "/orders") return pathname.startsWith("/orders");
    if (href === "/workshop") return pathname.startsWith("/workshop");
    if (href === "/customers") return pathname.startsWith("/customers") || pathname.startsWith("/vehicles") || pathname.startsWith("/reminders");
    if (href === "/receivables") return pathname.startsWith("/receivables");
    if (href === "/finance") return financePaths.some(p => pathname === p || pathname.startsWith(`${p}/`));
    if (href === "/more") return morePaths.some(p => pathname === p || pathname.startsWith(`${p}/`));
    return false;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand brand-lockup">
          <img src="/lubricenter-lc-isotipo.png" alt="Lubricenter" />
          <span className="brand-copy">Lubricenter <b>OS</b></span>
        </Link>
        <div className="row topbar-actions"><Link className="btn btn-primary" href="/orders/new">+ Nueva orden</Link><PricingStatus /><button className="btn btn-ghost" onClick={async () => { await supabase.auth.signOut(); router.replace("/login"); }}>Salir</button></div>
      </header>
      {children}
      <nav className="nav" aria-label="Navegación principal">
        <div className="nav-primary">
          {nav.map(([href, icon, label]) => <Link key={href} href={href} aria-current={isActive(href) ? "page" : undefined} className={isActive(href) ? "nav-active" : ""}><strong aria-hidden="true">{icon}</strong><span>{label}</span></Link>)}
        </div>
        <div className="nav-shortcuts" aria-label="Accesos de dinero">
          <span>CONTROL DIARIO</span>
          <Link href="/cash"><b aria-hidden="true">▤</b> Caja</Link>
          <Link href="/expenses"><b aria-hidden="true">↗</b> Egresos</Link>
          <Link href="/cash-close"><b aria-hidden="true">✓</b> Cuadre</Link>
        </div>
      </nav>
    </div>
  );
}


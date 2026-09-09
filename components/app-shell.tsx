"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { PricingStatus } from "@/components/pricing-status";

const nav = [
  ["/", "⌂", "Inicio"],
  ["/orders/new", "+", "Orden"],
  ["/workshop", "⚒", "Taller"],
  ["/reminders", "♡", "CRM"],
  ["/more", "•••", "Más"],
] as const;

const morePaths = ["/customers", "/inventory", "/receivables", "/cash", "/payroll", "/settings", "/more"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return <>{children}</>;

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    if (href === "/orders/new") return pathname.startsWith("/orders");
    if (href === "/workshop") return pathname.startsWith("/workshop");
    if (href === "/reminders") return pathname.startsWith("/reminders");
    if (href === "/more") return morePaths.some(p => pathname === p || pathname.startsWith(`${p}/`));
    return false;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand brand-lockup">
          <img src="/lubricenter-logo.png" alt="Lubricenter" />
          <span className="brand-copy">Lubricenter <b>OS</b></span>
        </Link>
        <div className="row"><PricingStatus /><button className="btn btn-ghost" onClick={async () => { await supabase.auth.signOut(); router.replace("/login"); }}>Salir</button></div>
      </header>
      {children}
      <nav className="nav">
        {nav.map(([href, icon, label]) => <Link key={href} href={href} className={isActive(href) ? "nav-active" : ""}><strong>{icon}</strong>{label}</Link>)}
      </nav>
    </div>
  );
}

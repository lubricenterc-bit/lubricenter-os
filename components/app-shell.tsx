"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { PricingStatus } from "@/components/pricing-status";

const nav = [
  ["/", "⌂", "Inicio"],
  ["/orders/new", "+", "Orden"],
  ["/workshop", "⚒", "Taller"],
  ["/orders", "▤", "Órdenes"],
  ["/inventory", "▦", "Inventario"],
  ["/customers", "◉", "Clientes"],
  ["/reminders", "♡", "CRM"],
  ["/receivables", "₿", "Cobros"],
  ["/cash", "▣", "Caja"],
  ["/payroll", "$", "Nómina"],
  ["/settings", "⚙", "Config"],
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return <>{children}</>;

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
        {nav.map(([href, icon, label]) => {
          const active = href === "/orders"
            ? pathname === "/orders" || (pathname.startsWith("/orders/") && pathname !== "/orders/new")
            : pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
          return <Link key={href} href={href} className={active ? "nav-active" : ""}><strong>{icon}</strong>{label}</Link>;
        })}
      </nav>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

const nav = [
  ["/", "⌂", "Inicio"],
  ["/orders/new", "+", "Orden"],
  ["/orders", "▤", "Órdenes"],
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
        <Link href="/" className="brand">Lubricenter<span>.</span> OS</Link>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            await supabase.auth.signOut();
            router.replace("/login");
          }}
        >
          Salir
        </button>
      </header>
      {children}
      <nav className="nav">
        {nav.map(([href, icon, label]) => (
          <Link key={href} href={href} style={{ color: pathname === href ? "#fff" : undefined }}>
            <strong>{icon}</strong>{label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

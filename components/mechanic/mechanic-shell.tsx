"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OsIcon, type OsIconName } from "@/components/os-icon";
import { firstName, type MyProfile } from "@/lib/profile";

const TABS: { href: string; label: string; icon: OsIconName }[] = [
  { href: "/mecanico", label: "Mis trabajos", icon: "workshop" },
  { href: "/mecanico/historial", label: "Historial", icon: "list" },
  { href: "/mecanico/cotizar", label: "Cotizar", icon: "receipt" },
];

/** App del mecánico en el teléfono: solo sus vehículos, su historial y cotizar mano de obra. */
export function MechanicShell({ profile, onSignOut, children }: { profile: MyProfile; onSignOut: () => void; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = (href: string) => href === "/mecanico" ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  return <div className="shell os-theme os-mech-shell">
    <header className="os-mech-head">
      <span className="os-wordmark" aria-hidden="true" />
      <div className="os-mech-who">
        <span><small>{profile.job_title || "Mecánico"}</small><strong>{firstName(profile.name)}</strong></span>
        <button type="button" className="btn btn-ghost" onClick={onSignOut}><OsIcon name="logout" size={17} /> Salir</button>
      </div>
    </header>
    <main id="os-main" className="os-mech-main">{children}</main>
    <nav className="os-mech-tabs" aria-label="Secciones">
      {TABS.map(tab => <Link key={tab.href} href={tab.href} className={active(tab.href) ? "is-active" : undefined}
        aria-current={active(tab.href) ? "page" : undefined}>
        <OsIcon name={tab.icon} size={22} /><span>{tab.label}</span>
      </Link>)}
    </nav>
  </div>;
}

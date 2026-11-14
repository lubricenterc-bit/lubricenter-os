"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { BrandIcon } from "@/components/gotin";
import { OsIcon } from "@/components/os-icon";
import { firstName } from "@/lib/profile";
import type { BrandIconName } from "@/lib/brand-art";

type Counts = { toSend: number; booked: number; vehicles: number; ready: number; proposals: number };

/**
 * Inicio de la tablet de recepción (Ender): recibir vehículos y crear órdenes,
 * seguimiento de clientes (CRM) y el taller. Sin cobros, caja ni ganancias.
 */
export function ReceptionHome({ name }: { name: string }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  const load = useCallback(async () => {
    const [crm, board, proposals] = await Promise.all([
      supabase.rpc("crm_today_count"),
      supabase.from("workshop_board_current").select("workflow_status").limit(500),
      supabase.rpc("labor_proposals_list", { p_status: "PENDING" }),
    ]);
    const c = (crm.error ? null : crm.data) as { to_send?: number; booked_today?: number } | null;
    const rows = (board.error ? [] : board.data ?? []) as { workflow_status: string }[];
    setCounts({
      toSend: Number(c?.to_send ?? 0),
      booked: Number(c?.booked_today ?? 0),
      vehicles: rows.length,
      ready: rows.filter(row => row.workflow_status === "READY").length,
      proposals: proposals.error || !Array.isArray(proposals.data) ? 0 : proposals.data.length,
    });
  }, []);
  useVisiblePolling(load, 60_000);

  const receive: { href: string; title: string; note: string; icon: BrandIconName }[] = [
    { href: "/orders/new?start=oil", title: "Cambio de aceite", note: "Cliente, vehículo, aceite y filtro", icon: "bottle" },
    { href: "/orders/new?start=workshop", title: "Trabajo de taller", note: "Para Cheo, por cotización", icon: "wrench" },
    { href: "/orders/new?start=electro", title: "Electroauto", note: "Para Alexis, por cotización", icon: "lens" },
    { href: "/quote", title: "Cotizar", note: "Precios para el cliente sin crear orden", icon: "clip" },
  ];
  const n = (value: number | undefined) => counts ? String(value ?? 0) : "·";

  return <main className="container os-reception">
    <header className="os-page-head">
      <div><h1>Hola, {firstName(name) || "equipo"}</h1>
        <p>Recibe los vehículos, crea las órdenes y lleva el seguimiento de los clientes.</p></div>
    </header>

    <h2 className="os-reception-title">Recibir</h2>
    <div className="os-home-actions os-reception-grid">
      {receive.map(action => <Link key={action.href} href={action.href} className="os-act hov">
        <span><strong>{action.title}</strong><small>{action.note}</small></span>
        <BrandIcon name={action.icon} className="os-act-icon" />
      </Link>)}
    </div>

    <h2 className="os-reception-title">Clientes</h2>
    <div className="os-reception-tiles">
      <Link href="/crm?tab=today" className={"card os-tile" + (counts?.toSend ? " is-hot" : "")}>
        <b>{n(counts?.toSend)}</b><span><strong>Contactar hoy</strong><small>Postservicio y recordatorios de cambio de aceite</small></span><OsIcon name="arrow" size={18} />
      </Link>
      <Link href="/crm?tab=booked" className="card os-tile">
        <b>{n(counts?.booked)}</b><span><strong>Citas de hoy</strong><small>Clientes que agendaron</small></span><OsIcon name="arrow" size={18} />
      </Link>
      <Link href="/customers" className="card os-tile">
        <OsIcon name="search" size={22} /><span><strong>Buscar cliente</strong><small>Historial y vehículos</small></span><OsIcon name="arrow" size={18} />
      </Link>
    </div>

    <h2 className="os-reception-title">Taller</h2>
    <div className="os-reception-tiles">
      <Link href="/workshop" className="card os-tile">
        <b>{n(counts?.vehicles)}</b><span><strong>Vehículos en el taller</strong><small>{counts ? `${counts.ready} listos para entregar` : "Tablero por etapas"}</small></span><OsIcon name="arrow" size={18} />
      </Link>
      <Link href="/workshop/propuestas" className={"card os-tile" + (counts?.proposals ? " is-hot" : "")}>
        <b>{n(counts?.proposals)}</b><span><strong>Cotizaciones de mecánicos</strong><small>Mano de obra que proponen Cheo y Alexis</small></span><OsIcon name="arrow" size={18} />
      </Link>
      <div className="card os-tile is-soon" aria-disabled="true">
        <OsIcon name="car" size={22} /><span><strong>Ingreso del vehículo</strong><small>Próximamente: km, combustible, daños y fotos al recibir</small></span>
      </div>
    </div>
  </main>;
}

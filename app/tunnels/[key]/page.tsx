"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { TunnelPlayer } from "@/components/tunnel/tunnel-player";
import { getTunnel } from "@/lib/tunnels/registry";

export default function TunnelPage() {
  const params = useParams<{ key: string }>();
  const definition = getTunnel(String(params.key || ""));
  if (!definition) {
    return <div className="tn-root"><main className="tn-stage"><article className="tn-card"><div className="tn-slide-body">
      <p className="tn-eyebrow">Túnel no encontrado</p><h1 className="tn-summary-title">Este túnel no existe o no está disponible.</h1>
    </div><div className="tn-actions"><Link className="tn-btn tn-btn-primary" href="/tunnels">Volver a Túneles pendientes</Link></div></article></main></div>;
  }
  return <TunnelPlayer definition={definition} />;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { supabaseBackend } from "@/lib/tunnels/backend";
import { backendFor } from "@/lib/tunnels/client";
import { listTunnels } from "@/lib/tunnels/registry";
import { describeCondition } from "@/lib/tunnels/rules";
import type { TunnelRule } from "@/lib/tunnels/types";

const STATUS: Record<TunnelRule["status"], string> = { ACTIVE: "Activa", DISABLED: "Desactivada", PENDING_APPROVAL: "Espera aprobación" };

/** "Reglas aprendidas": rules belong to the process; the manual views use them too. */
export default function TunnelRulesPage() {
  const tunnels = listTunnels();
  const [filter, setFilter] = useState<string>("");
  const [rules, setRules] = useState<TunnelRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all: TunnelRule[] = [];
      const { data, error: e } = await supabase.from("tunnel_rules").select("*").order("created_at", { ascending: false });
      if (e) throw e;
      all.push(...((data || []) as TunnelRule[]));
      for (const t of tunnels.filter(t => t.backend === "memory")) all.push(...await backendFor(t, supabase).rules(t.key));
      setRules(all);
    } catch (e) { setError(e instanceof Error ? e.message : "No pude cargar las reglas"); }
  }, [tunnels]);
  useEffect(() => { void load(); }, [load]);

  const backendOf = (rule: TunnelRule) => {
    const t = tunnels.find(x => x.key === rule.tunnel_key);
    return t?.backend === "memory" ? backendFor(t, supabase) : supabaseBackend(supabase);
  };
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "No se pudo completar"); } finally { setBusy(false); }
  };
  const title = (key: string) => tunnels.find(t => t.key === key)?.title || key;
  const keys = [...new Set(rules.map(r => r.tunnel_key))];
  const shown = rules.filter(r => !filter || r.tunnel_key === filter);

  return <div className="container tn-list-page">
    <header className="tn-list-head">
      <div>
        <p className="tn-eyebrow"><Link href="/tunnels">Túneles pendientes</Link></p>
        <h1>Reglas aprendidas</h1>
        <p className="muted">Nacen cuando le explicas un caso a la IA y marcas «Recordar esto como regla». Valen para el proceso: el túnel y su vista manual.</p>
      </div>
      <label className="tn-filter">Proceso
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">Todos</option>
          {keys.map(k => <option key={k} value={k}>{title(k)}</option>)}
        </select>
      </label>
    </header>
    {error && <p className="tn-field-error" role="alert">{error}</p>}
    {!shown.length && <div className="card"><p>Todavía no hay reglas aprendidas.</p></div>}
    <ul className="tn-rules">
      {shown.map(rule => <li key={rule.id} className={"tn-rule is-" + rule.status.toLowerCase()}>
        <div className="tn-rule-main">
          <p className="tn-eyebrow">{title(rule.tunnel_key)} · {STATUS[rule.status]} · usada {rule.times_used} {rule.times_used === 1 ? "vez" : "veces"}</p>
          {editing?.id === rule.id
            ? <form onSubmit={e => { e.preventDefault(); void act(async () => { await backendOf(rule).updateRule(rule.id, { description: editing.text }); setEditing(null); }); }}>
                <textarea className="tn-textarea" rows={2} value={editing.text} onChange={e => setEditing({ id: rule.id, text: e.target.value })} maxLength={2000} autoFocus />
                <div className="tn-rule-actions"><button className="btn btn-primary" disabled={busy || editing.text.trim().length < 3}>Guardar</button><button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancelar</button></div>
              </form>
            : <h2>«{rule.description}»</h2>}
          <p className="muted">Cuando {describeCondition(rule.condition)} → propone {rule.outcome.action.label || Object.values(rule.outcome.action.payload || {}).join(", ") || rule.outcome.action.type}.</p>
        </div>
        {editing?.id !== rule.id && <div className="tn-rule-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing({ id: rule.id, text: rule.description })}>Editar</button>
          {rule.status === "ACTIVE"
            ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => backendOf(rule).updateRule(rule.id, { status: "DISABLED" }))}>Desactivar</button>
            : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => backendOf(rule).updateRule(rule.id, { status: "ACTIVE" }))}>{rule.status === "PENDING_APPROVAL" ? "Aprobar" : "Activar"}</button>}
          <button type="button" className="btn btn-ghost tn-danger" disabled={busy} onClick={() => { if (window.confirm("¿Borrar esta regla? Los casos parecidos volverán a preguntarse.")) void act(() => backendOf(rule).deleteRule(rule.id)); }}>Borrar</button>
        </div>}
      </li>)}
    </ul>
  </div>;
}

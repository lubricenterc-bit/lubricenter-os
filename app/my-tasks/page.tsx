"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Task = { id: string; title: string; due_on: string | null; completed_at: string | null; created_at: string };

export default function MyTasksPage() {
  const [name, setName] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [canComplete, setCanComplete] = useState(false);

  async function refresh() {
    setError("");
    const [{ data: identity }, { data: keys }] = await Promise.all([
      supabase.auth.getUser(), supabase.rpc("staff_my_permissions"),
    ]);
    if (!identity.user) { setError("Inicia sesión."); setLoaded(true); return; }
    const { data: staff, error: staffError } = await supabase.from("staff_users")
      .select("id,full_name").eq("auth_user_id",identity.user.id).maybeSingle();
    if (staffError || !staff) { setError("Tu cuenta aún no tiene tareas asignables."); setLoaded(true); return; }
    setName(staff.full_name);
    setCanComplete((keys || []).includes("tasks.complete"));
    const { data, error: taskError } = await supabase.from("staff_tasks")
      .select("id,title,due_on,completed_at,created_at")
      .eq("staff_user_id",staff.id).order("created_at",{ascending:false});
    if (taskError) setError(taskError.message); else setTasks(data || []);
    setLoaded(true);
  }
  useEffect(()=>{ void refresh(); },[]);
  async function complete(id: string, done: boolean) {
    setBusy(id); setError("");
    const { error } = await supabase.rpc("staff_set_task_completed",{p_task_id:id,p_completed:done});
    setBusy("");
    if (error) { setError(error.message); return; }
    await refresh();
  }
  const outstanding = tasks.filter(t => !t.completed_at);
  return <main className="container stack team-page">
    <div className="team-heading"><div><span className="team-eyebrow">LUBRICENTER OS / MI JORNADA</span>
      <h1>Mis tareas</h1><p>{name ? "Pendientes de "+name : "Consulta tus compromisos de trabajo."}</p></div>
      <div className="team-summary"><strong>{outstanding.length}</strong><span>Pendientes</span></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    {!loaded ? <div className="card">Cargando tareas…</div> : <div className="card team-task-list">
      {tasks.map(t => <div key={t.id} className="team-task">
        <span className={"team-task-marker "+(t.completed_at?"done":"")}>{t.completed_at?"✓":"○"}</span>
        <div><strong>{t.title}</strong><small>{t.completed_at?"Completada":
          t.due_on?"Fecha límite: "+t.due_on:"Sin fecha límite"}</small></div>
        {canComplete && <button type="button" className="btn btn-ghost" disabled={busy===t.id}
          onClick={()=>void complete(t.id,!t.completed_at)}>
          {busy===t.id?"Guardando…":t.completed_at?"Reabrir":"Marcar lista"}</button>}
      </div>)}
      {!tasks.length && !error && <p className="muted">No tienes tareas asignadas por ahora.</p>}
    </div>}
    <Link href="/">← Volver a mi jornada</Link>
  </main>;
}

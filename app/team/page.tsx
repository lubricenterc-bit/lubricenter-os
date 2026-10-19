"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import Link from "next/link";

type Member = {
  id: string; full_name: string; email: string | null; job_title: string;
  auth_user_id: string | null; active: boolean; created_at: string;
  last_sign_in_at: string | null;
};
type Permission = { staff_user_id: string; permission_key: string; enabled: boolean };
type Catalog = { key: string; area: string; label: string; explanation: string; recommended: boolean; sort_order: number };
type Activity = { id: number; event_key: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>; happened_at: string };
type Task = { id: string; title: string; due_on: string | null; completed_at: string | null; created_at: string };
type Tab = "permissions" | "activity" | "tasks";

const dateTime = (date: string | null) => date ? new Date(date).toLocaleString("es-VE", {
  timeZone: "America/Caracas", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}) : "Sin registrar";
const actionName: Record<string, string> = {
  INSERT: "Creó un registro", UPDATE: "Modificó un registro", DELETE: "Eliminó un registro",
  "task.assigned": "Se le asignó una tarea", "task.completed": "Completó una tarea",
  "task.reopened": "Reabrió una tarea", "permission.changed": "Cambio de permisos",
  "access.changed": "Cambio de acceso", "account.invited": "Invitación enviada",
};
const entityName: Record<string, string> = {
  orders: "orden", order_items: "detalle de orden", payments: "cobro",
  order_tenders: "método de pago", customers: "cliente", vehicles: "vehículo",
  inventory_movements: "movimiento de inventario", products: "producto",
  account_movements: "movimiento de caja", cash_closings: "cierre diario",
  crm_manual_cases: "caso de CRM", payroll_adjustments: "ajuste de nómina",
};

export default function TeamPage() {
  const [owner, setOwner] = useState<boolean | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<Tab>("permissions");
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = members.find(member => member.id === selectedId);
  const granted = useMemo(() => new Set(permissions.filter(p => p.staff_user_id === selectedId && p.enabled).map(p => p.permission_key)), [permissions, selectedId]);
  const byArea = useMemo(() => {
    const areas = new Map<string, Catalog[]>();
    for (const item of catalog) areas.set(item.area, [...(areas.get(item.area) || []), item]);
    return Array.from(areas);
  }, [catalog]);
  const openTasks = tasks.filter(task => !task.completed_at);
  const overdue = openTasks.filter(task => task.due_on && task.due_on < new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" }));

  const loadMembers = useCallback(async () => {
    const [list, perms] = await Promise.all([
      supabase.rpc("staff_admin_list"),
      supabase.from("staff_permissions").select("staff_user_id,permission_key,enabled"),
    ]);
    if (list.error || perms.error) throw new Error(list.error?.message || perms.error?.message);
    const users = (Array.isArray(list.data) ? list.data : []) as Member[];
    setMembers(users);
    setPermissions((perms.data || []) as Permission[]);
    setSelectedId(previous => users.some(user => user.id === previous) ? previous : users[0]?.id || "");
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    const [activity, assigned] = await Promise.all([
      supabase.from("staff_activity_events").select("id,event_key,entity_type,entity_id,details,happened_at")
        .eq("staff_user_id", id).order("happened_at", { ascending: false }).limit(100),
      supabase.from("staff_tasks").select("id,title,due_on,completed_at,created_at")
        .eq("staff_user_id", id).order("created_at", { ascending: false }),
    ]);
    if (activity.error || assigned.error) throw new Error(activity.error?.message || assigned.error?.message);
    setActivities((activity.data || []) as Activity[]);
    setTasks((assigned.data || []) as Task[]);
  }, []);

  useEffect(() => {
    let active = true;
    async function init() {
      const [{ data: role, error: roleError }, cats] = await Promise.all([
        supabase.rpc("finance_role"),
        supabase.from("staff_permission_catalog").select("key,area,label,explanation,recommended,sort_order").order("sort_order"),
      ]);
      if (!active) return;
      if (roleError) { setError(roleError.message); setOwner(false); return; }
      if (role !== "OWNER") { setOwner(false); return; }
      setOwner(true);
      if (cats.error) { setError(cats.error.message); return; }
      setCatalog((cats.data || []) as Catalog[]);
      try { await loadMembers(); } catch(e) { if (active) setError((e as Error).message); }
    }
    void init();
    return () => { active = false; };
  }, [loadMembers]);

  useEffect(() => {
    setInviteEmail(selected?.email || "");
    setError(""); setMessage("");
    if (owner && selectedId) void loadDetail(selectedId).catch(e => setError((e as Error).message));
  }, [selectedId, owner, loadDetail, selected?.email]);

  async function togglePermission(key: string, enabled: boolean) {
    if (!selected) return;
    setPendingKey(key); setError(""); setMessage("");
    const { error } = await supabase.rpc("staff_admin_permission", { p_staff_user_id: selected.id, p_key: key, p_enabled: enabled });
    setPendingKey("");
    if (error) { setError(error.message); return; }
    setPermissions(previous => previous.some(p => p.staff_user_id === selected.id && p.permission_key === key)
      ? previous.map(p => p.staff_user_id === selected.id && p.permission_key === key ? { ...p, enabled } : p)
      : [...previous, { staff_user_id: selected.id, permission_key: key, enabled }]);
    setMessage("Permiso actualizado y registrado en auditoría.");
    await loadDetail(selected.id);
  }

  async function toggleActive() {
    if (!selected?.auth_user_id) return;
    setBusy(true); setError(""); setMessage("");
    const { error } = await supabase.rpc("staff_admin_status", { p_staff_user_id: selected.id, p_active: !selected.active });
    setBusy(false);
    if (error) return setError(error.message);
    await Promise.all([loadMembers(), loadDetail(selected.id)]);
    setMessage("Estado de acceso actualizado.");
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    const { data, error } = await supabase.functions.invoke("staff-invite", {
      body: { staff_user_id: selected.id, email: inviteEmail.trim().toLowerCase() },
    });
    setBusy(false);
    if (error || data?.error) { setError(data?.error || error?.message || "No se pudo enviar la invitación"); return; }
    setMessage("Invitación enviada. Edgar podrá definir su contraseña con el enlace del correo.");
    await Promise.all([loadMembers(), loadDetail(selected.id)]);
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    const { error } = await supabase.rpc("staff_admin_add_task", {
      p_staff_user_id: selected.id, p_title: taskTitle.trim(), p_due_on: taskDue || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setTaskTitle(""); setTaskDue("");
    setMessage("Tarea asignada y registrada.");
    await loadDetail(selected.id);
  }

  if (owner === null) return <main className="container stack"><div className="card">Verificando acceso a Gestión de equipo…</div></main>;
  if (!owner) return <main className="container stack"><div className="card stack"><h1>Gestión de equipo</h1>
    <p>Solo el propietario puede administrar usuarios, permisos y auditoría.</p><Link href="/">Volver al inicio</Link></div></main>;

  return <main className="container stack team-page">
    <div className="team-heading">
      <div><span className="team-eyebrow">ADMINISTRACIÓN / ACCESOS</span><h1>Equipo y permisos</h1>
        <p>Controla lo que cada persona puede hacer y revisa su actividad real en Lubricenter OS.</p></div>
      <div className="team-summary"><strong>{members.length}</strong><span>Perfiles del equipo</span></div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="success" role="status">{message}</div>}
    <div className="team-layout">
      <aside className="card team-members" aria-label="Usuarios">
        <div className="team-card-title"><h2>Usuarios</h2><span>{members.length}</span></div>
        {members.map(member => <button type="button" key={member.id}
          onClick={() => setSelectedId(member.id)}
          className={"team-member"+(member.id === selectedId ? " selected" : "")}>
          <span className="team-avatar">{member.full_name.split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()}</span>
          <span className="team-member-copy"><strong>{member.full_name}</strong><small>{member.job_title}</small></span>
          <span className={"team-status "+(member.auth_user_id && member.active ? "online" : "")} title={member.auth_user_id ? member.active ? "Acceso habilitado" : "Acceso suspendido" : "Sin invitación"} />
        </button>)}
        {members.length === 0 && <p className="muted">No hay perfiles configurados.</p>}
        <div className="team-aside-note">Un usuario por persona. Nunca compartas la cuenta principal ni contraseñas.</div>
      </aside>
      {selected && <div className="team-detail">
        <section className="card team-profile">
          <div className="team-profile-header">
            <div><span className="team-eyebrow">FICHA DEL USUARIO</span><h2>{selected.full_name}</h2><p>{selected.job_title}</p></div>
            <span className={"team-profile-badge "+(selected.auth_user_id && selected.active?"is-active":"")}>
              {selected.auth_user_id ? selected.active?"Acceso activo":"Acceso suspendido" : "Pendiente de invitación"}
            </span>
          </div>
          <div className="team-metrics">
            <div><small>Último acceso</small><strong>{dateTime(selected.last_sign_in_at)}</strong></div>
            <div><small>Permisos activados</small><strong>{granted.size} de {catalog.length}</strong></div>
            <div><small>Tareas pendientes</small><strong>{openTasks.length}</strong></div>
            <div><small>Vencidas</small><strong>{overdue.length}</strong></div>
          </div>
          {!selected.auth_user_id ? <form className="team-invite" onSubmit={invite}>
            <label><span className="label">Correo para invitar a {selected.full_name}</span>
              <input className="input" type="email" required placeholder="correo@ejemplo.com" value={inviteEmail}
                onChange={e=>setInviteEmail(e.target.value)} /></label>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy?"Enviando…":"Enviar invitación"}</button>
            <small>La cuenta de Supabase Auth se crea al enviar el enlace. No se inventan claves.</small>
          </form> : <div className="team-access-line">
            <span>{selected.email}</span>
            <button className={"btn "+(selected.active?"btn-ghost":"btn-primary")} type="button" onClick={toggleActive} disabled={busy}>
              {selected.active?"Suspender acceso":"Reactivar acceso"}
            </button>
          </div>}
        </section>
        <div className="team-tabs" role="tablist" aria-label="Gestión del usuario">
          {([["permissions","Permisos"],["activity","Actividad"],["tasks","Tareas y pendientes"]] as const).map(([value,label]) =>
            <button key={value} role="tab" aria-selected={tab===value} onClick={() => setTab(value)}
              className={tab===value?"active":""}>{label}</button>)}
        </div>
        {tab === "permissions" && <div className="team-permissions stack">
          <div className="team-info">Los cambios se guardan individualmente, con usuario, fecha y hora. Las acciones sensibles también se validan en la base de datos, no solo en el menú.</div>
          {byArea.map(([area, items]) => <section className="card team-permission-group" key={area}>
            <div className="team-card-title"><h3>{area}</h3><span>{items.filter(item=>granted.has(item.key)).length}/{items.length}</span></div>
            {items.map(item => <label className="team-permission" key={item.key}>
              <input type="checkbox" checked={granted.has(item.key)} disabled={!!pendingKey}
                onChange={e => void togglePermission(item.key,e.target.checked)} />
              <span className="team-permission-text"><strong>{item.label}</strong><small>{item.explanation}</small></span>
              {item.recommended && <span className="team-recommended">Gerente</span>}
            </label>)}
          </section>)}
        </div>}
        {tab === "activity" && <section className="card stack">
          <div className="team-card-title"><h3>Historial verificado</h3><button className="btn btn-ghost" type="button"
            onClick={()=>void loadDetail(selected.id)}>Actualizar</button></div>
          <p className="muted small">Operaciones registradas por el servidor, no clics de pantalla. Las consultas sin cambios no aparecen como trabajo realizado.</p>
          <div className="team-timeline">
            {activities.map(a => <div className="team-event" key={a.id}>
              <div className="team-event-dot"/><div><strong>{actionName[a.event_key]||a.event_key}</strong>
                <p>{entityName[a.entity_type]||a.entity_type}{a.entity_id ? " · "+a.entity_id.slice(0,12):""}</p>
                {a.event_key==="permission.changed" && <small>{a.details?.enabled ? "Permiso habilitado":"Permiso deshabilitado"}</small>}
                <time>{dateTime(a.happened_at)}</time></div></div>)}
            {!activities.length && <p className="muted">Aún no hay acciones registradas para esta persona.</p>}
          </div>
        </section>}
        {tab === "tasks" && <section className="card stack">
          <div className="team-card-title"><h3>Control de cumplimiento</h3><span>{openTasks.length} pendientes</span></div>
          <form className="team-task-form" onSubmit={createTask}>
            <input className="input" required minLength={3} maxLength={250}
              placeholder="Ej. Conciliar el cierre del sábado" value={taskTitle} onChange={e=>setTaskTitle(e.target.value)} />
            <input className="input" type="date" aria-label="Fecha límite" value={taskDue} onChange={e=>setTaskDue(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={busy}>Asignar tarea</button>
          </form>
          <p className="muted small">Una tarea vencida y no completada aparece como pendiente. El sistema no puede afirmar que alguien no trabajó solo porque no generó actividad.</p>
          <div className="team-task-list">
            {tasks.map(task => <div className="team-task" key={task.id}>
              <span className={"team-task-marker "+(task.completed_at?"done":"")}>{task.completed_at?"✓":"○"}</span>
              <div><strong>{task.title}</strong><small>{task.completed_at?"Completada "+dateTime(task.completed_at):
                task.due_on ? "Vence "+task.due_on+(task.due_on < new Date().toLocaleDateString("en-CA",{timeZone:"America/Caracas"})?" · VENCIDA":""):"Sin fecha límite"}</small></div>
              <span className={"team-task-indicator "+(task.completed_at?"done":"")}>{task.completed_at?"Lista":"Pendiente"}</span>
            </div>)}
            {!tasks.length && <p className="muted">Aún no hay tareas asignadas.</p>}
          </div>
          <Link href="/my-tasks" className="muted small">Vista que utilizará el empleado para completar sus tareas →</Link>
        </section>}
      </div>}
    </div>
  </main>;
}

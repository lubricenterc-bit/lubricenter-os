"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { OsIcon } from "@/components/os-icon";
import { SkelCards } from "@/components/skeleton";
import { PROFILE_LABEL } from "@/lib/profile";

type Profile = "ADMIN" | "RECEPTION" | "MECHANIC";
type StaffRow = {
  id: string; full_name: string; email: string | null; job_title: string | null; profile: Profile;
  device: string | null; employee_id: string | null; employee: string | null; active: boolean;
  has_account: boolean; last_sign_in_at: string | null; permissions: string[];
};
type CatalogRow = { key: string; area: string; label: string; explanation: string; sort_order: number };
type Employee = { id: string; code: string; name: string };

const PROFILE_HELP: Record<Profile, string> = {
  ADMIN: "Todo lo operativo. Finanzas, ganancias, conciliaciones y nómina le piden tu PIN cada vez que entra.",
  RECEPTION: "Recibir vehículos, crear órdenes, clientes y CRM. No cobra ni toca caja.",
  MECHANIC: "Solo su app en el teléfono: sus vehículos, su historial y cotizar mano de obra. No ve montos ni ganancias.",
};

async function accountApi(body: Record<string, string>) {
  const session = await supabase.auth.getSession();
  const response = await fetch("/api/staff/accounts", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.data.session?.access_token || ""}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar.");
}

function lastSeen(value: string | null) {
  if (!value) return "Nunca ha entrado";
  return "Último ingreso: " + new Date(value).toLocaleString("es-VE", { timeZone: "America/Caracas", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Administración → Usuarios (solo el dueño). */
export default function StaffUsersPage() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [users, perms, people] = await Promise.all([
      supabase.rpc("staff_admin_users"),
      supabase.from("staff_permission_catalog").select("key,area,label,explanation,sort_order").order("sort_order"),
      supabase.from("employees").select("id,code,name").eq("active", true).order("name"),
    ]);
    setLoaded(true);
    if (users.error) { setError(/propietario|dueño|OWNER/i.test(users.error.message) ? "Solo el dueño puede ver esta pantalla." : users.error.message); return; }
    setError("");
    setRows((users.data ?? []) as StaffRow[]);
    setCatalog((perms.data ?? []) as CatalogRow[]);
    setEmployees((people.data ?? []) as Employee[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <main className="container stack os-users">
    <header className="os-page-head">
      <div><h1>Usuarios</h1>
        <p>Cada persona entra con su propio correo y contraseña, y ve solo lo suyo. Lo que hace cada uno queda registrado con su nombre.</p></div>
      <button type="button" className="btn btn-primary" onClick={() => { setAdding(true); setOpen(null); }}><OsIcon name="plus" size={18} /> Agregar persona</button>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {!loaded && <SkelCards count={3} />}
    {adding && <ProfileForm employees={employees} onDone={async saved => { setAdding(false); if (saved) { await load(); setOpen(saved); } }} />}
    {rows.map(row => <UserCard key={row.id} row={row} catalog={catalog} employees={employees} open={open === row.id}
      onToggle={() => setOpen(open === row.id ? null : row.id)} onChanged={load} />)}
  </main>;
}

function UserCard({ row, catalog, employees, open, onToggle, onChanged }: {
  row: StaffRow; catalog: CatalogRow[]; employees: Employee[]; open: boolean; onToggle: () => void; onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(row.email || "");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);

  const areas = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    catalog.forEach(item => map.set(item.area, [...(map.get(item.area) || []), item]));
    return [...map.entries()];
  }, [catalog]);

  async function run(task: () => Promise<void>, done: string) {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(done); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo completar."); }
    finally { setBusy(false); }
  }
  const createAccount = () => run(async () => {
    await accountApi({ action: "create", staff_user_id: row.id, email, password });
    setPassword("");
  }, `Cuenta creada. ${row.full_name.split(" ")[0]} ya puede entrar con ${email}.`);
  const changePassword = () => run(async () => {
    await accountApi({ action: "password", staff_user_id: row.id, password });
    setPassword("");
  }, "Contraseña cambiada.");
  const setActive = (active: boolean) => run(async () => {
    const { error } = await supabase.rpc("staff_admin_status", { p_staff_user_id: row.id, p_active: active });
    if (error) throw new Error(error.message);
  }, active ? "Acceso activado." : "Acceso suspendido: ya no puede entrar.");
  const setPermission = (key: string, enabled: boolean) => run(async () => {
    const { error } = await supabase.rpc("staff_admin_permission", { p_staff_user_id: row.id, p_key: key, p_enabled: enabled });
    if (error) throw new Error(error.message);
  }, "Permiso guardado.");

  const status = !row.has_account ? "Sin cuenta" : row.active ? "Activo" : "Suspendido";
  return <article className={"card os-user" + (open ? " is-open" : "")}>
    <button type="button" className="os-user-head" onClick={onToggle} aria-expanded={open}>
      <span className="os-mono">{row.full_name.slice(0, 2).toUpperCase()}</span>
      <span className="os-user-name"><strong>{row.full_name}</strong>
        <small>{PROFILE_LABEL[row.profile]}{row.device ? ` · ${row.device}` : ""}{row.employee ? ` · nómina: ${row.employee}` : ""}</small></span>
      <span className={"os-user-status is-" + (!row.has_account ? "none" : row.active ? "on" : "off")}>{status}</span>
      <OsIcon name="down" size={16} className={"os-drawer-arrow" + (open ? " is-open" : "")} />
    </button>
    {open && <div className="os-user-body">
      <p className="muted">{PROFILE_HELP[row.profile]}</p>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success" role="status">{notice}</div>}

      <section className="os-user-section">
        <h3>Cuenta</h3>
        {row.has_account
          ? <>
              <p>{row.email} · {lastSeen(row.last_sign_in_at)}</p>
              <div className="os-user-inline">
                <input className="input" type="password" autoComplete="new-password" placeholder="Nueva contraseña (mín. 8)" value={password} onChange={e => setPassword(e.target.value)} aria-label="Nueva contraseña" />
                <button type="button" className="btn btn-ghost" disabled={busy || password.length < 8} onClick={changePassword}>Cambiar contraseña</button>
              </div>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setActive(!row.active)}>
                {row.active ? "Suspender acceso" : "Activar acceso"}</button>
            </>
          : <div className="os-user-inline">
              <input className="input" type="email" autoComplete="off" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)} aria-label="Correo" />
              <input className="input" type="password" autoComplete="new-password" placeholder="Contraseña (mín. 8)" value={password} onChange={e => setPassword(e.target.value)} aria-label="Contraseña" />
              <button type="button" className="btn btn-primary" disabled={busy || !email.includes("@") || password.length < 8} onClick={createAccount}>Crear cuenta</button>
            </div>}
        {!row.has_account && <small className="muted">Anota la contraseña y dásela en persona. Después puede usarla en su {row.device?.toLowerCase() || "equipo"} y la sesión queda abierta.</small>}
      </section>

      <section className="os-user-section">
        <div className="row-between"><h3>Perfil</h3>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(value => !value)}>{editing ? "Cerrar" : "Editar"}</button></div>
        {editing && <ProfileForm row={row} employees={employees} onDone={async saved => { setEditing(false); if (saved) await onChanged(); }} />}
      </section>

      {row.profile !== "MECHANIC" && <section className="os-user-section">
        <h3>Permisos</h3>
        <p className="muted">Se cumplen en la base de datos: sin el permiso, el sistema rechaza la acción aunque la pantalla se abra.</p>
        <div className="os-user-perms">
          {areas.map(([area, items]) => <fieldset key={area}>
            <legend>{area}</legend>
            {items.map(item => <label key={item.key} className="os-user-perm">
              <input type="checkbox" checked={row.permissions.includes(item.key)} disabled={busy}
                onChange={e => setPermission(item.key, e.target.checked)} />
              <span><strong>{item.label}</strong><small>{item.explanation}</small></span>
            </label>)}
          </fieldset>)}
        </div>
      </section>}
    </div>}
  </article>;
}

function ProfileForm({ row, employees, onDone }: { row?: StaffRow; employees: Employee[]; onDone: (savedId: string | null) => void | Promise<void> }) {
  const [name, setName] = useState(row?.full_name || "");
  const [job, setJob] = useState(row?.job_title || "");
  // Una persona nueva no trae perfil por defecto: hay que elegirlo (la base pone RECEPTION si falta).
  const [profile, setProfile] = useState<Profile | "">(row?.profile || "");
  const [device, setDevice] = useState(row?.device || "");
  const [employee, setEmployee] = useState(row?.employee_id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!profile) { setError("Elige el perfil de esta persona."); return; }
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("staff_admin_save", {
      p_id: row?.id ?? null, p_full_name: name, p_job_title: job, p_profile: profile, p_device: device,
      p_employee_id: profile === "MECHANIC" ? employee || null : null,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    await onDone(String(data));
  }

  return <form className={"os-user-form" + (row ? "" : " card")} onSubmit={save}>
    {!row && <h3>Nueva persona</h3>}
    <div className="grid grid-2">
      <label><span className="label">Nombre</span><input className="input" value={name} onChange={e => setName(e.target.value)} required /></label>
      <label><span className="label">Cargo</span><input className="input" value={job} onChange={e => setJob(e.target.value)} placeholder="Ej. Atención al cliente" /></label>
      <label><span className="label">Perfil</span>
        <select className="select" value={profile} onChange={e => setProfile(e.target.value as Profile)} required>
          {!profile && <option value="">Elegir perfil…</option>}
          <option value="ADMIN">Administración (computadora)</option>
          <option value="RECEPTION">Recepción (tablet)</option>
          <option value="MECHANIC">Mecánico (teléfono)</option>
        </select></label>
      <label><span className="label">Dispositivo</span><input className="input" value={device} onChange={e => setDevice(e.target.value)} placeholder="Computadora, Tablet, Teléfono" /></label>
      {profile === "MECHANIC" && <label><span className="label">Mecánico de nómina</span>
        <select className="select" value={employee} onChange={e => setEmployee(e.target.value)} required>
          <option value="">Elegir…</option>
          {employees.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
    </div>
    {profile && <p className="muted">{PROFILE_HELP[profile]}</p>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="row">
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !profile}>{busy ? "Guardando…" : "Guardar"}</button>
      <button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>Cancelar</button>
    </div>
  </form>;
}

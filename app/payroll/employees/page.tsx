"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/** Administración del equipo: nombre, activo, % del mecánico, % de ayudante y sueldo fijo semanal. */
type Employee = {
  id: string; code: string; name: string; active: boolean;
  workshop_percent: number | null; assistant_percent: number | null; fixed_weekly: number | null;
};
type Draft = { name: string; active: boolean; workshop: string; assistant: string; fixed: string };

const show = (v: number | null) => (v == null ? "" : String(Number(v)));
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });

export default function EmployeesPage() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [validFrom, setValidFrom] = useState(today());
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setError("");
    const r = await supabase.rpc("employees_admin");
    if (r.error) setError(r.error.message);
    else {
      const list = (r.data ?? []) as Employee[];
      setRows(list);
      setDrafts(Object.fromEntries(list.map(e => [e.id, { name: e.name, active: e.active, workshop: show(e.workshop_percent), assistant: show(e.assistant_percent), fixed: show(e.fixed_weekly) }])));
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function save(e: Employee) {
    const d = drafts[e.id]; setBusy(e.id); setError(""); setNotice("");
    try {
      if (d.name.trim() !== e.name || d.active !== e.active) {
        const r = await supabase.rpc("employee_save", { p_id: e.id, p_name: d.name, p_role: null, p_active: d.active }); if (r.error) throw r.error;
      }
      const rules: [string, string, number | null][] = [["WORKSHOP_PERCENT", d.workshop, e.workshop_percent], ["ASSISTANT_BONUS_PERCENT", d.assistant, e.assistant_percent], ["FIXED_WEEKLY", d.fixed, e.fixed_weekly]];
      for (const [type, text, current] of rules) {
        const value = num(text);
        if (value == null || value === (current == null ? null : Number(current))) continue;
        if (!Number.isFinite(value) || value < 0) throw new Error("Revisa los montos de " + d.name);
        const r = await supabase.rpc("employee_set_rule", { p_employee: e.id, p_rule_type: type, p_value: value, p_valid_from: validFrom }); if (r.error) throw r.error;
      }
      setNotice(`${d.name} actualizado desde el ${validFrom}.`); await load();
    } catch (x: any) { setError(x.message ?? "No se pudo guardar"); }
    setBusy(null);
  }

  async function create() {
    if (newName.trim().length < 2) return setError("Escribe el nombre del nuevo empleado.");
    setBusy("new"); setError(""); setNotice("");
    const r = await supabase.rpc("employee_save", { p_id: null, p_name: newName, p_role: null, p_active: true });
    setBusy(null);
    if (r.error) return setError(r.error.message);
    setNewName(""); setNotice("Empleado agregado. Ahora define su pago."); await load();
  }

  return <main className="container stack">
    <header className="stack">
      <h1 style={{ margin: 0 }}>Equipo</h1>
      <p className="muted">Sueldo fijo semanal y porcentajes de cada persona. Los cambios valen desde la fecha que elijas; las semanas anteriores no se tocan. Los bonos de rendimiento se registran en <Link href="/payroll">Nómina</Link> como ajuste de tipo bono.</p>
    </header>
    <section className="card stack">
      <label style={{ maxWidth: 260 }}><span className="label">Los cambios valen desde</span><input className="input" type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} /></label>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="muted" role="status">{notice}</div>}
    </section>
    <section className="card" style={{ overflowX: "auto" }}>
      {loading ? <p className="muted">Cargando equipo…</p> :
        <table className="table" style={{ width: "100%", minWidth: 760 }}>
          <thead><tr><th>Nombre</th><th>Taller %</th><th>Ayudante %</th><th>Fijo semanal $</th><th>Activo</th><th /></tr></thead>
          <tbody>{rows.map(e => {
            const d = drafts[e.id]; if (!d) return null;
            const set = (p: Partial<Draft>) => setDrafts(all => ({ ...all, [e.id]: { ...d, ...p } }));
            return <tr key={e.id}>
              <td><input className="input" value={d.name} onChange={x => set({ name: x.target.value })} aria-label={`Nombre de ${e.name}`} />
                {e.code === "ALFREDO" && <div className="muted small">Mecánico de taller: cobra el % de la mano de obra</div>}</td>
              <td><input className="input" style={{ width: 84 }} inputMode="decimal" value={d.workshop} onChange={x => set({ workshop: x.target.value })} aria-label={`Porcentaje taller de ${e.name}`} /></td>
              <td><input className="input" style={{ width: 84 }} inputMode="decimal" value={d.assistant} onChange={x => set({ assistant: x.target.value })} aria-label={`Porcentaje ayudante de ${e.name}`} /></td>
              <td><input className="input" style={{ width: 100 }} inputMode="decimal" value={d.fixed} onChange={x => set({ fixed: x.target.value })} aria-label={`Sueldo fijo de ${e.name}`} /></td>
              <td><input type="checkbox" checked={d.active} onChange={x => set({ active: x.target.checked })} aria-label={`${e.name} activo`} /></td>
              <td><button className="btn btn-primary" disabled={busy === e.id} onClick={() => void save(e)}>{busy === e.id ? "Guardando…" : "Guardar"}</button></td>
            </tr>;
          })}</tbody>
        </table>}
    </section>
    <section className="card stack">
      <h2 className="section-title">Agregar persona</h2>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <input className="input" style={{ flex: "1 1 240px" }} placeholder="Nombre" value={newName} onChange={e => setNewName(e.target.value)} />
        <button className="btn" disabled={busy === "new"} onClick={() => void create()}>{busy === "new" ? "Agregando…" : "Agregar"}</button>
      </div>
    </section>
  </main>;
}

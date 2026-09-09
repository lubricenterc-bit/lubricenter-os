"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";

type Employee = { id: string; code: string; name: string };
type Accrual = { id: string; employee_id: string; source_type: string; amount_ref: number; occurred_at: string; description: string | null };
type Adjustment = { id: string; employee_id: string; adjustment_type: string; amount_ref: number; occurred_on: string; note: string | null };

export default function PayrollPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accruals, setAccruals] = useState<Accrual[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [adjType, setAdjType] = useState("SUPPLIES");
  const [adjAmount, setAdjAmount] = useState(0);
  const [adjNote, setAdjNote] = useState("");

  async function load() {
    const [{ data: e, error: ee }, { data: a, error: ae }, { data: j, error: je }] = await Promise.all([
      supabase.from("employees").select("id,code,name").eq("active", true).order("name"),
      supabase.from("payroll_accruals").select("id,employee_id,source_type,amount_ref,occurred_at,description").is("payroll_run_id", null).order("occurred_at"),
      supabase.from("payroll_adjustments").select("id,employee_id,adjustment_type,amount_ref,occurred_on,note").is("payroll_run_id", null).order("occurred_on"),
    ]);
    if (ee || ae || je) setError(ee?.message || ae?.message || je?.message || "Error cargando nómina");
    setEmployees((e ?? []) as Employee[]); setAccruals((a ?? []) as Accrual[]); setAdjustments((j ?? []) as Adjustment[]);
    if (!employeeId && e?.length) setEmployeeId(e[0].id);
  }
  useEffect(() => { load(); }, []);

  const totals = useMemo(() => employees.map(emp => {
    const variable = accruals.filter(a => a.employee_id === emp.id).reduce((s, a) => s + Number(a.amount_ref), 0);
    const adj = adjustments.filter(a => a.employee_id === emp.id).reduce((s, a) => s + Number(a.amount_ref), 0);
    return { emp, variable, adj, pending: variable + adj };
  }), [employees, accruals, adjustments]);

  async function addAdjustment() {
    if (!employeeId || !adjAmount) return;
    setBusy(true); setError("");
    const { error } = await supabase.rpc("add_payroll_adjustment", {
      p_employee_id: employeeId,
      p_adjustment_type: adjType,
      p_amount_ref: -Math.abs(adjAmount),
      p_note: adjNote || null,
      p_occurred_on: new Date().toISOString().slice(0, 10),
    });
    setBusy(false);
    if (error) return setError(error.message);
    setAdjAmount(0); setAdjNote(""); await load();
  }

  async function settle(employee: Employee) {
    const end = new Date();
    const start = new Date(end); start.setDate(end.getDate() - 6);
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("create_weekly_payroll_run", {
      p_employee_id: employee.id,
      p_period_start: start.toISOString().slice(0, 10),
      p_period_end: end.toISOString().slice(0, 10),
    });
    setBusy(false);
    if (error) return setError(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    alert(`Liquidación creada: ${fmtRef(row?.total_ref ?? 0)}`);
    await load();
  }

  return <main className="container stack">
    <div><h1 style={{ marginBottom: 4 }}>Nómina</h1><div className="muted">Devengos pendientes, bonos y deducciones. Liquidar no puede repetir lo ya pagado.</div></div>
    {error && <div className="error">{error}</div>}

    <section className="grid grid-2">
      {totals.map(({ emp, variable, adj, pending }) => <div className="card stack" key={emp.id}>
        <div className="row-between"><h2 style={{ margin: 0 }}>{emp.name}</h2><span className="pill">{emp.code}</span></div>
        <div className="row-between"><span className="muted">Variable pendiente</span><strong>{fmtRef(variable)}</strong></div>
        <div className="row-between"><span className="muted">Ajustes / deducciones</span><strong>{fmtRef(adj)}</strong></div>
        <div className="divider" />
        <div className="row-between"><strong>Pendiente visible</strong><span className="money-lg">{fmtRef(pending)}</span></div>
        {emp.code === "ALEXIS" && <div className="muted small">El sueldo fijo semanal se agrega al crear la liquidación según la regla vigente; no está incluido en el subtotal variable mostrado arriba.</div>}
        <button className="btn btn-primary" disabled={busy} onClick={() => settle(emp)}>Liquidar últimos 7 días</button>
      </div>)}
    </section>

    <section className="card stack">
      <h2 className="section-title">Agregar deducción</h2>
      <div className="grid grid-3">
        <label><span className="label">Empleado</span><select className="select" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>{employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label><span className="label">Tipo</span><select className="select" value={adjType} onChange={e => setAdjType(e.target.value)}><option value="SUPPLIES">Insumos</option><option value="ADVANCE">Adelanto / préstamo</option><option value="DEBT">Deuda</option><option value="OTHER">Otro</option></select></label>
        <label><span className="label">Monto REF</span><input className="input" type="number" min="0" step="0.01" value={adjAmount || ""} onChange={e => setAdjAmount(Number(e.target.value))} /></label>
      </div>
      <label><span className="label">Nota</span><input className="input" value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder="Ej. insumos de la semana" /></label>
      <button className="btn" disabled={busy || !adjAmount} onClick={addAdjustment}>Registrar deducción</button>
    </section>

    <section className="card" style={{ overflowX: "auto" }}>
      <h2 className="section-title">Detalle pendiente</h2>
      <table className="table"><thead><tr><th>Empleado</th><th>Tipo</th><th>Descripción</th><th>REF</th></tr></thead><tbody>
        {accruals.map(a => <tr key={a.id}><td>{employees.find(e => e.id === a.employee_id)?.name ?? "—"}</td><td>{a.source_type}</td><td>{a.description ?? "—"}</td><td>{fmtRef(a.amount_ref)}</td></tr>)}
        {adjustments.map(a => <tr key={a.id}><td>{employees.find(e => e.id === a.employee_id)?.name ?? "—"}</td><td>{a.adjustment_type}</td><td>{a.note ?? "—"}</td><td>{fmtRef(a.amount_ref)}</td></tr>)}
      </tbody></table>
    </section>
  </main>;
}

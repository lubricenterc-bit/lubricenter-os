"use client";

import Link from "next/link";
import Decimal from "decimal.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { parseBdv, parseCashea, type Preview } from "@/lib/finance/importers";
import { isXlsBinary, readXlsFirstSheet } from "@/lib/xls-biff";
import { mergeBnc, parseBnc, type BncPreview } from "@/lib/cashea-conciliation/bnc";
import { runEngine, summarizePeriod, BRANCHES, type Adjustment, type BankLine, type Branch, type CasheaOrder, type CasheaPayment, type ClassifiedLine, type Cutoff, type Destination, type EngineException, type OsOrder, type OsPayment, type OsSale, type Override } from "@/lib/cashea-conciliation/engine";
import { bdvPanel, canonicalCasheaHeaders, detectKind, exportSheets, ORIGIN_LABELS, RULE_LABELS, type BdvLine } from "@/lib/cashea-conciliation/report";
import "./conciliacion.css";

type Dataset = {
  from: string; branches: Branch[]; bank_lines: BankLine[]; cashea_payments: CasheaPayment[]; cashea_orders: CasheaOrder[];
  os_sales: OsSale[]; os_orders: OsOrder[]; os_payments: OsPayment[]; overrides: (Override & { created_at: string })[];
  adjustments: Adjustment[]; cutoffs: (Cutoff & { summary: Record<string, unknown> | null })[]; destinations: Destination[];
  imports: { id: string; kind: string; file_name: string; row_count: number; inserted: number; observed_from: string | null; observed_to: string | null; chain_ok: boolean | null; created_at: string }[];
  bdv_lines: BdvLine[];
};
type Upload = { name: string; kind: "BNC" | "CASHEA_TRANSACTIONS" | "CASHEA_ORDERS" | "BDV"; bnc?: BncPreview; cashea?: Preview };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const KIND_LABEL: Record<Upload["kind"], string> = { BNC: "Estado de cuenta BNC", CASHEA_TRANSACTIONS: "Pagos Cashea (export)", CASHEA_ORDERS: "Órdenes Cashea", BDV: "BDV Cabudare (texto)" };
const EXCEPTION_LABEL: Record<string, string> = {
  SIN_IDENTIFICAR: "Pago sin identificar", DEBITO_SIN_CLASIFICAR: "Salida sin clasificar", RETIRO_CEDULA_DESCONOCIDA: "Retiro a cédula nueva", CANCELADA_CON_INICIAL: "Cancelada con inicial cobrado",
  OS_BDV_EN_BNC: "OS dice BDV, cayó en BNC", MONTO_DIFERENTE: "Monto OS ≠ banco", FACTURA_MAL_ESCRITA: "Factura mal escrita", REFERENCIA_MAL_CARGADA: "Referencia mal cargada",
  POSIBLE_CABUDARE: "Posible Cabudare", CABUDARE_SIN_ENLACE: "Cabudare sin enlace", INICIAL_NO_REGISTRADO: "Inicial no registrado en el OS", REFERENCIA_PAGO_DISTINTA: "Referencia distinta en el OS", SALTO_DE_SALDO: "Falta un reporte", CORTE_NO_ENCONTRADO: "Cero no encontrado",
};
const money = (v: string | number) => new Decimal(v || 0);
// Reconciliation figures always show cents so they can be checked against the bank statement.
const fmtVes = (v: string | number | null | undefined) => `Bs. ${Number(v ?? 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const neg = (v: string) => money(v).lt(0);

export default function CasheaConciliationPage() {
  const [role, setRole] = useState("");
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [bdvText, setBdvText] = useState("");
  const [rate, setRate] = useState("");
  const [tab, setTab] = useState<"pagos" | "retiros" | "ordenes">("pagos");
  const [branchFilter, setBranchFilter] = useState("");
  const [search, setSearch] = useState("");
  const [assign, setAssign] = useState<{ subject: "ORDER" | "BANK_LINE"; key: string; label: string; branch: string } | null>(null);
  const [assignNote, setAssignNote] = useState("");
  const [proposal, setProposal] = useState<{ title: string; lines: string[]; apply: () => Promise<string> } | null>(null);

  const load = useCallback(async () => {
    const r = await supabase.rpc("finance_role");
    if (r.error) { setError(r.error.message); return; }
    const current = String(r.data ?? ""); setRole(current);
    if (!["OWNER", "ADMIN"].includes(current)) return;
    const d = await supabase.rpc("cashea_conc_dataset", { p_from: null });
    if (d.error) { setError(d.error.message); return; }
    setData(d.data as Dataset);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const result = useMemo(() => data ? runEngine({
    branches: data.branches, bankLines: data.bank_lines.map(l => ({ ...l, debit: String(l.debit), credit: String(l.credit), balance: String(l.balance) })),
    casheaPayments: data.cashea_payments.map(p => ({ ...p, amount: String(p.amount), amount_ref: String(p.amount_ref ?? 0), rate: p.rate === null ? null : String(p.rate), installments: p.installments ?? [] })),
    casheaOrders: data.cashea_orders.map(o => ({ ...o, total_ref: String(o.total_ref), initial_ref: String(o.initial_ref), installments: (o.installments ?? []).map(q => ({ ...q, amount_ref: String(q.amount_ref), paid_ref: String(q.paid_ref) })) })),
    osSales: data.os_sales.map(s => ({ ...s, gross_ref: String(s.gross_ref), initial_ref: String(s.initial_ref) })),
    osOrders: data.os_orders.map(o => ({ ...o, total_ref: String(o.total_ref) })),
    osPayments: data.os_payments.map(p => ({ ...p, amount: String(p.amount) })),
    overrides: data.overrides, adjustments: data.adjustments.map(a => ({ ...a, amount_ves: String(a.amount_ves) })),
    cutoffs: data.cutoffs.map(c => ({ ...c, balance_ves: String(c.balance_ves) })), destinations: data.destinations, today: today(),
  }) : null, [data]);

  const branchName = useMemo(() => new Map((data?.branches ?? []).map(b => [b.code, b.name])), [data]);
  const latestRate = useMemo(() => { if (!result) return ""; const d = [...result.rateByDate.keys()].sort().at(-1); return d ? result.rateByDate.get(d)! : ""; }, [result]);
  const effectiveRate = rate || latestRate;
  const bdv = useMemo(() => {
    if (!data || !result || !data.bdv_lines.length) return null;
    const from = result.current.from_date ?? data.from;
    const withdrawals = result.lines.filter(l => l.kind === "RETIRO" && l.allocations[0]?.branch === BRANCHES.CABUDARE && l.line_date >= from);
    const refs = new Set(data.os_payments.filter(p => p.method === "TRANSFER_BDV").map(p => (p.reference ?? "").replace(/\D/g, "").slice(-4)));
    return bdvPanel(data.bdv_lines.filter(l => l.occurred_at.slice(0, 10) >= from).map(l => ({ ...l, amount: String(l.amount), balance: l.balance === null ? null : String(l.balance) })), withdrawals, refs);
  }, [data, result]);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)); }
    finally { setBusy(false); }
  }

  async function readFiles(files: FileList | null) {
    if (!files?.length) return;
    const next: Upload[] = [];
    for (const file of Array.from(files)) {
      if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name}: archivo mayor de 15 MB.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let cells: unknown[][];
      if (isXlsBinary(bytes)) cells = readXlsFirstSheet(bytes);
      else if (file.name.toLowerCase().endsWith(".xlsx")) { const { readSheet } = await import("read-excel-file/browser"); cells = await readSheet(file, { parseNumber: (v: string) => v }) as unknown[][]; }
      else throw new Error(`${file.name}: usa el .xls del BNC o los .xlsx de Cashea.`);
      const kind = detectKind(cells);
      if (kind === "BNC") next.push({ name: file.name, kind, bnc: parseBnc(cells as Parameters<typeof parseBnc>[0]) });
      else if (kind === "CASHEA_TRANSACTIONS" || kind === "CASHEA_ORDERS") next.push({ name: file.name, kind, cashea: parseCashea(canonicalCasheaHeaders(cells, kind), kind) });
      else throw new Error(`${file.name}: no se reconoce el reporte (BNC, pagos Cashea u órdenes Cashea).`);
    }
    setUploads(u => [...u.filter(x => !next.some(n => n.name === x.name)), ...next]);
  }

  function addBdv() {
    const preview = parseBdv(bdvText);
    setUploads(u => [...u.filter(x => x.kind !== "BDV"), { name: "BDV Cabudare (pegado)", kind: "BDV", cashea: preview }]);
  }

  async function importAll() {
    const blocking = uploads.filter(u => (u.bnc?.errors.length ?? 0) + (u.cashea?.errors.length ?? 0) > 0);
    if (blocking.length) throw new Error(`Corrige los errores de: ${blocking.map(u => u.name).join(", ")}`);
    const steps: string[] = [];
    const bnc = uploads.filter(u => u.kind === "BNC").map(u => u.bnc!);
    if (bnc.length) {
      const merged = mergeBnc(bnc);
      const r = await supabase.rpc("cashea_conc_import_bnc", { p_file_name: uploads.filter(u => u.kind === "BNC").map(u => u.name).join(" + "), p_lines: merged.lines, p_chain_ok: merged.chain_ok });
      if (r.error) throw r.error;
      steps.push(`BNC: ${r.data.inserted} movimientos nuevos, ${r.data.duplicates} ya estaban`);
    }
    const sources = await supabase.from("external_sources").select("id,provider").eq("active", true);
    if (sources.error) throw sources.error;
    for (const u of uploads.filter(x => x.kind !== "BNC")) {
      const provider = u.kind === "BDV" ? "BDV" : u.kind;
      const source = sources.data.find(s => s.provider === provider);
      if (!source) throw new Error(`Falta configurar la fuente ${provider} en Revisión financiera.`);
      const p = u.cashea!;
      const r = await supabase.rpc("finance_import", { p_source_id: source.id, p_name: u.name, p_from: p.observed_from, p_to: p.observed_to, p_preview: p });
      if (r.error) throw r.error;
      const log = await supabase.rpc("cashea_conc_log_import", { p_kind: u.kind === "CASHEA_TRANSACTIONS" ? "CASHEA_PAYMENTS" : u.kind, p_file_name: u.name, p_batch_id: r.data });
      if (log.error) throw log.error;
      steps.push(`${KIND_LABEL[u.kind]}: ${p.rows.length + p.orders.length} filas`);
    }
    setUploads([]); setBdvText("");
    await load();
    setNotice(steps.join(" · ") + ". Revisa el corte y presiona «Actualizar el OS».");
  }

  async function updateOs() {
    if (!result) return;
    const items = [...result.ownership.entries()].map(([external_order, o]) => ({ external_order, branch: o.branch }));
    const own = await supabase.rpc("cashea_conc_apply_ownership", { p_items: items });
    if (own.error) throw own.error;
    const sync = await supabase.rpc("cashea_conc_sync_installments");
    if (sync.error) throw sync.error;
    const rec = await supabase.rpc("finance_reconcile");
    if (rec.error) throw rec.error;
    await load();
    setNotice(`OS actualizado: ${own.data.other_location} cobros marcados de otra sucursal, ${own.data.returned} devueltos a revisión · cuotas pagadas ${sync.data.paid}, parciales ${sync.data.partial}, ventas Cashea saldadas ${sync.data.settled} · casos abiertos en finanzas: ${rec.data?.open_cases ?? "—"}.`);
  }

  async function saveAssign() {
    if (!assign) return;
    const r = await supabase.rpc("cashea_conc_set_override", { p_subject: assign.subject, p_key: assign.key, p_branch: assign.branch || null, p_note: assignNote });
    if (r.error) throw r.error;
    setAssign(null); setAssignNote(""); await load();
  }

  // Every automatic correction is shown first; it is applied only after the explicit "Sí".
  function propose(e: EngineException) {
    const f = e.fix;
    if (!f) return;
    if (f.action === "CORRECT_PAYMENT") { window.location.href = `/orders/${f.order_id}/correct-payment`; return; }
    if (f.action === "MOVE_TO_BNC") setProposal({ title: `Corregir pago de ${f.order_number}`, lines: [
      `Monto: ${fmtVes(f.amount_ves)} (no cambia)`,
      `Cuenta: ${f.from_method === "TRANSFER_BNC" ? "BNC" : f.from_method === "TRANSFER_BDV" ? "BDV" : "Pago móvil"} → BNC`,
      `Referencia: ${f.from_reference || "—"} → ${f.to_reference}`,
      `Evidencia: abono del BNC del ${f.bank_date} por ${fmtVes(f.bank_amount_ves)}`,
    ], apply: async () => {
      const r = await supabase.rpc("cashea_conc_fix_payment", { p_payment_id: f.payment_id, p_bank_line_id: f.bank_line_id, p_confirmed: true });
      if (r.error) throw r.error;
      return `${f.order_number}: pago movido al BNC con referencia ${f.to_reference}.`;
    } });
    else if (f.action === "SET_REFERENCE") setProposal({ title: `Vincular ${e.order_number ?? "la venta"} con Cashea`, lines: [
      `Orden Cashea: ${f.reference}`, e.title, e.detail,
    ], apply: async () => {
      const r = await supabase.rpc("cashea_conc_set_reference", { p_sale_id: f.sale_id, p_reference: f.reference, p_reason: e.kind === "REFERENCIA_MAL_CARGADA" ? "Referencia Cashea mal escrita en el OS (conciliación Cashea)" : "Identificada por fecha y monto en la conciliación Cashea" });
      if (r.error) throw r.error;
      return `${e.order_number ?? "Venta"} vinculada con la orden Cashea ${f.reference}.`;
    } });
    else setProposal({ title: `Asignar orden Cashea ${f.external_order}`, lines: [`Sucursal: ${branchName.get(f.branch) ?? f.branch}`, e.detail], apply: async () => {
      const r = await supabase.rpc("cashea_conc_set_override", { p_subject: "ORDER", p_key: f.external_order, p_branch: f.branch, p_note: `Confirmado en conciliación: ${e.title}` });
      if (r.error) throw r.error;
      return `Orden ${f.external_order} asignada a ${branchName.get(f.branch) ?? f.branch}.`;
    } });
  }

  async function applyProposal() {
    if (!proposal) return;
    const message = await proposal.apply();
    setProposal(null); await load();
    setNotice(`${message} Cuando termines, presiona «Actualizar el OS».`);
  }

  async function markZero(line: ClassifiedLine) {
    if (!result || !data) return;
    const idx = result.lines.findIndex(l => l.id === line.id);
    const activeCut = result.current.cutoff;
    const anchor = result.current.from_line_id ? result.lines.findIndex(l => l.id === result.current.from_line_id) - 1 : null;
    const summary = summarizePeriod({ branches: data.branches, adjustments: data.adjustments.map(a => ({ ...a, amount_ves: String(a.amount_ves) })) }, result.lines, activeCut, anchor, idx);
    const note = window.prompt(`Marcar cero el ${line.line_date} (ref ${line.reference}, saldo ${fmtVes(line.balance)}). Nota opcional:`, "");
    if (note === null) return;
    const r = await supabase.rpc("cashea_conc_mark_cutoff", { p_bank_line_id: line.id, p_note: note, p_summary: summary });
    if (r.error) throw r.error;
    await load(); setNotice("Nuevo cero guardado. El corte actual arranca desde ahí.");
  }

  async function exportExcel() {
    if (!result) return;
    const { default: writeExcelFile } = await import("write-excel-file/browser");
    const sheets = exportSheets({ result, summary: result.current, receivables: result.receivables, rate: effectiveRate, branchName, bdv, exceptions: result.exceptions });
    await writeExcelFile(sheets as never).toFile(`Cashea_Cabudare_corte_${result.current.to_date ?? today()}.xlsx`);
  }

  if (role && !["OWNER", "ADMIN"].includes(role)) return <main className="container stack"><h1>Conciliación Cashea</h1><div className="card">Esta revisión corresponde al administrador o al dueño.</div></main>;

  const lines = result?.lines ?? [];
  const periodIds = new Set<string>();
  if (result?.current.from_line_id) { let on = false; for (const l of lines) { if (l.id === result.current.from_line_id) on = true; if (on) periodIds.add(l.id); if (l.id === result.current.to_line_id) break; } }
  const q = search.trim().toLowerCase();
  const visibleLines = lines.filter(l => periodIds.has(l.id) && (!branchFilter || l.allocations.some(a => a.branch === branchFilter))
    && (!q || [l.reference, l.description, l.note, ...l.allocations.map(a => `${a.external_order ?? ""} ${a.os_order_number ?? ""}`)].join(" ").toLowerCase().includes(q)));
  const visibleOrders = (result?.orders ?? []).filter(o => (!branchFilter || o.ownership.branch === branchFilter)
    && (!q || [o.external_order, o.invoice, o.buyer, o.ownership.os_order_number].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => b.purchased_on.localeCompare(a.purchased_on));
  const cur = result?.current;

  return <main className="container stack cashea-conc">
    <div className="row-between"><div><div className="eyebrow">FINANZAS · CASHEA</div><h1>Conciliación por sucursal</h1><p className="muted">Cuánto del dinero del BNC ***4493 es de cada sucursal desde el último cero y cuánto queda por cobrar en Cashea.</p></div>
      <div className="row"><Link className="btn" href="/cashea">Volver a Cashea</Link>{result && <button className="btn" onClick={() => run(exportExcel)} disabled={busy}>Exportar Excel</button>}</div></div>
    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    <section className="card stack">
      <h2 className="section-title">Cargar reportes</h2>
      <p className="muted small">Sube juntos el estado de cuenta del BNC (Rpt*.xls), el export de pagos (export_*.xlsx) y el de órdenes de Cashea (ordenes_*.xlsx). Se pueden solapar: lo repetido no se duplica y cada orden queda con su versión más reciente.</p>
      <input className="input" type="file" multiple accept=".xls,.xlsx" disabled={busy} onChange={e => { const f = e.target.files; void run(() => readFiles(f)); e.target.value = ""; }} />
      <details><summary className="muted small">BDV de Cabudare (opcional): pegar movimientos copiados de la web del banco</summary>
        <textarea className="textarea" rows={5} value={bdvText} onChange={e => setBdvText(e.target.value)} placeholder="Fecha · Referencia · Descripción · Débito / Crédito · Monto · Saldo" />
        <button className="btn" disabled={busy || !bdvText.trim()} onClick={() => run(async () => addBdv())}>Revisar BDV pegado</button>
      </details>
      {uploads.map(u => { const p = u.bnc ?? u.cashea!; const rows = u.bnc ? u.bnc.lines.length : u.cashea!.rows.length + u.cashea!.orders.length; const chain = u.bnc ? u.bnc.chain_ok : u.cashea!.balance_chain;
        return <div key={u.name} className="row-between order-item"><div><strong>{u.name}</strong><div className="muted small">{KIND_LABEL[u.kind]} · {rows} filas · {p.observed_from} → {p.observed_to}{p.duplicates ? ` · ${p.duplicates} repetidas` : ""}{chain === false ? " · saldos con saltos" : chain ? " · saldos encadenados" : ""}</div>
          {!!p.errors.length && <div className="error small">{p.errors.length} errores: {p.errors.slice(0, 3).map(e => `fila ${e.row}: ${e.message}`).join(" · ")}</div>}
          {!!p.warnings.length && <div className="muted small">{p.warnings.length} observaciones: {p.warnings.slice(0, 2).map(e => `fila ${e.row}: ${e.message}`).join(" · ")}</div>}</div>
          <button className="btn btn-ghost" onClick={() => setUploads(x => x.filter(y => y !== u))}>Quitar</button></div>; })}
      {!!uploads.length && <button className="btn btn-primary" disabled={busy} onClick={() => run(importAll)}>{busy ? "Cargando…" : "Cargar reportes"}</button>}
      <div className="row-between"><span className="muted small">Después de cargar: marca los cobros de otras sucursales en finanzas, actualiza las cuotas pagadas de Cabudare y reconcilia.</span>
        <button className="btn btn-primary" disabled={busy || !result} onClick={() => run(updateOs)}>Actualizar el OS</button></div>
      {!!data?.imports.length && <details><summary className="muted small">Últimas cargas</summary>{data.imports.map(i => <div key={i.id} className="muted small">{i.created_at.slice(0, 16).replace("T", " ")} · {i.kind} · {i.file_name} · {i.inserted}/{i.row_count} nuevas · {i.observed_from} → {i.observed_to}</div>)}</details>}
    </section>

    {!data && !error && <div className="card">Cargando…</div>}
    {result && cur && <>
      <section className="card stack">
        <div className="row-between"><h2 className="section-title">Corte actual</h2><span className="muted small">{cur.cutoff ? `Desde el cero del ${cur.cutoff.cut_date} (ref ${cur.cutoff.reference})` : "Sin cero registrado"} · hasta {cur.to_date ?? "—"} · {cur.credits} abonos</span></div>
        <div className="cc-table-wrap"><table className="table cc-table"><thead><tr><th>Sucursal</th><th>Entró al BNC</th><th>Retiró del BNC</th><th>Ajustes</th><th>Le toca hoy</th></tr></thead><tbody>
          {cur.rows.map(r => <tr key={r.branch}><td>{r.name}</td><td>{fmtVes(r.entered)}</td><td>{fmtVes(r.withdrawn)}</td><td>{fmtVes(r.adjustments)}</td><td className={neg(r.due) ? "cc-neg" : ""}><strong>{fmtVes(r.due)}</strong></td></tr>)}
          <tr><td className="muted">Saldo que quedó en el cero (sin asignar)</td><td /><td /><td /><td>{fmtVes(cur.residual)}</td></tr>
          <tr className="cc-total"><td>Total</td><td>{fmtVes(cur.entered)}</td><td>{fmtVes(cur.withdrawn)}</td><td /><td>{fmtVes(cur.total)}</td></tr>
          <tr className={money(cur.difference).isZero() ? "cc-ok" : "cc-bad"}><td>Saldo del BNC</td><td colSpan={3}>{money(cur.difference).isZero() ? "Cuadra con el banco" : `Diferencia ${fmtVes(cur.difference)}: falta un reporte o hay un salto de saldo`}</td><td>{cur.bank_balance === null ? "—" : fmtVes(cur.bank_balance)}</td></tr>
        </tbody></table></div>
        {result.zeroSuggestion && <div className="finance-warning card"><span>El retiro del {result.zeroSuggestion.line.line_date} (ref {result.zeroSuggestion.line.reference}) dejó el BNC en {fmtVes(result.zeroSuggestion.balance)}. ¿Es el nuevo cero?</span><button className="btn btn-primary" disabled={busy} onClick={() => run(() => markZero(result.zeroSuggestion!.line))}>Marcar nuevo cero</button></div>}
      </section>

      <section className="card stack">
        <div className="row-between"><h2 className="section-title">Por cobrar de Cashea</h2><label className="row small">Tasa Bs/USD<input className="input cc-rate" inputMode="decimal" value={rate} placeholder={latestRate} onChange={e => setRate(e.target.value.replace(",", "."))} /></label></div>
        <div className="cc-table-wrap"><table className="table cc-table"><thead><tr><th>Sucursal</th><th>Vencido USD</th><th>Por vencer USD</th><th>Total USD</th><th>Total Bs</th></tr></thead><tbody>
          {result.receivables.map(r => <tr key={r.branch}><td>{r.name}</td><td className={money(r.overdue_ref).gt(0) ? "cc-neg" : ""}>{fmtRef(r.overdue_ref)}</td><td>{fmtRef(r.upcoming_ref)}</td><td><strong>{fmtRef(r.total_ref)}</strong></td><td>{/^\d+(\.\d+)?$/.test(effectiveRate) ? fmtVes(money(r.total_ref).mul(effectiveRate).toFixed(2)) : "—"}</td></tr>)}
          <tr className="cc-total"><td>Total</td><td>{fmtRef(result.receivables.reduce((s, r) => s.add(r.overdue_ref), money(0)).toFixed(2))}</td><td>{fmtRef(result.receivables.reduce((s, r) => s.add(r.upcoming_ref), money(0)).toFixed(2))}</td><td>{fmtRef(result.receivables.reduce((s, r) => s.add(r.total_ref), money(0)).toFixed(2))}</td><td /></tr>
        </tbody></table></div>
        <p className="muted small">Cuota pendiente = monto − pagado si no está DONE ni CANCELLED; vencida si está DELAYED o su fecha ya pasó. Órdenes canceladas no cuentan. Fuente: último export de órdenes.</p>
      </section>

      <section className="card stack">
        <h2 className="section-title">Excepciones ({result.exceptions.length})</h2>
        {!result.exceptions.length && <p className="muted">Nada pendiente.</p>}
        {result.exceptions.map(e => <div key={e.key} className="row-between order-item"><div><span className="pill warn">{EXCEPTION_LABEL[e.kind] ?? e.kind}</span> <strong>{e.title}</strong><div className="muted small">{e.detail}{e.amount_ves ? ` · ${fmtVes(e.amount_ves)}` : ""}</div></div>
          <div className="row">{e.fix && <button className="btn" disabled={busy} onClick={() => propose(e)}>{e.fix.action === "SET_REFERENCE" ? "Vincular" : e.fix.action === "ASSIGN_ORDER" ? "Asignar" : e.fix.action === "MOVE_TO_BNC" ? "Corregir" : "Revisar"}</button>}
            {e.bank_line_id && <button className="btn btn-ghost" onClick={() => setAssign({ subject: "BANK_LINE", key: e.bank_line_id!, label: e.title, branch: "" })}>Asignar sucursal</button>}
            {!e.bank_line_id && e.external_order && e.kind !== "POSIBLE_CABUDARE" && <button className="btn btn-ghost" onClick={() => setAssign({ subject: "ORDER", key: e.external_order!, label: `Orden Cashea ${e.external_order}`, branch: "" })}>Reasignar</button>}</div></div>)}
      </section>

      <section className="card stack">
        <div className="row-between"><h2 className="section-title">Detalle</h2><div className="row">{(["pagos", "retiros", "ordenes"] as const).map(t => <button key={t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t === "pagos" ? "Pagos BNC" : t === "retiros" ? "Retiros" : "Órdenes"}</button>)}</div></div>
        <div className="grid grid-2"><select className="select" value={branchFilter} onChange={e => setBranchFilter(e.target.value)}><option value="">Todas las sucursales</option>{data!.branches.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select>
          <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar referencia, orden, factura, comprador" /></div>
        <div className="cc-table-wrap">
          {tab === "pagos" && <table className="table cc-table"><thead><tr><th>Fecha</th><th>Referencia</th><th>Monto</th><th>Sucursal</th><th>Origen</th><th>Detalle</th><th /></tr></thead><tbody>
            {visibleLines.filter(l => money(l.credit).gt(0)).map(l => <tr key={l.id}><td>{l.line_date}</td><td>{l.reference}</td><td>{fmtVes(l.credit)}</td><td>{l.allocations.map(a => <div key={a.branch + a.external_order}>{branchName.get(a.branch)}{l.allocations.length > 1 ? ` ${fmtVes(a.amount)}` : ""}</div>)}</td><td>{ORIGIN_LABELS[l.origin]}</td><td className="small">{l.note}</td>
              <td><button className="btn btn-ghost" onClick={() => setAssign({ subject: "BANK_LINE", key: l.id, label: `${l.line_date} ref ${l.reference} · ${fmtVes(l.credit)}`, branch: "" })}>Reasignar</button></td></tr>)}
          </tbody></table>}
          {tab === "retiros" && <table className="table cc-table"><thead><tr><th>Fecha</th><th>Referencia</th><th>Tipo</th><th>Monto</th><th>Sucursal</th><th>Detalle</th><th>Saldo</th><th /></tr></thead><tbody>
            {visibleLines.filter(l => money(l.debit).gt(0)).map(l => <tr key={l.id}><td>{l.line_date}</td><td>{l.reference}</td><td>{l.kind === "RETIRO" ? "Retiro" : l.kind === "COMISION" ? "Comisión" : "Otro"}</td><td>{fmtVes(l.debit)}</td><td>{branchName.get(l.allocations[0]?.branch ?? "")}</td><td className="small">{l.note}</td><td>{fmtVes(l.balance)}</td>
              <td className="row">{l.kind !== "COMISION" && <button className="btn btn-ghost" onClick={() => setAssign({ subject: "BANK_LINE", key: l.id, label: `Retiro ${l.line_date} ref ${l.reference}`, branch: "" })}>Reasignar</button>}
                {money(l.balance).lt(10000) && <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => markZero(l))}>Marcar cero</button>}</td></tr>)}
          </tbody></table>}
          {tab === "ordenes" && <table className="table cc-table"><thead><tr><th>Orden</th><th>Factura</th><th>Comprador</th><th>Compra</th><th>Estado</th><th>Sucursal</th><th>Vencido</th><th>Por vencer</th><th>Bs recibidos</th><th /></tr></thead><tbody>
            {visibleOrders.slice(0, 300).map(o => <tr key={o.external_order}><td>{o.external_order}</td><td>{o.invoice ?? "—"}</td><td className="small">{o.buyer}</td><td>{o.purchased_on}</td><td>{o.status}</td><td>{branchName.get(o.ownership.branch)}<div className="muted small">{RULE_LABELS[o.ownership.rule]}{o.ownership.os_order_number ? ` · ${o.ownership.os_order_number}` : ""}</div></td>
              <td>{fmtRef(o.overdue_ref)}</td><td>{fmtRef(o.upcoming_ref)}</td><td>{fmtVes(o.received_ves)}</td>
              <td><button className="btn btn-ghost" onClick={() => setAssign({ subject: "ORDER", key: o.external_order, label: `Orden Cashea ${o.external_order} (${o.invoice ?? "sin factura"})`, branch: "" })}>Reasignar</button></td></tr>)}
          </tbody></table>}
        </div>
        {tab === "ordenes" && visibleOrders.length > 300 && <p className="muted small">Mostrando 300 de {visibleOrders.length}; usa el buscador.</p>}
      </section>

      <Adjustments data={data!} branchName={branchName} busy={busy} run={run} reload={load} />
      <Cutoffs data={data!} busy={busy} run={run} reload={load} role={role} />
      <Destinations data={data!} branchName={branchName} busy={busy} run={run} reload={load} />

      {bdv && <section className="card stack">
        <h2 className="section-title">BDV de Cabudare ({bdv.from} → {bdv.to})</h2>
        <div className="cc-table-wrap"><table className="table cc-table"><tbody>
          <tr><td>Saldo inicial</td><td>{fmtVes(bdv.opening)}</td></tr><tr><td>+ Retiros recibidos del BNC</td><td>{fmtVes(bdv.fromBnc)}</td></tr>
          <tr><td>+ Cobros de ventas</td><td>{fmtVes(bdv.sales)}</td></tr><tr><td>+ Otras entradas</td><td>{fmtVes(bdv.otherIn)}</td></tr>
          <tr><td>− Egresos grandes (≥ 30.000 Bs)</td><td>{fmtVes(bdv.bigOut)}</td></tr><tr><td>− Gastos menores</td><td>{fmtVes(bdv.smallOut)}</td></tr><tr><td>− Comisiones</td><td>{fmtVes(bdv.fees)}</td></tr>
          <tr className={money(bdv.closing).eq(bdv.computedClosing) ? "cc-total" : "cc-bad"}><td>Saldo final</td><td>{fmtVes(bdv.closing)}{money(bdv.closing).eq(bdv.computedClosing) ? "" : ` (calculado ${fmtVes(bdv.computedClosing)})`}</td></tr>
        </tbody></table></div>
        <p className="muted small">Si un egreso grande fue un pago a otra sucursal, regístralo como ajuste entre sucursales (a favor de Cabudare, a cargo de quien lo recibió).</p>
        {bdv.big.map(l => <div key={l.id} className="row-between order-item"><div><strong>{fmtVes(l.amount)}</strong><div className="muted small">{l.occurred_at.slice(0, 16).replace("T", " ")} · ref {l.reference} · {l.description}</div></div></div>)}
      </section>}
    </>}

    {proposal && <div className="overlay"><div className="sheet stack">
      <h2>{proposal.title}</h2>
      <ul className="stack">{proposal.lines.filter(Boolean).map(x => <li key={x}>{x}</li>)}</ul>
      <p className="muted small">Queda registrado en la auditoría del OS.</p>
      <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => run(applyProposal)}>{busy ? "Corrigiendo…" : "Sí, corregir"}</button><button className="btn" disabled={busy} onClick={() => setProposal(null)}>No</button></div>
    </div></div>}
    {assign && <div className="overlay"><div className="sheet stack">
      <h2>Reasignar sucursal</h2><p className="muted">{assign.label}. La decisión manual gana sobre las reglas y queda registrada con su motivo.</p>
      <label>Sucursal<select className="select" value={assign.branch} onChange={e => setAssign({ ...assign, branch: e.target.value })}><option value="">Volver a la regla automática</option>{data?.branches.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
      <label>Motivo<input className="input" value={assignNote} onChange={e => setAssignNote(e.target.value)} placeholder="Ej.: confirmado con Norte por WhatsApp" /></label>
      <div className="row"><button className="btn btn-primary" disabled={busy || assignNote.trim().length < 3} onClick={() => run(saveAssign)}>Guardar</button><button className="btn" onClick={() => setAssign(null)}>Cancelar</button></div>
    </div></div>}
  </main>;
}

type SectionProps = { data: Dataset; busy: boolean; run: (f: () => Promise<void>) => Promise<void>; reload: () => Promise<void> };

function Adjustments({ data, branchName, busy, run, reload }: SectionProps & { branchName: Map<string, string> }) {
  const [date, setDate] = useState(today()), [amount, setAmount] = useState(""), [debit, setDebit] = useState("NORTE"), [credit, setCredit] = useState("CABUDARE"), [note, setNote] = useState(""), [reference, setReference] = useState("");
  async function save() {
    const r = await supabase.rpc("cashea_conc_adjustment", { p_occurred_on: date, p_amount: amount.replace(/\./g, "").replace(",", "."), p_debit_branch: debit, p_credit_branch: credit, p_note: note, p_reference: reference || null });
    if (r.error) throw r.error;
    setAmount(""); setNote(""); setReference(""); await reload();
  }
  async function voidAdj(id: string) { const reason = window.prompt("Motivo para anular el ajuste:"); if (!reason) return; const r = await supabase.rpc("cashea_conc_void", { p_kind: "ADJUSTMENT", p_id: id, p_reason: reason }); if (r.error) throw r.error; await reload(); }
  return <section className="card stack">
    <h2 className="section-title">Ajustes entre sucursales</h2>
    <p className="muted small">Ej.: el 25/10 Cabudare pagó 45.000 Bs a Norte desde su BDV → a favor de Cabudare, a cargo de Norte.</p>
    <div className="grid grid-2"><label>Fecha<input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>Monto Bs<input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label>A favor de<select className="select" value={credit} onChange={e => setCredit(e.target.value)}>{data.branches.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
      <label>A cargo de<select className="select" value={debit} onChange={e => setDebit(e.target.value)}>{data.branches.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
      <label>Nota<input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Traspaso BDV a Norte" /></label><label>Referencia<input className="input" value={reference} onChange={e => setReference(e.target.value)} /></label></div>
    <button className="btn btn-primary" disabled={busy || !amount || note.trim().length < 3 || debit === credit} onClick={() => run(save)}>Registrar ajuste</button>
    {data.adjustments.map(a => <div key={a.id} className="row-between order-item"><div><strong>{fmtVes(a.amount_ves)}</strong> · {a.occurred_on}<div className="muted small">A favor de {branchName.get(a.credit_branch)} · a cargo de {branchName.get(a.debit_branch)} · {a.note}{a.reference ? ` · ref ${a.reference}` : ""}</div></div><button className="btn btn-ghost" disabled={busy} onClick={() => run(() => voidAdj(a.id))}>Anular</button></div>)}
  </section>;
}

function Cutoffs({ data, busy, run, reload, role }: SectionProps & { role: string }) {
  async function voidCut(id: string) { const reason = window.prompt("Motivo para anular este cero:"); if (!reason) return; const r = await supabase.rpc("cashea_conc_void", { p_kind: "CUTOFF", p_id: id, p_reason: reason }); if (r.error) throw r.error; await reload(); }
  return <section className="card stack">
    <h2 className="section-title">Ceros registrados</h2>
    {[...data.cutoffs].reverse().map(c => { const s = c.summary as { rows?: { name: string; due: string }[]; total?: string } | null;
      return <div key={c.id} className="row-between order-item"><div><strong>{c.cut_date}</strong> · ref {c.reference} · saldo {fmtVes(c.balance_ves)}<div className="muted small">{c.note}{s?.rows ? " · " + s.rows.filter(r => !money(r.due).isZero()).map(r => `${r.name} ${fmtVes(r.due)}`).join(" · ") : ""}{c.bank_line_id ? "" : " · línea del banco aún no cargada"}</div></div>
        {role === "OWNER" && <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => voidCut(c.id))}>Anular</button>}</div>; })}
  </section>;
}

function Destinations({ data, branchName, busy, run, reload }: SectionProps & { branchName: Map<string, string> }) {
  const [cedula, setCedula] = useState(""), [branch, setBranch] = useState("AFUERA_SIN_ASIGNAR"), [label, setLabel] = useState("");
  async function save() { const r = await supabase.rpc("cashea_conc_set_destination", { p_cedula: cedula, p_branch: branch, p_label: label }); if (r.error) throw r.error; setCedula(""); setLabel(""); await reload(); }
  return <section className="card stack">
    <h2 className="section-title">Destinos de los retiros del BNC</h2>
    {data.destinations.map(d => <div key={d.cedula} className="row-between order-item"><div><strong>{d.cedula}</strong> → {branchName.get(d.branch)}<div className="muted small">{d.label}</div></div><button className="btn btn-ghost" onClick={() => { setCedula(d.cedula); setBranch(d.branch); setLabel(d.label); }}>Editar</button></div>)}
    <div className="grid grid-2"><label>Cédula<input className="input" value={cedula} onChange={e => setCedula(e.target.value)} placeholder="V12306298" /></label><label>Sucursal<select className="select" value={branch} onChange={e => setBranch(e.target.value)}>{data.branches.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
      <label>Descripción<input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Titular y cuenta destino" /></label></div>
    <button className="btn" disabled={busy || !cedula || label.trim().length < 2} onClick={() => run(save)}>Guardar destino</button>
  </section>;
}

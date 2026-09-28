"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";
import { referenceError } from "@/lib/finance/money";

type Customer = { id: string; name: string | null; phone: string | null };
type Pocket = "USD" | "VES_BCV";
type Method = "CASH_VES" | "TRANSFER_BDV" | "TRANSFER_BNC" | "CASH_USD" | "ZELLE" | "BINANCE";
type Entry = {
  id: string; pocket: Pocket; movement_type: "DEPOSIT" | "USE" | "RELEASE" | "REFUND" | "REVERSAL";
  origin: "ADVANCE" | "OVERPAYMENT" | "CANCELLED_SALE" | "USE" | "RELEASE" | "REFUND" | "OVERPAYMENT_REVERSAL";
  delta_usd: number; amount_original: number; currency: "USD" | "VES"; value_ves: number;
  bcv_rate_snapshot: number; operative_rate_snapshot: number; method: string | null;
  reference: string | null; note: string; order_id: string | null; created_at: string;
};

const methods: readonly [Method, string][] = [
  ["CASH_VES", "Efectivo Bs"], ["TRANSFER_BDV", "Pago móvil · Venezuela"],
  ["TRANSFER_BNC", "Pago móvil · BNC"], ["CASH_USD", "Efectivo USD"],
  ["ZELLE", "Zelle USD"], ["BINANCE", "Binance USD"],
];
const usdMethod = (method: Method) => ["CASH_USD","ZELLE","BINANCE"].includes(method);
const title = (entry: Entry) => ({
  DEPOSIT: entry.origin==="OVERPAYMENT"?"Sobrante de pago":entry.origin==="CANCELLED_SALE"?"Venta anulada · cobro conservado":"Anticipo recibido", USE: "Usado en una orden",
  RELEASE: "Devuelto al saldo", REFUND: "Devuelto al cliente", REVERSAL: "Cobro corregido",
})[entry.movement_type];

export default function CustomerBalanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const requestId = useRef<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [balances, setBalances] = useState<Record<Pocket, number>>({ USD: 0, VES_BCV: 0 });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rates, setRates] = useState({ bcv: 0, operative: 0 });
  const [role, setRole] = useState("OPERATOR");
  const [action, setAction] = useState<"DEPOSIT" | "REFUND">("DEPOSIT");
  const [pocket, setPocket] = useState<Pocket>("VES_BCV");
  const [method, setMethod] = useState<Method>("CASH_VES");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function edit<T>(setter: (value: T) => void, value: T) {
    requestId.current = null; setConfirmed(false); setter(value);
  }
  async function load() {
    const [c, a, h, r, userRole] = await Promise.all([
      supabase.from("customers").select("id,name,phone").eq("id",id).single(),
      supabase.from("customer_balance_accounts").select("pocket,balance_usd").eq("customer_id",id),
      supabase.from("customer_balance_movements").select("id,pocket,movement_type,origin,delta_usd,amount_original,currency,value_ves,bcv_rate_snapshot,operative_rate_snapshot,method,reference,note,order_id,created_at").eq("customer_id",id).order("created_at",{ascending:false}).limit(100),
      supabase.rpc("get_current_rates"),
      supabase.rpc("finance_role"),
    ]);
    const firstError = [c.error,a.error,h.error,r.error,userRole.error].find(Boolean);
    if (firstError) { setError(firstError.message); setLoading(false); return; }
    setCustomer(c.data as Customer);
    const next: Record<Pocket,number> = { USD: 0, VES_BCV: 0 };
    for (const row of a.data ?? []) next[row.pocket as Pocket] = Number(row.balance_usd);
    setBalances(next);
    setEntries((h.data ?? []) as Entry[]);
    const rateRow = Array.isArray(r.data) ? r.data[0] : r.data;
    setRates({ bcv: Number(rateRow?.bcv_rate ?? 0), operative: Number(rateRow?.operative_rate ?? 0) });
    setRole(String(userRole.data ?? "OPERATOR"));
    setLoading(false);
  }
  useEffect(() => { if (id) load(); }, [id]);

  function switchAction(next: "DEPOSIT" | "REFUND") {
    setAction(next); setPocket("VES_BCV"); setMethod("CASH_VES");
    setAmount(""); setReference(""); setNote(""); setConfirmed(false);
    setError(""); requestId.current = null;
  }
  function switchPocket(next: Pocket) {
    edit(setPocket,next); setMethod(next === "USD" ? "CASH_USD" : "CASH_VES");
    setReference("");
  }
  async function submit() {
    if (busy) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || Math.abs(Math.round(value*100)-value*100)>0.000001) return setError("Indica un monto positivo con máximo dos decimales.");
    if (!confirmed) return setError(action === "DEPOSIT" ? "Confirma que el dinero ya fue recibido." : "Confirma que entregarás este dinero al cliente.");
    const re = referenceError(method,reference); if (re) return setError(re);
    if (action === "REFUND" && note.trim().length < 5) return setError("Explica por qué se devuelve el saldo.");
    if (action === "REFUND" && value > balances[pocket]) return setError("No puedes devolver más que el saldo disponible.");
    setBusy(true); setError(""); setNotice("");
    requestId.current ??= crypto.randomUUID();
    const result = action === "DEPOSIT"
      ? await supabase.rpc("record_customer_balance_deposit", {
          p_customer_id:id,p_method:method,p_amount_original:value,p_reference:reference.trim()||null,
          p_note:note.trim()||null,p_request_id:requestId.current,
        })
      : await supabase.rpc("refund_customer_balance", {
          p_customer_id:id,p_pocket:pocket,p_amount_usd:value,p_method:method,
          p_reference:reference.trim()||null,p_reason:note.trim(),p_request_id:requestId.current,
        });
    setBusy(false);
    if (result.error) return setError(result.error.message);
    requestId.current = null; setAmount(""); setReference(""); setNote(""); setConfirmed(false);
    setNotice(action === "DEPOSIT" ? "Anticipo registrado. Ya está disponible para usar en órdenes." : "Devolución registrada y descontada del saldo.");
    await load();
  }

  const depositPocket: Pocket = usdMethod(method) ? "USD" : "VES_BCV";
  const depositValueUsd = depositPocket === "USD" ? Number(amount||0) : rates.bcv > 0 ? Number(amount||0)/rates.bcv : 0;
  const refundValue = pocket === "USD" ? fmtRef(Number(amount||0)) : fmtVes(Number(amount||0)*rates.bcv);

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">CRM · SALDO A FAVOR</div><h1>{customer?.name || "Cliente"}</h1><p>{customer?.phone || "Sin teléfono"} · El dinero recibido y su uso quedan en un historial.</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>
    <div className="row"><Link className="btn btn-ghost" href="/customer-balances">← Todos los saldos</Link><Link className="btn" href={`/customers/${id}`}>Ficha del cliente</Link></div>
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="success" role="status">{notice}</div>}
    {loading ? <div className="card muted">Cargando saldo…</div> : <>
      <section className="grid grid-2">
        <div className="card stack"><div className="muted small">DIVISAS RECIBIDAS</div><div className="kpi">{fmtRef(balances.USD)}</div><div className="muted small">Se usan como USD; una devolución debe salir en divisas.</div></div>
        <div className="card stack"><div className="muted small">BS RECIBIDOS · VALOR BCV CONGELADO</div><div className="kpi">{fmtRef(balances.VES_BCV)}</div><div className="muted small">Hoy equivalen a {fmtVes(balances.VES_BCV*rates.bcv)} con BCV {rates.bcv.toLocaleString("es-VE")}.</div></div>
      </section>
      <section className="card stack">
        <div><h2 className="section-title">Administrar saldo</h2><div className="muted small">Un anticipo aumenta la caja. Usar saldo en una orden no registra dinero nuevo.</div></div>
        <div className="segmented"><button className={action==="DEPOSIT"?"btn btn-primary":"btn btn-ghost"} onClick={() => switchAction("DEPOSIT")}>Registrar anticipo</button>{["ADMIN","OWNER"].includes(role) && <button className={action==="REFUND"?"btn btn-primary":"btn btn-ghost"} onClick={() => switchAction("REFUND")}>Devolver saldo</button>}</div>
        {action === "REFUND" && <div><span className="label">Qué saldo se devuelve</span><div className="grid grid-2"><button className={pocket==="VES_BCV"?"btn btn-primary":"btn"} onClick={() => switchPocket("VES_BCV")}>Bs · BCV {fmtRef(balances.VES_BCV)}</button><button className={pocket==="USD"?"btn btn-primary":"btn"} onClick={() => switchPocket("USD")}>Divisas {fmtRef(balances.USD)}</button></div></div>}
        <label><span className="label">{action==="DEPOSIT"?"Cómo recibiste el anticipo":"Cómo se devolverá"}</span><select className="select" value={method} onChange={event => { const next=event.target.value as Method; if(action==="REFUND" && usdMethod(next)!==(pocket==="USD")) return; edit(setMethod,next); setReference(""); }}><option value={method}>{methods.find(([key])=>key===method)?.[1]}</option>{methods.filter(([key])=>key!==method && (action==="DEPOSIT" || usdMethod(key)===(pocket==="USD"))).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
        <div className="grid grid-2"><label><span className="label">{action==="DEPOSIT" ? `Monto recibido · ${depositPocket==="USD"?"USD":"Bs"}` : "Valor a devolver · USD de saldo"}</span><input className="input" type="number" min="0.01" step="0.01" value={amount} onChange={event=>edit(setAmount,event.target.value)} placeholder="0,00" /></label><label><span className="label">{method.startsWith("TRANSFER")?"Últimos 4 de referencia · obligatorio":"Referencia · opcional"}</span><input className="input" value={reference} onChange={event=>edit(setReference,event.target.value)} /></label></div>
        <label><span className="label">{action==="DEPOSIT"?"Nota · opcional":"Motivo · obligatorio"}</span><textarea className="textarea" value={note} onChange={event=>edit(setNote,event.target.value)} placeholder={action==="DEPOSIT"?"Ej. anticipo para próximo servicio":"Ej. devolución solicitada por el cliente"} /></label>
        <div className="card stack"><div className="row-between"><span>{action==="DEPOSIT"?"Saldo que se acreditará":"Monto que se entregará"}</span><strong>{action==="DEPOSIT"?fmtRef(Math.round(depositValueUsd*100)/100):refundValue}</strong></div><div className="muted small">{action==="DEPOSIT" && depositPocket==="VES_BCV" ? `BCV al recibir: ${rates.bcv.toLocaleString("es-VE")} Bs/USD. Ese valor USD se conservará hasta que se use.` : action==="REFUND" && pocket==="VES_BCV" ? `Se entregarán Bs a la BCV actual de ${rates.bcv.toLocaleString("es-VE")} Bs/USD.` : "El saldo permanece y se entrega en divisas."}</div></div>
        <label className="row"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} /><span>{action==="DEPOSIT"?"Confirmo que recibí este dinero.":"Confirmo la devolución en el método indicado."}</span></label>
        <button className="btn btn-primary btn-block" disabled={busy||!confirmed||!Number(amount)||!rates.bcv} onClick={submit}>{busy?"Registrando…":action==="DEPOSIT"?"Registrar anticipo recibido":"Registrar devolución"}</button>
      </section>
      <section className="card stack"><div><h2 className="section-title">Historial de movimientos</h2><div className="muted small">Cada fila conserva la moneda, la tasa y la orden relacionada.</div></div>{entries.map(entry => <div className="order-item" key={entry.id}><div className="row-between"><div><strong>{title(entry)}</strong><div className="muted small">{fmtDate(entry.created_at)} · {entry.pocket==="USD"?"Divisas":"Bs · BCV"}{entry.method?` · ${methods.find(([key])=>key===entry.method)?.[1]??entry.method}`:""}</div></div><strong style={{color:entry.delta_usd>0?"#65d393":undefined}}>{entry.delta_usd>0?"+":"−"}{fmtRef(Math.abs(Number(entry.delta_usd)))}</strong></div><div className="muted small">{entry.currency==="USD"?fmtRef(entry.amount_original):fmtVes(entry.amount_original)} · BCV {Number(entry.bcv_rate_snapshot).toLocaleString("es-VE")}{entry.reference?` · Ref. ${entry.reference}`:""}</div>{entry.note && <div className="small">{entry.note}</div>}{entry.order_id && <Link className="btn btn-ghost" href={`/orders/${entry.order_id}`}>Ver orden</Link>}</div>)}{!entries.length && <div className="muted">Todavía no hay movimientos para este cliente.</div>}</section>
    </>}
  </main>;
}

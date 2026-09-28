"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";

type Account = { customer_id: string; pocket: "USD" | "VES_BCV"; balance_usd: number };
type Customer = { id: string; name: string | null; phone: string | null; document_id: string | null };

export default function CustomerBalancesPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Record<string, Customer>>({});
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Customer[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase.from("customer_balance_accounts")
        .select("customer_id,pocket,balance_usd").gt("balance_usd", 0).order("updated_at", { ascending: false }).limit(500);
      if (error) { setError(error.message); setLoading(false); return; }
      const rows = (data ?? []) as Account[];
      setAccounts(rows);
      const ids = [...new Set(rows.map(row => row.customer_id))];
      if (ids.length) {
        const result = await supabase.from("customers").select("id,name,phone,document_id").in("id", ids);
        if (result.error) setError(result.error.message);
        else setCustomers(Object.fromEntries(((result.data ?? []) as Customer[]).map(row => [row.id, row])));
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    const text = query.trim().replace(/[,().%_*\\]/g, " ").trim();
    if (text.length < 2) { setMatches([]); return; }
    let active = true;
    const timer = window.setTimeout(async () => {
      const result = await supabase.from("customers").select("id,name,phone,document_id")
        .or(`name.ilike.%${text}%,phone.ilike.%${text}%,document_id.ilike.%${text}%`).order("name").limit(12);
      if (!active) return;
      if (result.error) setError(result.error.message);
      else setMatches((result.data ?? []) as Customer[]);
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  const rows = useMemo(() => {
    const map = new Map<string, { customer: Customer | null; usd: number; vesBcv: number }>();
    for (const account of accounts) {
      const row = map.get(account.customer_id) ?? { customer: customers[account.customer_id] ?? null, usd: 0, vesBcv: 0 };
      if (account.pocket === "USD") row.usd = Number(account.balance_usd);
      else row.vesBcv = Number(account.balance_usd);
      map.set(account.customer_id, row);
    }
    return [...map.entries()];
  }, [accounts, customers]);

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">CLIENTES · DINERO RECIBIDO POR ANTICIPADO</div><h1>Saldos a favor</h1><p>Consulta lo que Lubricenter debe a cada cliente. USD y Bs ligados a BCV se mantienen separados.</p></div><img src="/lubricenter-logo.png" alt="Lubricenter" /></section>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="card stack"><div><h2 className="section-title">Buscar cliente</h2><div className="muted small">Encuéntralo para registrar un anticipo o revisar su historial, incluso si todavía no tiene saldo.</div></div><input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre, teléfono o cédula · mínimo 2 caracteres" />{matches.map(customer => <Link className="directory-option" href={`/customers/${customer.id}/balance`} key={customer.id}><strong>{customer.name || customer.phone || "Cliente"}</strong><span>{[customer.phone,customer.document_id].filter(Boolean).join(" · ")}</span></Link>)}{query.trim().length >= 2 && !matches.length && <div className="muted small">Sin coincidencias. Puedes crear el cliente desde CRM.</div>}</section>
    <section className="card stack"><div className="row-between"><div><h2 className="section-title">Clientes con saldo disponible</h2><div className="muted small">La columna Bs muestra su equivalente en USD de referencia; se convierte a BCV cuando se use.</div></div><span className="pill">{rows.length}</span></div>{loading && <div className="muted">Cargando saldos…</div>}{rows.map(([id,row]) => <Link href={`/customers/${id}/balance`} className="order-item row-between" key={id}><div><strong>{row.customer?.name || row.customer?.phone || "Cliente"}</strong><div className="muted small">{row.customer?.phone || "Sin teléfono"}</div></div><div style={{ textAlign: "right" }}><strong>Divisas {fmtRef(row.usd)}</strong><div className="muted small">Bs · valor BCV {fmtRef(row.vesBcv)}</div></div></Link>)}{!loading && !rows.length && <div className="muted">Todavía no hay anticipos con saldo disponible.</div>}</section>
    <Link className="btn btn-ghost" href="/customers">Ir a CRM central</Link>
  </main>;
}

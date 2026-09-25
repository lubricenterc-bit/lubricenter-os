'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
type Account = { id: string; name: string; currency: string; activated: boolean; opening_native: number; system_in_native: number; system_out_native: number; expected_native: number; actual_native: number | null; difference_native: number | null; explanation: string | null };
type Data = { role: string; legacy: boolean; status: string; accounts: Account[]; closing: { notes: string | null; review_reason: string | null } | null };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
const money = (v: number | null, c: string) => v === null ? 'Sin contar' : `${c === 'USD' ? '$' : 'Bs '}${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export default function FinanceCashClose() {
  const [day, setDay] = useState(today()), [data, setData] = useState<Data | null>(null), [counts, setCounts] = useState<Record<string, string>>({}), [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reason, setReason] = useState('');
  async function load() { const r = await supabase.rpc('cash_close_dashboard', { p_business_date: day }); if (r.error) throw r.error; const d = r.data as Data; setData(d); setCounts(Object.fromEntries(d.accounts.map(a => [a.id, a.actual_native === null ? '' : String(a.actual_native)]))); setNotes(Object.fromEntries(d.accounts.map(a => [a.id, a.explanation ?? '']))); }
  useEffect(() => { load().catch(e => setError(e.message)); }, [day]);
  async function act(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function rpc(name: string, args: Record<string, unknown>) { const r = await supabase.rpc(name, args); if (r.error) throw r.error; }
  const locked = data?.status === 'CLOSED' || data?.legacy;
  return <main className="container stack"><section className="brand-hero"><div><div className="eyebrow">DOS CONTEOS AL FINAL DEL DÍA</div><h1>Cuadre de efectivo</h1><p>Cuenta los dólares y bolívares físicos. Bancos y Cashea se revisan por separado.</p></div><Link className="btn" href="/finance/inbox">Revisión financiera</Link></section>
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="success" role="status">{notice}</div>}
    <section className="card row-between"><label>Día<input className="input" type="date" max={today()} value={day} disabled={busy} onChange={e => setDay(e.target.value)} /></label><strong>{({ OPEN: 'Abierto', CLOSED: 'Cerrado', REVIEW: 'Cambió después del cierre', REOPENED: 'Reabierto' } as Record<string, string>)[data?.status ?? 'OPEN']}</strong></section>
    {data?.legacy && <div className="card">Cierre histórico conservado con sus cuentas originales. El nuevo proceso comienza con la apertura física.</div>}
    {data?.status === 'REVIEW' && <div className="finance-warning card">{data.closing?.review_reason}. El administrador debe verificar los conteos. Puedes seguir atendiendo.</div>}
    <section className="grid grid-2">{data?.accounts.map(a => <article className="card stack" key={a.id}><h2>{a.name}</h2>
      {!a.activated ? <><p>Esta caja necesita un conteo inicial real.</p>{data.role === 'OWNER' ? <><label>Efectivo que hay ahora<input className="input" type="number" min="0" step="0.01" value={counts[a.id] ?? ''} onChange={e => setCounts({ ...counts, [a.id]: e.target.value })} /></label><button className="btn btn-primary" disabled={busy || !counts[a.id] || !Number.isFinite(Number(counts[a.id])) || Number(counts[a.id]) < 0} onClick={() => act(async () => { await rpc('finance_cash_activate', { p_account_id: a.id, p_amount: counts[a.id], p_reason: 'Conteo físico de apertura confirmado por el dueño' }); setNotice('Apertura registrada desde este momento.'); })}>Confirmar apertura desde ahora</button></> : <p>El dueño debe confirmar la apertura una sola vez.</p>}</> : <>
        <div className="cash-close-flow">{[['Apertura',a.opening_native],['Entradas',a.system_in_native],['Salidas',a.system_out_native],['Esperado',a.expected_native]].map(([label,value])=><div key={label}><div>{label}</div><strong>{money(Number(value),a.currency)}</strong></div>)}</div>
        <label>Efectivo contado · {a.currency}<input className="input" inputMode="decimal" type="number" min="0" step="0.01" disabled={locked || busy} value={counts[a.id] ?? ''} onChange={e => setCounts({ ...counts, [a.id]: e.target.value })} placeholder="Escribe el conteo; cero es válido" /></label>
        <div>Diferencia: <strong>{counts[a.id] === '' ? 'Pendiente de contar' : money(Number(counts[a.id]) - Number(a.expected_native), a.currency)}</strong></div>
        <label>Nota si sabes qué ocurrió · opcional<input className="input" disabled={locked || busy} value={notes[a.id] ?? ''} onChange={e => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="Puedes dejar una diferencia pendiente de revisión" /></label>
        {!locked && <button className="btn btn-primary" disabled={busy || counts[a.id] === '' || !Number.isFinite(Number(counts[a.id])) || Number(counts[a.id]) < 0} onClick={() => act(async () => { await rpc('save_cash_count', { p_business_date: day, p_account_id: a.id, p_actual_native: counts[a.id], p_explanation: notes[a.id] || null, p_denominations: {} }); setNotice('Conteo guardado.'); })}>Guardar conteo</button>}
      </>}
    </article>)}</section>
    {data && !locked && <section className="card stack"><button className="btn btn-primary" disabled={busy || data.accounts.length !== 2 || data.accounts.some(a => !a.activated || a.actual_native === null || String(a.actual_native) !== counts[a.id])} onClick={() => act(async () => { await rpc('close_cash_day', { p_business_date: day, p_notes: null }); setNotice('Día cerrado. Diferencias en revisión, sin ajustes automáticos.'); })}>Cerrar con los conteos guardados</button><p>Solo se exige contar el efectivo. Los pendientes administrativos no bloquean ventas.</p></section>}
    {data?.status === 'CLOSED' && <section className="card stack"><Link className="btn" href={`/cash-close/${day}/receipt`}>Imprimir resumen 58 mm</Link>{data.role === 'OWNER' && !data.legacy && <><label>Motivo para reabrir<input className="input" value={reason} onChange={e => setReason(e.target.value)} /></label><button className="btn" disabled={busy || reason.trim().length < 5} onClick={() => act(() => rpc('reopen_cash_day', { p_business_date: day, p_reason: reason }))}>Reabrir con historial</button></>}</section>}
    <Link href="/finance" className="btn btn-ghost">← Finanzas</Link>
  </main>;
}

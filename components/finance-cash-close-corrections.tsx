'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Account = {
  id: string;
  name: string;
  currency: string;
  activated: boolean;
  actual_native: number | null;
};
type Revision = {
  id: string;
  revision_type: 'COUNT_CORRECTION' | 'REOPEN_REQUEST';
  account_id: string | null;
  actor_id: string;
  actor_label?: string;
  reason: string;
  before_actual: string | null;
  after_actual: string | null;
  created_at: string;
};
type Props = {
  day: string;
  status: string;
  legacy: boolean;
  accounts: Account[];
  onChanged: () => Promise<void>;
};

const formatMoney = (value: string | number | null, currency: string) =>
  value === null ? '—' :
  `${currency === 'USD' ? '$' : 'Bs '}${Number(value).toLocaleString('es-VE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })}`;

export function CashCloseCorrections({ day, status, legacy, accounts, onChanged }: Props) {
  const [selected, setSelected] = useState('');
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');
  const [explanation, setExplanation] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [history, setHistory] = useState<Revision[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  const eligible = useMemo(
    () => accounts.filter(a => a.activated && a.actual_native !== null),
    [accounts]
  );
  const account = eligible.find(a => a.id === selected);

  useEffect(() => {
    if (!eligible.some(a => a.id === selected)) setSelected(eligible[0]?.id ?? '');
  }, [eligible, selected]);

  useEffect(() => {
    setActual(account?.actual_native === null || account === undefined ? '' : String(account.actual_native));
  }, [account?.id, account?.actual_native]);

  async function loadHistory() {
    const { data, error } = await supabase.rpc('finance_cash_revision_history', {
      p_business_date: day
    });
    if (!error) setHistory((data ?? []) as Revision[]);
  }
  useEffect(() => { void loadHistory(); }, [day, status]);

  const presented = !legacy && (status === 'CLOSED' || status === 'REVIEW');
  if (!presented && !history.length) return null;

  async function changeCount() {
    if (!account || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const amount = Number(actual);
      if (actual.trim() === '' || !Number.isFinite(amount) || amount < 0)
        throw new Error('Escribe el monto realmente contado.');
      if (reason.trim().length < 8) throw new Error('Explica el motivo (mínimo 8 caracteres).');
      const { error } = await supabase.rpc('finance_cash_correct_closed', {
        p_business_date: day, p_account_id: account.id, p_actual_native: amount,
        p_reason: reason.trim(), p_explanation: explanation.trim() || null
      });
      if (error) throw error;
      setNotice('Corrección guardada con historial. El propietario recibió una alerta en Lubricenter OS.');
      setShowEditor(false); setReason(''); setExplanation('');
      await onChanged();
      await loadHistory();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function requestReopen() {
    if (busy || requestReason.trim().length < 8) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error } = await supabase.rpc('finance_cash_request_reopen', {
        p_business_date: day, p_reason: requestReason.trim()
      });
      if (error) throw error;
      setNotice('Solicitud enviada al propietario. No se alteró el cierre.');
      setRequestReason('');
      await loadHistory();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return <section className="card stack">
    <div>
      <h2 className="section-title">Correcciones con historial</h2>
      <p className="muted small">Puedes corregir el efectivo contado después de cerrar. Quedan guardados el valor anterior, el nuevo, el motivo, el usuario y la fecha. El propietario recibirá una alerta. No se crean gastos ni movimientos nuevos.</p>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    {presented && <div className="row">
      <button className="btn btn-primary" onClick={() => setShowEditor(v => !v)} disabled={busy || !eligible.length}>
        {showEditor ? 'Cancelar corrección' : 'Corregir conteo'}
      </button>
    </div>}
    {presented && showEditor && <div className="card stack">
      <label>Cuenta
        <select className="input" value={selected} onChange={e => setSelected(e.target.value)}>
          {eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <div className="muted small">Conteo anterior: {formatMoney(account?.actual_native ?? null, account?.currency ?? 'USD')}</div>
      <label>Conteo corregido · {account?.currency}
        <input className="input" type="number" min="0" step="0.01"
          value={actual} onChange={e => setActual(e.target.value)} />
      </label>
      <label>Motivo obligatorio
        <textarea className="textarea" rows={2} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Ej. Se contó nuevamente el efectivo después de detectar un error" />
      </label>
      <label>Explicación del conteo (opcional)
        <input className="input" value={explanation} onChange={e => setExplanation(e.target.value)}
          placeholder="Observaciones adicionales" />
      </label>
      <div className="muted small">Si faltó registrar un gasto, regístralo una sola vez en Egresos. Esta opción solo corrige el conteo físico.</div>
      <button className="btn btn-primary" disabled={busy || !account || actual.trim()==='' || !Number.isFinite(Number(actual)) || Number(actual)<0 || reason.trim().length<8}
        onClick={changeCount}>{busy ? 'Guardando…' : 'Guardar corrección y avisar'}</button>
    </div>}
    {presented && <div className="stack">
      <h3 className="section-title">Solicitar reapertura</h3>
      <p className="muted small">Si la semana ya fue conciliada, solo el propietario puede autorizar su reapertura. La solicitud no cambia saldos.</p>
      <label>Motivo de la solicitud
        <input className="input" value={requestReason} onChange={e => setRequestReason(e.target.value)}
          placeholder="Describe qué necesitas corregir" />
      </label>
      <button className="btn" disabled={busy || requestReason.trim().length<8} onClick={requestReopen}>Notificar al propietario</button>
    </div>}
    <h3 className="section-title">Historial de cambios</h3>
    {!history.length && <div className="muted small">Todavía no hay correcciones posteriores al cierre.</div>}
    {history.map(rev => {
      const a = accounts.find(x => x.id === rev.account_id);
      return <div className="order-item" key={rev.id}>
        <div className="row-between">
          <strong>{rev.revision_type === 'COUNT_CORRECTION' ? 'Conteo corregido' : 'Reapertura solicitada'}{a ? ` · ${a.name}` : ''}</strong>
          <span className="muted small">{new Date(rev.created_at).toLocaleString('es-VE')}</span>
        </div>
        {rev.revision_type === 'COUNT_CORRECTION' && <div>
          {formatMoney(rev.before_actual, a?.currency ?? 'USD')} → <strong>{formatMoney(rev.after_actual, a?.currency ?? 'USD')}</strong>
        </div>}
        <div className="muted small">Por {rev.actor_label || rev.actor_id.slice(0,8)} · Motivo: {rev.reason}</div>
      </div>;
    })}
  </section>;
}

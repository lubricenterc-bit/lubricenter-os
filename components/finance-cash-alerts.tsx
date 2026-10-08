'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Alert = {
  id: string;
  business_date: string;
  message: string;
  event_type: string;
  created_at: string;
  read_at: string | null;
};

export function FinanceCashAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState('');

  async function load() {
    const { data, error } = await supabase
      .from('finance_cash_close_alerts')
      .select('id,business_date,message,event_type,created_at,read_at')
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) setError(error.message);
    else { setAlerts((data ?? []) as Alert[]); setError(''); }
  }

  useEffect(() => {
    void load();
    // Owner inbox refreshes while Finance is open. Alerts remain stored in the DB.
    const id = window.setInterval(() => { void load(); }, 30000);
    return () => window.clearInterval(id);
  }, []);

  async function markRead(id: string) {
    const { error } = await supabase
      .from('finance_cash_close_alerts')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
    if (error) setError(error.message);
    else setAlerts(prev => prev.filter(a => a.id !== id));
  }

  if (!alerts.length && !error) return null;
  return <section className="card stack">
    <div className="row-between">
      <div><h2 className="section-title">Avisos de cierres</h2>
        <p className="muted small">Cambios hechos después de cerrar o solicitudes de reapertura de tu sucursal.</p></div>
      <span className="pill">{alerts.length} sin leer</span>
    </div>
    {error && <div className="error" role="alert">No se pudieron cargar avisos: {error}</div>}
    {alerts.map(a => <div className="order-item" key={a.id}>
      <div className="row-between"><strong>{a.event_type === 'REOPEN_REQUEST' ? 'Reapertura solicitada' : 'Cierre modificado'}</strong>
        <span className="muted small">{new Date(a.created_at).toLocaleString('es-VE')}</span></div>
      <div className="small">{a.message}</div>
      <div className="row">
        <Link className="btn btn-ghost" href={`/cash-close?day=${a.business_date}`}>Ver cierre</Link>
        <button className="btn" onClick={() => void markRead(a.id)}>Marcar leído</button>
      </div>
    </div>)}
  </section>;
}

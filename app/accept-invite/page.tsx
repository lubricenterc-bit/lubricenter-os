"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function AcceptInvite() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function check() {
      // The Supabase client processes invitation fragments/session automatically.
      const { data, error } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!error && data.session) { setReady(true); return; }
      setError("Enlace vencido o inválido. Solicita una nueva invitación al administrador.");
    }
    void check();
    const { data: changes } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted && session) { setReady(true); setError(""); }
    });
    return () => { mounted = false; changes.subscription.unsubscribe(); };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password.length < 10) return setError("Utiliza al menos 10 caracteres.");
    if (password !== confirm) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setError(error.message); setBusy(false); return; }
    await supabase.auth.signOut();
    router.replace("/login?invited=1");
  }

  return <main className="mesa-theme mesa-login">
    <section className="mesa-login-art" aria-label="Lubricenter OS">
      <div className="mesa-login-wordmark">LC <span>LUBRICENTER OS</span></div>
      <div><span className="mesa-login-kicker">BIENVENIDO AL EQUIPO</span>
        <h1>Tu cuenta.<br/>Tu trabajo<span>.</span></h1>
        <p>Un acceso individual para una operación transparente y organizada.</p></div>
      <span className="mesa-login-foot">SEGURIDAD / RESPONSABILIDAD / EQUIPO</span>
    </section>
    <section className="mesa-login-form">
      <div className="card stack">
        <h2>Activa tu acceso</h2>
        <p className="muted">Configura una contraseña personal. No la compartas con nadie.</p>
        {error && <div className="error" role="alert">{error}</div>}
        {ready && <form onSubmit={save} className="stack">
          <label><span className="label">Nueva contraseña</span><input className="input" type="password" autoComplete="new-password" required minLength={10}
            value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <label><span className="label">Confirmar contraseña</span><input className="input" type="password" autoComplete="new-password" required minLength={10}
            value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy?"Activando…":"Guardar y entrar"}</button>
        </form>}
      </div>
    </section>
  </main>;
}

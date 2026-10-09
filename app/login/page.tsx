"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { loginReturnPath } from "@/lib/login-return";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace(loginReturnPath(new URLSearchParams(window.location.search).get('next')));
  }

  return (
    <main className="mesa-theme mesa-login">
      <section className="mesa-login-art" aria-label="Lubricenter OS">
        <div className="mesa-login-wordmark">LC <span>LUBRICENTER OS</span></div>
        <div><span className="mesa-login-kicker">TU TALLER, EN MARCHA.</span><h1>Todo listo.<br/>A trabajar<span>.</span></h1><p>El mostrador, el taller y tu equipo.<br/>En una misma mesa.</p></div>
        <span className="mesa-login-foot">OPERACIÓN / SERVICIO / PERSONAS</span>
      </section>
      <section className="mesa-login-form">
      <div className="card stack">
        <div>
          <div className="os-login-brand"><img src="/api/brand/isotipo.png" alt="Isotipo Lubricenter" /><span>Lubricenter <b>OS</b></span></div>
          <h2>Bienvenido de vuelta.</h2>
          <p className="muted">Accede a tu mesa de trabajo.</p>
        </div>
        <form className="stack" onSubmit={submit}>
          <label><span className="label">Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label><span className="label">Contraseña</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          {error && <div className="error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
      </div>
      </section>
    </main>
  );
}


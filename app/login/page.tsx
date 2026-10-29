"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { loginReturnPath } from "@/lib/login-return";
import { BrandIcon, Gotin, useLive } from "@/components/gotin";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const artLive = useLive<HTMLElement>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace(loginReturnPath(new URLSearchParams(window.location.search).get('next')));
  }

  return (
    <main className="os-theme os-login">
      <section className="os-login-art" ref={artLive} aria-label="Lubricenter OS">
        <span className="os-wordmark os-login-wordmark" role="img" aria-label="Lubricenter" />
        <div className="os-login-copy">
          <h1>Todo listo.<br />A trabajar.</h1>
          <p>El mostrador, el taller y tu equipo en una misma mesa.</p>
        </div>
        <div className="os-login-stage" aria-hidden="true">
          <Gotin pose={error ? "shrug" : "wave"} jump={busy} />
          <span className="os-login-props"><BrandIcon name="bottle" /><BrandIcon name="filter" /><BrandIcon name="wrench" /></span>
        </div>
        <span className="os-login-foot">Cuidamos lo que te mueve</span>
      </section>
      <section className="os-login-form">
        <div className="os-login-card">
          <div className="os-login-brand"><img src="/api/brand/isotipo.png" alt="" /><span>Lubricenter <b>OS</b></span></div>
          <h2>Bienvenido de vuelta.</h2>
          <p>Accede a tu mesa de trabajo.</p>
          <form onSubmit={submit}>
            <label><span className="label">Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
            <label><span className="label">Contraseña</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
          </form>
        </div>
      </section>
    </main>
  );
}

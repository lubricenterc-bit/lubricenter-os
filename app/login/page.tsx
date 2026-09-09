"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

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
    router.replace("/");
  }

  return (
    <main className="container" style={{ maxWidth: 480, paddingTop: 70 }}>
      <div className="card stack">
        <div>
          <div className="brand" style={{ fontSize: 34 }}>Lubricenter<span>.</span> OS</div>
          <p className="muted">Primer build · entorno de desarrollo</p>
        </div>
        <form className="stack" onSubmit={submit}>
          <label><span className="label">Email</span><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label><span className="label">Contraseña</span><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          {error && <div className="error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
      </div>
    </main>
  );
}

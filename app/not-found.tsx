import Link from "next/link";

export const metadata = { title: "Página no encontrada · Lubricenter OS" };

export default function NotFound() {
  return (
    <main className="container stack">
      <section className="card stack">
        <div className="eyebrow">ERROR 404</div>
        <h1>Esta pantalla no existe</h1>
        <p className="muted">El enlace puede estar incompleto o la pantalla cambió de lugar. Tus datos no se modificaron.</p>
        <div className="row">
          <Link className="btn btn-primary" href="/">Ir al inicio</Link>
          <Link className="btn btn-ghost" href="/orders">Ver órdenes</Link>
        </div>
      </section>
    </main>
  );
}

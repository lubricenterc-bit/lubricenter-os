import Link from "next/link";

const groups = [
  {
    title: "Operación",
    description: "Trabaja con órdenes y consulta lo que ya pasó.",
    links: [
      ["/orders", "▤", "Órdenes", "Abiertas, cerradas y Crédito LC"],
      ["/customers", "◉", "Clientes y vehículos", "Directorio e historial"],
    ],
  },
  {
    title: "Administración",
    description: "Inventario, dinero, nómina y configuración.",
    links: [
      ["/inventory", "▦", "Inventario", "Existencias, catálogo y conteos"],
      ["/cash", "▣", "Caja", "Pagos y movimientos del día"],
      ["/receivables", "$", "Cobros", "Crédito LC y abonos"],
      ["/payroll", "%", "Nómina", "Cheo, Alexis y ajustes"],
      ["/settings", "⚙", "Configuración", "Notion, CRM y reglas"],
    ],
  },
] as const;

export default function MorePage() {
  return <main className="container stack">
    <section className="brand-hero">
      <div><div className="eyebrow">LUBRICENTER OS</div><h1>Más herramientas</h1><p>Las funciones administrativas quedan fuera del flujo principal para no mezclar atención, taller, CRM y contabilidad.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter" />
    </section>

    {groups.map(group => <section className="card stack" key={group.title}>
      <div><div className="eyebrow">{group.title.toUpperCase()}</div><h2 className="section-title" style={{ marginBottom: 4 }}>{group.title}</h2><div className="muted small">{group.description}</div></div>
      <div className="grid grid-2">
        {group.links.map(([href, icon, label, description]) => <Link key={href} href={href} className="card" style={{ color: "inherit", textDecoration: "none" }}>
          <div className="row"><span className="emoji">{icon}</span><strong>{label}</strong></div>
          <div className="muted small" style={{ marginTop: 6 }}>{description}</div>
        </Link>)}
      </div>
    </section>)}
  </main>;
}

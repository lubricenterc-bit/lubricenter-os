/** Esqueletos de carga: la forma de la pantalla aparece al instante y los datos la rellenan. */

type SkelProps = { w?: number | string; h?: number | string; r?: number | string; className?: string };

/** Un bloque gris con brillo que recorre su superficie. */
export function Skel({ w = "100%", h = 14, r = 8, className = "" }: SkelProps) {
  return <span className={"os-skel " + className} style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

/** Filas de una lista: ícono, dos líneas de texto y una cifra a la derecha. */
export function SkelRows({ rows = 6, icon = true, trailing = true }: { rows?: number; icon?: boolean; trailing?: boolean }) {
  return <div className="os-skel-rows" aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <div className="os-skel-row" key={index} style={{ animationDelay: index * 45 + "ms" }}>
      {icon && <Skel w={44} h={44} r={14} />}
      <span className="os-skel-lines"><Skel w={`${62 - (index % 3) * 12}%`} h={14} /><Skel w={`${38 + (index % 2) * 14}%`} h={11} /></span>
      {trailing && <Skel w={64} h={18} />}
    </div>)}
  </div>;
}

/** Tarjetas en rejilla, como las del taller o el catálogo. */
export function SkelCards({ count = 4 }: { count?: number }) {
  return <div className="os-skel-cards" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div className="os-skel-card" key={index} style={{ animationDelay: index * 60 + "ms" }}>
      <Skel w={86} h={22} r={5} /><Skel w="78%" h={16} /><Skel w="52%" h={12} /><Skel h={38} r={999} />
    </div>)}
  </div>;
}

/** Ficha de detalle: título grande, cifras y bloques de contenido. */
export function SkelDetail() {
  return <div className="os-skel-detail" aria-hidden="true">
    <Skel w="46%" h={38} r={12} />
    <Skel w="70%" h={14} />
    <div className="os-skel-figures"><Skel h={74} r={20} /><Skel h={74} r={20} /><Skel h={74} r={20} /></div>
    <SkelRows rows={4} />
  </div>;
}

export type LoadingKind = "list" | "cards" | "detail" | "table";

/**
 * Bloque de carga accesible: los lectores de pantalla oyen el texto y la vista muestra la forma
 * de lo que viene. Sustituye a «Cargando…» en una tarjeta gris.
 */
export function LoadingBlock({ label, kind = "list", rows }: { label: string; kind?: LoadingKind; rows?: number }) {
  return <div className={"os-loading is-" + kind} role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    {kind === "list" && <SkelRows rows={rows ?? 6} />}
    {kind === "table" && <SkelRows rows={rows ?? 8} icon={false} />}
    {kind === "cards" && <SkelCards count={rows ?? 4} />}
    {kind === "detail" && <SkelDetail />}
  </div>;
}

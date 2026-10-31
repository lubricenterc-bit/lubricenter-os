"use client";

/** One segment per decision: done in orange, the current one outlined. */
export function ProgressSegments({ ids, done, current }: { ids: string[]; done: Set<string>; current: string | null }) {
  if (!ids.length) return <div className="tn-progress" aria-hidden="true" />;
  return <div className="tn-progress" role="progressbar" aria-valuemin={0} aria-valuemax={ids.length} aria-valuenow={done.size}
    aria-label={`${done.size} de ${ids.length} decisiones listas`}>
    {ids.map(id => <span key={id} className={"tn-seg" + (done.has(id) ? " is-done" : "") + (id === current ? " is-current" : "")} />)}
  </div>;
}

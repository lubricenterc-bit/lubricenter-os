"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useAppSession } from "@/components/app-session-context";
import { Gotin, useLive } from "@/components/gotin";
import { OsIcon } from "@/components/os-icon";
import { HELP_AREAS, HELP_TOPICS, searchHelp, type HelpArea } from "@/lib/help-topics";
import { useUrlState } from "@/lib/use-url-state";
import "./ayuda.css";

export default function HelpPage() {
  return <Suspense fallback={null}><HelpScreen /></Suspense>;
}

function HelpScreen() {
  const { role } = useAppSession();
  const owner = role === "OWNER" || role === "ADMIN";
  const [state, setState] = useUrlState({ q: "", area: "" });
  const [open, setOpen] = useState<string | null>(null);
  const live = useLive<HTMLElement>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Desde el buscador Ctrl K se llega con #tema: se abre y se lleva a la vista.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !HELP_TOPICS.some(topic => topic.id === id)) return;
    setOpen(id);
    requestAnimationFrame(() => document.getElementById("tema-" + id)?.scrollIntoView({ block: "center" }));
  }, []);

  const found = useMemo(() => searchHelp(state.q, owner, 80)
    .filter(topic => !state.area || topic.area === state.area), [state.q, state.area, owner]);
  const areas = HELP_AREAS.filter(area => HELP_TOPICS.some(topic => topic.area === area.id && (owner || !topic.ownerOnly)));
  const grouped = areas.map(area => ({ ...area, topics: found.filter(topic => topic.area === area.id) })).filter(group => group.topics.length);

  return <main className="container os-help" ref={live}>
    <header className="os-help-head">
      <div>
        <h1>¿Cómo hago…?</h1>
        <p>Escribe lo que necesitas y te digo dónde está y cómo se hace. También puedes buscar desde cualquier pantalla con Ctrl K.</p>
      </div>
      <span className="os-help-gotin" aria-hidden="true"><Gotin pose={found.length ? "point" : "shrug"} /></span>
    </header>

    <label className="os-search os-help-search">
      <span className="sr-only">Buscar en la ayuda</span>
      <OsIcon name="search" size={22} className="os-search-icon" />
      <input ref={inputRef} value={state.q} onChange={event => { setState({ q: event.target.value }); setOpen(null); }}
        placeholder="Ej: vuelto, cierre de caja, Cashea, ingresar mercancía…" autoComplete="off" enterKeyHint="search" />
    </label>

    <nav className="os-help-areas" aria-label="Áreas">
      <button type="button" className={!state.area ? "is-on" : undefined} onClick={() => setState({ area: "" })}>Todo</button>
      {areas.map(area => <button key={area.id} type="button" className={state.area === area.id ? "is-on" : undefined}
        aria-pressed={state.area === area.id} onClick={() => setState({ area: state.area === area.id ? "" : area.id as HelpArea })}>{area.label}</button>)}
    </nav>

    {!found.length && <div className="os-help-empty">
      <Gotin pose="shrug" />
      <strong>No encontré «{state.q}»</strong>
      <span>Prueba con otra palabra, como «cobrar», «orden» o «inventario», o pregúntale al encargado.</span>
    </div>}

    {grouped.map(group => <section key={group.id} className="os-help-group" aria-labelledby={"area-" + group.id}>
      <h2 id={"area-" + group.id}>{group.label}</h2>
      <ul>
        {group.topics.map(topic => {
          const isOpen = open === topic.id || (!!state.q && found.length <= 2);
          return <li key={topic.id} id={"tema-" + topic.id} className={isOpen ? "is-open" : undefined}>
            <button type="button" className="os-help-q" aria-expanded={isOpen} aria-controls={"pasos-" + topic.id}
              onClick={() => setOpen(isOpen ? null : topic.id)}>
              <span>{topic.question}</span>
              {topic.shortcut && <kbd>{topic.shortcut}</kbd>}
              <OsIcon name="down" size={18} className="os-help-chevron" />
            </button>
            {isOpen && <div className="os-help-a" id={"pasos-" + topic.id}>
              <ol>{topic.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              <Link className="btn btn-primary" href={topic.href}>{topic.cta} <OsIcon name="arrow" size={16} /></Link>
            </div>}
          </li>;
        })}
      </ul>
    </section>)}
  </main>;
}

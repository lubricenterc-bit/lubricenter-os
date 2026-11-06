import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { HELP_AREAS, HELP_TOPICS, searchHelp } from "../lib/help-topics";
import { NAV_MODULES, navigationSearch } from "../lib/navigation";

/** Una ruta de la app existe si hay un page.tsx en su carpeta (o es redirección conocida). */
function routeExists(href: string) {
  const path = href.split(/[?#]/)[0].replace(/\/$/, "");
  return existsSync(`app${path}/page.tsx`) || (path === "" && existsSync("app/page.tsx"));
}

describe("Ayuda para el equipo", () => {
  it("cada tema lleva a una pantalla que existe", () => {
    for (const topic of HELP_TOPICS) expect(routeExists(topic.href), `${topic.id} → ${topic.href}`).toBe(true);
  });
  it("los temas son únicos, tienen pasos y pertenecen a un área", () => {
    const ids = HELP_TOPICS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const areas = new Set(HELP_AREAS.map(a => a.id));
    for (const topic of HELP_TOPICS) {
      expect(areas.has(topic.area), topic.id).toBe(true);
      expect(topic.steps.length, topic.id).toBeGreaterThan(0);
      expect(topic.question.startsWith("¿") || topic.question.length > 10, topic.id).toBe(true);
    }
  });
  it("encuentra la respuesta con las palabras que usa el mostrador", () => {
    expect(searchHelp("vuelto", false)[0].id).toBe("vuelto");
    expect(searchHelp("cierre caja", false)[0].id).toBe("cierre");
    expect(searchHelp("cashea", false).some(t => t.id === "cashea")).toBe(true);
    expect(searchHelp("mercancía", false)[0].id).toBe("ingresar-mercancia");
    expect(searchHelp("ganancia", false).some(t => t.ownerOnly)).toBe(false);
    expect(searchHelp("ganancia", true)[0].id).toBe("ganancias");
  });
  it("los atajos de la ayuda coinciden con los del teclado", () => {
    const shortcuts: Record<string, string> = { F2: "/quick-sale", F3: "/orders/new", F4: "/quote", F6: "/workshop" };
    for (const topic of HELP_TOPICS.filter(t => t.shortcut)) {
      expect(shortcuts[topic.shortcut!], topic.id).toBeDefined();
    }
  });
  it("la Ayuda está en el menú y en el buscador", () => {
    expect(NAV_MODULES.flatMap(m => m.links).some(l => l.href === "/ayuda")).toBe(true);
    expect(navigationSearch("ayuda", "OPERATOR")[0].href).toBe("/ayuda");
  });
});

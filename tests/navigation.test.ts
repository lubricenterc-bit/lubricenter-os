import { describe, expect, it } from "vitest";
import { NAV_MODULES, linksForModule, moduleForPath, navigationSearch, pageLabelForPath } from "../lib/navigation";

describe("Navegación de escritorio Lubricenter OS", () => {
  it("conserva siete áreas principales claramente identificadas", () => {
    expect(NAV_MODULES.map(m => m.id)).toEqual([
      "home", "sales", "workshop", "customers", "inventory", "finance", "admin"
    ]);
  });
  it("preserva destinos de operación y finanzas", () => {
    const routes: Record<string, string> = {
      "/": "home",
      "/quick-sale": "sales",
      "/orders": "sales",
      "/orders/new": "sales",
      "/orders/123/correct": "sales",
      "/workshop": "workshop",
      "/customers": "customers",
      "/vehicles/123": "customers",
      "/reminders": "customers",
      "/campaigns": "customers",
      "/inventory": "inventory",
      "/expenses": "inventory",
      "/suppliers/123": "inventory",
      "/purchases/123": "inventory",
      "/cash": "finance",
      "/cash-close": "finance",
      "/cash-close/2026-10-07/receipt": "finance",
      "/finance/reconcile": "finance",
      "/finance/inbox": "finance",
      "/cashea/balance": "finance",
      "/receivables": "finance",
      "/payroll": "finance",
      "/settings": "admin",
      "/more": "admin"
    };
    for (const [path, id] of Object.entries(routes)) {
      expect(moduleForPath(path).id, path).toBe(id);
    }
  });
  it("distingue la página específica de un módulo anidado", () => {
    expect(pageLabelForPath("/finance/reconcile")).toBe("Conciliación semanal");
    expect(pageLabelForPath("/orders/new")).toBe("Nueva orden");
    expect(pageLabelForPath("/cash-close/2026-10-07/receipt")).toBe("Cierre diario");
  });
  it("deja las acciones operativas disponibles al encargado", () => {
    const financial = NAV_MODULES.find(m => m.id === "finance");
    expect(financial).toBeDefined();
    const links = linksForModule(financial!, "OPERATOR").map(item => item.href);
    expect(links).toContain("/cash-close");
    expect(links).toContain("/receivables");
    expect(links).not.toContain("/finance/reconcile");
    expect(links).not.toContain("/payroll");
  });
  it("encuentra herramientas por nombre y palabra clave", () => {
    expect(navigationSearch("arqueo", "OPERATOR")[0].href).toBe("/cash-close");
    expect(navigationSearch("proveedores", "OPERATOR")[0].href).toBe("/expenses");
    expect(navigationSearch("BDV", "OWNER").some(x => x.href === "/finance/reconcile")).toBe(true);
    expect(navigationSearch("BDV", "OPERATOR")).toEqual([]);
  });
  it("no crea rutas duplicadas entre los módulos", () => {
    const hrefs = NAV_MODULES.flatMap(m => m.links.map(l => l.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

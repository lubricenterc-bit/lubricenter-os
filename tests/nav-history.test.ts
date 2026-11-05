import { describe, expect, it } from "vitest";
import { NAV_HISTORY_MAX, pop, previous, pushEntry, readHistory, takeRestore, updateScroll } from "@/lib/nav-history";
import { readUrlState, writeUrlState } from "@/lib/use-url-state";
import { parentForPath } from "@/lib/navigation";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("historial de navegación", () => {
  it("apila en orden y la misma ruta solo actualiza filtros", () => {
    const s = memory();
    pushEntry({ path: "/orders", search: "", title: "Órdenes" }, s, 1);
    pushEntry({ path: "/orders", search: "?q=ana", title: "Órdenes" }, s, 2);
    pushEntry({ path: "/orders/abc", search: "", title: "Órdenes" }, s, 3);
    const entries = readHistory(s);
    expect(entries.map(e => e.path + e.search)).toEqual(["/orders?q=ana", "/orders/abc"]);
  });

  it("guarda como máximo 30 entradas", () => {
    const s = memory();
    for (let i = 0; i < 45; i++) pushEntry({ path: "/p" + i, search: "", title: "P" }, s, i);
    const entries = readHistory(s);
    expect(entries).toHaveLength(NAV_HISTORY_MAX);
    expect(entries[0].path).toBe("/p15");
    expect(entries.at(-1)?.path).toBe("/p44");
  });

  it("previous ignora la ruta actual", () => {
    const s = memory();
    pushEntry({ path: "/orders", search: "?status=ALL", title: "Órdenes" }, s);
    pushEntry({ path: "/orders/1", search: "", title: "Orden" }, s);
    expect(previous("/orders/1", s)?.search).toBe("?status=ALL");
    expect(previous("/orders", s)?.path).toBe("/orders/1");
    expect(previous("/otra", s)?.path).toBe("/orders/1");
  });

  it("pop vuelve a la anterior y deja su scroll para restaurar", () => {
    const s = memory();
    pushEntry({ path: "/orders", search: "?page=2", title: "Órdenes" }, s);
    updateScroll("/orders", 812.4, s);
    pushEntry({ path: "/orders/1", search: "", title: "Orden" }, s);
    updateScroll("/orders", 5, s); // no es la pantalla actual: no cambia nada
    const target = pop("/orders/1", s);
    expect(target?.path).toBe("/orders");
    expect(target?.scrollY).toBe(812);
    expect(readHistory(s).map(e => e.path)).toEqual(["/orders"]);
    expect(takeRestore("/otra", s)).toBeNull();
    expect(takeRestore("/orders", s)).toBe(812);
    expect(takeRestore("/orders", s)).toBeNull();
  });

  it("sin almacenamiento no falla", () => {
    const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => undefined };
    expect(() => pushEntry({ path: "/", search: "", title: "Inicio" }, broken)).not.toThrow();
    expect(readHistory(broken)).toEqual([]);
    expect(previous("/", broken)).toBeNull();
    expect(pop("/", broken)).toBeNull();
  });
});

describe("estado en la URL", () => {
  const defaults = { q: "", status: "CLOSED", page: "0" };

  it("lee los valores y usa los defaults cuando faltan", () => {
    expect(readUrlState(new URLSearchParams("q=ana&page=3"), defaults)).toEqual({ q: "ana", status: "CLOSED", page: "3" });
    expect(readUrlState(new URLSearchParams(""), defaults)).toEqual(defaults);
  });

  it("omite los valores por defecto y conserva parámetros ajenos", () => {
    expect(writeUrlState("", defaults, { q: "", status: "CLOSED", page: "0" })).toBe("");
    expect(writeUrlState("?preview=9", defaults, { q: "ana maría", status: "ALL", page: "0" })).toBe("?preview=9&q=ana+mar%C3%ADa&status=ALL");
    expect(writeUrlState("?q=ana&status=ALL", defaults, { q: "ana", status: "CLOSED", page: "0" })).toBe("?q=ana");
  });

  it("ida y vuelta conserva el estado", () => {
    const state = { q: "1.500 & más", status: "OPEN", page: "4" };
    const search = writeUrlState("", defaults, state);
    expect(readUrlState(new URLSearchParams(search), defaults)).toEqual(state);
  });
});

describe("pantalla padre para «Volver» sin historial", () => {
  it("las raíces de sección y el inicio no tienen padre", () => {
    expect(parentForPath("/")).toBeNull();
    expect(parentForPath("/orders")).toBeNull();
    expect(parentForPath("/inventory")).toBeNull();
  });
  it("los detalles vuelven a su lista", () => {
    expect(parentForPath("/orders/abc")).toEqual({ href: "/orders", label: "Órdenes" });
    expect(parentForPath("/orders/abc/receipt")).toEqual({ href: "/orders/abc", label: "Orden" });
    expect(parentForPath("/purchases/1")).toEqual({ href: "/expenses", label: "Compras y proveedores" });
    expect(parentForPath("/suppliers/1")?.href).toBe("/expenses");
    expect(parentForPath("/customers/1/balance")?.href).toBe("/customer-balances");
    expect(parentForPath("/customers/1")).toEqual({ href: "/customers", label: "Clientes" });
  });
});

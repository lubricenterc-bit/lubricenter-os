/**
 * Historial de navegación interno de la app (por pestaña, en sessionStorage).
 * Sirve al botón «Volver» del shell: recuerda ruta, filtros (search) y scroll.
 * Todo acceso al almacenamiento va en try/catch: el navegador puede bloquearlo.
 */
export type NavEntry = { path: string; search: string; title: string; scrollY: number; at: number };

export const NAV_HISTORY_KEY = "lubricenter:nav-history";
export const NAV_RESTORE_KEY = "lubricenter:nav-restore";
export const NAV_HISTORY_MAX = 30;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function readHistory(storage: Store | null = store()): NavEntry[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(NAV_HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch { return []; }
}

function writeHistory(entries: NavEntry[], storage: Store | null = store()) {
  if (!storage) return;
  try { storage.setItem(NAV_HISTORY_KEY, JSON.stringify(entries.slice(-NAV_HISTORY_MAX))); } catch { /* sin almacenamiento */ }
}

function isEntry(value: unknown): value is NavEntry {
  const entry = value as NavEntry;
  return !!entry && typeof entry.path === "string" && typeof entry.search === "string";
}

function normalizeSearch(search: string) {
  return !search || search === "?" ? "" : search.startsWith("?") ? search : "?" + search;
}

/**
 * Registra la pantalla actual. Si es la misma ruta que la última entrada
 * (p. ej. solo cambiaron los filtros), actualiza esa entrada en vez de apilar otra.
 */
export function pushEntry(entry: { path: string; search: string; title: string }, storage: Store | null = store(), now = Date.now()) {
  const entries = readHistory(storage);
  const search = normalizeSearch(entry.search);
  const last = entries[entries.length - 1];
  if (last && last.path === entry.path) {
    entries[entries.length - 1] = { ...last, search, title: entry.title, at: now };
  } else {
    entries.push({ path: entry.path, search, title: entry.title, scrollY: 0, at: now });
  }
  writeHistory(entries, storage);
  return entries.slice(-NAV_HISTORY_MAX);
}

/** Guarda el scroll de la pantalla actual (la última entrada). */
export function updateScroll(path: string, scrollY: number, storage: Store | null = store()) {
  const entries = readHistory(storage);
  const last = entries[entries.length - 1];
  if (!last || last.path !== path) return;
  last.scrollY = Math.max(0, Math.round(scrollY));
  writeHistory(entries, storage);
}

/** La entrada anterior con una ruta distinta de la actual, o null. */
export function previous(currentPath: string, storage: Store | null = store()): NavEntry | null {
  const entries = readHistory(storage);
  let index = entries.length - 1;
  while (index >= 0 && entries[index].path === currentPath) index--;
  return index >= 0 ? entries[index] : null;
}

/**
 * Quita del historial la pantalla actual (y repeticiones de ella) y devuelve
 * la anterior, que pasa a ser la última. Deja pendiente restaurar su scroll.
 */
export function pop(currentPath: string, storage: Store | null = store()): NavEntry | null {
  const entries = readHistory(storage);
  while (entries.length && entries[entries.length - 1].path === currentPath) entries.pop();
  const target = entries[entries.length - 1] || null;
  writeHistory(entries, storage);
  if (target && storage) {
    try { storage.setItem(NAV_RESTORE_KEY, JSON.stringify({ path: target.path, scrollY: target.scrollY })); } catch { /* sin almacenamiento */ }
  }
  return target;
}

/** Scroll pendiente de restaurar para esta ruta (se consume al leerlo). */
export function takeRestore(path: string, storage: Store | null = store()): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(NAV_RESTORE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { path?: string; scrollY?: number };
    if (value.path !== path) return null;
    storage.removeItem(NAV_RESTORE_KEY);
    return typeof value.scrollY === "number" ? value.scrollY : null;
  } catch { return null; }
}

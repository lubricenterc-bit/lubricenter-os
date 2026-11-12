import { supabase } from "@/lib/supabase";
import type { MyProfile } from "@/lib/profile";

/**
 * Caché en memoria para consultas que solo dependen de QUIÉN es el usuario
 * (rol, permisos) y no de datos de negocio.
 *
 * - Deduplica: si tres componentes piden el rol al mismo tiempo, sale UNA petición.
 * - TTL corto: un cambio de rol se ve como máximo a los pocos minutos.
 * - Se vacía al cambiar la sesión (login, logout, cambio de usuario).
 * - Nunca guarda errores: un fallo de red se reintenta en la siguiente llamada.
 *
 * Es solo una optimización de UI: la autorización real sigue en RLS y en las RPC.
 * NO usar para tasas, precios, saldos ni nada monetario.
 */
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Entry = { at: number; promise: Promise<RpcResult<unknown>> };

const DEFAULT_TTL_MS = 5 * 60_000;
const entries = new Map<string, Entry>();
let listening = false;

function listenForSessionChanges() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  supabase.auth.onAuthStateChange(event => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") entries.clear();
  });
}

export function clearSessionCache() {
  entries.clear();
}

export function cachedRpc<T>(fn: SessionRpc, ttlMs = DEFAULT_TTL_MS): Promise<RpcResult<T>> {
  listenForSessionChanges();
  const now = Date.now();
  const hit = entries.get(fn);
  if (hit && now - hit.at < ttlMs) return hit.promise as Promise<RpcResult<T>>;

  const promise = Promise.resolve(supabase.rpc(fn)).then(
    result => {
      const value = { data: (result.data ?? null) as T | null, error: result.error ? { message: result.error.message } : null };
      if (value.error && entries.get(fn)?.promise === promise) entries.delete(fn);
      return value;
    },
    (error: unknown) => {
      if (entries.get(fn)?.promise === promise) entries.delete(fn);
      return { data: null, error: { message: error instanceof Error ? error.message : "Sin conexión" } };
    },
  );
  entries.set(fn, { at: now, promise });
  return promise;
}

/** Solo RPC sin argumentos que dependen exclusivamente de la identidad del usuario. */
export type SessionRpc = "finance_role" | "can_administer_orders" | "my_profile";

export const financeRole = () => cachedRpc<string>("finance_role");
export const canAdministerOrders = () => cachedRpc<boolean>("can_administer_orders");
export const myProfile = () => cachedRpc<MyProfile | null>("my_profile");

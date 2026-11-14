/**
 * Perfil de la persona que inició sesión (RPC my_profile).
 *
 * - OWNER: cuenta del dueño. Todo, sin PIN.
 * - SHARED: la otra cuenta antigua compartida. Se comporta como hasta ahora.
 * - ADMIN: Edgar (computadora). Todo; los módulos del dueño piden PIN cada vez que entra.
 * - RECEPTION: Ender (tablet). Órdenes, clientes, CRM y taller. Sin cobros ni caja.
 * - MECHANIC: Cheo y Alexis (teléfono). Solo su app: /mecanico.
 *
 * Sin dependencias (lo usan las pruebas). La RPC está en session-cache (myProfile).
 * Es solo para decidir qué se muestra. La autorización real está en la base
 * (staff_can, staff_write_guard, finance_role con la ventana del PIN).
 */
export type StaffProfile = "OWNER" | "SHARED" | "ADMIN" | "RECEPTION" | "MECHANIC";
export type MyProfile = {
  profile: StaffProfile;
  name: string;
  staff_user_id?: string;
  employee_id?: string | null;
  device?: string | null;
  job_title?: string | null;
  permissions: string[];
  sensitive_until?: string | null;
};

export function firstName(name: string | null | undefined) {
  return (name || "").trim().split(/\s+/)[0] || "";
}

/** Módulos que antes eran solo del dueño. Para Edgar piden PIN al entrar. */
export const SENSITIVE_PREFIXES = [
  "/finance", "/cashea/conciliacion", "/cashea/balance", "/payroll",
] as const;

export function isSensitivePath(path: string) {
  return SENSITIVE_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + "/"));
}

/** Rutas que puede abrir la tablet de recepción (además de /login). */
const RECEPTION_PREFIXES = [
  "/", "/orders", "/quote", "/workshop", "/customers", "/vehicles", "/crm", "/reminders",
  "/service-history", "/catalog", "/ayuda", "/print", "/campaigns", "/promociones", "/oil-change",
] as const;

export const MECHANIC_HOME = "/mecanico";
export const USERS_PATH = "/settings/usuarios";

export function homeFor(profile: StaffProfile | undefined) {
  return profile === "MECHANIC" ? MECHANIC_HOME : "/";
}

/** ¿Este perfil puede abrir esta ruta? Si no, la app lo lleva a su inicio. */
export function canOpenPath(profile: StaffProfile | undefined, path: string) {
  if (!profile || profile === "OWNER" || profile === "SHARED" || profile === "ADMIN") {
    // El dueño y Edgar no entran a la app de mecánicos (no tienen empleado asociado).
    if (path === MECHANIC_HOME || path.startsWith(MECHANIC_HOME + "/")) return false;
    // Las cuentas y contraseñas del equipo las maneja solo el dueño.
    if (profile === "ADMIN" && (path === USERS_PATH || path.startsWith(USERS_PATH + "/"))) return false;
    return true;
  }
  if (profile === "MECHANIC") return path === MECHANIC_HOME || path.startsWith(MECHANIC_HOME + "/") || path.startsWith("/print/");
  // Recepción
  if (isSensitivePath(path)) return false;
  return RECEPTION_PREFIXES.some(prefix => prefix === "/" ? path === "/" : path === prefix || path.startsWith(prefix + "/"));
}

export const PROFILE_LABEL: Record<StaffProfile, string> = {
  OWNER: "Dueño",
  SHARED: "Cuenta compartida",
  ADMIN: "Administración",
  RECEPTION: "Recepción",
  MECHANIC: "Mecánico",
};

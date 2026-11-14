import { createClient } from "@supabase/supabase-js";
import { pushUser } from "@/lib/finance/push-server";

export const runtime = "nodejs";

/**
 * Cuentas del equipo (solo el dueño): crear la cuenta de acceso de una persona de
 * staff_users con correo y contraseña, o cambiarle la contraseña.
 *
 * Crear usuarios de Supabase Auth requiere la clave de servicio, que nunca llega al
 * navegador. El perfil, el empleado y los permisos se guardan con RPC normales.
 */
function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const actor = await pushUser(request);
  if (!actor) return Response.json({ error: "Inicia sesión" }, { status: 401 });
  const role = await actor.client.rpc("finance_role");
  if (role.error || role.data !== "OWNER") return Response.json({ error: "Solo el dueño administra las cuentas." }, { status: 403 });

  const admin = adminClient();
  if (!admin) return Response.json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY en el servidor (Railway)." }, { status: 503 });

  const input = await request.json().catch(() => null) as { action?: string; staff_user_id?: string; email?: string; password?: string } | null;
  const staffId = typeof input?.staff_user_id === "string" ? input.staff_user_id : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!staffId) return Response.json({ error: "Falta la persona." }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "La contraseña debe tener al menos 8 caracteres." }, { status: 400 });

  const staff = await admin.from("staff_users").select("id,full_name,auth_user_id,email").eq("id", staffId).maybeSingle();
  if (staff.error || !staff.data) return Response.json({ error: "No encontré a esa persona." }, { status: 404 });

  if (input?.action === "create") {
    const email = (input.email || "").trim().toLowerCase();
    if (!EMAIL.test(email)) return Response.json({ error: "Escribe un correo válido." }, { status: 400 });
    if (staff.data.auth_user_id) return Response.json({ error: "Esta persona ya tiene cuenta. Usa «Cambiar contraseña»." }, { status: 409 });
    const created = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: staff.data.full_name },
    });
    if (created.error || !created.data.user) {
      const taken = /already|registered|exists/i.test(created.error?.message || "");
      return Response.json({ error: taken ? "Ese correo ya tiene una cuenta en el sistema." : created.error?.message || "No se pudo crear la cuenta." }, { status: 400 });
    }
    const linked = await admin.from("staff_users")
      .update({ auth_user_id: created.data.user.id, email, active: true, updated_at: new Date().toISOString() })
      .eq("id", staffId).is("auth_user_id", null).select("id");
    if (linked.error || !linked.data?.length) {
      await admin.auth.admin.deleteUser(created.data.user.id);
      return Response.json({ error: linked.error?.message || "No se pudo enlazar la cuenta; intenta de nuevo." }, { status: 500 });
    }
    await admin.from("staff_activity_events").insert({
      staff_user_id: staffId, actor_user_id: actor.user.id, event_key: "account.created",
      entity_type: "staff_user", details: { email },
    });
    return Response.json({ ok: true });
  }

  if (input?.action === "password") {
    if (!staff.data.auth_user_id) return Response.json({ error: "Esta persona todavía no tiene cuenta." }, { status: 400 });
    const updated = await admin.auth.admin.updateUserById(staff.data.auth_user_id, { password });
    if (updated.error) return Response.json({ error: updated.error.message }, { status: 400 });
    await admin.from("staff_activity_events").insert({
      staff_user_id: staffId, actor_user_id: actor.user.id, event_key: "account.password_changed",
      entity_type: "staff_user", details: {},
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Acción desconocida." }, { status: 400 });
}

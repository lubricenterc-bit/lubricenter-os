// Owner-only staff invitation; the service role key never leaves the Edge runtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });
const APP_REDIRECT = "https://lubricenter-web-production.up.railway.app/accept-invite";

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { error: "Método no permitido" });

  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishable || !serviceKey) return reply(503, { error: "Configuración de invitaciones incompleta" });

  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply(401, { error: "Sesión requerida" });

  const userClient = createClient(url, publishable, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: identity, error: authError } = await userClient.auth.getUser(token);
  if (authError || !identity.user) return reply(401, { error: "Sesión inválida" });

  const { data: role, error: roleError } = await userClient.rpc("finance_role");
  if (roleError || role !== "OWNER") return reply(403, { error: "Solo el propietario puede invitar empleados" });

  let input: { staff_user_id?: string; email?: string };
  try { input = await request.json(); } catch { return reply(400, { error: "Datos inválidos" }); }
  const id = (input.staff_user_id || "").trim();
  const email = (input.email || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return reply(400, { error: "Identificador o correo inválido" });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: target, error: targetError } = await admin.from("staff_users")
    .select("id,full_name,auth_user_id").eq("id", id).maybeSingle();
  if (targetError) return reply(500, { error: "No se pudo verificar el perfil" });
  if (!target || target.auth_user_id) return reply(409, { error: "El perfil no existe o ya tiene cuenta de acceso" });

  const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: APP_REDIRECT,
    data: { full_name: target.full_name },
  });
  if (inviteError || !invitation.user) return reply(400, { error: inviteError?.message || "No se pudo crear la invitación" });

  const { error: linkError } = await admin.from("staff_users").update({
    email, auth_user_id: invitation.user.id, active: true, updated_at: new Date().toISOString(),
  }).eq("id", id).is("auth_user_id", null);
  if (linkError) return reply(500, { error: "Invitación enviada, pero falta asociar el perfil: contacta al administrador" });

  await admin.from("staff_activity_events").insert({
    staff_user_id: id, actor_user_id: identity.user.id,
    event_key: "account.invited", entity_type: "staff_user",
    entity_id: id, details: { email },
  });
  return reply(200, { success: true });
});

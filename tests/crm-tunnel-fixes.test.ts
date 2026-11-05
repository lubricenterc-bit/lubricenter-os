import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DISMISS_REASONS, KIND_LABEL, RECOVERY_BUCKETS, RECOVERY_CELLS, dismissReasons, matchesQuery, moveToEnd } from "../lib/crm";

const sql = readFileSync("supabase/migrations/20261105190000_crm_tunnel_fixes.sql", "utf8");
const tunnel = readFileSync("components/crm/contact-tunnel.tsx", "utf8");
const page = readFileSync("app/crm/page.tsx", "utf8");

describe("CRM: el envío no se pierde", () => {
  it("abrir WhatsApp queda guardado en la base antes de salir a WhatsApp", () => {
    expect(sql).toContain("create table if not exists public.crm_send_attempts");
    expect(sql).toContain("alter table public.crm_send_attempts enable row level security");
    const open = tunnel.slice(tunnel.indexOf("async function openWhatsapp"), tunnel.indexOf("function reopenWhatsapp"));
    expect(open.indexOf("crm_open_send")).toBeGreaterThan(-1);
    // La pestaña se abre en el mismo toque y solo va a WhatsApp si la base lo permite.
    expect(open.indexOf('window.open("", "_blank")')).toBeLessThan(open.indexOf("crm_open_send"));
    expect(open.indexOf("crm_open_send")).toBeLessThan(open.indexOf("tab.location.href = link"));
    expect(open).toContain("tab?.close()");
  });

  it("la confirmación se registra aunque el estado haya cambiado y no se duplica", () => {
    expect(sql).toContain("create or replace function public.crm_confirm_send(p_attempt_id uuid, p_sent boolean)");
    expect(sql).toContain("if a.resolution = 'SENT' and p_sent then return 'SENT'; end if;");
    expect(tunnel).toContain("crm_confirm_send");
    expect(tunnel).not.toContain("crm_record_send");
  });

  it("los pendientes de confirmar se ven en Hoy y abren el túnel en «¿Lo enviaste?»", () => {
    expect(sql).toContain("'pending', lubricenter_private.crm_pending_json()");
    expect(page).toContain("<PendingConfirm items={pending}");
    expect(tunnel).toContain('useState<Phase>(() => (pending.length ? "confirm" : "compose"))');
  });

  it("el túnel va en la URL: atrás lo cierra y al recargar se vuelve a abrir", () => {
    expect(page).toContain('q.set("tunnel", source)');
    expect(page).toContain('window.addEventListener("popstate", onPop)');
    expect(page).toContain("if (source) void openTunnel(source, false)");
  });
});

describe("CRM: reglas del ciclo", () => {
  it("«No enviar» con motivo y «Después» que no pierde al cliente", () => {
    expect(DISMISS_REASONS.map(r => r.id)).toEqual(["NOT_NEEDED", "TOO_LATE", "ALREADY_DONE", "NO_WHATSAPP"]);
    expect(dismissReasons("POST_SERVICE").map(r => r.id)).toEqual(["NOT_NEEDED", "NO_WHATSAPP"]);
    expect(sql).toContain("when p.outcome_current and p.outcome = 'DISMISSED' and p.outcome_notes = 'TOO_LATE' then 'DORMANT'");
    expect(sql).toContain("'DECLINED','SOLD_VEHICLE','CLOSED_NO_REPLY','DISMISSED') then 'CLOSED'");
    expect(moveToEnd(["a", "b", "c"], 0)).toEqual(["b", "c", "a"]);
    expect(moveToEnd(["a", "b", "c"], 2)).toEqual(["a", "b", "c"]);
  });

  it("posponer ya no borra los contactos del sistema anterior", () => {
    expect(sql).toContain("case when b.reset_at is null and b.n_sent = 0 and b.action_sent_at is not null");
    expect(sql).not.toContain("b.action_status = 'SENT' and b.action_sent_at is not null");
  });

  it("una persona por día y el postservicio cuenta para los 14 días", () => {
    expect(sql).toContain("select distinct on (r.customer_id) r.* from ready r");
    expect(sql).toContain("where f.customer_id = r.customer_id and f.status = 'SENT' and f.sent_at is not null");
    expect(sql).toContain("v_remaining := greatest(v_cap - v_sent - v_post, 0);");
  });

  it("«Más adelante», segunda oportunidad, cartera y «Ya volvió» con ciclo nuevo", () => {
    expect(sql).toContain("when q.outcome_current and q.outcome = 'POSTPONED' then 'AGREED'");
    expect(sql).toContain("then case when q.n_second = 0 then 'SECOND' end");
    expect(sql).toContain("('crm_second_chance_days', '120'::jsonb)");
    expect(sql).toContain("e.event_type in ('OTHER_SHOP', 'RETURNED')");
    expect(sql).toContain("when 'RETURNED' then coalesce(p_date, v_today + 90)");
    expect(KIND_LABEL.AGREED).toBe("Como quedamos");
    expect(KIND_LABEL.SECOND).toBe("Segunda oportunidad");
    expect(RECOVERY_BUCKETS).not.toContain("POOL");
    expect(RECOVERY_CELLS.at(-1)).toBe("POOL");
  });

  it("CHECK ampliados sin quitar valores y nada abierto a anon", () => {
    for (const v of ["'SENT'", "'REPLIED'", "'BOOKED'", "'DECLINED'", "'CLOSED_NO_REPLY'", "'REACTIVATED'", "'POSTPONED'", "'OTHER_SHOP'", "'SOLD_VEHICLE'", "'WRONG_NUMBER'", "'RETURNED'", "'DISMISSED'"]) {
      expect(sql).toContain(v);
    }
    expect(sql).not.toMatch(/grant [^;]* to anon/i);
    const fns = [...sql.matchAll(/create or replace function public\.(crm_[a-z_]+)\(/g)].map(m => m[1]);
    for (const fn of fns) expect(sql, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`));
  });

  it("buscador sin acentos para «Esperando respuesta»", () => {
    expect(matchesQuery("José Pérez AB123CD Corolla", "jose corolla")).toBe(true);
    expect(matchesQuery("José Pérez", "maria")).toBe(false);
    expect(matchesQuery("Cualquiera", "")).toBe(true);
  });
});

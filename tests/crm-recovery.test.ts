import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contactText, contactableToday, dueText, RECOVERY_BUCKETS } from "../lib/crm";

const sql = readFileSync("supabase/migrations/20261104180000_crm_recovery.sql", "utf8");
const item = readFileSync("supabase/migrations/20261104181000_crm_queue_item.sql", "utf8");

describe("CRM: Recuperar", () => {
  it("tramos por días desde el vencimiento", () => {
    expect(RECOVERY_BUCKETS).toEqual(["SOON", "D0_30", "D31_90", "D91_180", "D181_365", "D365P"]);
    expect(sql).toContain("when p_days between -15 and -1 then 'SOON'");
    expect(sql).toContain("when p_days between 0 and 30 then 'D0_30'");
    expect(sql).toContain("when p_days > 365 then 'D365P'");
  });

  it("textos de la lista", () => {
    expect(dueText(47)).toBe("vencido hace 47 días");
    expect(dueText(1)).toBe("vencido hace 1 día");
    expect(dueText(0)).toBe("vence hoy");
    expect(dueText(-5)).toBe("vence en 5 días");
    expect(contactText(0, null)).toBe("sin contactar");
    expect(contactText(2, "2026-10-12")).toMatch(/^2 mensajes · último /);
    expect(contactableToday(15, 89)).toBe(15);
    expect(contactableToday(0, 89)).toBe(0);
    expect(contactableToday(15, 3)).toBe(3);
  });

  it("«Ya volvió» amplía los resultados sin quitar ninguno y cierra el ciclo", () => {
    expect(sql).toContain("'POSTPONED','OTHER_SHOP','SOLD_VEHICLE','WRONG_NUMBER','RETURNED']");
    expect(sql).toContain("when p.outcome_current and p.outcome = 'RETURNED' then 'RETURNED'");
    expect(sql).toContain("'OPT_OUT','SNOOZE','RETURNED') then");
    expect(sql).toContain("where v.status not in ('OPTED_OUT', 'CLOSED', 'RETURNED')");
  });

  it("el túnel por tramo respeta el tope diario y no repite persona", () => {
    expect(sql).toContain("v_remaining := greatest(v_cap - v_sent, 0);");
    expect(sql).toContain("select distinct on (r.customer_id) r.*");
    expect(sql).toContain("where j.status = 'READY' and lubricenter_private.crm_recovery_bucket(j.days_from_due) = p_bucket");
    expect(item).toContain("Llegaste al máximo de hoy (%). Mañana siguen.");
    expect(item).toContain("if r.status <> 'READY' then");
  });

  it("lecturas con RLS (security invoker) y nada abierto a anon", () => {
    for (const fn of ["crm_recovery_summary()", "crm_recovery_list(text, text, text, int, int)", "crm_bucket_queue(text, int)"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon;`);
    }
    expect(sql).toMatch(/crm_recovery_summary\(\)\nreturns jsonb language sql stable security invoker/);
    expect(sql).toMatch(/crm_recovery_list\([\s\S]*?\)\nreturns jsonb language plpgsql stable security invoker/);
    expect(sql).not.toMatch(/grant [^;]* to anon/i);
    expect(item).not.toMatch(/grant [^;]* to anon/i);
  });

  it("Recuperar es la primera pestaña y va en la URL", () => {
    const page = readFileSync("app/crm/page.tsx", "utf8");
    expect(page).toContain('{ id: "RECOVER", label: "Recuperar" },\n    { id: "TODAY"');
    expect(page).toContain('RECOVER: "recover"');
    expect(page).toContain('?? "RECOVER") as Tab');
    const home = readFileSync("components/os-home.tsx", "utf8");
    expect(home).toContain('href: "/crm?tab=recover"');
    expect(home).toContain('href: "/crm?tab=today"');
  });
});

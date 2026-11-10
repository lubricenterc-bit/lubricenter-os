import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { addDays, captureBlocks, estimateMinutes, waLink } from "../lib/crm";
import { moduleForPath, navigationSearch } from "../lib/navigation";

const sql = readFileSync("supabase/migrations/20261103150000_crm_semiauto.sql", "utf8");

describe("CRM semiautomático", () => {
  it("las reglas viven en la base y nada se envía solo", () => {
    expect(sql).toContain("create or replace view public.crm_vehicle_journeys with (security_invoker = true)");
    expect(sql).toContain("create or replace function public.crm_board()");
    // Máximo diario, 14 días entre mensajes a una persona y corte del 10 sep.
    expect(sql).toContain("('crm_daily_cap', '15'::jsonb)");
    expect(sql).toContain("::date + 14");
    expect(sql).toContain("('crm_legacy_bulk_date', '\"2026-09-10\"'::jsonb)");
    // Ninguna llamada a servicios externos desde la base.
    expect(sql).not.toMatch(/net\.http|http_post|pg_net/i);
  });

  it("las tablas nuevas tienen RLS y nada queda abierto a anon", () => {
    for (const t of ["crm_message_templates", "crm_customer_flags", "crm_capture_skips"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    }
    expect(sql).not.toMatch(/grant [^;]* to anon/i);
    const fns = [...sql.matchAll(/create or replace function public\.(crm_[a-z_]+)\(/g)].map(m => m[1]);
    for (const fn of fns) expect(sql, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`));
  });

  it("el postservicio no muestra líneas internas y usa km venezolanos", () => {
    expect(sql).toContain("not in ('CASHEA_SURCHARGE', 'PASS_THROUGH')");
    expect(sql).toContain("!~* 'cashea'");
    expect(sql).toContain("replace(to_char(p_km, 'FM999,999,999'), ',', '.')");
    expect(sql).toContain("'crm-expire-post-service'");
  });

  it("la pantalla registra el envío solo después de confirmarlo", () => {
    const tunnel = readFileSync("components/crm/contact-tunnel.tsx", "utf8");
    const open = tunnel.indexOf("function openWhatsapp");
    const confirm = tunnel.indexOf("async function confirmSent");
    expect(open).toBeGreaterThan(-1);
    expect(tunnel.slice(open, confirm)).not.toContain("crm_record_send");
    expect(tunnel).toContain("¿Lo enviaste?");
  });

  it("Seguimiento reemplaza a Recordatorios en el menú", () => {
    expect(moduleForPath("/crm").id).toBe("customers");
    expect(moduleForPath("/reminders").id).toBe("customers");
    expect(navigationSearch("recordatorios", "OPERATOR").some(x => x.href === "/crm")).toBe(true);
    expect(readFileSync("app/reminders/page.tsx", "utf8")).toContain('redirect("/crm")');
  });

  it("Venta rápida pide la placa cuando hay aceite", () => {
    const quick = readFileSync("components/quick-sale-screen.tsx", "utf8");
    expect(quick).toContain("<OilCaptureCard");
    expect(quick).toContain("disabled={captureBlocking}");
  });

  it("la placa solo se exige cuando hubo cambio de aceite", () => {
    const capture = readFileSync("supabase/migrations/20261104120000_crm_capture_only_oil_change.sql", "utf8");
    expect(capture).toContain("create or replace function lubricenter_private.crm_order_needs_capture(p_order_id uuid)");
    // Servicio de cambio, o 4 L de aceite de motor (galón = 4) + filtro de aceite.
    expect(capture).toContain("l.item_type = 'SERVICE' and l.business_area = 'OIL_CHANGE'");
    expect(capture).toContain("when l.unit = 'GAL' then 4");
    expect(capture).toContain("), 0) >= 4");
    expect(capture).toContain("l.category = 'Filtro Aceite'");
    expect(capture).toContain("coalesce(l.pricing_mode, '') <> 'BONUS'");
    // La captura opcional existe y la métrica usa el mismo criterio.
    expect(capture).toContain("'optional', v_oil is not null and not v_needs");
    expect(capture).toContain("and lubricenter_private.crm_order_needs_capture(o.id)");
    expect(capture).toMatch(/revoke all on function lubricenter_private\.crm_order_needs_capture\(uuid\) from public, anon/);
  });

  it("litros sueltos no bloquean; un cambio de aceite sí", () => {
    expect(captureBlocks({ needs: false, optional: true })).toBe(false);
    expect(captureBlocks({ needs: true, optional: false })).toBe(true);
    expect(captureBlocks(null)).toBe(false);
    const card = readFileSync("components/crm/oil-capture-card.tsx", "utf8");
    expect(card).toContain("¿Fue para un cambio de aceite? Anotar placa");
    expect(card).toContain("onBlockingChange(captureBlocks(s))");
  });

  it("utilidades", () => {
    expect(waLink("584141234567", "Hola ñ")).toBe("https://api.whatsapp.com/send?phone=584141234567&text=Hola%20%C3%B1");
    // Emojis: directo a api.whatsapp.com (wa.me los rompe al redirigir)
    expect(waLink("584141234567", "Hola 👋 🛢️")).toBe("https://api.whatsapp.com/send?phone=584141234567&text=Hola%20%F0%9F%91%8B%20%F0%9F%9B%A2%EF%B8%8F");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(estimateMinutes(12)).toBe(7);
  });
});

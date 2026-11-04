import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Receipt58 } from "../components/receipt/receipt-58";
import { footerPhrase, lineDetail, receiptShareText, shortDate } from "../lib/receipt";
import { casheaSale, cashWithChange, oilChange } from "./receipt-fixtures";

const html = (data: typeof oilChange) => renderToStaticMarkup(createElement(Receipt58, { data }));

describe("recibo de 58 mm", () => {
  it.each([["cambio de aceite", oilChange], ["Cashea", casheaSale], ["efectivo con vuelto", cashWithChange]])("%s: sin líneas internas y total en es-VE", (_name, data) => {
    const out = html(data);
    expect(out).not.toMatch(/recargo|ajuste de cashea|importe adicional|compra para el trabajo|PASS_THROUGH|CASHEA_SURCHARGE/i);
    expect(out).toContain(`$${data.totals.ref.toLocaleString("es-VE", { minimumFractionDigits: 2 })}`);
    expect(out).toContain("Cuidamos lo que te mueve.");
    expect(out).toContain("Nota de entrega · Documento no fiscal");
  });

  it("cambio de aceite: cortesía, próximo cambio y frase", () => {
    const out = html(oilChange);
    expect(out).toContain("Cortesía");
    expect(out).toContain("Tu próximo cambio");
    expect(out).toContain("163.283 km");
    expect(out).toContain("04/02/2027");
    expect(out).toContain("$50,00");
    expect(out).toContain("Bs 44.660,89");
    expect(out).toContain("Atendió: Edgar");
    expect(footerPhrase(oilChange)).toBe("Te escribimos cuando se acerque tu cambio.");
    expect(lineDetail(oilChange.lines[0])).toBe("5 L × $9,00");
  });

  it("Cashea: inicial y cuotas, con la frase de la app", () => {
    const out = html(casheaSale);
    expect(out).toContain("Inicial 40%");
    expect(out).toContain("Cuota 3 · 15/12");
    expect(footerPhrase(casheaSale)).toBe("Las cuotas se pagan en la app de Cashea.");
  });

  it("efectivo con vuelto y total con recuadro", () => {
    const out = html(cashWithChange);
    expect(out).toContain('data-total-style="BORDER"');
    expect(out).toContain("Vuelto entregado");
    expect(out).toContain("WhatsApp 0414 123 4567");
    expect(out).toContain("@lubricenter");
    expect(footerPhrase(cashWithChange)).toBe("Gracias por tu compra.");
  });

  it("bandas de cotización y anulada", () => {
    expect(html({ ...oilChange, order: { ...oilChange.order, status: "OPEN" } })).toContain("Cotización · venta abierta");
    expect(html({ ...oilChange, order: { ...oilChange.order, status: "CANCELLED" } })).toContain("Anulada · sin validez");
  });

  it("texto para compartir en el mismo orden", () => {
    const text = receiptShareText(oilChange);
    const order = ["LUBRICENTER", "OS-000378", "Felipe Díaz", "BRAVA 15W40", "*Total: $50,00*", "Pago móvil", "Tu próximo cambio", "Cuidamos"];
    let last = -1;
    for (const part of order) { const at = text.indexOf(part); expect(at, part).toBeGreaterThan(last); last = at; }
    expect(shortDate("2027-02-04")).toBe("04/02/2027");
  });

  it("CSS: 48 mm, solo blanco y negro, sin !important y sin tocar el recibo viejo", () => {
    const css = readFileSync("app/print/receipt/receipt-print.css", "utf8");
    expect(css).toContain("width: 48mm");
    expect(css).not.toContain("!important");
    const printable = css.slice(0, css.indexOf("@media screen"));
    const colors = printable.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];
    expect(new Set(colors.map(c => c.toLowerCase()))).toEqual(new Set(["#fff", "#000"]));
    expect(readFileSync("components/app-shell.tsx", "utf8")).toContain('pathname.startsWith("/print/")');
    expect(readFileSync("app/payroll/[id]/receipt/page.tsx", "utf8")).toContain("ReceiptPrintButton");
  });

  it("migración: order_receipt de solo lectura y configuración solo para el dueño", () => {
    const sql = readFileSync("supabase/migrations/20261104140000_order_receipt.sql", "utf8");
    const fix = readFileSync("supabase/migrations/20261104143000_order_receipt_cancelled_totals.sql", "utf8");
    expect(fix).toContain("if o.status in ('OPEN', 'CANCELLED') then");
    expect(sql).toContain("create or replace function public.order_receipt(p_order_id uuid)\nreturns jsonb language plpgsql stable security invoker");
    expect(sql).toContain("revoke all on function public.order_receipt(uuid) from public, anon");
    expect(sql).toContain("revoke all on function public.set_receipt_settings(jsonb, text) from public, anon");
    expect(sql).toContain("'Cargo por financiamiento'");
    expect(sql).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });
});

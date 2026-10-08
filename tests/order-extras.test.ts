import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  addManualExtra, EMPTY_ORDER_EXTRAS, extrasNameKey, manualExtras,
  normalizeOrderExtras, OIL_CHANGE_COURTESY_PRESETS,
  OIL_CHANGE_SERVICE_PRESETS, orderExtrasRpcParams, selectedPresets, toggleExtra,
  uniqueExtraLabels, validateOrderExtras
} from "../lib/order-extras";

describe("Servicios adicionales de cambio de aceite",()=>{
  it("tiene selección rápida de las cortesías y servicios acordados",()=>{
    expect(OIL_CHANGE_SERVICE_PRESETS).toContain("Calibración de presión de cauchos");
    expect(OIL_CHANGE_SERVICE_PRESETS).toContain("Revisión de niveles");
    expect(OIL_CHANGE_COURTESY_PRESETS).toContain("Líquido limpiaparabrisas");
    expect(OIL_CHANGE_COURTESY_PRESETS).toContain("Lavado de cortesía");
  });
  it("no marca automáticamente servicios sin haberlos realizado",()=>{
    expect(EMPTY_ORDER_EXTRAS).toEqual({services:[],bonuses:[],notes:""});
    expect(normalizeOrderExtras(null)).toEqual(EMPTY_ORDER_EXTRAS);
  });
  it("seleccionar es una acción por casilla y quitar conserva los demás",()=>{
    const label="Calibración de presión de cauchos";
    let services=toggleExtra([],label,true);
    services=toggleExtra(services,"Revisión de niveles",true);
    expect(services).toEqual([label,"Revisión de niveles"]);
    services=toggleExtra(services,"calibracion de presion de cauchos",false);
    expect(services).toEqual(["Revisión de niveles"]);
    expect(selectedPresets(services,OIL_CHANGE_SERVICE_PRESETS)).toEqual(["Revisión de niveles"]);
  });
  it("permite personalizar servicios y regalos sin duplicar nombres ni sobrescribir listas",()=>{
    const services=addManualExtra(["Revisión de niveles"],"   Revisar batería   ");
    const again=addManualExtra(services,"revisar  bateria");
    expect(again).toEqual(["Revisión de niveles","Revisar batería"]);
    expect(manualExtras(again,OIL_CHANGE_SERVICE_PRESETS)).toEqual(["Revisar batería"]);
    expect(extrasNameKey(" Presión  de  Cauchos ")).toBe("presion de cauchos");
  });
  it("rehidrata servicios, cortesías y observaciones que ya existían en CRM",()=>{
    const previous=normalizeOrderExtras({
      crm_additional_services:["Calibración de presión de cauchos","Prueba de frenos"],
      crm_bonuses:["Lavado de cortesía","Líquido limpiaparabrisas"],
      crm_observations:"Se observó desgaste en caucho delantero."
    });
    expect(previous.services).toHaveLength(2);
    expect(previous.bonuses).toHaveLength(2);
    expect(previous.notes).toContain("desgaste");
    expect(selectedPresets(previous.bonuses,OIL_CHANGE_COURTESY_PRESETS)).toHaveLength(2);
    expect(manualExtras(previous.services,OIL_CHANGE_SERVICE_PRESETS)).toEqual(["Prueba de frenos"]);
  });
  it("reutiliza la función RPC existente en vez de crear cargos, tablas o registros duplicados",()=>{
    const extras={services:["Revisión de niveles"],bonuses:["Lavado de cortesía"],notes:"Cliente satisfecho"};
    expect(orderExtrasRpcParams("order-123",extras)).toEqual({
      p_order_id:"order-123",
      p_additional_services:["Revisión de niveles"],
      p_bonuses:["Lavado de cortesía"],
      p_observations:"Cliente satisfecho"
    });
    expect(validateOrderExtras(extras)).toBeNull();
    expect(validateOrderExtras({...extras,notes:"a".repeat(2100)})).toContain("2000");
    expect(uniqueExtraLabels([" Lavado de cortesía ","lavado de CORTESIA",""])).toEqual(["Lavado de cortesía"]);
  });
  it("se integra en el flujo principal y guarda CRM antes de registrar el cambio de aceite",()=>{
    const oil=readFileSync("app/orders/[id]/oil-change/page.tsx","utf8");
    const order=readFileSync("components/order-workspace.tsx","utf8");
    const component=readFileSync("components/order-additional-services.tsx","utf8");
    expect(oil).toContain("<OrderExtrasChecklist value={extras}");
    expect(oil).toContain("setExtras(normalizeOrderExtras(orderRes.data))");
    expect(oil.indexOf('"set_order_crm_extras"')).toBeLessThan(oil.indexOf('"add_oil_change_package_flexible"'));
    expect(order).toContain("<OrderAdditionalServices key={orderId} orderId={orderId}/>");
    expect(order).not.toContain("<OrderCrmExtras orderId={orderId} />");
    expect(component).toContain('supabase.rpc("set_order_crm_extras"');
    expect(component).toContain("Tienes cambios sin guardar");
  });
});

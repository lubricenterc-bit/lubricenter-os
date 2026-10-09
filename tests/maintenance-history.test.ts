import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { filterMaintenanceRecords, maintenanceIsHistorical, maintenanceMismatch, groupMaintenanceByDay, type MaintenanceHistoryRecord } from "../lib/maintenance-history";
import { moduleForPath, navigationSearch } from "../lib/navigation";
const old: MaintenanceHistoryRecord = {
  id:"record-old",order_id:null,customer_id:"customer-old",vehicle_id:"vehicle-1",
  service_type:"OIL_CHANGE",description:"Cambio de aceite 20W50",performed_at:"2026-01-29T16:00:00Z",odometer:88000,
  oil_brand:"Marca",oil_viscosity:"20W50",oil_quantity_liters:4,oil_filter_code:"3387",next_service_odometer:93000,next_service_date:null,
  service_notes:"Revisión general",included_services:["Revisión de niveles"],bonuses:["Lavado"],source_system:"google_sheets_oil_history",source_invoice:"ref-1",
  customer:{id:"customer-old",name:"Cliente anterior",phone:null},
  vehicle:{id:"vehicle-1",plate:"AB123CD",make:"Marca",model:"Modelo",year:2010,customer_id:"customer-current"},
};
const now: MaintenanceHistoryRecord={...old,id:"record-now",customer_id:"customer-current",order_id:"order-now",source_system:null,
  performed_at:"2026-10-01T16:00:00Z",customer:{id:"customer-current",name:"Cliente actual",phone:null}};
describe("archivo de mantenimiento",()=>{
 it("preserva clientes históricos separados del dueño actual",()=>{
   expect(maintenanceMismatch(old)).toBe(true);
   expect(maintenanceMismatch(now)).toBe(false);
   expect(maintenanceIsHistorical(old)).toBe(true);
   expect(maintenanceIsHistorical(now)).toBe(false);
 });
 it("permite buscar por placa, nombre y filtro y filtrar clientes sin fusionarlos",()=>{
   const data=[old,now],base={query:"",kind:"ALL" as const,origin:"ALL" as const};
   expect(filterMaintenanceRecords(data,{...base,query:"AB-123-CD"})).toHaveLength(2);
   expect(filterMaintenanceRecords(data,{...base,customerId:"customer-old"}).map(x=>x.id)).toEqual(["record-old"]);
   expect(filterMaintenanceRecords(data,{...base,origin:"HISTORIC"})).toHaveLength(1);
   expect(filterMaintenanceRecords(data,{...base,query:"3387"})).toHaveLength(2);
 });
 it("ordena el historial por día descendente",()=>{
   expect(groupMaintenanceByDay([old,now]).map(([date])=>date)).toEqual(["2026-10-01","2026-01-29"]);
 });
 it("está en Clientes y disponible desde órdenes y fichas",()=>{
   expect(moduleForPath("/service-history").id).toBe("customers");
   expect(navigationSearch("historial","OPERATOR").some(x=>x.href==="/service-history")).toBe(true);
   expect(readFileSync("app/orders/page.tsx","utf8")).toContain("Historial de mantenimiento");
   expect(readFileSync("app/customers/[id]/page.tsx","utf8")).toContain("SERVICIOS REGISTRADOS");
 });
 it("consulta registros ya importados sin duplicarlos",()=>{
   const listing=readFileSync("app/service-history/page.tsx","utf8");
   expect(listing).toContain('from("service_records")');
   expect(listing).toContain("read-only");
   expect(readFileSync("app/service-history/[id]/page.tsx","utf8")).toContain("Sin orden contable");
 });
});

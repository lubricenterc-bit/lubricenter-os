export type ServiceHistoryType = "OIL_CHANGE" | "WORKSHOP" | "ELECTROAUTO" | "OTHER";
export type ServiceHistoryPerson = { id: string; name: string | null; phone: string | null };
export type ServiceHistoryVehicle = {
  id: string;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  customer_id: string | null;
};
export type MaintenanceHistoryRecord = {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  vehicle_id: string;
  service_type: ServiceHistoryType;
  description: string;
  performed_at: string;
  odometer: number | null;
  oil_brand: string | null;
  oil_viscosity: string | null;
  oil_quantity_liters: number | null;
  oil_filter_code: string | null;
  next_service_odometer: number | null;
  next_service_date: string | null;
  service_notes: string | null;
  included_services: string[];
  bonuses: string[];
  source_system: string | null;
  source_invoice: string | null;
  customer?: ServiceHistoryPerson | null;
  vehicle?: ServiceHistoryVehicle | null;
};

export type MaintenanceFilters = {
  query: string;
  kind: "ALL" | "OIL_CHANGE" | "WORKSHOP" | "ELECTROAUTO" | "OTHER";
  origin: "ALL" | "HISTORIC" | "CURRENT";
  customerId?: string | null;
  vehicleId?: string | null;
};

function stripped(input: string | null | undefined) {
  return (input ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
export function maintenanceIsHistorical(s: Pick<MaintenanceHistoryRecord, "order_id"|"source_system">) {
  return s.order_id == null && s.source_system != null;
}
export function maintenanceVehicleLabel(vehicle: ServiceHistoryVehicle | null | undefined) {
  if (!vehicle) return "Vehículo sin información";
  const label = [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ");
  return label || vehicle.plate || "Vehículo";
}
export function maintenanceServiceLabel(kind: ServiceHistoryType) {
  return ({
    OIL_CHANGE:"Cambio de aceite", WORKSHOP:"Trabajo de taller",
    ELECTROAUTO:"Electroauto", OTHER:"Servicio adicional"
  })[kind] || "Servicio";
}
export function maintenanceMismatch(s: MaintenanceHistoryRecord) {
  return !!(s.customer_id && s.vehicle?.customer_id && s.customer_id !== s.vehicle.customer_id);
}
export function filterMaintenanceRecords(rows: MaintenanceHistoryRecord[], filters: MaintenanceFilters) {
  const term = stripped(filters.query);
  return rows.filter(row => {
    if (filters.customerId && row.customer_id !== filters.customerId) return false;
    if (filters.vehicleId && row.vehicle_id !== filters.vehicleId) return false;
    if (filters.kind !== "ALL" && row.service_type !== filters.kind) return false;
    const historic = maintenanceIsHistorical(row);
    if (filters.origin === "HISTORIC" && !historic) return false;
    if (filters.origin === "CURRENT" && historic) return false;
    if (!term) return true;
    const haystack=stripped([
      row.customer?.name, row.customer?.phone, row.vehicle?.plate,
      row.vehicle?.make, row.vehicle?.model, row.description,
      row.oil_brand, row.oil_viscosity, row.oil_filter_code,
      row.source_invoice
    ].filter(Boolean).join(" "));
    const compactTerm=term.replace(/\s/g,"");
    return haystack.includes(term) ||
      (compactTerm.length>=3 && haystack.replace(/\s/g,"").includes(compactTerm));
  });
}
export function groupMaintenanceByDay(rows: MaintenanceHistoryRecord[]) {
  const map = new Map<string, MaintenanceHistoryRecord[]>();
  for (const row of rows) {
    const day = row.performed_at.slice(0, 10);
    const list = map.get(day) || [];
    list.push(row);
    map.set(day,list);
  }
  return [...map.entries()].sort((a,b)=>b[0].localeCompare(a[0]));
}

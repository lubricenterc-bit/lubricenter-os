export type MaintenanceReminder = {
  customer_name: string | null;
  make: string | null;
  model: string | null;
  plate: string | null;
  next_service_date: string | null;
  next_service_odometer: number | null;
  urgency: "DUE" | "SOON" | "UPCOMING" | "SENT" | "SNOOZED";
};

function displayDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

export function reminderMessage(r: MaintenanceReminder): string {
  const name = r.customer_name?.trim().split(/\s+/)[0] || "amigo";
  const vehicle = [r.make, r.model].filter(Boolean).join(" ") || "vehículo";
  const vehicleLabel = r.plate ? `${vehicle} (${r.plate})` : vehicle;
  const occasion = r.urgency === "DUE" ? "ya corresponde" : r.urgency === "SOON" ? "se acerca" : "está prevista";
  const targets = [
    r.next_service_odometer != null ? `alrededor de los ${r.next_service_odometer.toLocaleString("es-VE")} km` : null,
    r.next_service_date ? `el ${displayDate(r.next_service_date)}` : null,
  ].filter(Boolean);
  const targetLine = targets.length ? `\n📅 La teníamos estimada para *${targets.join(" o ")}*.` : "";
  return `Hola *${name}* 👋 ¿Cómo va tu *${vehicleLabel}*?\n\n🛠️ Según el último servicio, tu *próxima revisión* ${occasion}.${targetLine}\n\n📲 Si ya hiciste el servicio, cuéntanos para mantener tu historial al día. Si sigue pendiente, responde a este mensaje y coordinamos tu visita.\n\n*Lubricenter*`;
}

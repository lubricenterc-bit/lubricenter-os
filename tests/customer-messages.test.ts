import { describe, expect, it } from "vitest";
import { reminderMessage, type MaintenanceReminder } from "../lib/domain/customer-messages";

const reminder = (patch: Partial<MaintenanceReminder> = {}): MaintenanceReminder => ({
  customer_name: "María Pérez", make: "Toyota", model: "Corolla", plate: "ABC123",
  next_service_date: "2026-11-15", next_service_odometer: 85000, urgency: "SOON", ...patch,
});

describe("customer maintenance reminder", () => {
  it("uses a warm, scannable message without saying the service is due too early", () => {
    const message = reminderMessage(reminder());
    expect(message).toContain("Hola *María* 👋");
    expect(message).toContain("*Toyota Corolla (ABC123)*");
    expect(message).toContain("*próxima revisión* se acerca");
    expect(message).toContain("85.000 km");
    expect(message).toContain("15 de noviembre");
    expect(message).toContain("coordinamos tu visita");
    expect(message).not.toContain("ya corresponde");
  });

  it("identifies a due service and omits dates that were never recorded", () => {
    const message = reminderMessage(reminder({ urgency: "DUE", next_service_date: null, next_service_odometer: null }));
    expect(message).toContain("ya corresponde");
    expect(message).not.toContain("La teníamos estimada");
    expect(message).not.toContain("null");
  });
});

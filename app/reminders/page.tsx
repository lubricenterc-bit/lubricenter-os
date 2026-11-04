import { redirect } from "next/navigation";

// Recordatorios se unió a Seguimiento (CRM semiautomático, nov 2026).
export default function RemindersRedirect() {
  redirect("/crm");
}

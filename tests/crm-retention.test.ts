import { describe,it,expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCrmJourney, caracasDay, calendarDayDelta, crmStage, makeCrmMessage,
  cleanCrmWhatsapp, type CrmVehicleReminder, type CrmMaintenanceEvent
} from "../lib/crm-retention";

const at=new Date("2026-10-09T15:00:00Z");
const base:CrmVehicleReminder={
  service_record_id:"svc-1",vehicle_id:"car-1",customer_id:"client-1",
  customer_name:"María Elena",customer_phone:"04121234567",plate:"AB123CD",
  make:"Ford",model:"Fiesta",year:2010,current_odometer:110000,service_odometer:105000,
  performed_at:"2026-07-01T10:00:00Z",next_service_odometer:110000,
  next_service_date:"2026-10-09",reminder_status:"PENDING",snoozed_until:null,
  sent_at:null,urgency:"DUE",service_count:3,mileage_points:3,slope_pairs:3,
  km_per_day:50,days_per_5000km:100,typical_visit_days:95,
  projected_km_due_date:"2026-10-09",projected_habit_due_date:null,
  calendar_due_date:"2026-10-10",forecast_confidence:"MEDIUM",due_reason:"KM_USAGE"
};
const sent=(id:string,date:string,stage:"PREVENTIVE"|"DUE"|"LATE"|"RECOVERY"|"WINBACK",other?:Partial<CrmMaintenanceEvent>):CrmMaintenanceEvent=>({
  id,service_record_id:"svc-1",vehicle_id:"car-1",customer_id:"client-1",
  event_type:"SENT",stage,message_text:"Mensaje registrado",notes:null,recorded_at:date,...other
});

describe("CRM de fidelización y recuperación",()=>{
  it("segmenta desde 14 días antes hasta más de 90 días de retraso",()=>{
    expect(crmStage(-15)).toBe("NOT_READY");
    expect(crmStage(-14)).toBe("PREVENTIVE");
    expect(crmStage(-5)).toBe("PREVENTIVE");
    expect(crmStage(-4)).toBe("DUE");
    expect(crmStage(7)).toBe("DUE");
    expect(crmStage(8)).toBe("LATE");
    expect(crmStage(30)).toBe("LATE");
    expect(crmStage(31)).toBe("RECOVERY");
    expect(crmStage(90)).toBe("RECOVERY");
    expect(crmStage(91)).toBe("WINBACK");
    expect(calendarDayDelta("2026-10-13","2026-10-09")).toBe(-4);
    expect(caracasDay(at)).toBe("2026-10-09");
  });
  it("no escribe sin consentimiento, con rechazo o sin número correcto",()=>{
    expect(buildCrmJourney(base,[],"UNKNOWN",[],at).status).toBe("NEEDS_CONSENT");
    expect(buildCrmJourney(base,[],"OPT_OUT",[],at).status).toBe("OPTED_OUT");
    expect(buildCrmJourney(base,[],"OPT_IN",[],at).status).toBe("READY");
    expect(buildCrmJourney({...base,customer_phone:null},[],"OPT_IN",[],at).status).toBe("NO_PHONE");
    expect(cleanCrmWhatsapp("0412-123-4567")).toBe("584121234567");
    expect(cleanCrmWhatsapp("123456789")).toBe("");
  });
  it("requiere reactivar explícitamente el archivo con estado SENT heredado",()=>{
    const archived={...base,reminder_status:"SENT" as const};
    expect(buildCrmJourney(archived,[],"OPT_IN",[],at).status).toBe("ARCHIVED");
    const activated:CrmMaintenanceEvent={
      id:"re-opened",event_type:"REACTIVATED",stage:null,service_record_id:"svc-1",
      customer_id:"client-1",vehicle_id:"car-1",message_text:null,notes:null,
      recorded_at:"2026-10-09T12:00:00Z"
    };
    expect(buildCrmJourney({...archived,reminder_status:"PENDING"},[activated],"OPT_IN",[activated],at).status).toBe("READY");
  });
  it("no repite etapa ni invade otro vehículo del mismo propietario",()=>{
    const oldSent=sent("first","2026-09-20T15:00:00Z","PREVENTIVE");
    expect(buildCrmJourney(base,[oldSent],"OPT_IN",[oldSent],at).status).toBe("READY");
    const same=sent("same","2026-09-20T15:00:00Z","DUE");
    expect(buildCrmJourney(base,[same],"OPT_IN",[same],at).status).toBe("CONTACTED");
    const recent=sent("recent","2026-10-03T15:00:00Z","PREVENTIVE");
    expect(buildCrmJourney(base,[recent],"OPT_IN",[recent],at).status).toBe("WAITING");
    const other=sent("other","2026-10-06T15:00:00Z","PREVENTIVE",{
      service_record_id:"svc-2",vehicle_id:"car-2"
    });
    expect(buildCrmJourney(base,[],"OPT_IN",[other],at).status).toBe("WAITING");
  });
  it("máximo tres envíos y respuesta o cita detienen el seguimiento",()=>{
    const s1=sent("s1","2026-08-01T10:00:00Z","PREVENTIVE");
    const s2=sent("s2","2026-09-01T10:00:00Z","LATE");
    const s3=sent("s3","2026-09-20T10:00:00Z","RECOVERY");
    expect(buildCrmJourney(base,[s1,s2,s3],"OPT_IN",[s1,s2,s3],at).status).toBe("COMPLETED");
    const reply={...s1,id:"reply",event_type:"REPLIED" as const,stage:null,recorded_at:"2026-09-21T15:00:00Z"};
    const book={...s1,id:"booking",event_type:"BOOKED" as const,stage:null,recorded_at:"2026-09-22T15:00:00Z"};
    expect(buildCrmJourney(base,[s1,reply],"OPT_IN",[s1,reply],at).status).toBe("REPLIED");
    expect(buildCrmJourney(base,[s1,reply,book],"OPT_IN",[s1,reply,book],at).status).toBe("BOOKED");
  });
  it("WhatsApp por etapa no afirma kilómetros actuales ni inventa descuentos",()=>{
    const journey=buildCrmJourney(base,[],"OPT_IN",[],at);
    const msg=makeCrmMessage(base,journey);
    expect(msg).toContain("María");
    expect(msg).toContain("Ford Fiesta");
    expect(msg).toContain("AB123CD");
    expect(msg).toContain("cambios anteriores de este mismo carro");
    expect(msg).toContain("confirmas cuánto marca hoy");
    expect(msg).toContain("no te enviemos estos recordatorios");
    expect(msg).not.toMatch(/ya tienes 110\.000 km|llegó a 110000|urgente|debes venir hoy|descuento/i);
    const recovering={...base,next_service_date:"2026-08-01",due_reason:"CALENDAR_LIMIT" as const};
    expect(makeCrmMessage(recovering,buildCrmJourney(recovering,[],"OPT_IN",[],at)))
      .toContain("Hace un buen tiempo");
    expect(makeCrmMessage(base,{...journey,contactCount:2})).toContain("No queremos llenarte de mensajes");
  });
  it("abrir WhatsApp es distinto a confirmar el envío",()=>{
    const ui=readFileSync("components/maintenance-journey-screen.tsx","utf8");
    expect(ui).toContain("setOpened(prev=>");
    expect(ui).toContain('!opened[r.service_record_id]');
    expect(ui).toContain("p_event_type:eventType");
    expect(ui).toContain("set_crm_contact_permission");
    expect(ui).toContain("record_crm_maintenance_activity");
    expect(ui).toContain("REACTIVATED");
    const reminders=readFileSync("app/reminders/page.tsx","utf8");
    expect(reminders).toContain("<MaintenanceJourneyScreen");
    expect(reminders).toContain("visibleFollowups.map");
  });
});

import { describe,it,expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const uid=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");

describe("CRM trazabilidad y frecuencia PostgreSQL",()=>{
  it("aplica permisos reales, bloquea duplicados y contactos simultáneos entre carros",async()=>{
    const db=new PGlite();
    try {
      const schema=[
        "CREATE ROLE authenticated;",
        "CREATE ROLE anon;",
        "CREATE SCHEMA auth;",
        "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000009'::uuid $$;",
        "CREATE FUNCTION public.require_auth() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;",
        "CREATE TABLE public.customers(id uuid PRIMARY KEY);",
        "CREATE TABLE public.vehicles(id uuid PRIMARY KEY,customer_id uuid REFERENCES customers(id));",
        "CREATE TABLE public.orders(id uuid PRIMARY KEY,status text);",
        "CREATE TABLE public.service_records(id uuid PRIMARY KEY,vehicle_id uuid REFERENCES vehicles(id),customer_id uuid REFERENCES customers(id),service_type text,performed_at timestamptz,created_at timestamptz DEFAULT now(),order_id uuid);",
        "CREATE TABLE public.maintenance_reminder_actions(service_record_id uuid PRIMARY KEY,status text,snoozed_until date,sent_at timestamptz);",
        "CREATE FUNCTION public.set_maintenance_reminder_status(p_service_record_id uuid,p_status text,p_snoozed_until date DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN INSERT INTO public.maintenance_reminder_actions VALUES(p_service_record_id,p_status,p_snoozed_until,now()) ON CONFLICT(service_record_id) DO UPDATE SET status=excluded.status,snoozed_until=excluded.snoozed_until,sent_at=excluded.sent_at; END; $fn$;",
        "CREATE VIEW public.maintenance_reminders_current AS SELECT s.id service_record_id,s.vehicle_id,v.customer_id,coalesce(a.status,'PENDING') reminder_status,a.snoozed_until,(now() AT TIME ZONE 'America/Caracas')::date next_service_date FROM public.service_records s JOIN public.vehicles v ON v.id=s.vehicle_id LEFT JOIN public.maintenance_reminder_actions a ON a.service_record_id=s.id;"
      ].join("\n");
      await db.exec(schema);
      await db.query("INSERT INTO customers VALUES ($1),($2)",[uid(1),uid(2)]);
      await db.query("INSERT INTO vehicles VALUES ($1,$3),($2,$3)",[uid(101),uid(102),uid(1)]);
      await db.query("INSERT INTO service_records(id,vehicle_id,customer_id,service_type,performed_at) VALUES ($1,$3,$5,'OIL_CHANGE',now()),($2,$4,$5,'OIL_CHANGE',now())",
        [uid(201),uid(202),uid(101),uid(102),uid(1)]);
      const sql=readFileSync("supabase/migrations/20261009_crm_retention_contact_journeys.sql","utf8");
      await db.exec(sql);
      const params=[uid(201),"SENT","DUE","Hola, te ayudamos con el mantenimiento del carro"];
      await expect(db.query("SELECT record_crm_maintenance_activity($1,$2,$3,$4)",params))
        .rejects.toThrow(/autorización/);
      await expect(db.query("SELECT set_crm_contact_permission($1,$2,$3)",[uid(1),"OPT_IN",""]))
        .rejects.toThrow(/Indica dónde/);
      await db.query("SELECT set_crm_contact_permission($1,$2,$3)",[uid(1),"OPT_IN","Autorizó en el mostrador"]);
      await db.query("SELECT record_crm_maintenance_activity($1,$2,$3,$4)",params);
      await expect(db.query("SELECT record_crm_maintenance_activity($1,$2,$3,$4)",params))
        .rejects.toThrow(/misma etapa/);
      await expect(db.query("SELECT record_crm_maintenance_activity($1,$2,$3,$4)",
        [uid(202),"SENT","DUE","Hola, te ayudamos con el mantenimiento del carro"]))
        .rejects.toThrow(/catorce días/);
      const sent=await db.query<{n:number}>("SELECT count(*)::int n FROM crm_maintenance_events WHERE event_type='SENT'");
      expect(sent.rows[0].n).toBe(1);
      await db.query("SELECT set_crm_contact_permission($1,$2,$3)",[uid(1),"OPT_OUT","No enviar mensajes"]);
      await expect(db.query("SELECT record_crm_maintenance_activity($1,$2,$3,$4)",
        [uid(202),"SENT","DUE","Hola, te ayudamos con el mantenimiento del carro"]))
        .rejects.toThrow(/autorización/);
      await db.query("SELECT record_crm_maintenance_activity($1,$2)",[uid(201),"REPLIED"]);
      const reply=await db.query<{n:number}>("SELECT count(*)::int n FROM crm_maintenance_events WHERE event_type='REPLIED'");
      expect(reply.rows[0].n).toBe(1);
      expect(sql).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:public\.)?(?:orders|payments|inventory_movements|customers|vehicles)\b/i);
    }finally{await db.close();}
  },30000);
});

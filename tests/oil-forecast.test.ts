import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  canMentionUsageForecast, confidenceForForecast,
  forecastConfidenceLabel, forecastMethodNote, forecastReasonLabel,
  type VehicleOilForecast
} from "../lib/oil-forecast";

const u=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const schema=`
CREATE TABLE orders(id uuid PRIMARY KEY,status text);
CREATE TABLE customers(id uuid PRIMARY KEY,name text,phone text);
CREATE TABLE vehicles(id uuid PRIMARY KEY,customer_id uuid,plate text,make text,model text,year int,current_odometer int);
CREATE TABLE service_records(
 id uuid PRIMARY KEY,vehicle_id uuid,customer_id uuid,performed_at timestamptz,
 created_at timestamptz DEFAULT now(),service_type text,odometer int,
 next_service_date date,next_service_odometer int,oil_brand text,oil_viscosity text,oil_filter_code text,
 order_id uuid
);
CREATE TABLE app_settings(key text PRIMARY KEY,value jsonb);
CREATE TABLE maintenance_reminder_actions(
 service_record_id uuid PRIMARY KEY,status text,snoozed_until date,sent_at timestamptz
);
`;

describe("Predicción matemática por vehículo",()=>{
  it("usa Theil-Sen, no mezcla vehículos y conserva calendario con pocos datos",async()=>{
    const pg=new PGlite();
    try {
      await pg.exec(schema);
      await pg.query(`INSERT INTO customers VALUES ($1,'Cliente A','584120000000'),($2,'Dueño anterior',null)`,[u(1),u(2)]);
      await pg.query(`INSERT INTO vehicles VALUES
        ($1,$3,'AA111AA','Ford','Fiesta',2010,15000),
        ($2,$3,'BB222BB','Toyota','Corolla',2012,80000),
        ($4,$3,'CC333CC','Chevrolet','Aveo',2014,40000)`,
        [u(101),u(102),u(1),u(103)]);
      await pg.query(`INSERT INTO app_settings VALUES ('crm_operational_start_date','"2025-01-01"'::jsonb)`);
      await pg.query(`INSERT INTO service_records(
        id,vehicle_id,customer_id,performed_at,service_type,odometer,next_service_date,next_service_odometer
      ) VALUES
        ($1,$5,$8,'2026-01-01T16:00:00Z','OIL_CHANGE',10000,'2026-04-01',15000),
        ($2,$5,$8,'2026-02-01T16:00:00Z','OIL_CHANGE',15000,'2026-05-02',20000),
        ($3,$6,$8,'2026-02-01T16:00:00Z','OIL_CHANGE',80000,'2026-05-02',85000),
        ($4,$7,$9,'2026-01-01T16:00:00Z','OIL_CHANGE',35000,'2026-04-01',40000),
        ($10,$7,$8,'2026-02-01T16:00:00Z','OIL_CHANGE',40000,'2026-05-02',45000)`,
        [u(201),u(202),u(203),u(204),u(101),u(102),u(103),u(1),u(2),u(205)]);
      const migration=readFileSync("supabase/migrations/20261009_vehicle_oil_usage_forecasts.sql","utf8");
      await pg.exec(migration);
      const a=await pg.query<Record<string,unknown>>("SELECT * FROM vehicle_oil_usage_forecasts WHERE vehicle_id=$1",[u(101)]);
      expect(a.rows).toHaveLength(1);
      const forecast=a.rows[0];
      expect(forecast.service_count).toBe(2);
      expect(forecast.mileage_points).toBe(2);
      expect(forecast.slope_pairs).toBe(1);
      expect(Number(forecast.km_per_day)).toBeGreaterThan(150);
      expect(Number(forecast.km_per_day)).toBeLessThan(170);
      expect(forecast.confidence).toBe("LOW");
      expect(forecast.due_reason).toBe("KM_USAGE");
      expect(new Date(forecast.projected_km_due_date as string).toISOString().slice(0,10)).toBe("2026-03-04");
      const b=await pg.query<Record<string,unknown>>("SELECT * FROM vehicle_oil_usage_forecasts WHERE vehicle_id=$1",[u(102)]);
      expect(b.rows[0].confidence).toBe("INSUFFICIENT");
      expect(b.rows[0].km_per_day).toBeNull();
      expect(b.rows[0].due_reason).toBe("CALENDAR_LIMIT");
      const c=await pg.query<Record<string,unknown>>("SELECT * FROM vehicle_oil_usage_forecasts WHERE vehicle_id=$1",[u(103)]);
      expect(c.rows[0].service_count).toBe(1); // Dueño anterior NO cuenta.
      expect(c.rows[0].confidence).toBe("INSUFFICIENT");
      const reminders=await pg.query<Record<string,unknown>>("SELECT vehicle_id,customer_id,forecast_confidence,next_service_date FROM maintenance_reminders_current WHERE vehicle_id=$1",[u(101)]);
      expect(reminders.rows[0].customer_id).toBe(u(1));
      expect(reminders.rows[0].forecast_confidence).toBe("LOW");
      // La optimización NO puede cambiar destinatario, fecha, segmento ni estado.
      // El SQL antiguo y el nuevo deben devolver la misma información para todos los carros.
      const previous = await pg.query<Record<string,unknown>>(
        "SELECT vehicle_id,service_record_id,customer_id,next_service_date,reminder_status,urgency,forecast_confidence,due_reason FROM maintenance_reminders_current ORDER BY vehicle_id"
      );
      const optimize=readFileSync(
        "supabase/migrations/20261010_optimize_reminder_view.sql","utf8"
      );
      await pg.exec(optimize);
      const current = await pg.query<Record<string,unknown>>(
        "SELECT vehicle_id,service_record_id,customer_id,next_service_date,reminder_status,urgency,forecast_confidence,due_reason FROM maintenance_reminders_current ORDER BY vehicle_id"
      );
      expect(current.rows).toEqual(previous.rows);
      expect(current.rows).toHaveLength(3);
      const summary=await pg.query<{ urgency:string;n:number }>(
        "SELECT urgency, count(*)::int n FROM maintenance_reminders_current GROUP BY urgency ORDER BY urgency"
      );
      expect(summary.rows.reduce((sum,row)=>sum+row.n,0)).toBe(3);
    } finally {await pg.close();}
  },30000);

  it("distingue confianza cualitativa de falsa certeza",()=>{
    const f:VehicleOilForecast={service_count:2,mileage_points:2,slope_pairs:1,km_per_day:90,
      days_per_5000km:56,typical_visit_days:63,
      projected_km_due_date:"2026-12-01",projected_habit_due_date:null,
      calendar_due_date:"2027-01-01",confidence:"LOW",due_reason:"KM_USAGE"};
    expect(confidenceForForecast(f)).toBe("LOW");
    expect(canMentionUsageForecast(f)).toBe(true);
    expect(forecastConfidenceLabel("LOW")).toContain("preliminar");
    expect(forecastReasonLabel("VISIT_PATTERN")).toContain("frecuencia");
    expect(forecastMethodNote(f)).toContain("pocos cambios");
    expect(canMentionUsageForecast({...f,confidence:"INSUFFICIENT",km_per_day:null})).toBe(false);
  });
});

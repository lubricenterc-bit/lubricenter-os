import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';

let db:PGlite;
async function scalar(sql:string,args:unknown[]=[]):Promise<any>{
  const result=await db.query(sql,args);
  const row=result.rows[0] as Record<string,unknown>|undefined;
  return row?Object.values(row)[0]:null;
}
async function setupContact(){
  let location=await scalar("select id from locations where code='CABUDARE' limit 1");
  if(!location) location=await scalar("insert into locations(code,name,active) values('CABUDARE','Lubricenter Cabudare',true) returning id");
  const customer=await scalar("insert into customers(name,phone) values('Cliente campaña','584141234567') returning id");
  const vehicle=await scalar("insert into vehicles(customer_id,plate,make,model) values($1,'PROMO1','Chevrolet','Aveo') returning id",[customer]);
  const campaign=await scalar("select id from crm_campaigns where slug='aceite-inyectores-oct-2026'");
  const contact=await scalar(`
    insert into crm_campaign_contacts(
      campaign_id,customer_id,vehicle_id,name_snapshot,phone_snapshot,vehicle_snapshot,
      plate_snapshot,segment,priority,rank,reason,message_snapshot,status,sent_at
    ) values($1,$2,$3,'Cliente campaña','584141234567','Chevrolet Aveo','PROMO1',
      'reenganche',true,1,'Prueba','Mensaje','SENT','2026-10-07 10:00:00-04')
    returning id
  `,[campaign,customer,vehicle]);
  return {location,customer,vehicle,contact};
}
async function closedOrder(customer:string,vehicle:string,location:string){
  return scalar(`
    insert into orders(status,customer_id,vehicle_id,location_id,opened_at,closed_at,business_at)
    values('CLOSED',$1,$2,$3,'2026-10-07 11:59:00-04','2026-10-07 12:00:00-04','2026-10-07 12:00:00-04')
    returning id
  `,[customer,vehicle,location]);
}

beforeAll(async()=>{
  db=new PGlite();
  await db.exec(gunzipSync(readFileSync('tests/fixtures/production-structure.sql.gz')).toString());
  await db.exec(readFileSync('supabase/migrations/20261006203000_crm_campaigns.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261007143000_campaign_auto_conversion.sql','utf8'));
},120000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});

it('marks the campaign as converted when the exact promoted vehicle returns in Cabudare',async()=>{
  const x=await setupContact();
  const order=await closedOrder(x.customer,x.vehicle,x.location);
  await db.query(`
    insert into service_records(order_id,customer_id,vehicle_id,service_type,description,performed_at)
    values($1,$2,$3,'OIL_CHANGE','Cambio de aceite','2026-10-07 12:05:00-04')
  `,[order,x.customer,x.vehicle]);
  expect(await scalar('select status from crm_campaign_contacts where id=$1',[x.contact])).toBe('CONVERTED');
  expect(await scalar('select converted_order_id from crm_campaign_contacts where id=$1',[x.contact])).toBe(order);
});

it('does not count another vehicle from the same customer as campaign success',async()=>{
  const x=await setupContact();
  const other=await scalar("insert into vehicles(customer_id,plate,make,model) values($1,'OTHER1','Ford','Fiesta') returning id",[x.customer]);
  const order=await closedOrder(x.customer,other,x.location);
  await db.query(`
    insert into service_records(order_id,customer_id,vehicle_id,service_type,description,performed_at)
    values($1,$2,$3,'OIL_CHANGE','Cambio de aceite','2026-10-07 12:05:00-04')
  `,[order,x.customer,other]);
  expect(await scalar('select status from crm_campaign_contacts where id=$1',[x.contact])).toBe('SENT');
});

it('does not treat a paper or legacy import as a campaign conversion',async()=>{
  const x=await setupContact();
  await db.query(`
    insert into service_records(customer_id,vehicle_id,service_type,description,performed_at,source_system,imported_at)
    values($1,$2,'OIL_CHANGE','Registro histórico','2026-10-07 12:05:00-04','PAPER_ARCHIVE',now())
  `,[x.customer,x.vehicle]);
  expect(await scalar('select status from crm_campaign_contacts where id=$1',[x.contact])).toBe('SENT');
});

it('does not attribute a return after the campaign window closes',async()=>{
  const x=await setupContact();
  const order=await closedOrder(x.customer,x.vehicle,x.location);
  await db.query(`
    insert into service_records(order_id,customer_id,vehicle_id,service_type,description,performed_at)
    values($1,$2,$3,'OIL_CHANGE','Cambio de aceite','2026-10-11 09:00:00-04')
  `,[order,x.customer,x.vehicle]);
  expect(await scalar('select status from crm_campaign_contacts where id=$1',[x.contact])).toBe('SENT');
});
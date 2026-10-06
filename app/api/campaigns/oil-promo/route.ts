import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {selectContacts, type Customer, type Vehicle, type Service, type Visit} from '../../../../lib/campaign/oil-promo';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const CAMPAIGN_SLUG='aceite-inyectores-oct-2026';
const privateHeaders={'Cache-Control':'private, no-store, max-age=0','Vary':'Authorization','X-Robots-Tag':'noindex, nofollow'};
const allowedStatuses=['PENDING','SENT','RESPONDED','SCHEDULED','VISITED','CONVERTED','NOT_INTERESTED'] as const;
type CampaignStatus=(typeof allowedStatuses)[number];
type StoredContact={
  id:string; campaign_id:string; customer_id:string; vehicle_id:string|null;
  name_snapshot:string; phone_snapshot:string; vehicle_snapshot:string; plate_snapshot:string|null;
  segment:string; priority:boolean; rank:number; reason:string; message_snapshot:string;
  status:CampaignStatus; sent_at:string|null; responded_at:string|null; scheduled_for:string|null;
  visited_at:string|null; converted_at:string|null; converted_order_id:string|null; outcome_note:string|null;
};
function reply(body:unknown,status=200){return Response.json(body,{status,headers:privateHeaders});}
async function readAll<T>(client:SupabaseClient,table:string,columns:string,closed=false):Promise<T[]> {
  const rows:T[]=[];
  for(let offset=0;offset<20000;offset+=500){
    let query=client.from(table).select(columns).order('id').range(offset,offset+499);
    if(closed)query=query.eq('status','CLOSED');
    const {data,error}=await query;
    if(error)throw new Error('No se pudo consultar el historial');
    rows.push(...(data||[]) as unknown as T[]);
    if(!data||data.length<500)return rows;
  }
  throw new Error('El historial supera el límite de esta consulta');
}
async function authorizedClient(request:Request){
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token)return {error:reply({error:'Inicia sesión para ver campañas.'},401)};
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key)return {error:reply({error:'La conexión no está disponible.'},503)};
  const client=createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await client.auth.getUser(token);
  if(auth.error||!auth.data.user)return {error:reply({error:'Tu sesión venció. Inicia sesión nuevamente.'},401)};
  const role=await client.rpc('finance_role');
  if(role.error||!['OWNER','ADMIN'].includes(role.data))return {error:reply({error:'Campañas requiere una cuenta de dueño o administrador.'},403)};
  return {client,userId:auth.data.user.id};
}
async function campaign(client:SupabaseClient){
  const {data,error}=await client.from('crm_campaigns').select('*').eq('slug',CAMPAIGN_SLUG).single();
  if(error||!data)throw new Error('La campaña no está configurada');
  return data;
}
export async function GET(request:Request) {
  try{
    const auth=await authorizedClient(request);if(auth.error)return auth.error;
    const {client,userId}=auth;
    const current=await campaign(client);
    const [customers,vehicles,services,visits]=await Promise.all([
      readAll<Customer>(client,'customers','id,name,phone'),
      readAll<Vehicle>(client,'vehicles','id,customer_id,make,model,year,plate'),
      readAll<Service>(client,'service_records','id,vehicle_id,performed_at,service_type,description,service_notes,oil_brand,oil_viscosity,next_service_date'),
      readAll<Visit>(client,'orders','id,vehicle_id,business_at,closed_at,opened_at',true)
    ]);
    const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const selected=selectContacts(customers,vehicles,services,visits,asOf);
    const {data:existing,error:existingError}=await client.from('crm_campaign_contacts').select('*').eq('campaign_id',current.id);
    if(existingError)throw existingError;
    const known=new Set((existing||[]).map((row:any)=>row.customer_id));
    const missing=selected.flatMap((c,index)=>known.has(c.customerId)?[]:[{
      campaign_id:current.id,customer_id:c.customerId,vehicle_id:c.vehicleId,
      name_snapshot:c.name,phone_snapshot:c.phone,vehicle_snapshot:c.vehicle,plate_snapshot:c.plate,
      segment:c.kind,priority:c.first,rank:index+1,reason:c.reason,message_snapshot:c.message,status:'PENDING'
    }]);
    if(missing.length){
      const {error}=await client.from('crm_campaign_contacts').insert(missing);
      if(error)throw error;
    }
    const {data:rows,error:rowsError}=await client.from('crm_campaign_contacts').select('*').eq('campaign_id',current.id).order('rank',{ascending:true});
    if(rowsError)throw rowsError;
    const contacts=(rows as StoredContact[]||[]).map(c=>({
      id:c.id,customerId:c.customer_id,vehicleId:c.vehicle_id,name:c.name_snapshot,phone:c.phone_snapshot,
      vehicle:c.vehicle_snapshot,plate:c.plate_snapshot,kind:c.segment,first:c.priority,reason:c.reason,
      message:c.message_snapshot,url:`https://wa.me/${c.phone_snapshot}?text=${encodeURIComponent(c.message_snapshot)}`,
      status:c.status,sentAt:c.sent_at,respondedAt:c.responded_at,scheduledFor:c.scheduled_for,
      visitedAt:c.visited_at,convertedAt:c.converted_at,convertedOrderId:c.converted_order_id,note:c.outcome_note
    }));
    return reply({campaign:current,contacts,asOf,userId});
  }catch(error){
    console.error('campaign GET failed',error);
    return reply({error:'No se pudo cargar la campaña completa. Intenta nuevamente.'},503);
  }
}
export async function PATCH(request:Request){
  try{
    const auth=await authorizedClient(request);if(auth.error)return auth.error;
    const {client,userId}=auth;
    const body=await request.json().catch(()=>null) as {contactId?:string;status?:string;scheduledFor?:string|null;note?:string|null;convertedOrderId?:string|null}|null;
    if(!body?.contactId||!body.status||!allowedStatuses.includes(body.status as CampaignStatus))return reply({error:'Estado de campaña inválido.'},400);
    const current=await campaign(client);
    const now=new Date().toISOString();
    const status=body.status as CampaignStatus;
    const patch:Record<string,unknown>={status,outcome_note:body.note?.trim()||null,last_action_by:userId,updated_at:now};
    if(status==='SENT')patch.sent_at=now;
    if(status==='RESPONDED')patch.responded_at=now;
    if(status==='SCHEDULED'){patch.responded_at=now;patch.scheduled_for=body.scheduledFor||null;}
    if(status==='VISITED')patch.visited_at=now;
    if(status==='CONVERTED'){patch.visited_at=now;patch.converted_at=now;patch.converted_order_id=body.convertedOrderId||null;}
    const {data,error}=await client.from('crm_campaign_contacts').update(patch).eq('id',body.contactId).eq('campaign_id',current.id).select('*').single();
    if(error)throw error;
    return reply({ok:true,contact:data});
  }catch(error){
    console.error('campaign PATCH failed',error);
    return reply({error:'No se pudo guardar el estado de la campaña.'},503);
  }
}

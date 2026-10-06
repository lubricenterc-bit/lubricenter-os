import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {selectContacts, type Customer, type Vehicle, type Service, type Visit} from '../../../../lib/campaign/oil-promo';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const privateHeaders={'Cache-Control':'private, no-store, max-age=0','Vary':'Authorization','X-Robots-Tag':'noindex, nofollow'};
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
export async function GET(request:Request) {
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token)return reply({error:'Inicia sesión para ver los clientes.'},401);
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key)return reply({error:'La conexión no está disponible.'},503);
  try{
    const client=createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
    const auth=await client.auth.getUser(token);
    if(auth.error||!auth.data.user)return reply({error:'Tu sesión venció. Inicia sesión nuevamente.'},401);
    const role=await client.rpc('finance_role');
    if(role.error||!['OWNER','ADMIN'].includes(role.data))return reply({error:'Esta lista necesita una cuenta de dueño o administrador.'},403);
    const [customers,vehicles,services,visits]=await Promise.all([
      readAll<Customer>(client,'customers','id,name,phone'),
      readAll<Vehicle>(client,'vehicles','id,customer_id,make,model,year,plate'),
      readAll<Service>(client,'service_records','id,vehicle_id,performed_at,service_type,description,service_notes,oil_brand,oil_viscosity,next_service_date'),
      readAll<Visit>(client,'orders','id,vehicle_id,business_at,closed_at,opened_at',true)
    ]);
    const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return reply({contacts:selectContacts(customers,vehicles,services,visits,asOf),asOf,userId:auth.data.user.id});
  }catch{return reply({error:'No se pudo cargar la lista completa. Intenta nuevamente.'},503);}
}

import {timingSafeEqual} from 'node:crypto';
import {pushAdmin,pushConfigured,sendPush} from '@/lib/finance/push-server';
import {digestMessage,type Digest} from '@/lib/finance/push';
export const runtime='nodejs';
export async function POST(request:Request){
 const secret=process.env.FINANCE_JOB_SECRET||'';
 const incoming=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 const expected=Buffer.from(secret),provided=Buffer.from(incoming);
 if(secret.length<32||provided.length!==expected.length||!timingSafeEqual(expected,provided))return Response.json({error:'No autorizado'},{status:401});
 if(!pushConfigured())return Response.json({error:'Servicio de avisos incompleto'},{status:503});
 const db=pushAdmin();
 const run=await db.from('finance_job_runs').insert({status:'RUNNING'}).select('id').single();
 if(run.error)return Response.json({error:'No se pudo registrar la ejecución'},{status:503});
 let sent=0,failed=0;
 try{
  const refresh=await db.rpc('finance_push_refresh');if(refresh.error)throw refresh.error;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas'}).format(new Date());
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Caracas',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  // Reconcile every execution; summarize once a day after 18:00 Caracas.
  if(hour>=18){
   let offset=0;const digests=new Map<string,Digest>();
   while(true){
    const r=await db.from('finance_push_subscriptions').select('id,user_id,endpoint,p256dh,auth').eq('active',true).order('id').range(offset,offset+49);
    if(r.error)throw r.error;
    for(const s of r.data??[]){
     if(!digests.has(s.user_id)){const d=await db.rpc('finance_push_digest',{p_user:s.user_id});if(d.error)throw d.error;digests.set(s.user_id,d.data as Digest);}
     const body=digestMessage(digests.get(s.user_id)!);if(!body)continue;
     const claim=await db.rpc('finance_push_claim',{p_subscription:s.id,p_day:date});if(claim.error)throw claim.error;if(!claim.data)continue;
     try{
      await sendPush(s,body);
      const done=await db.from('finance_push_deliveries').update({status:'SENT',updated_at:new Date().toISOString()}).eq('subscription_id',s.id).eq('business_date',date);if(done.error)throw done.error;sent++;
     }catch(e){
      failed++;const status=(e as {statusCode?:number}).statusCode;
      if(status===404||status===410){const off=await db.from('finance_push_subscriptions').update({active:false}).eq('id',s.id);if(off.error)throw off.error;}
      const fail=await db.from('finance_push_deliveries').update({status:'FAILED',error:status?`Push HTTP ${status}`:'No aceptado por el servicio push',updated_at:new Date().toISOString()}).eq('subscription_id',s.id).eq('business_date',date);if(fail.error)throw fail.error;
     }
    }
    if((r.data?.length??0)<50)break;offset+=50;
   }
  }
  const finish=await db.from('finance_job_runs').update({status:failed?'PARTIAL':'SUCCESS',finished_at:new Date().toISOString(),sent,failed}).eq('id',run.data.id);if(finish.error)throw finish.error;
  return Response.json({ok:failed===0,sent,failed});
 }catch{
  await db.from('finance_job_runs').update({status:'FAILED',finished_at:new Date().toISOString(),sent,failed,error:'Error de consulta o envío; revisar logs del servidor'}).eq('id',run.data.id);
  return Response.json({error:'Falló la revisión automática; no se certificó conciliación.'},{status:503});
 }
}

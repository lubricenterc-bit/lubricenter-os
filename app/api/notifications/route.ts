import {pushConfigured,pushUser,sendPush} from '@/lib/finance/push-server';
export const runtime='nodejs';
export async function GET(request:Request){
 const actor=await pushUser(request);if(!actor)return Response.json({error:'Inicia sesión'},{status:401});
 return Response.json({configured:pushConfigured(),publicKey:process.env.WEB_PUSH_PUBLIC_KEY||null});
}
export async function POST(request:Request){
 const actor=await pushUser(request);if(!actor)return Response.json({error:'Inicia sesión'},{status:401});
 if(!pushConfigured())return Response.json({error:'Falta activar el servicio de avisos en el servidor.'},{status:503});
 // Browser is only allowed to test one of its own saved subscriptions.
 const input=await request.json().catch(()=>null);
 if(typeof input?.endpoint!=='string')return Response.json({error:'Suscripción inválida'},{status:400});
 const r=await actor.client.from('finance_push_subscriptions').select('endpoint,p256dh,auth').eq('user_id',actor.user.id).eq('endpoint',input.endpoint).eq('active',true).maybeSingle();
 if(r.error||!r.data)return Response.json({error:'Activa los avisos en este teléfono primero.'},{status:400});
 try{await sendPush(r.data,'Prueba recibida. Los avisos diarios te llevarán a los pendientes.');return Response.json({accepted:true,message:'Enviado al servicio push; confirma que apareció en tu teléfono.'});}catch{return Response.json({error:'El servicio push no aceptó la prueba; revisa la configuración.'},{status:502});}
}

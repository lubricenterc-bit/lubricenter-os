import {createClient} from '@supabase/supabase-js';
import webpush from 'web-push';
import {allowedPushEndpoint} from './push';
export function pushConfigured(){return !!(process.env.SUPABASE_SERVICE_ROLE_KEY&&process.env.WEB_PUSH_PUBLIC_KEY&&process.env.WEB_PUSH_PRIVATE_KEY&&process.env.WEB_PUSH_SUBJECT&&process.env.FINANCE_JOB_SECRET);}
export function pushAdmin(){return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});}
export async function pushUser(request:Request){
 const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
 if(!token)return null;
 const client=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await client.auth.getUser(token);
 return !error&&data.user?{user:data.user,client}:null;
}
export async function sendPush(s:{endpoint:string;p256dh:string;auth:string},body:string,url='/finance/inbox'){
 if(!allowedPushEndpoint(s.endpoint))throw new Error('Proveedor push no permitido');
 return webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify({title:'Lubricenter · pendientes',body,url}),{TTL:3600,timeout:8000,vapidDetails:{subject:process.env.WEB_PUSH_SUBJECT!,publicKey:process.env.WEB_PUSH_PUBLIC_KEY!,privateKey:process.env.WEB_PUSH_PRIVATE_KEY!}});
}

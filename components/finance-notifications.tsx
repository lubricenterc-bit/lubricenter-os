'use client';
import {useEffect,useState} from 'react';
import {supabase} from '@/lib/supabase';
export function FinanceNotifications(){
 const [configured,setConfigured]=useState(false),[key,setKey]=useState(''),[supported,setSupported]=useState(false),[active,setActive]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[job,setJob]=useState<{status:string;started_at:string;finished_at:string|null}|null>(null);
 async function api(method='GET',body?:unknown){const s=await supabase.auth.getSession();const r=await fetch('/api/notifications',{method,headers:{Authorization:`Bearer ${s.data.session?.access_token||''}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw new Error(d.error);return d;}
 useEffect(()=>{
  setSupported('serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window);
  api().then(d=>{setConfigured(d.configured);setKey(d.publicKey||'');}).catch(e=>setMessage(e.message));
  if('serviceWorker' in navigator)navigator.serviceWorker.getRegistration('/').then(async r=>{const sub=await r?.pushManager.getSubscription();if(!sub)return;const stored=await supabase.from('finance_push_subscriptions').select('id').eq('endpoint',sub.endpoint).eq('active',true).maybeSingle();if(!stored.error)setActive(!!stored.data);});
  supabase.from('finance_job_runs').select('status,started_at,finished_at').order('started_at',{ascending:false}).limit(1).maybeSingle().then(r=>{if(!r.error)setJob(r.data);});
 },[]);
 async function enable(){setBusy(true);setMessage('');try{
  const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('El teléfono no autorizó los avisos. Actívalos desde su configuración.');
  const reg=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/'));const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
  const json=sub.toJSON();const user=await supabase.auth.getUser();if(!user.data.user)throw new Error('Inicia sesión');
  const r=await supabase.from('finance_push_subscriptions').upsert({user_id:user.data.user.id,endpoint:sub.endpoint,p256dh:json.keys?.p256dh,auth:json.keys?.auth,active:true},{onConflict:'endpoint'});if(r.error)throw r.error;
  setActive(true);setMessage('Este teléfono está registrado. Envía una prueba para confirmar la recepción.');
 }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 async function test(){setBusy(true);try{const reg=await navigator.serviceWorker.getRegistration('/');const sub=await reg?.pushManager.getSubscription();if(!sub)throw new Error('Primero activa los avisos');const d=await api('POST',{endpoint:sub.endpoint});setMessage(d.message);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 async function disable(){setBusy(true);try{const reg=await navigator.serviceWorker.getRegistration('/');const sub=await reg?.pushManager.getSubscription();if(sub){const r=await supabase.from('finance_push_subscriptions').delete().eq('endpoint',sub.endpoint);if(r.error)throw r.error;await sub.unsubscribe();}setActive(false);setMessage('Avisos desactivados en este teléfono.');}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 const stale=!job?.finished_at||Date.now()-Date.parse(job.finished_at)>45*60*1000;
 return <section className="card stack"><h2>Avisos al teléfono</h2><p>Resumen diario desde las 6:00 p. m.: caja, vueltos pendientes y, para administración, excepciones y reportes faltantes. Abre la app desde el aviso para resolverlos.</p>{!supported&&<p>Este navegador no ofrece notificaciones. En iPhone agrega la app a la pantalla de inicio y ábrela desde su icono.</p>}{!configured&&<div className="finance-warning">Falta configurar las claves y el programador del servidor. Los avisos aún no están activos.</div>}<p>Revisión automática: {job?`${job.status} · ${new Date(job.finished_at||job.started_at).toLocaleString('es-VE')}`:'Sin ejecución comprobada'}. {stale?'No se ha comprobado una ejecución reciente.':''}</p><div className="row"><button className="btn btn-primary" disabled={busy||!configured||!supported} onClick={enable}>{active?'Registrar nuevamente':'Activar en este teléfono'}</button>{active&&<><button className="btn" disabled={busy} onClick={test}>Enviar prueba</button><button className="btn" disabled={busy} onClick={disable}>Desactivar</button></>}</div>{message&&<p role="status">{message}</p>}</section>;
}

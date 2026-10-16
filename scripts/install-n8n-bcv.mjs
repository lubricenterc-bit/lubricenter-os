// Run only with authorized API access to the existing Taller Lubricenter instance.
// Secrets are supplied via environment variables and never printed or put in JSON files.
import {readFile} from "node:fs/promises";
const host = "https://mi-n8n-railway-production.up.railway.app";
const apiKey = process.env.N8N_API_KEY;
const jobSecret = process.env.BCV_OFFICIAL_JOB_SECRET;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!apiKey || !jobSecret || jobSecret.length < 33 || !anonKey) throw Error("Faltan credenciales de instalación; no se cambió n8n");
const workflow = JSON.parse(await readFile(new URL("../automations/n8n-bcv-official.json",import.meta.url),"utf8"));
async function api(path,method="GET",body) {
 const response=await fetch(`${host}/api/v1${path}`,{method,headers:{"X-N8N-API-KEY":apiKey,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw Error(`n8n API ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
 return data;
}
let cursor,existing;
do {
 const page=await api(`/workflows?limit=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
 existing=page.data.find(item=>item.name===workflow.name);
 cursor=page.nextCursor;
}while(cursor&&!existing);
if(existing) {
 console.log(JSON.stringify({installed:true,id:existing.id,active:existing.active,url:`${host}/workflow/${existing.id}`,message:"Se conserva el flujo existente; no se sobrescribió"}));
 process.exit(0);
}
const createdCredentials=[];
let installed;
try {
 const collector=await api('/credentials','POST',{name:"Lubricenter BCV · captador oficial",type:"httpCustomAuth",data:{json:JSON.stringify({headers:{Authorization:`Bearer ${anonKey}`,"x-lubricenter-job":jobSecret}})}});
 createdCredentials.push(collector.id);
 const webhook=await api('/credentials','POST',{name:"Lubricenter BCV · comprobación",type:"httpHeaderAuth",data:{name:"x-lubricenter-job",value:jobSecret}});
 createdCredentials.push(webhook.id);
 workflow.nodes.find(n=>n.id==='collect').credentials.httpCustomAuth.id=collector.id;
 workflow.nodes.find(n=>n.id==='webhook').credentials.httpHeaderAuth.id=webhook.id;
 installed=await api('/workflows','POST',workflow);
}catch(error) {
 for(const id of createdCredentials)await api(`/credentials/${id}`,'DELETE').catch(()=>{});
 throw error;
}
if(process.env.N8N_PUBLISH==='true') {
 await api(`/workflows/${installed.id}/activate`,'POST',{});
 const response=await fetch(`${host}/webhook/lubricenter-bcv-official-check`,{method:'POST',headers:{'x-lubricenter-job':jobSecret},signal:AbortSignal.timeout(180_000)});
 const result=await response.json().catch(()=>null);
 if(!response.ok||result?.ok!==true||result?.provider!=='BCV_OFFICIAL') {
  await api(`/workflows/${installed.id}/deactivate`,'POST',{});
  throw Error("La prueba de n8n no confirmó captura oficial; se dejó sin publicar");
 }
 const check=await api(`/workflows/${installed.id}`);
 if(check.active!==true)throw Error("n8n no confirmó el flujo publicado");
 console.log(JSON.stringify({installed:true,active:true,id:installed.id,url:`${host}/workflow/${installed.id}`,verifiedRate:result.usd_ves,valueDate:result.fecha_valor}));
}else console.log(JSON.stringify({installed:true,active:false,id:installed.id,url:`${host}/workflow/${installed.id}`}));

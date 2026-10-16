import {OFFICIAL_BCV_URL, parseOfficialBcv, readOfficialHtml} from "../_shared/bcv-official.ts";
import {SECTIGO_DV_R36} from "../_shared/bcv-tls-chain.ts";

const JSON_HEADERS = {"content-type":"application/json","cache-control":"no-store"};
async function rpc(name:string, body:Record<string,unknown>, key:string, url:string) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method:"POST", headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(()=>null);
  if (!response.ok) throw Error(`No se pudo registrar la captura BCV (${response.status})`);
  return payload;
}

Deno.serve(async request => {
  if (request.method !== "POST") return Response.json({ok:false,error:"Método no permitido"},{status:405,headers:JSON_HEADERS});
  const serverUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serverUrl || !serviceKey) return Response.json({ok:false,error:"Configuración incompleta"},{status:503,headers:JSON_HEADERS});
  let authorized = false;
  try {
    authorized = !!(await rpc("bcv_official_authorize", {p_secret:request.headers.get("x-lubricenter-job")??""}, serviceKey, serverUrl));
    if (!authorized) return Response.json({ok:false,error:"No autorizado"},{status:403,headers:JSON_HEADERS});
    // The official server omits its Sectigo intermediate. Supply the reviewed
    // public intermediate; certificate, hostname and expiry validation stay on.
    const client = Deno.createHttpClient({caCerts:[SECTIGO_DV_R36]});
    let html: string;
    try {
      const response = await fetch(OFFICIAL_BCV_URL, {
        client,redirect:"error",headers:{Accept:"text/html","Cache-Control":"no-cache","User-Agent":"LubricenterOS-BCV/1.0"},
        signal:AbortSignal.timeout(20_000),
      });
      html = await readOfficialHtml(response);
    } finally { client.close(); }
    const publication = parseOfficialBcv(html);
    const result = await rpc("bcv_official_record", {p_value:publication.value,p_value_date:publication.valueDate,p_html:html}, serviceKey, serverUrl);
    return Response.json(result,{headers:JSON_HEADERS});
  } catch(error) {
    const detail = error instanceof Error ? error.message : "Fallo desconocido del captador oficial";
    if (authorized) await rpc("bcv_official_record_failure",{p_error:detail},serviceKey,serverUrl).catch(()=>{});
    console.error("bcv-rate-sync:",detail);
    return Response.json({ok:false,error:detail},{status:502,headers:JSON_HEADERS});
  }
});

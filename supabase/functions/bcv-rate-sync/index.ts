// BCV USD/VES ingest. Only a Supabase Cron request bearing the private Vault token
// may reach this function. Source publishes both capture time and Fecha Valor.
const SOURCE="https://bcv.today/api/v1/rate.json";
const JSON_HEADERS={"content-type":"application/json","cache-control":"no-store"};
async function rpc(name:string,body:Record<string,unknown>,key:string,url:string){
  const res=await fetch(url+"/rest/v1/rpc/"+name,{
    method:"POST",
    headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)
  });
  const payload=await res.json().catch(()=>null);
  if(!res.ok)throw Error("Fallo interno al comprobar o guardar publicación BCV ("+res.status+")");
  return payload;
}
Deno.serve(async request=>{
  if(request.method!=="POST")return Response.json({ok:false,error:"Método no permitido"},{status:405});
  const serverUrl=Deno.env.get("SUPABASE_URL");
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!serverUrl||!serviceKey)return Response.json({ok:false,error:"Configuración del servidor incompleta"},{status:503});
  try{
    const token=request.headers.get("x-lubricenter-job")??"";
    if(!(await rpc("bcv_authorize_job",{p_secret:token},serviceKey,serverUrl)))
      return Response.json({ok:false,error:"No autorizado"},{status:403});
    const res=await fetch(SOURCE,{
      headers:{"Accept":"application/json","Cache-Control":"no-cache"},
      signal:AbortSignal.timeout(15000),
    });
    if(!res.ok)throw Error("Proveedor BCV no disponible ("+res.status+")");
    const payload=await res.json();
    const usd=payload?.USD;
    const date=payload?.effective_date;
    const published=payload?.updated_at;
    if(typeof usd!=="number"||!Number.isFinite(usd)||usd<=0||usd>1000000||
       typeof date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(date)||
       typeof published!=="string"||!Number.isFinite(Date.parse(published)))
      throw Error("La API no incluye USD, Fecha Valor y fecha de publicación válidos");
    const result=await rpc("bcv_accept_publication",{
      p_value:usd,p_value_date:date,p_published_at:published,p_source_url:SOURCE
    },serviceKey,serverUrl);
    return Response.json({ok:true,provider:"BCV_TODAY",...result}, {headers:JSON_HEADERS});
  }catch(error){
    const detail=error instanceof Error?error.message:"Fallo desconocido";
    console.error("bcv-rate-sync:",detail);
    return Response.json({ok:false,error:detail},{status:502,headers:JSON_HEADERS});
  }
});

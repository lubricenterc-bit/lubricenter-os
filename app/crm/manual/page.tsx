"use client";
import Link from "next/link";
import {useEffect,useMemo,useRef,useState} from "react";
import {supabase} from "@/lib/supabase";

type CaseStatus="PENDING_SERVICE"|"SCHEDULED"|"COMPLETED"|"CANCELLED";
type Basis="UNVERIFIED"|"REPORTED_EXTERNALLY"|"ORDER_LINKED"|"NO_CHARGE";
type Case={id:string;vehicle_id:string;customer_id:string;payer_customer_id:string|null;linked_order_id:string|null;payment_context:Basis;payment_note:string|null;status:CaseStatus;scheduled_for:string|null;next_contact_on:string|null;notes:string|null;service_record_id:string|null;crm_message:string|null;crm_message_sent_at:string|null;version:number;updated_at:string};
type Car={id:string;customer_id:string|null;plate:string|null;make:string|null;model:string|null;current_odometer:number|null};
type Person={id:string;name:string|null;phone:string|null};
type Order={id:string;order_number:string;status:string;customer_id:string|null;total_ref:number};
type FormData={vehicle_id:string;payer_customer_id:string;linked_order_id:string;payment_context:Basis;payment_note:string;scheduled_for:string;next_contact_on:string;notes:string;order_number:string};
type Done={performed_at:string;odometer:string;oil_brand:string;oil_viscosity:string;oil_quantity_liters:string;oil_filter_code:string;next_service_odometer:string;next_service_date:string};
const defaultForm=():FormData=>({vehicle_id:"",payer_customer_id:"",linked_order_id:"",payment_context:"UNVERIFIED",payment_note:"",scheduled_for:"",next_contact_on:"",notes:"",order_number:""});
const defaultDone=():Done=>({performed_at:"",odometer:"",oil_brand:"",oil_viscosity:"",oil_quantity_liters:"",oil_filter_code:"",next_service_odometer:"",next_service_date:""});
const statuses:Record<CaseStatus,string>={PENDING_SERVICE:"Pendiente de realizar",SCHEDULED:"Agendado",COMPLETED:"Realizado",CANCELLED:"Anulado"};
const bases:Record<Basis,string>={UNVERIFIED:"Pago sin verificar / seguimiento",REPORTED_EXTERNALLY:"Pago reportado fuera del sistema",ORDER_LINKED:"Pago registrado en una orden anterior",NO_CHARGE:"Servicio sin cobro"};
const money=(n:number)=>Number(n).toFixed(2)+" REF";
function local(value:string|null){if(!value)return "";return new Intl.DateTimeFormat("sv-SE",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)).replace(" ","T");}
function instant(v:string){return v?new Date(v+":00-04:00").toISOString():null;}
const readDate=(v:string|null)=>v?v.slice(0,10):"";
export default function ManualCrmPage(){
 const [cases,setCases]=useState<Case[]>([]),[cars,setCars]=useState<Car[]>([]),[people,setPeople]=useState<Person[]>([]),[orders,setOrders]=useState<Order[]>([]);
 const [permissions,setPermissions]=useState<Record<string,string>>({});
 const [admin,setAdmin]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[editing,setEditing]=useState(false);
 const [chosen,setChosen]=useState<Case|null>(null),[form,setForm]=useState<FormData>(defaultForm());
 const [done,setDone]=useState<Done>(defaultDone()),[reason,setReason]=useState(""),[message,setMessage]=useState("");
 const [search,setSearch]=useState(""),[carSearch,setCarSearch]=useState(""),[payerSearch,setPayerSearch]=useState("");
 const [filter,setFilter]=useState<CaseStatus|"ALL">("ALL"),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const request=useRef<string|null>(null);
 const personById=useMemo(()=>new Map(people.map(p=>[p.id,p])),[people]);
 const carById=useMemo(()=>new Map(cars.map(v=>[v.id,v])),[cars]);
 const orderById=useMemo(()=>new Map(orders.map(o=>[o.id,o])),[orders]);
 const currentCar=carById.get(form.vehicle_id),payer=personById.get(form.payer_customer_id),owner=personById.get(currentCar?.customer_id||"");
 const order=orderById.get(form.linked_order_id);
 const visible=cases.filter(c=>{
  if(filter!=="ALL"&&c.status!==filter)return false;
  const v=carById.get(c.vehicle_id),p=personById.get(c.customer_id),pay=personById.get(c.payer_customer_id||"");
  return [v?.plate,v?.make,v?.model,p?.name,p?.phone,pay?.name,orderById.get(c.linked_order_id||"")?.order_number,c.notes]
   .join(" ").toLocaleLowerCase("es-VE").includes(search.toLocaleLowerCase("es-VE"));
 });
 const vehicleMatches=cars.filter(v=>v.customer_id&&[v.plate,v.make,v.model,personById.get(v.customer_id)?.name]
  .join(" ").toLocaleLowerCase("es-VE").includes(carSearch.toLocaleLowerCase("es-VE"))).slice(0,120);
 const payerMatches=people.filter(p=>[p.name,p.phone].join(" ").toLocaleLowerCase("es-VE").includes(payerSearch.toLocaleLowerCase("es-VE"))).slice(0,120);
 const crmMessage=message||chosen?.crm_message||("Hola "+(owner?.name||"cliente")+", en Lubricenter tenemos un cambio de aceite pendiente para "+[currentCar?.make,currentCar?.model,currentCar?.plate].filter(Boolean).join(" ")+". ¿Cuándo te gustaría coordinar la visita?");
 async function load(){
  const [a,v,p,o,roles,allow]=await Promise.all([
   supabase.from("crm_manual_cases").select("*").order("updated_at",{ascending:false}).limit(500),
   supabase.from("vehicles").select("id,customer_id,plate,make,model,current_odometer").order("updated_at",{ascending:false}).limit(2000),
   supabase.from("customers").select("id,name,phone").order("name").limit(2000),
   supabase.from("orders").select("id,order_number,status,customer_id,total_ref").eq("status","CLOSED").order("closed_at",{ascending:false}).limit(500),
   supabase.from("crm_contact_permissions").select("customer_id,status").limit(2000),
   supabase.rpc("can_administer_orders")
  ]);
  const err=a.error||v.error||p.error||o.error||allow.error;
  if(err)throw err;
  setCases((a.data||[]) as Case[]);setCars((v.data||[]) as Car[]);
  setPeople((p.data||[]) as Person[]);setOrders((o.data||[]) as Order[]);
  setAdmin(allow.data===true);
  if(!roles.error)setPermissions(Object.fromEntries((roles.data||[]).map(row=>[row.customer_id,row.status])));
 }
 useEffect(()=>{load().catch(e=>setError(e.message||String(e))).finally(()=>setLoading(false));},[]);
 function openNew(){
  request.current=crypto.randomUUID();setChosen(null);setForm(defaultForm());setDone(defaultDone());
  setEditing(true);setReason("");setMessage("");setError("");setNotice("");setCarSearch("");setPayerSearch("");
 }
 function openCase(c:Case){
  request.current=null;setChosen(c);setEditing(true);setDone(defaultDone());
  setForm({vehicle_id:c.vehicle_id,payer_customer_id:c.payer_customer_id||"",linked_order_id:c.linked_order_id||"",
   payment_context:c.payment_context,payment_note:c.payment_note||"",scheduled_for:local(c.scheduled_for),
   next_contact_on:readDate(c.next_contact_on),notes:c.notes||"",order_number:orderById.get(c.linked_order_id||"")?.order_number||""});
  setCarSearch("");setPayerSearch("");setReason("");setMessage(c.crm_message||"");setError("");setNotice("");
 }
 async function findOrder(){
  setError("");
  const query=form.order_number.trim().toUpperCase();
  if(!query){setForm(f=>({...f,linked_order_id:""}));return;}
  const r=await supabase.from("orders").select("id,order_number,status,customer_id,total_ref").eq("order_number",query).maybeSingle();
  if(r.error||!r.data||r.data.status!=="CLOSED"){setError(r.error?.message||"No se encontró una orden cerrada con ese número.");return;}
  const foundOrder=r.data as Order;
  setOrders(prev=>[foundOrder,...prev.filter(o=>o.id!==foundOrder.id)]);
  setForm(f=>({...f,linked_order_id:foundOrder.id,payer_customer_id:foundOrder.customer_id||""}));
  setNotice("Orden vinculada para referencia; no se cobra otra vez.");
 }
 async function save(){
  if(busy)return;
  if(!currentCar?.customer_id)return setError("Selecciona el vehículo con propietario.");
  if(form.payment_context==="ORDER_LINKED"&&!form.linked_order_id)return setError("Busca y selecciona la orden anterior.");
  setBusy(true);setError("");setNotice("");
  try{
   request.current??=crypto.randomUUID();
   const payload={...form,request_id:request.current,scheduled_for:instant(form.scheduled_for),
    payer_customer_id:form.payer_customer_id||null,linked_order_id:form.linked_order_id||null,next_contact_on:form.next_contact_on||null};
   const r=await supabase.rpc("crm_manual_case_save",{p_case_id:chosen?.id||null,p_payload:payload,
    p_expected_version:chosen?.version??null});
   if(r.error)throw r.error;
   await load();setEditing(false);setChosen(null);request.current=null;
   setNotice("Ficha guardada; no se añadió ningún ingreso ni se marcó el servicio como realizado.");
  }catch(e:any){setError(e.message||String(e));}finally{setBusy(false);}
 }
 async function transition(action:"COMPLETE"|"CANCEL"|"MARK_CONTACT_SENT"){
  if(!chosen||busy)return;
  setBusy(true);setError("");setNotice("");
  const payload=action==="COMPLETE"?{...done,performed_at:instant(done.performed_at)}:action==="CANCEL"?{reason}:{message:crmMessage};
  try{
   const r=await supabase.rpc("crm_manual_case_transition",{p_case_id:chosen.id,
     p_action:action,p_expected_version:chosen.version,p_payload:payload});
   if(r.error)throw r.error;
   await load();setEditing(false);setChosen(null);setMessage("");
   setNotice(action==="COMPLETE"?"Servicio registrado en historial y próximos recordatorios, sin cobrar otra vez.":
    action==="CANCEL"?"Ficha de CRM anulada. Los pagos existentes no se modificaron.":"Contacto real marcado como enviado.");
  }catch(e:any){setError(e.message||String(e));}finally{setBusy(false);}
 }
 async function copy(){
  try{await navigator.clipboard.writeText(crmMessage);setNotice("Texto copiado. Marca enviado solamente después de enviarlo realmente.");}
  catch{setError("No se pudo copiar automáticamente; selecciona el texto manualmente.");}
 }
 return <main className="container stack">
  <section className="brand-hero"><div><div className="eyebrow">CLIENTES · MANTENIMIENTOS PENDIENTES</div>
   <h1>CRM manual</h1><p>Servicios pagados previamente, pendientes o realizados. Independiente de caja y Cashea, con orden anterior opcional.</p></div>
   <img src="/lubricenter-logo.png" alt="Lubricenter"/></section>
  <div className="grid grid-3">
   <div className="card stack"><span className="muted small">Pendientes</span><strong>{cases.filter(c=>c.status==="PENDING_SERVICE").length}</strong></div>
   <div className="card stack"><span className="muted small">Agendados</span><strong>{cases.filter(c=>c.status==="SCHEDULED").length}</strong></div>
   <div className="card stack"><span className="muted small">Realizados</span><strong>{cases.filter(c=>c.status==="COMPLETED").length}</strong></div>
  </div>
  <section className="card stack">
   <div className="row-between"><div><h2 className="section-title">Fichas independientes</h2><div className="muted small">Ninguna ficha genera pagos ni órdenes.</div></div>
    {admin&&<button className="btn btn-primary" onClick={openNew}>+ Crear ficha CRM</button>}</div>
   <div className="grid grid-2"><input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar placa, cliente, orden…"/>
    <select className="select" value={filter} onChange={e=>setFilter(e.target.value as CaseStatus|"ALL")}>
     <option value="ALL">Todos los estados</option>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>
   {loading&&<p className="muted">Cargando fichas CRM…</p>}
   {visible.map(c=>{const v=carById.get(c.vehicle_id),client=personById.get(c.customer_id),pay=personById.get(c.payer_customer_id||"");
    return <div className="order-item row-between" key={c.id}><div><strong>{v?.plate||"Sin placa"} · {v?.make} {v?.model}</strong>
      <div className="muted small">{client?.name||"Sin nombre"} · {statuses[c.status]}</div>
      <div className="muted small">{bases[c.payment_context]} · {c.linked_order_id?orderById.get(c.linked_order_id)?.order_number||"Orden anterior":"Sin orden"}</div>
      <div className="muted small">{c.scheduled_for?"Cita: "+local(c.scheduled_for):"Sin cita"}{pay?" · Pagador: "+pay.name:""}</div>
     </div><button className="btn" onClick={()=>openCase(c)}>Ver ficha</button></div>})}
   {!loading&&visible.length===0&&<p className="muted">No hay fichas para estos filtros.</p>}
  </section>
  {error&&<div className="error" role="alert">{error}</div>}
  {notice&&<div className="success" role="status">{notice}</div>}
  {editing&&<section className="card stack">
   <div className="row-between"><h2 className="section-title">{chosen?"CRM · "+statuses[chosen.status]:"Nuevo CRM manual"}</h2>
    <button className="btn" onClick={()=>setEditing(false)}>Cerrar</button></div>
   <p className="muted small">«Pago reportado» no equivale a dinero conciliado. El servicio solo entra al historial cuando confirmes que se realizó.</p>
   <fieldset disabled={!admin||busy||chosen?.status==="COMPLETED"||chosen?.status==="CANCELLED"} className="stack" style={{border:0,padding:0}}>
    <h3>1. Vehículo y propietario</h3>
    <input className="input" placeholder="Buscar placa, modelo o propietario" value={carSearch} onChange={e=>setCarSearch(e.target.value)}/>
    <select className="select" value={form.vehicle_id} onChange={e=>setForm(f=>({...f,vehicle_id:e.target.value}))}>
     <option value="">Selecciona un vehículo *</option>
     {currentCar&&!vehicleMatches.some(v=>v.id===currentCar.id)&&<option value={currentCar.id}>{currentCar.plate} · {currentCar.make} {currentCar.model}</option>}
     {vehicleMatches.map(v=><option key={v.id} value={v.id}>{v.plate||"Sin placa"} · {v.make} {v.model} · {personById.get(v.customer_id||"")?.name||"Sin propietario"}</option>)}
    </select>
    <p className="muted small">El CRM corresponde a <strong>{owner?.name||"el propietario seleccionado"}</strong>, no necesariamente a quien pagó.</p>
    <h3>2. Pago y orden anterior (opcionales)</h3>
    <select className="select" value={form.payment_context} onChange={e=>setForm(f=>({...f,payment_context:e.target.value as Basis}))}>
     {Object.entries(bases).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
    <input className="input" value={payerSearch} onChange={e=>setPayerSearch(e.target.value)} placeholder="Buscar pagador, si fue otra persona"/>
    <select className="select" value={form.payer_customer_id} onChange={e=>setForm(f=>({...f,payer_customer_id:e.target.value}))}>
     <option value="">Pagador no especificado</option>
     {payer&&!payerMatches.some(p=>p.id===payer.id)&&<option value={payer.id}>{payer.name}</option>}
     {payerMatches.map(p=><option key={p.id} value={p.id}>{p.name||"Sin nombre"} {p.phone||""}</option>)}
    </select>
    <div className="row"><input className="input" value={form.order_number}
      onChange={e=>setForm(f=>({...f,order_number:e.target.value,linked_order_id:""}))} placeholder="Número de orden anterior, ej. OS-000214"/>
      <button className="btn" type="button" onClick={()=>void findOrder()}>Vincular</button>
      <button className="btn btn-ghost" type="button" onClick={()=>setForm(f=>({...f,order_number:"",linked_order_id:""}))}>Quitar</button></div>
    {order&&<p className="muted small">Orden relacionada: <Link href={"/orders/"+order.id}>{order.order_number}</Link> · {money(order.total_ref)}. No se genera otro ingreso.</p>}
    <textarea className="input" rows={2} value={form.payment_note} onChange={e=>setForm(f=>({...f,payment_note:e.target.value}))} placeholder="Referencia, evidencia o explicación (sin datos bancarios sensibles)"/>
    <h3>3. Agenda y observaciones</h3>
    <div className="grid grid-2">
     <label><span className="label">Fecha y hora prevista</span><input className="input" type="datetime-local" value={form.scheduled_for} onChange={e=>setForm(f=>({...f,scheduled_for:e.target.value}))}/></label>
     <label><span className="label">Próximo contacto</span><input className="input" type="date" value={form.next_contact_on} onChange={e=>setForm(f=>({...f,next_contact_on:e.target.value}))}/></label>
    </div>
    <textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Trabajo comprometido, instrucciones y notas"/>
    <button className="btn btn-primary" disabled={busy||!form.vehicle_id} onClick={()=>void save()}>{busy?"Guardando…":chosen?"Guardar ficha":"Crear pendiente sin venta"}</button>
   </fieldset>
   {chosen&&admin&&chosen.status!=="COMPLETED"&&chosen.status!=="CANCELLED"&&<div className="stack">
    <h3>4. Registrar servicio efectivamente realizado</h3>
    <p className="muted small">Solo aquí se crea el historial y se activan los recordatorios de mantenimiento. No se registran cobros adicionales.</p>
    <div className="grid grid-2">
     <label><span className="label">Fecha/hora real</span><input className="input" type="datetime-local" value={done.performed_at} onChange={e=>setDone(d=>({...d,performed_at:e.target.value}))}/></label>
     <label><span className="label">Kilometraje *</span><input className="input" type="number" value={done.odometer} onChange={e=>setDone(d=>({...d,odometer:e.target.value}))}/></label>
     <label><span className="label">Aceite usado *</span><input className="input" value={done.oil_brand} onChange={e=>setDone(d=>({...d,oil_brand:e.target.value}))}/></label>
     <label><span className="label">Viscosidad</span><input className="input" value={done.oil_viscosity} onChange={e=>setDone(d=>({...d,oil_viscosity:e.target.value}))}/></label>
     <label><span className="label">Litros</span><input className="input" type="number" step=".1" value={done.oil_quantity_liters} onChange={e=>setDone(d=>({...d,oil_quantity_liters:e.target.value}))}/></label>
     <label><span className="label">Filtro</span><input className="input" value={done.oil_filter_code} onChange={e=>setDone(d=>({...d,oil_filter_code:e.target.value}))}/></label>
     <label><span className="label">Próximo km</span><input className="input" type="number" value={done.next_service_odometer} onChange={e=>setDone(d=>({...d,next_service_odometer:e.target.value}))}/></label>
     <label><span className="label">Próxima fecha</span><input className="input" type="date" value={done.next_service_date} onChange={e=>setDone(d=>({...d,next_service_date:e.target.value}))}/></label>
    </div>
    <button className="btn btn-primary" disabled={busy||!done.odometer||!done.oil_brand||(!done.next_service_odometer&&!done.next_service_date)}
     onClick={()=>void transition("COMPLETE")}>Confirmar servicio y activar CRM de mantenimiento</button>
    <h3>Anular un pendiente sin modificar pagos</h3>
    <textarea className="input" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Motivo de anulación del CRM (no devuelve dinero)" rows={2}/>
    <button className="btn btn-ghost" disabled={busy||reason.trim().length<8} onClick={()=>void transition("CANCEL")}>Anular ficha</button>
   </div>}
   {chosen&&admin&&chosen.status!=="CANCELLED"&&<div className="stack">
    <h3>5. Contacto manual por WhatsApp</h3>
    <p className="muted small">Nunca se envía automáticamente. Respeta el consentimiento del propietario.</p>
    <textarea className="input" rows={4} value={message||crmMessage} onChange={e=>setMessage(e.target.value)}/>
    {permissions[chosen.customer_id]!=="OPT_IN"&&<p className="error">No hay consentimiento OPT_IN comprobado para este propietario.</p>}
    <div className="row">
     <button className="btn" disabled={permissions[chosen.customer_id]!=="OPT_IN"} onClick={()=>void copy()}>Copiar WhatsApp</button>
     <button className="btn btn-primary" disabled={busy||chosen.crm_message_sent_at!==null||permissions[chosen.customer_id]!=="OPT_IN"} onClick={()=>void transition("MARK_CONTACT_SENT")}>Marcar enviado</button>
    </div>
    {chosen.crm_message_sent_at&&<p className="muted small">Envío registrado: {local(chosen.crm_message_sent_at)}</p>}
   </div>}
  </section>}
  <p className="muted small">El CRM manual no sustituye a <Link href="/finance/reconcile">Conciliación financiera</Link>. Una referencia de orden solo sirve para relacionar registros.</p>
 </main>;
}

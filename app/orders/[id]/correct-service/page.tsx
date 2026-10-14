"use client";

import Link from "next/link";
import {useParams,useRouter} from "next/navigation";
import {useEffect,useMemo,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef,fmtVes} from "@/lib/format";

type Car={id:string;customer_id:string|null;plate:string|null;make:string|null;model:string|null;current_odometer:number|null};
type OilService={id:string;service_vehicle_id:string|null;service_odometer:number|null;oil_brand:string|null;oil_viscosity:string|null;oil_quantity_liters:number|null;oil_filter_code:string|null;next_service_odometer:number|null;next_service_date:string|null};
type Order={id:string;order_number:string;status:string;customer_id:string|null;vehicle_id:string|null;total_ref:number;total_ves:number};
const digits=(v:string)=>v===""?null:Number(v);
export default function CorrectServicePage(){
 const {id}=useParams<{id:string}(),router=useRouter();
 const [order,setOrder]=useState<Order|null>(null);
 const [cars,setCars]=useState<Car[]>([]);
 const [owners,setOwners]=useState<Record<string,string>>({});
 const [services,setServices]=useState<OilService[]>([]);
 const [serviceId,setServiceId]=useState("NEW");
 const [vehicleId,setVehicleId]=useState("");
 const [odometer,setOdometer]=useState("");
 const [brand,setBrand]=useState("");
 const [viscosity,setViscosity]=useState("");
 const [liters,setLiters]=useState("");
 const [filter,setFilter]=useState("");
 const [nextKm,setNextKm]=useState("");
 const [nextDate,setNextDate]=useState("");
 const [reason,setReason]=useState("");
 const [search,setSearch]=useState("");
 const [showAll,setShowAll]=useState(false);
 const [confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [paymentCount,setPaymentCount]=useState(0);
 const [casheaRef,setCasheaRef]=useState<string|null>(null);

 useEffect(()=>{let active=true;(async()=>{
  const permission=await supabase.rpc("can_administer_orders");
  if(permission.error||permission.data!==true)throw Error("Solo el administrador puede corregir servicios de ventas cerradas.");
  const [o,i,v,c,p,cs]=await Promise.all([
   supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id,total_ref,total_ves").eq("id",id).single(),
   supabase.from("order_items").select("id,service_vehicle_id,service_odometer,oil_brand,oil_viscosity,oil_quantity_liters,oil_filter_code,next_service_odometer,next_service_date")
     .eq("order_id",id).eq("item_type","SERVICE").eq("business_area","OIL_CHANGE").order("created_at"),
   supabase.from("vehicles").select("id,customer_id,plate,make,model,current_odometer").order("plate").limit(2000),
   supabase.from("customers").select("id,name").order("name").limit(2000),
   supabase.from("payments").select("id",{count:"exact",head:true}).eq("order_id",id),
   supabase.from("cashea_sales").select("cashea_reference").eq("order_id",id).maybeSingle()
  ]);
  const err=o.error||i.error||v.error||c.error||p.error||cs.error;
  if(err)throw err;
  if(!active)return;
  if(o.data.status!=="CLOSED")throw Error("Esta herramienta es para ventas cerradas. Una orden abierta se edita normalmente.");
  setOrder(o.data as Order);setServices((i.data||[]) as OilService[]);
  setCars((v.data||[]) as Car[]);
  setOwners(Object.fromEntries((c.data||[]).map(x=>[x.id,x.name||"Sin nombre"])));
  setVehicleId(o.data.vehicle_id||"");setPaymentCount(p.count||0);
  setCasheaRef(cs.data?.cashea_reference||null);
 })().catch(e=>{if(active)setError(e.message||String(e));})
 .finally(()=>{if(active)setLoading(false)});
 return()=>{active=false};},[id]);

 const visibleCars=useMemo(()=>cars.filter(c=>{
  if(!c.customer_id)return false;
  if(!showAll&&c.customer_id!==order?.customer_id)return false;
  return [c.plate,c.make,c.model,owners[c.customer_id]].join(" ").toLowerCase()
    .includes(search.trim().toLowerCase());
 }).slice(0,150),[cars,showAll,order?.customer_id,search,owners]);
 const car=cars.find(c=>c.id===vehicleId);
 const service=services.find(i=>i.id===serviceId);

 function pickService(id:string){
  setServiceId(id);setConfirmed(false);setError("");
  const svc=services.find(i=>i.id===id);
  if(!svc){
   setVehicleId(order?.vehicle_id||"");setOdometer("");
   setBrand("");setViscosity("");setLiters("");setFilter("");setNextKm("");setNextDate("");
   return;
  }
  setVehicleId(svc.service_vehicle_id||order?.vehicle_id||"");
  setOdometer(String(svc.service_odometer??""));setBrand(svc.oil_brand||"");
  setViscosity(svc.oil_viscosity||"");setLiters(String(svc.oil_quantity_liters??""));
  setFilter(svc.oil_filter_code||"");setNextKm(String(svc.next_service_odometer??""));
  setNextDate(svc.next_service_date||"");
 }
 async function save(){
  if(!order||busy)return;
  if(!confirmed){setError("Confirma que comprobaste los datos reales.");return;}
  if(!vehicleId||!car?.customer_id){setError("Selecciona un vehículo con propietario.");return;}
  if(!odometer||!Number.isInteger(Number(odometer))||Number(odometer)<0){setError("Kilometraje inválido.");return;}
  if(brand.trim().length<2||reason.trim().length<8){setError("Escribe el aceite y un motivo claro de la corrección.");return;}
  if(!nextKm&&!nextDate){setError("Indica el próximo cambio por kilometraje o fecha.");return;}
  if(nextKm&&(!Number.isInteger(Number(nextKm))||Number(nextKm)<=Number(odometer))){
   setError("El próximo kilometraje debe ser mayor al actual.");return;
  }
  if(liters&&(!Number.isFinite(Number(liters))||Number(liters)<=0)){setError("Litros inválidos.");return;}
  setBusy(true);setError("");setSuccess("");
  const r=await supabase.rpc("correct_closed_oil_service",{
   p_order_id:id,p_service_item_id:service?.id||null,p_vehicle_id:vehicleId,
   p_odometer:Number(odometer),p_oil_brand:brand.trim(),
   p_oil_viscosity:viscosity.trim()||null,p_oil_liters:digits(liters),
   p_filter_code:filter.trim()||null,
   p_next_service_odometer:digits(nextKm),p_next_service_date:nextDate||null,
   p_reason:reason.trim()
  });
  setBusy(false);
  if(r.error){setError(r.error.message);return;}
  setSuccess("Corrección registrada. El historial y CRM de este vehículo quedaron actualizados. La orden, Cashea y los cobros permanecen intactos.");
  setConfirmed(false);setReason("");
  router.refresh();
 }
 return <main className="container stack" style={{maxWidth:850}}>
  <div className="row-between" style={{gap:12,flexWrap:"wrap"}}>
   <div><div className="eyebrow">CORRECCIÓN SIN ANULAR VENTAS</div>
    <h1>Corregir mantenimiento · {order?.order_number||"Orden"}</h1></div>
   <Link className="btn" href={"/orders/"+id}>Volver a la orden</Link>
  </div>
  <section className="card stack">
   <strong>Se conserva la cobranza original</strong>
   <p className="muted">Esta corrección únicamente agrega o actualiza el historial de cambio de aceite. No modifica totales, recibos, movimientos bancarios, inventario, comisión ni cuotas Cashea.</p>
   <div className="grid grid-2">
    <div><div className="muted small">Total de la orden</div><strong>{order?fmtRef(order.total_ref):"—"}</strong>
     <div className="muted small">{order?fmtVes(order.total_ves):""}</div></div>
    <div><div className="muted small">Cobros registrados</div><strong>{paymentCount}</strong>
     <div className="muted small">{casheaRef?"Cashea "+casheaRef:"Sin venta Cashea"}</div></div>
   </div>
  </section>
  {loading&&<p className="muted">Comprobando permisos y datos originales…</p>}
  {error&&<div className="error" role="alert">{error}</div>}
  {success&&<div className="success" role="status">{success}</div>}
  {order&&<section className="card stack">
   <h2 className="section-title">1. Servicio que necesitas corregir</h2>
   <label><span className="label">Tipo de corrección</span>
    <select className="select" value={serviceId} onChange={e=>pickService(e.target.value)}>
     <option value="NEW">Agregar registro de cambio de aceite omitido (sin costo nuevo)</option>
     {services.map((s,i)=><option key={s.id} value={s.id}>
      Corregir cambio {i+1} · {cars.find(c=>c.id===(s.service_vehicle_id||order.vehicle_id))?.plate||"Vehículo"} · {s.oil_brand||"Aceite"}
     </option>)}
    </select>
   </label>
   <h2 className="section-title">2. Vehículo y kilometraje reales</h2>
   <label className="row"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/>
    Buscar también vehículos de otros clientes (cuando alguien paga los cambios de otra persona)</label>
   <input className="input" placeholder="Buscar placa, modelo o propietario" value={search} onChange={e=>setSearch(e.target.value)}/>
   <label><span className="label">Vehículo específico *</span>
    <select className="select" value={vehicleId} onChange={e=>{setVehicleId(e.target.value);setConfirmed(false);}}>
     <option value="">Selecciona el vehículo</option>
     {car&&!visibleCars.some(c=>c.id===car.id)&&<option value={car.id}>{car.plate} · {car.make} {car.model}</option>}
     {visibleCars.map(c=><option value={c.id} key={c.id}>{c.plate||"Sin placa"} · {c.make} {c.model} · {owners[c.customer_id||""]||"Propietario"}</option>)}
    </select>
   </label>
   {car&&car.customer_id!==order.customer_id&&<p className="muted small">El servicio y su mensaje CRM pertenecerán a {owners[car.customer_id||""]||"el dueño del vehículo"}, distinto de quien pagó la venta.</p>}
   <label><span className="label">Kilometraje al momento del servicio *</span>
    <input className="input" type="number" min="0" value={odometer} onChange={e=>{setOdometer(e.target.value);setConfirmed(false);}}/></label>
   <h2 className="section-title">3. Aceite y próximo mantenimiento</h2>
   <div className="grid grid-2">
    <label><span className="label">Aceite utilizado *</span><input className="input" value={brand} onChange={e=>setBrand(e.target.value)}/></label>
    <label><span className="label">Viscosidad</span><input className="input" value={viscosity} onChange={e=>setViscosity(e.target.value)} placeholder="15W-40"/></label>
    <label><span className="label">Litros colocados</span><input className="input" type="number" step=".1" min=".1" value={liters} onChange={e=>setLiters(e.target.value)}/></label>
    <label><span className="label">Filtro de aceite</span><input className="input" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
    <label><span className="label">Próximo kilometraje</span><input className="input" type="number" min="0" value={nextKm} onChange={e=>setNextKm(e.target.value)}/></label>
    <label><span className="label">Próxima fecha</span><input className="input" type="date" value={nextDate} onChange={e=>setNextDate(e.target.value)}/></label>
   </div>
   <label><span className="label">Motivo de la corrección *</span>
    <textarea className="input" rows={3} value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}
     placeholder="Ej. la venta se cargó como productos y faltaba activar CRM para el cambio de aceite real."/>
   </label>
   <label className="row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
    Confirmo vehículo, kilometraje y datos reales. Los cobros y precios no deben cambiar.</label>
   <button className="btn btn-primary" disabled={busy||!confirmed||!reason.trim()||!vehicleId}
     onClick={()=>void save()}>{busy?"Corrigiendo…":"Registrar corrección y actualizar CRM"}</button>
   <p className="muted small">Si quieres cambiar cantidades, precios o medios de pago, utiliza la corrección financiera separada y revisa primero su impacto contable.</p>
  </section>}
 </main>;
}

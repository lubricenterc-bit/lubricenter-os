"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { OsIcon } from "@/components/os-icon";
import { fmtDate, fmtRef } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import {
  maintenanceIsHistorical, maintenanceMismatch, maintenanceServiceLabel, maintenanceVehicleLabel,
  type MaintenanceHistoryRecord
} from "@/lib/maintenance-history";

export default function MaintenanceHistoryDetailPage(){
  const {id}=useParams<{id:string}>();
  const [record,setRecord]=useState<MaintenanceHistoryRecord|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  useEffect(()=>{
    if(!id)return;
    let cancelled=false;
    async function load(){
      const r=await supabase.from("service_records").select([
        "id","order_id","customer_id","vehicle_id","service_type","description","performed_at",
        "odometer","oil_brand","oil_viscosity","oil_quantity_liters","oil_filter_code",
        "next_service_odometer","next_service_date","service_notes","included_services","bonuses",
        "source_system","source_invoice",
        "customer:customers!service_records_customer_id_fkey(id,name,phone)",
        "vehicle:vehicles!service_records_vehicle_id_fkey(id,plate,make,model,year,customer_id)"
      ].join(",")).eq("id",id).maybeSingle();
      if(cancelled)return;
      setLoading(false);
      if(r.error){setError(r.error.message);return;}
      if(!r.data){setError("No encontramos esta ficha de mantenimiento.");return;}
      setRecord(r.data as unknown as MaintenanceHistoryRecord);
    }
    void load();
    return ()=>{cancelled=true;};
  },[id]);

  if(loading)return <main className="container mh"><p className="mh-empty">Cargando ficha histórica de servicio…</p></main>;
  if(error||!record)return <main className="container mh"><div className="error" role="alert">{error}</div><Link href="/service-history" className="mh-button">Volver al historial</Link></main>;

  const historical=maintenanceIsHistorical(record);
  const isOil=record.service_type==="OIL_CHANGE";
  const previousCustomer=maintenanceMismatch(record);
  const oilData=[
    {label:"Aceite utilizado",value:record.oil_brand},
    {label:"Viscosidad",value:record.oil_viscosity},
    {label:"Cantidad de aceite",value:record.oil_quantity_liters!=null?record.oil_quantity_liters+" L":null},
    {label:"Filtro utilizado",value:record.oil_filter_code},
  ].filter(item=>item.value);
  const serviceData=[
    {label:"Fecha del trabajo",value:fmtDate(record.performed_at)},
    {label:"Kilometraje registrado",value:record.odometer!=null?record.odometer.toLocaleString("es-VE")+" km":null},
    {label:"Próximo mantenimiento",value:record.next_service_odometer!=null?record.next_service_odometer.toLocaleString("es-VE")+" km":null},
    {label:"Próxima fecha sugerida",value:record.next_service_date?fmtDate(record.next_service_date+"T12:00:00Z"):null}
  ].filter(item=>item.value);
  return <main className="container mh mh-detail">
    <div className="mh-detail-back"><Link href="/service-history" className="mh-text-link"><OsIcon name="arrow" size={17}/> Volver al historial completo</Link></div>
    <header className="mh-detail-header">
      <div>
        <div className="mh-eyebrow"><OsIcon name="clock" size={17}/> FICHA DE MANTENIMIENTO / {historical?"ARCHIVO HISTÓRICO":"LUBRICENTER OS"}</div>
        <h1>{maintenanceServiceLabel(record.service_type)}</h1>
        <p>{fmtDate(record.performed_at)} · {record.description}</p>
      </div>
      <span className={historical?"mh-origin is-archive":"mh-origin"}>{historical?"Histórico · Sin orden contable":"Orden operativa"}</span>
    </header>
    <section className="mh-detail-intro">
      <div><span>Cliente atendido</span><strong>{record.customer?.name||"Sin nombre"}</strong>
        {record.customer_id&&<Link href={"/customers/"+record.customer_id} className="mh-text-link">Abrir ficha del cliente <OsIcon name="right" size={15}/></Link>}</div>
      <div><span>Vehículo atendido</span><strong>{record.vehicle?.plate||"Sin placa"}</strong>
        <small>{maintenanceVehicleLabel(record.vehicle)}</small>
        <Link href={"/vehicles/"+record.vehicle_id} className="mh-text-link">Abrir historial del vehículo <OsIcon name="right" size={15}/></Link></div>
    </section>
    {previousCustomer&&<div className="mh-restricted">
      <OsIcon name="shield" size={18}/> El cliente que figura en esta visita es distinto al titular actual del vehículo.
      Conservamos el cliente histórico sin cambiar el dueño actual ni fusionar fichas.
    </div>}
    <section className="mh-detail-data">
      <div className="mh-detail-panel">
        <h2>Detalles del servicio</h2>
        <dl>{serviceData.map(entry=><div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
      </div>
      {isOil&&<div className="mh-detail-panel">
        <h2>Aceite y filtros</h2>
        {oilData.length?<dl>{oilData.map(entry=><div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
          :<p className="mh-muted">No se registraron especificaciones adicionales.</p>}
      </div>}
      <div className="mh-detail-panel">
        <h2>Servicios adicionales y cortesías</h2>
        {record.included_services?.length>0&&<div className="mh-extra-set"><strong>Servicios realizados</strong><div>{record.included_services.map((value,index)=><span key={index}>{value}</span>)}</div></div>}
        {record.bonuses?.length>0&&<div className="mh-extra-set"><strong>Cortesías</strong><div>{record.bonuses.map((value,index)=><span key={index}>{value}</span>)}</div></div>}
        {!record.included_services?.length&&!record.bonuses?.length&&<p className="mh-muted">Sin servicios adicionales documentados.</p>}
      </div>
      <div className="mh-detail-panel">
        <h2>Observaciones originales</h2>
        <p className="mh-detail-note">{record.service_notes||"No se registraron observaciones."}</p>
        {historical&&record.source_invoice&&<div className="mh-invoice-note">
          <OsIcon name="receipt" size={17}/> Referencia de factura anterior: <strong>{record.source_invoice}</strong>
        </div>}
      </div>
    </section>
    <footer className="mh-detail-footer">
      {historical?<div className="mh-read-only"><OsIcon name="shield" size={17}/>
        Ficha de mantenimiento importada de registros anteriores. Solo consulta: no modifica ventas, caja, inventario ni comisiones.
      </div>:record.order_id?<Link href={"/orders/"+record.order_id} className="mh-button is-primary">
        <OsIcon name="receipt" size={17}/> Abrir orden original <OsIcon name="right" size={15}/>
      </Link>:null}
      <Link href="/service-history" className="mh-button">Volver a todos los servicios</Link>
    </footer>
  </main>;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OsIcon } from "@/components/os-icon";
import { supabase } from "@/lib/supabase";
import { fmtDate } from "@/lib/format";
import {
  filterMaintenanceRecords, groupMaintenanceByDay,
  maintenanceIsHistorical, maintenanceMismatch, maintenanceServiceLabel, maintenanceVehicleLabel,
  type MaintenanceFilters, type MaintenanceHistoryRecord
} from "@/lib/maintenance-history";

const HISTORY_COLUMNS = [
  "id","order_id","customer_id","vehicle_id","service_type","description","performed_at",
  "odometer","oil_brand","oil_viscosity","oil_quantity_liters","oil_filter_code",
  "next_service_odometer","next_service_date","service_notes","included_services","bonuses",
  "source_system","source_invoice",
  "customer:customers!service_records_customer_id_fkey(id,name,phone)",
  "vehicle:vehicles!service_records_vehicle_id_fkey(id,plate,make,model,year,customer_id)"
].join(",");

const BASE_FILTERS: MaintenanceFilters={query:"",kind:"ALL",origin:"ALL"};

export default function ServiceHistoryPage() {
  const [rows,setRows]=useState<MaintenanceHistoryRecord[]>([]);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [filters,setFilters]=useState<MaintenanceFilters>(BASE_FILTERS);
  const [visible,setVisible]=useState(70);
  const [page,setPage]=useState(0);

  useEffect(()=>{
    const search=new URLSearchParams(window.location.search);
    setFilters(current=>({
      ...current,
      query:search.get("q")||search.get("plate")||"",
      customerId:search.get("customer"),
      vehicleId:search.get("vehicle"),
    }));
  },[]);

  const load=useCallback(async(reset=true)=>{
    setLoading(true);setError("");
    const requestedPage=reset?0:page;
    const result=await supabase.from("service_records")
      .select(HISTORY_COLUMNS,{count:"exact"})
      .order("performed_at",{ascending:false})
      .range(requestedPage*1000,requestedPage*1000+999);
    setLoading(false);
    if(result.error){setError(result.error.message);return;}
    const received=(result.data||[]) as unknown as MaintenanceHistoryRecord[];
    setRows(current=>reset?received:[...current,...received]);
    setTotal(result.count??received.length);
    if(reset){setPage(0);setVisible(70);} else{setPage(requestedPage);}
  },[page]);

  useEffect(()=>{void load(true);},[]);
  const filtered=useMemo(()=>filterMaintenanceRecords(rows,filters),[rows,filters]);
  const pageRows=filtered.slice(0,visible);
  const grouped=useMemo(()=>groupMaintenanceByDay(pageRows),[pageRows]);
  const historicCount=rows.filter(maintenanceIsHistorical).length;
  const currentCount=rows.length-historicCount;
  const distinctVehicles=new Set(rows.map(s=>s.vehicle_id)).size;
  const isFiltered=!!(filters.query||filters.customerId||filters.vehicleId||filters.kind!=="ALL"||filters.origin!=="ALL");

  const setFilter=<K extends keyof MaintenanceFilters>(key:K,value:MaintenanceFilters[K])=>{
    setFilters(current=>({...current,[key]:value}));
    setVisible(70);
  };

  return <main className="container mh">
    <header className="mh-header">
      <div className="mh-heading-copy">
        <div className="mh-eyebrow"><OsIcon name="clock" size={17}/> CRM / HISTORIAL DE MANTENIMIENTO</div>
        <h1>Cada visita cuenta una historia.</h1>
        <p>Encuentra los trabajos antiguos del Sheet y los realizados con Lubricenter OS. Un solo historial por vehículo, sin convertir los registros anteriores en ventas.</p>
      </div>
      <div className="mh-header-buttons">
        <Link href="/customers" className="mh-button"><OsIcon name="customers" size={17}/> Clientes</Link>
        <Link href="/orders" className="mh-button"><OsIcon name="receipt" size={17}/> Ventas y órdenes</Link>
      </div>
    </header>

    <div className="mh-stats" aria-label="Resumen de servicios registrados">
      <div><span>Servicios de mantenimiento</span><strong>{rows.length.toLocaleString("es-VE")}{total>rows.length?"+":""}</strong><small>Historial completo, no facturación</small></div>
      <div><span>Importados de archivos</span><strong>{historicCount.toLocaleString("es-VE")}</strong><small>Sin órdenes contables</small></div>
      <div><span>Generados por el OS</span><strong>{currentCount.toLocaleString("es-VE")}</strong><small>Con trazabilidad a sus órdenes</small></div>
      <div><span>Vehículos atendidos</span><strong>{distinctVehicles.toLocaleString("es-VE")}</strong><small>Por ficha única de vehículo</small></div>
    </div>

    <section className="mh-toolbar" aria-label="Buscar mantenimientos">
      <label className="mh-search"><OsIcon name="search" size={19}/>
        <input type="search" value={filters.query} placeholder="Buscar placa, cliente, teléfono, aceite, filtro o factura antigua…"
          onChange={e=>setFilter("query",e.target.value)} aria-label="Buscar en todo el historial"/>
      </label>
      <label className="mh-select"><span>Servicio</span><select value={filters.kind} onChange={e=>setFilter("kind",e.target.value as MaintenanceFilters["kind"])}>
        <option value="ALL">Todos los servicios</option>
        <option value="OIL_CHANGE">Cambios de aceite</option>
        <option value="WORKSHOP">Taller</option>
        <option value="ELECTROAUTO">Electroauto</option>
        <option value="OTHER">Otros</option>
      </select></label>
      <label className="mh-select"><span>Origen</span><select value={filters.origin} onChange={e=>setFilter("origin",e.target.value as MaintenanceFilters["origin"])}>
        <option value="ALL">Todos</option>
        <option value="HISTORIC">Histórico importado</option>
        <option value="CURRENT">Lubricenter OS</option>
      </select></label>
    </section>
    {(filters.customerId||filters.vehicleId) && <div className="mh-restricted">
      <OsIcon name="shield" size={17}/> Estás viendo el historial de una ficha específica.
      <Link href="/service-history">Ver todos los vehículos</Link>
    </div>}
    {error&&<div className="error" role="alert">{error} <button className="mh-button" onClick={()=>void load(true)}>Reintentar</button></div>}
    <div className="mh-results-head">
      <div><h2>{isFiltered?"Resultados del historial":"Historial completo"}</h2>
        <span>{loading?"Consultando registros…":filtered.length.toLocaleString("es-VE")+" servicios encontrados"}</span></div>
      <span className="mh-read-only"><OsIcon name="shield" size={15}/> Archivo de consulta · Sin movimientos contables</span>
    </div>

    {loading&&!rows.length&&<div className="mh-empty"><OsIcon name="clock" size={31}/> Cargando mantenimientos registrados…</div>}
    {!loading&&!error&&!filtered.length&&<div className="mh-empty">
      <OsIcon name="search" size={32}/><strong>No encontramos servicios con esos filtros</strong>
      <p>Prueba otra placa, nombre o fecha; los registros importados conservan sus datos originales.</p>
      <button className="mh-button" onClick={()=>setFilters(BASE_FILTERS)}>Limpiar búsqueda</button>
    </div>}
    <section className="mh-chronology" aria-label="Cronología de mantenimiento">
      {grouped.map(([day,services])=><div className="mh-day" key={day}>
        <h3>{fmtDate(day+"T12:00:00Z")} <span>{services.length} {services.length===1?"registro":"registros"}</span></h3>
        <div className="mh-day-grid">
          {services.map(record=>{
            const historic=maintenanceIsHistorical(record);
            return <article className="mh-record" key={record.id}>
              <div className="mh-record-top">
                <span className={"mh-service-kind"+(record.service_type==="OIL_CHANGE"?" is-oil":"")}>
                  <OsIcon name={record.service_type==="OIL_CHANGE"?"inventory":"workshop"} size={15}/>
                  {maintenanceServiceLabel(record.service_type)}
                </span>
                <span className={historic?"mh-origin is-archive":"mh-origin"}>
                  {historic?"Histórico · Sheets":"Orden registrada"}
                </span>
              </div>
              <div className="mh-record-main">
                <div><strong>{record.customer?.name||"Cliente sin nombre"}</strong>
                  <span>{maintenanceVehicleLabel(record.vehicle)} · {record.vehicle?.plate||"Sin placa"}</span></div>
                <p>{record.description}</p>
                <div className="mh-record-facts">
                  {record.odometer!=null&&<span><OsIcon name="car" size={14}/>{record.odometer.toLocaleString("es-VE")} km</span>}
                  {record.oil_viscosity&&<span><OsIcon name="inventory" size={14}/>{record.oil_viscosity}</span>}
                  {record.oil_filter_code&&<span>Filtro {record.oil_filter_code}</span>}
                </div>
              </div>
              {maintenanceMismatch(record)&&<p className="mh-record-owner-note">
                El cliente de esta visita es distinto al titular actual del vehículo. Se conserva la identidad histórica.</p>}
              <div className="mh-record-actions">
                <Link href={"/service-history/"+record.id} className="mh-button is-primary">Ver ficha del servicio <OsIcon name="right" size={16}/></Link>
                {record.customer_id&&<Link href={"/customers/"+record.customer_id} className="mh-text-link">Cliente</Link>}
                <Link href={"/vehicles/"+record.vehicle_id} className="mh-text-link">Vehículo</Link>
              </div>
            </article>;
          })}
        </div>
      </div>)}
    </section>
    {visible<filtered.length&&<button className="mh-load-more" onClick={()=>setVisible(v=>v+70)}>
      Mostrar más servicios <OsIcon name="down" size={18}/></button>}
    {rows.length<total&&!loading&&<button className="mh-load-more" onClick={()=>void load(false)}>
      Cargar más servicios de la base de datos <OsIcon name="down" size={18}/></button>}
    <p className="mh-disclaimer">Los servicios antiguos se recuperaron de los registros originales. Sus números de factura son referencias históricas; no se generan ingresos, impuestos, pagos ni salidas de inventario.</p>
  </main>;
}

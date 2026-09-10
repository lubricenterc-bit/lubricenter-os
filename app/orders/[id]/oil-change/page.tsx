"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

type Order = { id:string; order_number:string; status:string; customer_id:string|null; vehicle_id:string|null };
type Vehicle = { id:string; plate:string|null; make:string|null; model:string|null; year:number|null; current_odometer:number|null };
type Customer = { id:string; name:string|null; phone:string|null };
type InventoryItem = { id:string; sku:string; brand:string|null; description:string; category:string|null; quantity_on_hand:number; current_ref_bcv:number|null; current_price_ves:number|null; needs_review:boolean };
type CatalogItem = { id:string; name:string; category:string|null; filter_code:string|null; current_ref_bcv:number|null; current_price_ves:number|null };
type Source = "INVENTORY"|"CATALOG"|"MANUAL";
type FilterSource = "NONE"|Source;

type Pick = { id:string; title:string; subtitle:string; ref:number; ves:number; stock?:number; brand?:string; code?:string };

function normalize(v:string|null|undefined){return (v??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function viscosity(v:string){return v.match(/\b\d{1,2}\s*W\s*[-/]?\s*\d{2}\b/i)?.[0]?.replace(/\s+/g,"").replace("/","-")??"";}

export default function OilChangePage(){
  const {id:orderId}=useParams<{id:string}>();
  const router=useRouter();
  const [order,setOrder]=useState<Order|null>(null);
  const [vehicle,setVehicle]=useState<Vehicle|null>(null);
  const [customer,setCustomer]=useState<Customer|null>(null);
  const [inventory,setInventory]=useState<InventoryItem[]>([]);
  const [catalog,setCatalog]=useState<CatalogItem[]>([]);
  const [bcv,setBcv]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  const [odometer,setOdometer]=useState("");
  const [oilSource,setOilSource]=useState<Source>("INVENTORY");
  const [oilSearch,setOilSearch]=useState("");
  const [oilPick,setOilPick]=useState<Pick|null>(null);
  const [oilManual,setOilManual]=useState("");
  const [oilQty,setOilQty]=useState("1");
  const [oilRef,setOilRef]=useState("");
  const [oilViscosity,setOilViscosity]=useState("");
  const [liters,setLiters]=useState("");

  const [filterSource,setFilterSource]=useState<FilterSource>("NONE");
  const [filterSearch,setFilterSearch]=useState("");
  const [filterPick,setFilterPick]=useState<Pick|null>(null);
  const [filterManual,setFilterManual]=useState("");
  const [filterQty,setFilterQty]=useState("1");
  const [filterRef,setFilterRef]=useState("");

  const [serviceRef,setServiceRef]=useState("0");
  const [nextKm,setNextKm]=useState("5000");
  const [nextMonths,setNextMonths]=useState("3");

  async function load(){
    setLoading(true);setError("");
    const [o,r,inv,cat]=await Promise.all([
      supabase.from("orders").select("id,order_number,status,customer_id,vehicle_id").eq("id",orderId).single(),
      supabase.rpc("get_current_rates"),
      supabase.rpc("get_oil_change_inventory",{p_location_code:"CABUDARE"}),
      supabase.from("product_catalog_current").select("id,name,category,filter_code,current_ref_bcv,current_price_ves").eq("available",true).order("name").limit(1000),
    ]);
    const e=o.error||r.error||inv.error||cat.error;
    if(e){setError(e.message);setLoading(false);return;}
    const ord=o.data as Order;
    if(ord.status!=="OPEN"){setError("Esta orden ya no está abierta.");setLoading(false);return;}
    if(!ord.vehicle_id){setError("Esta orden necesita un vehículo. Vuelve a la orden y asígnalo primero.");setLoading(false);return;}
    setOrder(ord);
    const rr=Array.isArray(r.data)?r.data[0]:r.data;setBcv(Number(rr?.bcv_rate??0));
    setInventory((inv.data??[]).map((x:any)=>({...x,quantity_on_hand:Number(x.quantity_on_hand??0),current_ref_bcv:x.current_ref_bcv==null?null:Number(x.current_ref_bcv),current_price_ves:x.current_price_ves==null?null:Number(x.current_price_ves)})) as InventoryItem[]);
    setCatalog((cat.data??[]).map((x:any)=>({...x,current_ref_bcv:x.current_ref_bcv==null?null:Number(x.current_ref_bcv),current_price_ves:x.current_price_ves==null?null:Number(x.current_price_ves)})) as CatalogItem[]);
    const [v,c]=await Promise.all([
      supabase.from("vehicles").select("id,plate,make,model,year,current_odometer").eq("id",ord.vehicle_id).single(),
      ord.customer_id?supabase.from("customers").select("id,name,phone").eq("id",ord.customer_id).maybeSingle():Promise.resolve({data:null,error:null} as any),
    ]);
    if(v.error||c.error){setError((v.error||c.error)?.message??"No pude cargar cliente/vehículo.");setLoading(false);return;}
    setVehicle(v.data as Vehicle);setCustomer(c.data as Customer|null);
    if(v.data.current_odometer!=null)setOdometer(String(v.data.current_odometer));
    setLoading(false);
  }
  useEffect(()=>{if(orderId)load();},[orderId]);

  const inventoryOils=useMemo(()=>inventory.filter(i=>normalize(i.category).includes("aceite")&&!i.needs_review),[inventory]);
  const inventoryFilters=useMemo(()=>inventory.filter(i=>normalize(i.category).includes("filtro")&&!i.needs_review),[inventory]);
  const catalogOils=useMemo(()=>catalog.filter(i=>normalize(`${i.category} ${i.name}`).includes("aceite")&&!normalize(`${i.category} ${i.name}`).includes("filtro")),[catalog]);
  const catalogFilters=useMemo(()=>catalog.filter(i=>normalize(`${i.category} ${i.name}`).includes("filtro")),[catalog]);

  const oilResults=useMemo<Pick[]>(()=>{
    const q=normalize(oilSearch);
    if(oilSource==="INVENTORY") return inventoryOils.filter(i=>!q||normalize(`${i.sku} ${i.brand} ${i.description}`).includes(q)).slice(0,20).map(i=>({id:i.id,title:`${i.brand??"Aceite"} · ${i.sku}`,subtitle:i.description,ref:Number(i.current_ref_bcv??0),ves:Number(i.current_price_ves??0),stock:i.quantity_on_hand,brand:i.brand??i.description}));
    if(oilSource==="CATALOG") return catalogOils.filter(i=>!q||normalize(`${i.name} ${i.category}`).includes(q)).slice(0,20).map(i=>({id:i.id,title:i.name,subtitle:i.category??"Catálogo",ref:Number(i.current_ref_bcv??0),ves:Number(i.current_price_ves??0),brand:i.name}));
    return [];
  },[oilSource,oilSearch,inventoryOils,catalogOils]);

  const filterResults=useMemo<Pick[]>(()=>{
    const q=normalize(filterSearch);
    if(filterSource==="INVENTORY") return inventoryFilters.filter(i=>!q||normalize(`${i.sku} ${i.brand} ${i.description}`).includes(q)).slice(0,20).map(i=>({id:i.id,title:`${i.brand??"Filtro"} · ${i.sku}`,subtitle:i.description,ref:Number(i.current_ref_bcv??0),ves:Number(i.current_price_ves??0),stock:i.quantity_on_hand,code:i.sku}));
    if(filterSource==="CATALOG") return catalogFilters.filter(i=>!q||normalize(`${i.name} ${i.category} ${i.filter_code}`).includes(q)).slice(0,20).map(i=>({id:i.id,title:i.name,subtitle:i.category??"Catálogo",ref:Number(i.current_ref_bcv??0),ves:Number(i.current_price_ves??0),code:i.filter_code??i.name}));
    return [];
  },[filterSource,filterSearch,inventoryFilters,catalogFilters]);

  function switchOil(source:Source){setOilSource(source);setOilPick(null);setOilRef("");setOilSearch("");setOilManual("");}
  function chooseOil(p:Pick){setOilPick(p);setOilRef(p.ref>0?p.ref.toFixed(2):"");setOilViscosity(viscosity(`${p.title} ${p.subtitle}`));}
  function switchFilter(source:FilterSource){setFilterSource(source);setFilterPick(null);setFilterRef("");setFilterSearch("");setFilterManual("");}
  function chooseFilter(p:Pick){setFilterPick(p);setFilterRef(p.ref>0?p.ref.toFixed(2):"");}

  const oilUnit=Number(oilRef||0), oilUnits=Number(oilQty||0), filterUnit=Number(filterRef||0), filterUnits=Number(filterQty||0), labor=Number(serviceRef||0);
  const totalRef=oilUnit*oilUnits+(filterSource==="NONE"?0:filterUnit*filterUnits)+labor;
  const oilReady=oilSource==="MANUAL"?!!oilManual.trim():!!oilPick;
  const filterReady=filterSource==="NONE"||(filterSource==="MANUAL"?!!filterManual.trim():!!filterPick);
  const stockOilOk=oilSource!=="INVENTORY"||!oilPick||oilPick.stock==null||oilUnits<=oilPick.stock;
  const stockFilterOk=filterSource!=="INVENTORY"||!filterPick||filterPick.stock==null||filterUnits<=filterPick.stock;
  const ready=!!order&&!!vehicle&&Number(odometer)>=0&&oilReady&&filterReady&&oilUnits>0&&oilUnit>0&&stockOilOk&&stockFilterOk&&(filterSource==="NONE"||(filterUnits>0&&filterUnit>0));

  async function save(){
    if(!ready||busy)return;
    setBusy(true);setError("");
    const {error}=await supabase.rpc("add_oil_change_package_flexible",{
      p_order_id:orderId,p_odometer:Number(odometer),p_description:"Cambio de aceite",p_service_base_ref:labor,p_service_customer_ref:labor,
      p_oil_source:oilSource,p_oil_inventory_item_id:oilSource==="INVENTORY"?oilPick?.id:null,p_oil_product_id:oilSource==="CATALOG"?oilPick?.id:null,p_oil_description:oilSource==="MANUAL"?oilManual.trim():null,p_oil_units:oilUnits,p_oil_unit_ref:oilUnit,p_oil_brand:oilSource==="MANUAL"?oilManual.trim():oilPick?.brand??oilPick?.title??null,p_oil_viscosity:oilViscosity.trim()||null,p_oil_quantity_liters:liters?Number(liters):null,
      p_filter_source:filterSource,p_filter_inventory_item_id:filterSource==="INVENTORY"?filterPick?.id:null,p_filter_product_id:filterSource==="CATALOG"?filterPick?.id:null,p_filter_description:filterSource==="MANUAL"?filterManual.trim():null,p_filter_units:filterUnits,p_filter_unit_ref:filterSource==="NONE"?null:filterUnit,p_filter_code:filterSource==="NONE"?null:(filterPick?.code??filterManual.trim()||null),
      p_next_km_interval:Number(nextKm||0),p_next_months:Number(nextMonths||0),
    });
    setBusy(false);if(error)return setError(error.message);
    router.push(`/orders/${orderId}`);router.refresh();
  }

  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">CAMBIO DE ACEITE · {order?.order_number??"ORDEN"}</div><h1>Registrar servicio</h1><p>{customer?.name||customer?.phone||"Cliente"} · {[vehicle?.plate,vehicle?.make,vehicle?.model].filter(Boolean).join(" · ")}</p></div><img src="/lubricenter-logo.png" alt="Lubricenter"/></section>
    {error&&<div className="error">{error}</div>}
    {loading?<div className="card muted">Cargando aceites, filtros y precios…</div>:<>
      <section className="card stack"><div className="row-between"><div><div className="eyebrow">1 · VEHÍCULO</div><strong>{[vehicle?.plate,vehicle?.make,vehicle?.model,vehicle?.year].filter(Boolean).join(" · ")}</strong></div><button className="btn btn-ghost" onClick={()=>router.push(`/orders/${orderId}`)}>Volver</button></div><label><span className="label">Kilometraje actual *</span><input className="input" type="number" min="0" value={odometer} onChange={e=>setOdometer(e.target.value)} autoFocus/></label></section>

      <section className="card stack"><div><div className="eyebrow">2 · ACEITE</div><h2 className="section-title" style={{marginBottom:3}}>¿Qué aceite usaste?</h2><div className="muted small">Si el inventario aún no está al día, usa Catálogo o Manual. La venta no se bloquea.</div></div>
        <div className="segmented"><button className={`btn ${oilSource==="INVENTORY"?"btn-primary":"btn-ghost"}`} onClick={()=>switchOil("INVENTORY")}>Con stock</button><button className={`btn ${oilSource==="CATALOG"?"btn-primary":"btn-ghost"}`} onClick={()=>switchOil("CATALOG")}>Catálogo</button><button className={`btn ${oilSource==="MANUAL"?"btn-primary":"btn-ghost"}`} onClick={()=>switchOil("MANUAL")}>Manual</button></div>
        {oilSource!=="MANUAL"?<><input className="input" value={oilSearch} onChange={e=>setOilSearch(e.target.value)} placeholder="Marca, viscosidad, SKU…"/><div className="stack" style={{maxHeight:300,overflow:"auto"}}>{oilResults.map(p=><button key={p.id} className="card directory-option" style={{padding:12,textAlign:"left",borderColor:oilPick?.id===p.id?"#ff5d15":undefined}} onClick={()=>chooseOil(p)}><div className="row-between"><div><strong>{p.title}</strong><div className="muted small">{p.subtitle}</div></div><div style={{textAlign:"right"}}><strong>{p.ref>0?fmtRef(p.ref):"Precio manual"}</strong>{p.stock!=null&&<div className="muted small">Stock {p.stock}</div>}</div></div></button>)}{!oilResults.length&&<div className="muted small">No encontré coincidencias. Cambia a Catálogo o Manual.</div>}</div></>:<label><span className="label">Aceite / descripción *</span><input className="input" value={oilManual} onChange={e=>{setOilManual(e.target.value);if(!oilViscosity)setOilViscosity(viscosity(e.target.value));}} placeholder="Ej. Valvoline 15W40 semisintético"/></label>}
        <div className="grid grid-2"><label><span className="label">Unidades *</span><input className="input" type="number" min="0.01" step="0.01" value={oilQty} onChange={e=>setOilQty(e.target.value)}/></label><label><span className="label">Precio unitario REF *</span><input className="input" type="number" min="0.01" step="0.01" value={oilRef} onChange={e=>setOilRef(e.target.value)}/></label><label><span className="label">Viscosidad</span><input className="input" value={oilViscosity} onChange={e=>setOilViscosity(e.target.value)} placeholder="15W40"/></label><label><span className="label">Litros · opcional</span><input className="input" type="number" min="0" step="0.1" value={liters} onChange={e=>setLiters(e.target.value)}/></label></div>
        {!stockOilOk&&<div className="error">Solo hay {oilPick?.stock} unidades físicas. Cambia a “Catálogo” si sabes que sí existe pero el inventario aún no está actualizado.</div>}
      </section>

      <section className="card stack"><div><div className="eyebrow">3 · FILTRO</div><h2 className="section-title" style={{marginBottom:3}}>Filtro de aceite</h2></div>
        <div className="segmented"><button className={`btn ${filterSource==="NONE"?"btn-primary":"btn-ghost"}`} onClick={()=>switchFilter("NONE")}>Sin filtro</button><button className={`btn ${filterSource==="INVENTORY"?"btn-primary":"btn-ghost"}`} onClick={()=>switchFilter("INVENTORY")}>Con stock</button><button className={`btn ${filterSource==="CATALOG"?"btn-primary":"btn-ghost"}`} onClick={()=>switchFilter("CATALOG")}>Catálogo</button><button className={`btn ${filterSource==="MANUAL"?"btn-primary":"btn-ghost"}`} onClick={()=>switchFilter("MANUAL")}>Manual</button></div>
        {filterSource!=="NONE"&&filterSource!=="MANUAL"&&<><input className="input" value={filterSearch} onChange={e=>setFilterSearch(e.target.value)} placeholder="Código, marca o descripción…"/><div className="stack" style={{maxHeight:240,overflow:"auto"}}>{filterResults.map(p=><button key={p.id} className="card directory-option" style={{padding:12,textAlign:"left",borderColor:filterPick?.id===p.id?"#ff5d15":undefined}} onClick={()=>chooseFilter(p)}><div className="row-between"><div><strong>{p.title}</strong><div className="muted small">{p.subtitle}</div></div><div style={{textAlign:"right"}}><strong>{p.ref>0?fmtRef(p.ref):"Precio manual"}</strong>{p.stock!=null&&<div className="muted small">Stock {p.stock}</div>}</div></div></button>)}</div></>}
        {filterSource==="MANUAL"&&<label><span className="label">Filtro / código *</span><input className="input" value={filterManual} onChange={e=>setFilterManual(e.target.value)} placeholder="Ej. A1 AF-3387"/></label>}
        {filterSource!=="NONE"&&<div className="grid grid-2"><label><span className="label">Cantidad *</span><input className="input" type="number" min="0.01" step="0.01" value={filterQty} onChange={e=>setFilterQty(e.target.value)}/></label><label><span className="label">Precio unitario REF *</span><input className="input" type="number" min="0.01" step="0.01" value={filterRef} onChange={e=>setFilterRef(e.target.value)}/></label></div>}
        {!stockFilterOk&&<div className="error">No alcanza el stock físico. Usa Catálogo o Manual si el conteo todavía no refleja la existencia real.</div>}
      </section>

      <section className="card stack"><div><div className="eyebrow">4 · SERVICIO Y PRÓXIMO CAMBIO</div><strong>Termina el registro</strong></div><div className="grid grid-3"><label><span className="label">Servicio REF</span><input className="input" type="number" min="0" step="0.01" value={serviceRef} onChange={e=>setServiceRef(e.target.value)}/></label><label><span className="label">Próximo en km</span><input className="input" type="number" min="0" value={nextKm} onChange={e=>setNextKm(e.target.value)}/></label><label><span className="label">Próximo en meses</span><input className="input" type="number" min="0" value={nextMonths} onChange={e=>setNextMonths(e.target.value)}/></label></div><div className="row-between"><div><div className="muted small">TOTAL QUE SE AGREGARÁ</div><div className="money-lg">{fmtRef(totalRef)}</div></div><div style={{textAlign:"right"}}><strong>{fmtVes(totalRef*bcv)}</strong>{odometer&&nextKm&&<div className="muted small">Próximo: {(Number(odometer)+Number(nextKm)).toLocaleString("es-VE")} km</div>}</div></div></section>

      <button className="btn btn-primary btn-block" style={{minHeight:60,fontSize:17}} disabled={!ready||busy} onClick={save}>{busy?"Agregando servicio…":`Agregar cambio de aceite · ${fmtRef(totalRef)}`}</button>
      {!ready&&<div className="muted small" style={{textAlign:"center"}}>Completa kilometraje, aceite, cantidad y precio. El filtro es opcional.</div>}
    </>}
  </main>;
}

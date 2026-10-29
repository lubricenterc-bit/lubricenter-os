"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  FAMILIES,OIL_BASES,OIL_SYSTEMS,FUEL_TYPES,FILTER_TYPES,FILTER_DESIGNS,FILTER_MEDIA,
  emptyTechnicalSpec,normalizeTechnicalSpec,suggestedFamily,technicalSearchText,
  type CatalogTechSpec,type Family,
} from "@/lib/catalog-taxonomy";

type Item={id:string;sku?:string;name?:string;brand?:string|null;description?:string;category:string|null;needs_review?:boolean};
type Crossref={id:string;technical_spec_id:string;reference_brand:string;reference_code:string;reference_kind:string;verification_status:string};
type LabelledItem=Item&{spec:CatalogTechSpec|null;label:string};
function Select({label,value,options,change}:{label:string;value:string|null;options:readonly(readonly[string,string])[];change:(s:string|null)=>void}){
  return <label><span className="label">{label}</span><select className="input" value={value??""} onChange={e=>change(e.target.value||null)}>
    <option value="">Sin especificar</option>{options.map(([v,label])=><option key={v} value={v}>{label}</option>)}
  </select></label>;
}
function Txt({label,value,change,placeholder}:{label:string;value:string|null;change:(s:string|null)=>void;placeholder?:string}){
  return <label><span className="label">{label}</span><input className="input" value={value??""} placeholder={placeholder||""} onChange={e=>change(e.target.value||null)}/></label>;
}
function Num({label,value,change}:{label:string;value:number|null;change:(n:number|null)=>void}){
  return <label><span className="label">{label}</span><input className="input" type="number" min="0" step="any" value={value??""} onChange={e=>change(e.target.value===""?null:Number(e.target.value))}/></label>;
}
const BASE_NAMES:Record<string,string>=Object.fromEntries(OIL_BASES);
const SYSTEM_NAMES:Record<string,string>=Object.fromEntries(OIL_SYSTEMS);
const FILTER_NAMES:Record<string,string>=Object.fromEntries(FILTER_TYPES);
const FAMILY_NAMES:Record<string,string>=Object.fromEntries(FAMILIES);

export default function TechnicalCatalogPage(){
  const [mode,setMode]=useState<"stock"|"catalog">("stock");
  const [stock,setStock]=useState<Item[]>([]);
  const [catalog,setCatalog]=useState<Item[]>([]);
  const [specs,setSpecs]=useState<CatalogTechSpec[]>([]);
  const [crossrefs,setCrossrefs]=useState<Crossref[]>([]);
  const [query,setQuery]=useState("");
  const [family,setFamily]=useState("");
  const [category,setCategory]=useState("");
  const [brand,setBrand]=useState("");
  const [viscosity,setViscosity]=useState("");
  const [base,setBase]=useState("");
  const [system,setSystem]=useState("");
  const [fuel,setFuel]=useState("");
  const [filterType,setFilterType]=useState("");
  const [missing,setMissing]=useState(false);
  const [editing,setEditing]=useState<CatalogTechSpec|null>(null);
  const [editingName,setEditingName]=useState("");
  const [refBrand,setRefBrand]=useState("");
  const [refCode,setRefCode]=useState("");
  const [refKind,setRefKind]=useState("COMPETITOR");
  const [refSource,setRefSource]=useState("");
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  async function load(){
    setLoading(true);setError("");
    const [si,cp,ss,refs]=await Promise.all([
      supabase.from("inventory_items").select("id,sku,brand,description,category,needs_review").eq("active",true).order("sku").limit(1000),
      supabase.from("products").select("id,name,category").eq("active",true).eq("available",true).order("name").limit(1000),
      supabase.from("catalog_technical_specs").select("*").limit(2000),
      supabase.from("filter_cross_references").select("id,technical_spec_id,reference_brand,reference_code,reference_kind,verification_status").limit(4000),
    ]);
    setLoading(false);
    const failed=si.error||cp.error||ss.error||refs.error;
    if(failed){setError(failed.message);return;}
    setStock((si.data??[]) as Item[]);
    setCatalog((cp.data??[]) as Item[]);
    setSpecs((ss.data??[]) as CatalogTechSpec[]);
    setCrossrefs((refs.data??[]) as Crossref[]);
  }
  useEffect(()=>{void load();},[]);

  const entries=useMemo(()=>((mode==="stock"?stock:catalog).map(item=>{
    const spec=specs.find(s=>mode==="stock"?s.inventory_item_id===item.id:s.product_id===item.id)??null;
    const label=mode==="stock"?(item.sku||"Sin SKU")+" · "+(item.description||""):item.name||"";
    return {...item,spec,label};
  })),[stock,catalog,specs,mode]);
  const categories=useMemo(()=>Array.from(new Set(entries.map(e=>e.category).filter((v):v is string=>!!v))).sort(),[entries]);
  const brands=useMemo(()=>Array.from(new Set(entries.map(e=>e.spec?.brand||e.brand).filter((v):v is string=>!!v))).sort(),[entries]);
  const viscosities=useMemo(()=>Array.from(new Set(entries.map(e=>e.spec?.viscosity).filter((v):v is string=>!!v))).sort(),[entries]);
  const filtered=useMemo(()=>entries.filter(e=>{
    const s=e.spec;
    if(family&&(s?.family||suggestedFamily(e.category))!==family)return false;
    if(category&&e.category!==category)return false;
    if(brand&&(s?.brand||e.brand)!==brand)return false;
    if(viscosity&&s?.viscosity!==viscosity)return false;
    if(base&&s?.lubricant_base!==base)return false;
    if(system&&s?.lubricant_system!==system)return false;
    if(fuel&&s?.fuel_application!==fuel)return false;
    if(filterType&&s?.filter_type!==filterType)return false;
    if(missing&&s?.family)return false;
    const codes=crossrefs.filter(x=>x.technical_spec_id===s?.id).map(x=>x.reference_brand+" "+x.reference_code).join(" ");
    return (technicalSearchText(e,s)+" "+codes).includes(query.trim().toLocaleLowerCase("es-VE"));
  }),[entries,query,family,category,brand,viscosity,base,system,fuel,filterType,missing,crossrefs]);
  function update<K extends keyof CatalogTechSpec>(k:K,v:CatalogTechSpec[K]){setEditing(old=>old?{...old,[k]:v}:old);}
  function open(e:LabelledItem){
    setEditingName(e.label);setError("");setNotice("");
    setEditing(e.spec?{...e.spec,additional_tags:[...(e.spec.additional_tags??[])]}:
      emptyTechnicalSpec(mode==="catalog"?e.id:null,mode==="stock"?e.id:null,suggestedFamily(e.category)));
    setRefBrand("");setRefCode("");setRefKind("COMPETITOR");setRefSource("");
  }
  function reset(){
    setQuery("");setFamily("");setCategory("");setBrand("");setViscosity("");setBase("");
    setSystem("");setFuel("");setFilterType("");setMissing(false);
  }
  async function save(){
    if(!editing||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const s=normalizeTechnicalSpec(editing);
      const {id,...values}=s;
      const response=id
        ?await supabase.from("catalog_technical_specs").update(values).eq("id",id).select("*").single()
        :await supabase.from("catalog_technical_specs").insert(values).select("*").single();
      if(response.error)throw response.error;
      const next=response.data as CatalogTechSpec;
      setSpecs(old=>[...old.filter(x=>x.id!==next.id),next]);
      setEditing(next);setNotice("Etiquetas guardadas. No se alteraron existencias, órdenes, costos ni precios.");
    }catch(ex){setError(ex instanceof Error?ex.message:String(ex));}
    finally{setBusy(false);}
  }
  async function addCrossref(){
    if(!editing?.id||!refBrand.trim()||!refCode.trim()||busy)return;
    setBusy(true);setError("");
    const result=await supabase.from("filter_cross_references").insert({
      technical_spec_id:editing.id,reference_brand:refBrand.trim(),
      reference_code:refCode.trim(),reference_kind:refKind,
      evidence_source:refSource.trim()||null,verification_status:"PENDING"
    }).select("id,technical_spec_id,reference_brand,reference_code,reference_kind,verification_status").single();
    setBusy(false);
    if(result.error){setError(result.error.message);return;}
    setCrossrefs(old=>[...old,result.data as Crossref]);
    setRefBrand("");setRefCode("");setRefSource("");
    setNotice("Referencia registrada como PENDIENTE DE VERIFICACIÓN.");
  }
  return <main className="container stack">
    <section className="brand-hero"><div><div className="eyebrow">LUBRICENTER OS · FICHAS TÉCNICAS</div>
      <h1>Clasificar aceites y filtros</h1>
      <p>Etiquetas detalladas para encontrar referencias por características. Independientes del conteo físico y de Notion.</p></div>
      <img src="/lubricenter-logo.png" alt="Lubricenter"/>
    </section>
    <div className="row" style={{flexWrap:"wrap",gap:8}}>
      <Link className="btn btn-ghost" href="/inventory">← Inventario</Link>
      <Link className="btn btn-ghost" href="/catalog">Catálogo comercial</Link>
      <button className="btn" disabled={loading} onClick={()=>void load()}>{loading?"Cargando…":"Recargar fichas"}</button>
    </div>
    <section className="card stack">
      <div className="row" style={{flexWrap:"wrap",gap:8}}>
        <button className={"btn "+(mode==="stock"?"btn-primary":"btn-ghost")} onClick={()=>{setMode("stock");reset();}}>Inventario · {stock.length}</button>

      </div>
      <p className="muted small">Se clasifican SKU de inventario y productos de venta por separado. Vincularlos y validar equivalencias será una tarea independiente; no se supone compatibilidad por nombre o medidas.</p>
      <div className="grid grid-3">
        <label><span className="label">Buscar cualquier característica o código</span>
          <input className="input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="3387, 15W-40, Wix, M20x1.5…"/></label>
        <Select label="Familia" value={family||null} options={FAMILIES} change={v=>setFamily(v||"")}/>
        <label><span className="label">Categoría</span><select className="input" value={category} onChange={e=>setCategory(e.target.value)}>
          <option value="">Todas</option>{categories.map(c=><option key={c}>{c}</option>)}
        </select></label>
        <label><span className="label">Marca</span><select className="input" value={brand} onChange={e=>setBrand(e.target.value)}>
          <option value="">Todas</option>{brands.map(b=><option key={b}>{b}</option>)}
        </select></label>
        <label><span className="label">Viscosidad</span><select className="input" value={viscosity} onChange={e=>setViscosity(e.target.value)}>
          <option value="">Todas</option>{viscosities.map(v=><option key={v}>{v}</option>)}
        </select></label>
        <Select label="Base mineral / semi / full" value={base||null} options={OIL_BASES} change={v=>setBase(v||"")}/>
        <Select label="Sistema" value={system||null} options={OIL_SYSTEMS} change={v=>setSystem(v||"")}/>
        <Select label="Combustible" value={fuel||null} options={FUEL_TYPES} change={v=>setFuel(v||"")}/>
        <Select label="Tipo de filtro" value={filterType||null} options={FILTER_TYPES} change={v=>setFilterType(v||"")}/>
      </div>
      <div className="row-between" style={{flexWrap:"wrap",gap:8}}>
        <label className="row"><input type="checkbox" checked={missing} onChange={e=>setMissing(e.target.checked)}/><span>Solo sin clasificar</span></label>
        <button className="btn btn-ghost" onClick={reset}>Limpiar filtros</button>
      </div>
    </section>
    {error&&<div className="error" role="alert">{error}</div>}
    {notice&&<div className="success" role="status">{notice}</div>}
    <div className="row-between" style={{flexWrap:"wrap",gap:8}}>
      <h2 className="section-title" style={{margin:0}}>Referencias y fichas técnicas</h2>
      <span className="muted small">{filtered.length} coincidencias · {entries.filter(x=>x.spec?.family).length} clasificadas de {entries.length}</span>
    </div>
    {loading&&<div className="card muted">Cargando referencias…</div>}
    {!loading&&<section className="stack" style={{gap:8}}>
      {filtered.slice(0,200).map(e=>{
        const s=e.spec;
        const tags=[s?.brand||e.brand,s?.viscosity,s?.lubricant_base?BASE_NAMES[s.lubricant_base]:null,
          s?.lubricant_system?SYSTEM_NAMES[s.lubricant_system]:null,
          s?.filter_type?FILTER_NAMES[s.filter_type]:null,s?.filter_thread,
          s?.millard_reference?"Millard "+s.millard_reference:null,...(s?.additional_tags??[])
        ].filter((v):v is string=>!!v);
        return <article className="card" key={e.id} style={{padding:12}}>
          <div className="row-between" style={{gap:12,flexWrap:"wrap",alignItems:"start"}}>
            <div className="stack" style={{gap:5,flex:"1 1 240px"}}>
              <div className="row" style={{gap:7,flexWrap:"wrap"}}>
                <strong>{e.label}</strong>
                <span className={"pill "+(s?.family?"ok":"warn")}>
                  {s?.family?FAMILY_NAMES[s.family]:"Sin clasificar"}
                </span>{e.needs_review&&<span className="pill warn">Stock por revisar</span>}
              </div>
              <span className="muted small">{e.category||"Sin categoría"}</span>
              <div className="row" style={{gap:5,flexWrap:"wrap"}}>
                {tags.map((t,i)=><span className="pill" key={i}>{t}</span>)}
              </div>
            </div>
            <button className="btn btn-ghost" onClick={()=>open(e)}>{s?.family?"Editar etiquetas":"Clasificar"}</button>
          </div>
        </article>;
      })}
      {!filtered.length&&<div className="card muted">No hay referencias con esos filtros.</div>}
      {filtered.length>200&&<span className="small muted">Mostrando 200 coincidencias; acota la búsqueda para ver las demás.</span>}
    </section>}

    {editing&&<div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-label="Editar etiquetas técnicas" style={{maxWidth:780,maxHeight:"92vh",overflowY:"auto"}}>
      <div className="row-between" style={{gap:8,alignItems:"start"}}>
        <div><div className="eyebrow">FICHA TÉCNICA</div><h2 style={{margin:0}}>{editingName}</h2></div>
        <button className="btn btn-ghost" onClick={()=>{setEditing(null);setError("");}}>Cerrar</button>
      </div>
      <p className="muted small">Completa únicamente los datos comprobados en el envase o ficha técnica. Guardar no afecta cantidades, precios ni el historial de ventas.</p>
      <div className="grid grid-2">
        <Select label="Familia" value={editing.family} options={FAMILIES} change={v=>update("family",v as Family|null)}/>
        <Txt label="Marca" value={editing.brand} change={v=>update("brand",v)} placeholder="Marca comercial"/>
      </div>
      {editing.family==="OIL"&&<>
        <h3>Lubricantes</h3><div className="grid grid-2">
          <Txt label="Viscosidad / grado SAE" value={editing.viscosity} change={v=>update("viscosity",v)} placeholder="15W-40, 5W-30, 75W-90…"/>
          <Select label="Composición" value={editing.lubricant_base} options={OIL_BASES} change={v=>update("lubricant_base",v)}/>
          <Select label="Sistema de uso" value={editing.lubricant_system} options={OIL_SYSTEMS} change={v=>update("lubricant_system",v)}/>
          <Select label="Motor gasolina / diésel" value={editing.fuel_application} options={FUEL_TYPES} change={v=>update("fuel_application",v)}/>
          <Num label="Presentación (litros)" value={editing.volume_liters} change={v=>update("volume_liters",v)}/>
          <Txt label="API" value={editing.oil_api} change={v=>update("oil_api",v)} placeholder="SP, CK-4…"/>
          <Txt label="ACEA" value={editing.oil_acea} change={v=>update("oil_acea",v)} placeholder="A3/B4, C3…"/>
          <Txt label="JASO" value={editing.oil_jaso} change={v=>update("oil_jaso",v)} placeholder="MA2, MB…"/>
          <Txt label="Dexron / Mercon / GL / CVT" value={editing.lubricant_spec} change={v=>update("lubricant_spec",v)} placeholder="Dexron III, GL-5…"/>
          <Txt label="Homologaciones OEM" value={editing.oil_oem_approvals} change={v=>update("oil_oem_approvals",v)}/>
        </div>
      </>}
      {editing.family==="FILTER"&&<>
        <h3>Filtros</h3><div className="grid grid-2">
          <Select label="Tipo de filtro" value={editing.filter_type} options={FILTER_TYPES} change={v=>update("filter_type",v)}/>
          <Select label="Forma / construcción" value={editing.filter_design} options={FILTER_DESIGNS} change={v=>update("filter_design",v)}/>
          <Txt label="Rosca" value={editing.filter_thread} change={v=>update("filter_thread",v)} placeholder="M20x1.5, 3/4-16…"/>
          <Txt label="Referencia Millard documentada" value={editing.millard_reference} change={v=>update("millard_reference",v)}/>
          <Txt label="Referencia OEM" value={editing.oem_reference} change={v=>update("oem_reference",v)}/>
          <Select label="Medio filtrante" value={editing.filter_media} options={FILTER_MEDIA} change={v=>update("filter_media",v)}/>
          <Num label="Altura (mm)" value={editing.filter_height_mm} change={v=>update("filter_height_mm",v)}/>
          <Num label="Diámetro exterior (mm)" value={editing.filter_outer_diameter_mm} change={v=>update("filter_outer_diameter_mm",v)}/>
          <Num label="Diámetro interior (mm)" value={editing.filter_inner_diameter_mm} change={v=>update("filter_inner_diameter_mm",v)}/>
          <Num label="Largo (mm)" value={editing.filter_length_mm} change={v=>update("filter_length_mm",v)}/>
          <Num label="Ancho (mm)" value={editing.filter_width_mm} change={v=>update("filter_width_mm",v)}/>
          <Num label="Junta: diámetro interior (mm)" value={editing.filter_gasket_inner_mm} change={v=>update("filter_gasket_inner_mm",v)}/>
          <Num label="Junta: diámetro exterior (mm)" value={editing.filter_gasket_outer_mm} change={v=>update("filter_gasket_outer_mm",v)}/>
          <Txt label="Conexión" value={editing.filter_connector} change={v=>update("filter_connector",v)}/>
          <Select label="Combustible compatible" value={editing.fuel_application} options={FUEL_TYPES} change={v=>update("fuel_application",v)}/>
          <label><span className="label">Separador de agua</span><select className="input"
            value={editing.filter_water_separator===null?"":editing.filter_water_separator?"YES":"NO"}
            onChange={e=>update("filter_water_separator",e.target.value===""?null:e.target.value==="YES")}>
            <option value="">Sin especificar</option><option value="YES">Sí</option><option value="NO">No</option></select></label>
        </div>
        <Txt label="Notas sobre aplicaciones (pendientes de verificar)" value={editing.fitment_notes} change={v=>update("fitment_notes",v)}/>
      </>}
      <div className="grid grid-2">
        <label><span className="label">Etiquetas adicionales (separadas por comas)</span>
          <input className="input" value={editing.additional_tags.join(", ")}
            onChange={e=>update("additional_tags",e.target.value.split(","))} placeholder="Alta rotación, premium, caja 12 L"/></label>
        <Txt label="Fuente de la ficha técnica" value={editing.evidence_source} change={v=>update("evidence_source",v)} placeholder="Etiqueta, ficha fabricante, enlace…"/>
      </div>
      <div className="row-between" style={{gap:10,flexWrap:"wrap"}}>
        <span className="pill warn">Pendiente de validación técnica</span>
        <button className="btn btn-primary" disabled={busy} onClick={()=>void save()}>{busy?"Guardando…":"Guardar etiquetas"}</button>
      </div>
      {error&&<div className="error" role="alert">{error}</div>}
      {notice&&<div className="success">{notice}</div>}
      {editing.family==="FILTER"&&<>
        <hr/><h3>Referencias cruzadas · futura búsqueda Millard</h3>
        <p className="muted small">Se registran como PENDIENTES, no como equivalencias verificadas. Una coincidencia de rosca no demuestra compatibilidad.</p>
        {crossrefs.filter(x=>x.technical_spec_id===editing.id).map(x=><div key={x.id} className="card row-between"><strong>{x.reference_brand} · {x.reference_code}</strong><span className="pill warn">Pendiente</span></div>)}
        <div className="grid grid-2">
          <Txt label="Marca del código" value={refBrand} change={v=>setRefBrand(v||"")} placeholder="Millard, Wix, OEM…"/>
          <Txt label="Referencia" value={refCode} change={v=>setRefCode(v||"")} placeholder="Código exacto"/>
          <Select label="Tipo de referencia" value={refKind} options={[["MILLARD","Millard"],["COMPETITOR","Otra marca"],["OEM","Original / OEM"]]} change={v=>setRefKind(v||"COMPETITOR")}/>
          <Txt label="Fuente" value={refSource} change={v=>setRefSource(v||"")} placeholder="Fabricante, catálogo, ficha…"/>
        </div>
        <button className="btn" disabled={!editing.id||!refBrand.trim()||!refCode.trim()||busy} onClick={()=>void addCrossref()}>+ Agregar referencia pendiente</button>
        {!editing.id&&<p className="muted small">Guarda primero la ficha para registrar códigos cruzados.</p>}
      </>}
    </div></div>}
  </main>;
}

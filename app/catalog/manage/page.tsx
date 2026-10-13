"use client";
import Link from "next/link";
import {useCallback,useEffect,useMemo,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef,fmtVes} from "@/lib/format";
import {parseInvoiceCaptureLines,validateCatalogPrice,type InvoiceCaptureLine} from "@/lib/catalog-management";

type Item={
 id:string;name:string;category:string|null;filter_code:string|null;
 cash_usd_base_price:number;active:boolean;available:boolean;
 notes:string|null;image_url:string|null;updated_at:string;catalog_source:string|null;
};
type CatalogRate={id:string;cash_usd_base_price:number;current_price_ves:number|null;current_ref_bcv:number|null};
type Form={
 id:string|null;name:string;category:string;filter_code:string;price:string;
 notes:string;image:string;active:boolean;available:boolean;updated_at:string|null;
};
const blank=():Form=>({id:null,name:"",category:"",filter_code:"",price:"",
 notes:"",image:"",active:false,available:false,updated_at:null});
const money=(v:number|null|undefined)=>(v==null?"—":fmtRef(v));
function formatWhen(t:string){return new Date(t).toLocaleString("es-VE",{timeZone:"America/Caracas",dateStyle:"short",timeStyle:"short"});}
export default function ManageCatalog(){
 const [items,setItems]=useState<Item[]>([]);
 const [currentPrices,setCurrentPrices]=useState<CatalogRate[]>([]);
 const [role,setRole]=useState(false);
 const [isNative,setIsNative]=useState(false);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [search,setSearch]=useState("");
 const [categoryFilter,setCategoryFilter]=useState("ALL");
 const [statusFilter,setStatusFilter]=useState("ALL");
 const [form,setForm]=useState<Form|null>(null);
 const [invoiceOpen,setInvoiceOpen]=useState(false);
 const [supplier,setSupplier]=useState("");
 const [invoiceNumber,setInvoiceNumber]=useState("");
 const [invoiceDate,setInvoiceDate]=useState("");
 const [currency,setCurrency]=useState("USD");
 const [invoiceText,setInvoiceText]=useState("");
 const [invoiceNote,setInvoiceNote]=useState("");
 const [notice,setNotice]=useState("");
 const [error,setError]=useState("");
 const [history,setHistory]=useState<Array<{id:string;changed_at:string;before_state:any;after_state:any}>>([]);
 const [showHistory,setShowHistory]=useState(false);

 const load=useCallback(async()=>{
  setLoading(true);setError("");
  const [products,permissions,settings,snap]=await Promise.all([
    supabase.from("products").select("id,name,category,filter_code,cash_usd_base_price,notes,image_url,available,active,updated_at,catalog_source")
      .order("name").limit(2000),
    supabase.rpc("can_administer_orders"),
    supabase.from("app_settings").select("value").eq("key","catalog_authority").maybeSingle(),
    supabase.rpc("get_catalog_snapshot"),
  ]);
  setLoading(false);
  if(products.error||permissions.error||settings.error||snap.error){
   setError((products.error||permissions.error||settings.error||snap.error)?.message||"No se pudo cargar el catálogo.");
   return;
  }
  setItems((products.data||[]) as Item[]);
  setRole(permissions.data===true);
  setIsNative(settings.data?.value==="LUBRICENTER_OS");
  setCurrentPrices((snap.data||[]) as CatalogRate[]);
 },[]);
 useEffect(()=>{void load();},[load]);
 const categories=useMemo(()=>Array.from(new Set(items.map(x=>x.category).filter((x):x is string=>!!x))).sort(),[items]);
 const filtered=useMemo(()=>items.filter(p=>{
  if(categoryFilter!=="ALL"&&p.category!==categoryFilter)return false;
  if(statusFilter==="ACTIVE"&&(!p.active||!p.available))return false;
  if(statusFilter==="HIDDEN"&&(p.active&&p.available))return false;
  const haystack=[p.name,p.filter_code,p.category,p.notes].filter(Boolean).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es-VE");
  const term=search.normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLocaleLowerCase("es-VE");
  return haystack.includes(term);
 }),[items,categoryFilter,statusFilter,search]);
 function edit(p:Item){
  setForm({id:p.id,name:p.name,category:p.category||"",filter_code:p.filter_code||"",
   price:String(p.cash_usd_base_price),notes:p.notes||"",image:p.image_url||"",active:p.active,
   available:p.available,updated_at:p.updated_at});setNotice("");setError("");setShowHistory(false);setHistory([]);
 }
 async function showAudit(){
  if(!form?.id)return;
  const r=await supabase.from("catalog_product_changes").select("id,changed_at,before_state,after_state")
   .eq("product_id",form.id).order("changed_at",{ascending:false}).limit(30);
  if(r.error){setError(r.error.message);return;}
  setHistory(r.data||[]);setShowHistory(true);
 }
 async function save(){
  if(!form||busy||!role||!isNative)return;
  setNotice("");setError("");
  const price=Number(form.price.replace(",","."));
  const error=validateCatalogPrice(price,form.active,form.available);
  if(error){setError(error);return;}
  if(form.name.trim().length<2){setError("Indica el nombre completo del producto.");return;}
  setBusy(true);
  const result=await supabase.rpc("catalog_save_product",{
   p_id:form.id,p_name:form.name,p_category:form.category,p_filter_code:form.filter_code,
   p_usd:price,p_notes:form.notes,p_image_url:form.image,
   p_available:form.available,p_active:form.active,p_expected_updated_at:form.updated_at
  });
  setBusy(false);
  if(result.error){setError(result.error.message);return;}
  setForm(null);setNotice("Producto guardado con historial de auditoría. No se alteró su inventario.");
  await load();
 }
 const parsed=useMemo(()=>{
  if(!invoiceText.trim())return {lines:[] as InvoiceCaptureLine[],error:""};
  try{return {lines:parseInvoiceCaptureLines(invoiceText),error:""};}
  catch(ex){return{lines:[] as InvoiceCaptureLine[],error:ex instanceof Error?ex.message:String(ex)};}
 },[invoiceText]);
 async function importInvoice(){
  if(busy||!role||!isNative)return;
  setError("");setNotice("");
  if(parsed.error||!parsed.lines.length){setError(parsed.error||"Agrega al menos una línea.");return;}
  if(supplier.trim().length<2||!invoiceNumber.trim()){setError("Indica proveedor y número de factura.");return;}
  setBusy(true);
  const result=await supabase.rpc("catalog_register_invoice_items",{
    p_supplier_name:supplier.trim(),p_invoice_number:invoiceNumber.trim(),
    p_currency:currency,p_invoice_date:invoiceDate||null,
    p_lines:parsed.lines,p_note:invoiceNote.trim()||null
  });
  setBusy(false);
  if(result.error){setError(result.error.message);return;}
  setInvoiceOpen(false);
  setInvoiceNumber("");setInvoiceText("");setInvoiceNote("");
  setNotice("Factura captada: "+Number(result.data?.created??0)+
    " productos nuevos en borrador, "+Number(result.data?.matched??0)+
    " existentes identificados. Sin sumar cantidades a inventario ni cambiar precios de venta.");
  await load();
 }
 return <main className="container stack">
  <section className="row-between" style={{alignItems:"start",gap:12,flexWrap:"wrap"}}>
   <div><div className="eyebrow">LUBRICENTER OS · FUENTE OFICIAL</div>
    <h1>Administrar catálogo</h1>
    <p className="muted">Crea, modifica, clasifica y archiva artículos sin depender de Notion. El inventario físico se administra por separado.</p>
   </div>
   <div className="row" style={{gap:8,flexWrap:"wrap"}}>
    <Link href="/catalog" className="btn btn-ghost">Ver catálogo</Link>
    <Link href="/catalog/technical" className="btn btn-ghost">Fichas técnicas</Link>
    <Link href="/inventory" className="btn btn-ghost">Inventario</Link>
   </div>
  </section>
  {!isNative&&!loading&&<div className="card stack"><strong>Preparado para el cambio de fuente</strong>
   <p className="muted">El catálogo todavía pertenece a Notion. El editor se habilitará al activar la migración auditada de Lubricenter OS; no se harán cambios parciales.</p></div>}
  {!role&&!loading&&<div className="card muted">Solo la cuenta administradora de órdenes puede crear o modificar artículos y capturar facturas.</div>}
  {error&&<div className="error" role="alert">{error}</div>}
  {notice&&<div className="success" role="status">{notice}</div>}
  <section className="row-between" style={{gap:10,flexWrap:"wrap"}}>
   <div><strong>{items.length} artículos totales · {items.filter(p=>p.active&&p.available).length} publicados</strong>
   <div className="muted small">No se importaron las cantidades desactualizadas del Excel.</div></div>
   <div className="row" style={{gap:8,flexWrap:"wrap"}}>
    <button className="btn" onClick={()=>void load()} disabled={loading}>Actualizar</button>
    {role&&isNative&&<><button className="btn" onClick={()=>{setInvoiceOpen(true);setForm(null);setError("");}}>
     + Artículos desde factura
    </button><button className="btn btn-primary" onClick={()=>{setForm(blank());setError("");setNotice("");}}>+ Crear artículo</button></>}
   </div>
  </section>
  <section className="card stack">
   <div className="grid grid-3">
    <label><span className="label">Buscar artículo, código o descripción</span>
     <input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Aceite 15W-40, filtro 3387…"/></label>
    <label><span className="label">Categoría</span><select className="select" value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}>
     <option value="ALL">Todas</option>{categories.map(c=><option key={c} value={c}>{c}</option>)}
    </select></label>
    <label><span className="label">Estado</span><select className="select" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
     <option value="ALL">Todos</option><option value="ACTIVE">Disponibles</option><option value="HIDDEN">Borradores y archivados</option>
    </select></label>
   </div>
  </section>
  <section className="stack" aria-busy={loading}>
   <div className="muted small">{filtered.length} resultados</div>
   {filtered.map(p=>{
    const ref=currentPrices.find(x=>x.id===p.id);
    return <article key={p.id} className="card" style={{padding:14}}>
     <div className="row-between" style={{gap:12,alignItems:"center",flexWrap:"wrap"}}>
      <div className="row" style={{gap:12,flex:"1 1 260px",alignItems:"center"}}>
       <div style={{width:65,height:65,flexShrink:0,background:"var(--surface-secondary)",borderRadius:8,overflow:"hidden",display:"grid",placeItems:"center"}}>
        {p.image_url?<img src={p.image_url} alt="" style={{width:"100%",height:"100%",objectFit:"contain"}}/>:"Sin foto"}
       </div>
       <div className="stack" style={{gap:4}}>
        <strong>{p.name}</strong><span className="muted small">{p.category||"Sin categoría"}{p.filter_code?" · "+p.filter_code:""}</span>
        <span className={"pill "+(p.active&&p.available?"ok":"warn")} style={{alignSelf:"start"}}>{p.active&&p.available?"Disponible":"No publicado"}</span>
       </div>
      </div>
      <div className="stack" style={{gap:3,minWidth:150}}>
       <strong>{fmtRef(p.cash_usd_base_price)} <span className="muted small">precio divisas</span></strong>
       <span className="small">{money(ref?.current_ref_bcv)} a BCV</span>
       <span className="small muted">{ref?.current_price_ves==null?"—":fmtVes(ref.current_price_ves)} Bs</span>
      </div>
      {role&&isNative&&<button className="btn btn-ghost" onClick={()=>edit(p)}>Editar artículo</button>}
     </div>
    </article>;
   })}
   {loading&&<div className="card muted">Cargando catálogo…</div>}
   {!loading&&!filtered.length&&<div className="card muted">No hay artículos con esos filtros.</div>}
  </section>

  {form&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Editor de artículo"
    style={{maxWidth:760,maxHeight:"92vh",overflowY:"auto"}}>
   <div className="row-between"><h2>{form.id?"Editar artículo":"Nuevo artículo"}</h2>
    <button className="btn btn-ghost" onClick={()=>{setForm(null);setError("");}}>Cerrar</button></div>
   <p className="muted small">Precio en divisas como base comercial; $ BCV y Bs se calculan con las tasas vigentes. Las cantidades nunca se editan aquí.</p>
   <div className="grid grid-2">
    <label><span className="label">Nombre comercial</span><input className="input" value={form.name} onChange={e=>setForm(x=>x?{...x,name:e.target.value}:x)}/></label>
    <label><span className="label">Categoría</span><input className="input" value={form.category} onChange={e=>setForm(x=>x?{...x,category:e.target.value}:x)}/></label>
    <label><span className="label">Código / referencia del producto</span><input className="input" value={form.filter_code} onChange={e=>setForm(x=>x?{...x,filter_code:e.target.value}:x)}/></label>
    <label><span className="label">Precio base en divisas (USD)</span><input className="input" inputMode="decimal" value={form.price} onChange={e=>setForm(x=>x?{...x,price:e.target.value}:x)}/></label>
   </div>
   <label><span className="label">Descripción / notas</span><textarea className="input" rows={3} value={form.notes} onChange={e=>setForm(x=>x?{...x,notes:e.target.value}:x)}/></label>
   <label><span className="label">URL HTTPS de fotografía</span><input className="input" value={form.image} onChange={e=>setForm(x=>x?{...x,image:e.target.value}:x)} placeholder="https://…"/></label>
   <div className="row" style={{flexWrap:"wrap",gap:16}}>
    <label className="row"><input type="checkbox" checked={form.active} onChange={e=>setForm(x=>x?{...x,active:e.target.checked}:x)}/><span>Artículo activo</span></label>
    <label className="row"><input type="checkbox" checked={form.available} onChange={e=>setForm(x=>x?{...x,available:e.target.checked}:x)}/><span>Disponible para vender</span></label>
   </div>
   {!form.active||!form.available?<div className="muted small">Al no publicar un artículo, sus órdenes anteriores conservan la información original.</div>:null}
   {error&&<div className="error">{error}</div>}
   <div className="row" style={{gap:8,flexWrap:"wrap"}}>
    <button className="btn btn-primary" disabled={busy} onClick={()=>void save()}>{busy?"Guardando…":"Guardar artículo"}</button>
    {form.id&&<button className="btn" disabled={busy} onClick={()=>void showAudit()}>Ver historial</button>}
   </div>
   {showHistory&&<div className="stack"><h3>Historial del artículo</h3>
    {history.map(h=><div className="card small" key={h.id}><strong>{formatWhen(h.changed_at)}</strong>
     <div className="muted">Antes: {h.before_state?.name??"Nuevo"} · USD {h.before_state?.cash_usd_base_price??"—"}</div>
     <div>Después: {h.after_state?.name} · USD {h.after_state?.cash_usd_base_price}</div></div>)}
    {!history.length&&<p className="muted small">Sin modificaciones internas registradas todavía.</p>}
   </div>}
  </section></div>}
  {invoiceOpen&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Capturar artículos de factura"
    style={{maxWidth:850,maxHeight:"92vh",overflowY:"auto"}}>
   <div className="row-between"><h2>Captar artículos desde factura</h2><button className="btn btn-ghost" onClick={()=>{setInvoiceOpen(false);setError("");}}>Cerrar</button></div>
   <p className="muted small">Esto es una captura del catálogo, NO contabiliza la factura ni recibe mercancía. Las cantidades del documento quedan guardadas solo como referencia, no como stock físico.</p>
   <div className="grid grid-2">
    <label><span className="label">Proveedor</span><input className="input" value={supplier} onChange={e=>setSupplier(e.target.value)} placeholder="Nombre del proveedor"/></label>
    <label><span className="label">N.º de factura</span><input className="input" value={invoiceNumber} onChange={e=>setInvoiceNumber(e.target.value)}/></label>
    <label><span className="label">Fecha factura</span><input type="date" className="input" value={invoiceDate} onChange={e=>setInvoiceDate(e.target.value)}/></label>
    <label><span className="label">Moneda del costo</span><select className="select" value={currency} onChange={e=>setCurrency(e.target.value)}><option value="USD">USD</option><option value="VES">Bolívares</option></select></label>
   </div>
   <label><span className="label">Líneas de factura (una por fila)</span>
    <textarea className="input" rows={9} value={invoiceText} onChange={e=>setInvoiceText(e.target.value)}
     placeholder={"Nombre; Código; Categoría; Cantidad; Costo unitario\nAceite DK9 15W-40 semi; DK9-1540; Aceites; 12; 4,50\nFiltro 3387 Wix; 3387; Filtros; 6; 2,10"}/>
   </label>
   <p className="muted small">Puedes copiar las cinco columnas desde Excel, separadas por tabulaciones, o escribirlas con punto y coma. Los costos de compra NO reemplazan el precio de venta. Los productos nuevos se crean sin publicar para fijar precio y comprobar existencia.</p>
   <label><span className="label">Nota interna</span><input className="input" value={invoiceNote} onChange={e=>setInvoiceNote(e.target.value)} placeholder="Ej. llegada parcial o por validar"/></label>
   <div className="card stack">
    <strong>Vista previa · {parsed.lines.length} referencias</strong>
    {parsed.error?<div className="error">{parsed.error}</div>:<div className="muted small">{parsed.lines.slice(0,8).map(x=>x.name+" · "+x.quantity+" ud. · "+x.unit_cost+" "+currency).join(" | ")}</div>}
    {parsed.lines.length>8&&<span className="muted small">+ {parsed.lines.length-8} líneas adicionales</span>}
   </div>
   {error&&<div className="error">{error}</div>}
   <button className="btn btn-primary" disabled={busy||!!parsed.error||!parsed.lines.length} onClick={()=>void importInvoice()}>
    {busy?"Validando y registrando…":"Registrar artículos de la factura (sin tocar stock)"}
   </button>
   <p className="small muted">Para contabilizar compras y recibir existencias utiliza el módulo de proveedores y facturas de compras.</p>
  </section></div>}
 </main>;
}

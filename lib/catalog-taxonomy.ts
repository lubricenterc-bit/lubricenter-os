export const FAMILIES = [
  ["OIL","Aceites y lubricantes"],
  ["FILTER","Filtros"],
  ["OTHER","Otros consumibles"],
] as const;
export const OIL_BASES = [["MINERAL","Mineral"],["SEMI","Semisintético"],["FULL","Full sintético"]] as const;
export const OIL_SYSTEMS = [
  ["ENGINE","Motor"],["MANUAL_GEARBOX","Caja manual"],["ATF","Caja automática / ATF"],
  ["CVT","Caja CVT"],["DCT","Doble embrague / DCT"],["DIFFERENTIAL","Diferencial"],
  ["HYDRAULIC","Hidráulico"],["POWER_STEERING","Dirección hidráulica"],
  ["MOTORCYCLE","Motocicleta"],["OTHER","Otro"],
] as const;
export const FUEL_TYPES = [
  ["GASOLINE","Gasolina"],["DIESEL","Diésel / gasoil"],["BOTH","Ambos"],
  ["NA","No aplica"],
] as const;
export const FILTER_TYPES = [
  ["OIL","Aceite"],["ENGINE_AIR","Aire motor"],["FUEL","Combustible"],
  ["CABIN","Cabina"],["TRANSMISSION","Transmisión"],["HYDRAULIC","Hidráulico"],
  ["OTHER","Otro"],
] as const;
export const FILTER_DESIGNS = [
  ["SPIN_ON","Enroscable"],["CARTRIDGE","Cartucho"],["PANEL","Panel"],
  ["CYLINDRICAL","Cilíndrico"],["INLINE","En línea"],["OTHER","Otro"],
] as const;
export const FILTER_MEDIA = [["PAPER","Papel"],["SYNTHETIC","Sintético"],["CARBON","Carbón activo"],["OTHER","Otro"]] as const;

export type Family = "OIL"|"FILTER"|"OTHER";
export type CatalogTechSpec = {
  id?:string;
  product_id:string|null;
  inventory_item_id:string|null;
  family:Family|null;
  brand:string|null;
  viscosity:string|null;
  lubricant_base:string|null;
  lubricant_system:string|null;
  fuel_application:string|null;
  volume_liters:number|null;
  oil_api:string|null;
  oil_acea:string|null;
  oil_jaso:string|null;
  oil_oem_approvals:string|null;
  lubricant_spec:string|null;
  filter_type:string|null;
  filter_design:string|null;
  filter_thread:string|null;
  filter_height_mm:number|null;
  filter_outer_diameter_mm:number|null;
  filter_inner_diameter_mm:number|null;
  filter_length_mm:number|null;
  filter_width_mm:number|null;
  filter_gasket_inner_mm:number|null;
  filter_gasket_outer_mm:number|null;
  filter_media:string|null;
  filter_connector:string|null;
  filter_water_separator:boolean|null;
  millard_reference:string|null;
  oem_reference:string|null;
  fitment_notes:string|null;
  additional_tags:string[];
  evidence_source:string|null;
  verification_status:"PENDING"|"DOCUMENTED"|"VERIFIED";
};

export const TEXT_FIELDS = [
  "brand","viscosity","oil_api","oil_acea","oil_jaso","oil_oem_approvals",
  "lubricant_spec","filter_thread","filter_connector","millard_reference",
  "oem_reference","fitment_notes","evidence_source",
] as const;
export const NUMERIC_FIELDS = [
  "volume_liters","filter_height_mm","filter_outer_diameter_mm",
  "filter_inner_diameter_mm","filter_length_mm","filter_width_mm",
  "filter_gasket_inner_mm","filter_gasket_outer_mm",
] as const;

export function suggestedFamily(category:string|null):Family|null {
  const lower=(category||"").toLowerCase();
  if(/filtro/.test(lower))return "FILTER";
  if(/aceite|valvulina|hidraul|lubrican/.test(lower))return "OIL";
  return null;
}
export function technicalSearchText(source:{sku?:string|null;name?:string|null;brand?:string|null;description?:string|null;category?:string|null}, spec:Partial<CatalogTechSpec>|null):string {
  return [
    source.sku,source.name,source.brand,source.description,source.category,
    spec?.brand,spec?.viscosity,spec?.lubricant_base,spec?.lubricant_system,
    spec?.fuel_application,spec?.lubricant_spec,spec?.oil_api,spec?.oil_acea,
    spec?.oil_jaso,spec?.oil_oem_approvals,spec?.filter_type,spec?.filter_design,
    spec?.filter_thread,spec?.filter_connector,spec?.millard_reference,
    spec?.oem_reference,spec?.fitment_notes,...(spec?.additional_tags??[]),
  ].filter(Boolean).join(" ").toLocaleLowerCase("es-VE");
}
export function emptyTechnicalSpec(product_id:string|null,inventory_item_id:string|null,family:Family|null=null):CatalogTechSpec {
  return {
    product_id,inventory_item_id,family,brand:null,viscosity:null,lubricant_base:null,
    lubricant_system:null,fuel_application:null,volume_liters:null,
    oil_api:null,oil_acea:null,oil_jaso:null,oil_oem_approvals:null,lubricant_spec:null,
    filter_type:null,filter_design:null,filter_thread:null,
    filter_height_mm:null,filter_outer_diameter_mm:null,filter_inner_diameter_mm:null,
    filter_length_mm:null,filter_width_mm:null,filter_gasket_inner_mm:null,
    filter_gasket_outer_mm:null,filter_media:null,filter_connector:null,
    filter_water_separator:null,millard_reference:null,oem_reference:null,
    fitment_notes:null,additional_tags:[],evidence_source:null,verification_status:"PENDING",
  };
}
export function normalizeTechnicalSpec(spec:CatalogTechSpec):CatalogTechSpec {
  const result={...spec,additional_tags:Array.from(new Set((spec.additional_tags||[])
    .map(x=>x.trim()).filter(x=>x.length>0))).slice(0,30)};
  for(const field of TEXT_FIELDS)result[field]=result[field]?.trim()||null;
  for(const field of NUMERIC_FIELDS){
    const v=result[field];
    result[field]=v==null||String(v).trim()===""?null:Number(v);
    if(result[field]!==null&&(!Number.isFinite(result[field])||result[field]<=0))
      throw Error("Las medidas y volúmenes deben ser mayores que cero.");
  }
  if(!result.family){
    const blank=emptyTechnicalSpec(result.product_id,result.inventory_item_id);
    return {...blank,id:result.id};
  }
  if(result.family!=="OIL"){
    result.viscosity=null;result.lubricant_base=null;result.lubricant_system=null;
    result.oil_api=null;result.oil_acea=null;result.oil_jaso=null;
    result.oil_oem_approvals=null;result.lubricant_spec=null;
  }
  if(result.family!=="FILTER"){
    result.filter_type=null;result.filter_design=null;result.filter_thread=null;
    result.filter_height_mm=null;result.filter_outer_diameter_mm=null;
    result.filter_inner_diameter_mm=null;result.filter_length_mm=null;
    result.filter_width_mm=null;result.filter_gasket_inner_mm=null;
    result.filter_gasket_outer_mm=null;result.filter_media=null;
    result.filter_connector=null;result.filter_water_separator=null;
    result.millard_reference=null;result.oem_reference=null;result.fitment_notes=null;
  }
  result.verification_status="PENDING"; // future verified classification requires a separate controlled review process
  return result;
}

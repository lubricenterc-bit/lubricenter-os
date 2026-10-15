export type InvoiceCaptureLine = {
 name:string;sku:string;category:string;quantity:number;unit_cost:number;
};
export function parseInvoiceCaptureLines(source:string):InvoiceCaptureLine[]{
 const lines=source.trim().split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(!lines.length)throw Error("Agrega al menos un artículo a la factura.");
 if(lines.length>150)throw Error("Máximo 150 líneas por factura.");
 const result:InvoiceCaptureLine[]=[];
 for(const [index,line] of lines.entries()){
   // Excel pastes tabs; semicolon-delimited text supports names containing commas.
   const parts=(line.includes("\t")?line.split("\t"):line.split(";")).map(x=>x.trim());
   if(parts.length!==5)throw Error("Línea "+(index+1)+": escribe nombre; código; categoría; cantidad; costo.");
   const [name,sku,category,rawQuantity,rawCost]=parts;
   const quantity=Number(rawQuantity.replace(",","."));
   const unit_cost=Number(rawCost.replace(",","."));
   if(rawQuantity===""||rawCost===""||name.length<2||name.length>180||sku.length>100||category.length>120||
      !Number.isFinite(quantity)||quantity<=0||quantity>1e6||
      !Number.isFinite(unit_cost)||unit_cost<0||unit_cost>1e6)
     throw Error("Línea "+(index+1)+": valida nombre, cantidad y costo.");
   result.push({name,sku,category,quantity,unit_cost});
 }
 // Duplicate names must be reconciled before an atomic intake.
 const seen=new Set<string>();
 for(const row of result){const key=row.name.trim().toLocaleLowerCase("es-VE");if(seen.has(key))throw Error("El artículo "+row.name+" aparece repetido en la factura.");seen.add(key);}
 return result;
}
export function validateCatalogPrice(price:number,active:boolean,available:boolean){
 if(!Number.isFinite(price)||price<0||price>1e6)return "El precio debe ser válido y no negativo.";
 if(active&&available&&price<=0)return "No publiques un artículo sin precio de venta.";
 return null;
}

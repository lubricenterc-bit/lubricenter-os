// Browser-side A4 PDF generator. No new dependency and no server-side payroll data exposure.
// Supports Spanish text via WinAnsi/Latin-1 encoding. All output is clearly draft.
export type DraftPayrollLine={
  order:string;description:string;earnedOn:string;decision:string;commission:number;
  detail:string[];cashea?:string;
};
export type DraftPayrollInput={
  employee:string;start:string;end:string;createdOn:string;
  fixed:number;commissions:number;adjustments:number;casheaCommissionAdvances:number;otherBonuses:number;
  deductions:number;advances:number;priorDue:number;
  draftNet:number;notes:string[];
  orders:DraftPayrollLine[];
  adjustmentLines:{label:string;amount:number;state:string}[];
  casheaPolicies:{order:string;description:string;mode:string;full:number;collected:number;advance:number;installments:string[]}[];
};
const money=(v:number)=>"$"+Number(v||0).toFixed(2);
const asciiControl=(text:string)=>text.replace(/[\u0000-\u001f]/g," ").replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
  .replace(/[—–]/g,"-").replace(/€/g,"EUR").replace(/•/g,"-").replace(/…/g,"...");
const latin=(value:string)=>Array.from(asciiControl(value)).map(c=>{
  const code=c.charCodeAt(0);return code>=32&&code<=255?String.fromCharCode(code):"?";
}).join("");
const escapePdf=(s:string)=>latin(s).replaceAll("\\","\\\\").replaceAll("(","\\(").replaceAll(")","\\)");
const byteArray=(text:string)=>Uint8Array.from(Array.from(text).map(c=>c.charCodeAt(0)&255));
const wrap=(s:string,max=94)=>{
 const lines:string[]=[];let line="";
 for(const word of latin(s).split(/\s+/)){
  if(line.length+word.length+1>max&&line){lines.push(line);line="";}
  if(word.length>max){if(line){lines.push(line);line="";}for(let i=0;i<word.length;i+=max)lines.push(word.slice(i,i+max));}
  else line+=(line?" ":"")+word;
 }
 if(line)lines.push(line);
 return lines.length?lines:[""];
};
export function buildPayrollDraftPdf(data:DraftPayrollInput):Uint8Array{
 const pages:string[][]=[[]];let page=0;let y=779;
 const on=(s:string)=>pages[page].push(s);
 function line(text:string,opts?:{size?:number;bold?:boolean;indent?:number;color?:[number,number,number]}){
   const font=opts?.bold?"F2":"F1",size=opts?.size??9.5,x=opts?.indent??42;
   const color=opts?.color??[0.16,0.18,0.21];
   for(const fragment of wrap(text,Math.max(32,Math.floor((511-(x-42))/(size*0.51))))){
    if(y<79)newPage();
    on("BT /"+font+" "+size+" Tf "+color.map(n=>n.toFixed(3)).join(" ")+" rg 1 0 0 1 "+x+" "+y+" Tm ("+escapePdf(fragment)+") Tj ET");
    y-=Math.max(12,size+3);
   }
 }
 function newPage(){page++;pages.push([]);y=780;header();}
 function rule(){if(y<90)newPage();on("0.85 0.86 0.89 RG 42 "+(y+4)+" m 553 "+(y+4)+" l S");y-=8;}
 function heading(t:string){y-=7;line(t,{size:11.5,bold:true,color:[0.94,0.38,0.09]});y-=3;}
 function header(){
  on("0.12 0.13 0.16 rg 0 807 595 35 re f");
  on("BT /F2 13 Tf 1 1 1 rg 1 0 0 1 42 818 Tm (LUBRICENTER | NOMINA) Tj ET");
  on("BT /F2 11 Tf 0.92 0.30 0.06 rg 1 0 0 1 42 792 Tm (BORRADOR - NO LIQUIDADO) Tj ET");
  on("0.77 0.78 0.80 RG 42 62 m 553 62 l S");
  on("BT /F1 8 Tf 0.4 0.4 0.4 rg 1 0 0 1 42 48 Tm (Documento de revision. No acredita pago ni liquidacion.) Tj ET");
 }
 header();
 line("Empleado: "+data.employee+"     Semana: "+data.start+" al "+data.end,{bold:true,size:10.5}); 
 line("Preparado: "+data.createdOn+". Sujeto a correcciones antes de confirmar.",{size:8.5});
 heading("RESUMEN PROPUESTO");
 line("Sueldo fijo: "+money(data.fixed)+"    Comisiones por cobros: "+money(data.commissions));
 line("Comisiones Cashea adelantadas: +"+money(data.casheaCommissionAdvances));
 if(data.otherBonuses>0)line("Otros bonos: +"+money(data.otherBonuses));
 line("Descuentos: "+money(data.deductions)+"    Adelantos ya entregados: -"+money(data.advances));
 rule();
 line("NETO DE ESTA SEMANA PROPUESTO: "+money(data.draftNet),{bold:true,size:12});
 line("Los cargos comerciales de Cashea son gasto de Lubricenter, no descuentos del mecanico.",{size:8.5});
 if(data.priorDue>0)line("Saldo liquidado de semanas anteriores (separado): "+money(data.priorDue),{size:9});
 line("Este resumen es previo a la liquidacion; el monto final puede cambiar.",{size:8.5});
 heading("TRABAJOS Y ORDENES");
 for(const item of data.orders){
  if(y<170)newPage();
  line(item.order+" | "+item.earnedOn+" | "+item.description,{bold:true,size:9.5});
  line("Comision en esta nomina: "+money(item.commission)+" | Decision: "+item.decision,{size:9});
  for(const detail of item.detail)line("- "+detail,{size:8.6,indent:52});
  if(item.cashea)line("Cashea: "+item.cashea,{size:8.5,indent:52});
  y-=5;
 }
 heading("AJUSTES / BONOS / DESCUENTOS");
 if(data.adjustmentLines.length===0)line("Sin ajustes registrados.");
 for(const a of data.adjustmentLines)line((a.amount>=0?"+":"")+money(a.amount)+" | "+a.label+" | "+a.state,{size:9.3});
 heading("COMISIONES CASHEA - DECISION EN REVISION");
 if(data.casheaPolicies.length===0)line("Sin comisiones Cashea pendientes de decision.");
 for(const c of data.casheaPolicies){
  line(c.order+" "+c.description+" | "+(c.mode==="FULL_UPFRONT"?"Adelanto completo":"Pagar al cobrar"),{bold:true});
  line("Comision total "+money(c.full)+" | Cobros generados "+money(c.collected)+
    " | Adelanto adicional "+money(c.advance),{size:9});
  for(const inst of c.installments)line("- "+inst,{size:8.4,indent:52});
 }
 if(data.notes.length){
  heading("OBSERVACIONES PARA DISCUTIR");
  for(const note of data.notes)line("- "+note);
 }
 y-=15;line("Conforme empleado: __________________   Fecha: __________",{size:9});
 line("Revisado administracion: ________________",{size:9});
 const objects:string[]=[ "" ];
 const add=(body:string)=>{objects.push(body);return objects.length-1};
 const fontNormal=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
 const fontBold=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
 const pagesId=add("");
 const kids:number[]=[];
 for(const instructions of pages){
   const stream=instructions.join("\n")+"\n";
   const bytes=byteArray(stream);
   const streamObj=add("<< /Length "+bytes.length+" >>\nstream\n"+stream+"endstream");
   const pageId=add("<< /Type /Page /Parent "+pagesId+" 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 "+fontNormal+" 0 R /F2 "+fontBold+" 0 R >> >> /Contents "+streamObj+" 0 R >>");
   kids.push(pageId);
 }
 objects[pagesId]="<< /Type /Pages /Count "+kids.length+" /Kids ["+kids.map(x=>x+" 0 R").join(" ")+"] >>";
 const catalogId=add("<< /Type /Catalog /Pages "+pagesId+" 0 R >>");
 let buffer="%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";const offsets:number[]=[0];
 for(let i=1;i<objects.length;i++){offsets.push(buffer.length);buffer+=i+" 0 obj\n"+objects[i]+"\nendobj\n";}
 const xref=buffer.length;
 buffer+="xref\n0 "+objects.length+"\n0000000000 65535 f \n";
 for(let i=1;i<objects.length;i++)buffer+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
 buffer+="trailer\n<< /Size "+objects.length+" /Root "+catalogId+" 0 R >>\nstartxref\n"+xref+"\n%%EOF\n";
 return byteArray(buffer);
}
export function downloadPayrollDraftPdf(data:DraftPayrollInput){
 const file=buildPayrollDraftPdf(data);
 const blob=new Blob([file as BlobPart],{type:"application/pdf"});
 const url=URL.createObjectURL(blob),anchor=document.createElement("a");
 anchor.href=url;anchor.download="preliquidacion-"+data.employee.toLowerCase().replace(/[^a-z0-9]/gi,"-")+"-"+data.end+".pdf";
 document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}

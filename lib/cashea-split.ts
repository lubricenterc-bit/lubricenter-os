import { D } from "./finance/money";

export const CASHEA_INITIAL_METHODS = [
  ["TRANSFER_BDV","Banco de Venezuela · pago móvil / transferencia"],
  ["TRANSFER_BNC","BNC · pago móvil / transferencia"],
  ["CASH_VES","Efectivo en bolívares"],
  ["CASH_USD","Efectivo en dólares"],
  ["ZELLE","Zelle · USD"],
  ["BINANCE","Binance · USD"]
] as const;

export type CasheaInitialMethod = (typeof CASHEA_INITIAL_METHODS)[number][0];
export type CasheaSplitLine = {
  id:string; method:CasheaInitialMethod; amount:string; reference:string;
  autoFill?:boolean;
};
export type CasheaSplitPayload = {method:CasheaInitialMethod;amount:string;reference:string|null};
export function casheaCurrency(method:CasheaInitialMethod):"USD"|"VES" {
  return ["CASH_USD","ZELLE","BINANCE"].includes(method)?"USD":"VES";
}
export function isCasheaBank(method:CasheaInitialMethod) {
  return method==="TRANSFER_BDV"||method==="TRANSFER_BNC";
}
export function isCasheaElectronic(method:CasheaInitialMethod) {
  return isCasheaBank(method)||method==="ZELLE"||method==="BINANCE";
}
export function newCasheaSplitLine(id:string="initial"):CasheaSplitLine {
  return {id,method:"TRANSFER_BDV",amount:"",reference:"",autoFill:true};
}
export function casheaAutoAmount(requiredVes:number,method:CasheaInitialMethod,bcv:number) {
  if(!Number.isFinite(requiredVes)||requiredVes<0||bcv<=0)return "";
  const target=new D(requiredVes);
  return casheaCurrency(method)==="USD"?
    target.div(bcv).toDecimalPlaces(2).toFixed(2):
    target.toDecimalPlaces(2).toFixed(2);
}
export function casheaPaymentPreview(
  lines:CasheaSplitLine[],remainingVes:number,bcv:number
):{paidVes:number;differenceVes:number;valid:boolean;error:string|null;payload:CasheaSplitPayload[]} {
  const failure=(message:string):ReturnType<typeof casheaPaymentPreview>=>({
    paidVes:0,differenceVes:remainingVes,valid:false,error:message,payload:[]
  });
  if(!Number.isFinite(remainingVes)||remainingVes<0||!Number.isFinite(bcv)||bcv<=0)
    return failure("Actualiza los totales y la tasa BCV antes de cobrar.");
  if(lines.length>8)return failure("Máximo 8 métodos por inicial.");
  if(remainingVes>0&&lines.length===0)
    return failure("Agrega cómo recibiste la inicial.");
  let paid=new D(0);
  const payload:CasheaSplitPayload[]=[];
  for(const [index,line] of lines.entries()){
    const n=index+1;
    const amount=line.amount.trim();
    if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount)||new D(amount).lte(0))
      return failure("Cobro "+n+": indica un monto positivo con máximo dos decimales.");
    const ref=line.reference.trim();
    if(isCasheaBank(line.method)&&! /^\d{4,32}$/.test(ref))
      return failure("Cobro "+n+": indica al menos los últimos 4 dígitos de la referencia bancaria.");
    if(["ZELLE","BINANCE"].includes(line.method)&&(ref.length<4||ref.length>100))
      return failure("Cobro "+n+": escribe la referencia de Zelle o Binance.");
    if(ref.length>100)return failure("Cobro "+n+": referencia demasiado larga.");
    const ves=casheaCurrency(line.method)==="USD"
      ?new D(amount).mul(bcv).toDecimalPlaces(2)
      :new D(amount);
    paid=paid.plus(ves);
    payload.push({method:line.method,amount:new D(amount).toFixed(2),reference:ref||null});
  }
  const diff=new D(remainingVes).minus(paid).toDecimalPlaces(2);
  if(!diff.isZero())return {
    paidVes:Number(paid),differenceVes:Number(diff),valid:false,
    error:diff.gt(0)?"Faltan Bs "+diff.toFixed(2)+" para completar la inicial.":
      "Sobran Bs "+diff.abs().toFixed(2)+". Corrige los importes antes de cerrar.",
    payload
  };
  return {paidVes:Number(paid),differenceVes:0,valid:true,error:null,payload};
}

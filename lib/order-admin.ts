export const paymentMethods = {MOBILE_PAYMENT:"Pago móvil · Banco de Venezuela",TRANSFER_BDV:"Pago móvil · Banco de Venezuela",TRANSFER_BNC:"Pago móvil · BNC",CASH_VES:"Efectivo Bs",CASH_USD:"Efectivo USD"};
export function caracasInput(iso = new Date().toISOString()) { return new Date(new Date(iso).getTime()-4*60*60*1000).toISOString().slice(0,16); }
export function businessInstant(input:string) { return input ? new Date(`${input}:00-04:00`).toISOString() : null; }

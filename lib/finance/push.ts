export type Digest={cash:number;opening_needed:boolean;exceptions:number;reports:number;refunds:number;role:string;sources_needed?:boolean};
export function digestMessage(d:Digest):string|null{
 const parts:string[]=[];
 if(d.opening_needed)parts.push('confirmar apertura de caja');
 if(d.cash>0)parts.push(`${d.cash} cuadre(s) de caja`);
 if(d.exceptions>0)parts.push(`${d.exceptions} excepción(es)`);
 if(d.reports>0)parts.push(`${d.reports} reporte(s) por completar`);
 if(d.sources_needed)parts.push('configurar las fuentes de reportes');
 if(d.refunds>0)parts.push(`${d.refunds} vuelto(s) pendiente(s)`);
 return parts.length?`Por poner al día: ${parts.join(' · ')}. Abre la app para revisar.`:null;
}
export function allowedPushEndpoint(endpoint:string):boolean{
 try{const u=new URL(endpoint);return u.protocol==='https:'&&u.port===''&&!u.username&&!u.password&&(
  u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname==='web.push.apple.com'||u.hostname.endsWith('.push.apple.com')||u.hostname.endsWith('.notify.windows.com')
 );}catch{return false;}
}

/** Deterministic uncompressed ZIP for bank audit CSV files; no browser dependencies. */
export type ZipEntry = {name:string;content:string};
const encoder=new TextEncoder();
function u16(view:DataView,offset:number,value:number){view.setUint16(offset,value,true)}
function u32(view:DataView,offset:number,value:number){view.setUint32(offset,value>>>0,true)}
function crc32(bytes:Uint8Array):number{
 let crc=0xffffffff;
 for(const b of bytes){crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}
export function createAuditZip(entries:ZipEntry[]):Uint8Array{
 if(entries.length>65535)throw new Error('Demasiados archivos');
 const chunks:Uint8Array[]=[];const central:Uint8Array[]=[];let offset=0;let centralSize=0;
 for(const entry of entries){
  if(!/^[\w. -]{1,150}$/.test(entry.name)||entry.name.includes('..'))throw new Error('Nombre de archivo inválido');
  const name=encoder.encode(entry.name),data=encoder.encode(entry.content),crc=crc32(data);
  if(data.length>0xffffffff)throw new Error('Archivo demasiado grande');
  const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
  u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,6,0x0800);u16(lv,8,0);
  u32(lv,14,crc);u32(lv,18,data.length);u32(lv,22,data.length);u16(lv,26,name.length);
  local.set(name,30);chunks.push(local,data);
  const cd=new Uint8Array(46+name.length),cv=new DataView(cd.buffer);
  u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u16(cv,8,0x0800);u16(cv,10,0);
  u32(cv,16,crc);u32(cv,20,data.length);u32(cv,24,data.length);u16(cv,28,name.length);
  u32(cv,42,offset);cd.set(name,46);central.push(cd);centralSize+=cd.length;
  offset+=local.length+data.length;
 }
 const end=new Uint8Array(22),ev=new DataView(end.buffer);
 u32(ev,0,0x06054b50);u16(ev,8,entries.length);u16(ev,10,entries.length);
 u32(ev,12,centralSize);u32(ev,16,offset);
 const total=offset+centralSize+end.length;
 const result=new Uint8Array(total);let cursor=0;
 for(const c of [...chunks,...central,end]){result.set(c,cursor);cursor+=c.length;}
 return result;
}
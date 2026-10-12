'use client';

import Link from 'next/link';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { createAuditZip } from '@/lib/finance/audit-zip';

type Provider = 'BDV'|'BNC'|'CASHEA_TRANSACTIONS'|'CASHEA_ORDERS';
type Row = {provider:Provider;occurred_at:string;reference:string;description:string;direction:string;currency:string;amount:number|string;
 amount_ref:number|string|null;assigned_ref:number|string|null;external_order:string|null;order_number:string;
 balance:number|string|null;ownership_status:string;nature:string;category:string|null;reconciliation_status:string;
 amount_alloc:number|string;report_verified:boolean;reconciliation_reason:string;time_precision?:string;bank_cashea_match?:string;paired_reference?:string;paired_order?:string};
type CasheaOrder = {external_order:string;purchased_on:string;status:string;total_ref:number|string;initial_ref:number|string;
 invoice_no:string|null;order_number:string;relation_status:string;report_verified:boolean;installments:unknown};
type Source = {provider:Provider;records:number;in_ves:number|string;out_ves:number|string;own_in_ves:number|string;unattributed_in_ves:number|string;not_final:number;coverage:string};
type Report = {from:string;to:string;generated_at:string;status:string;transactions:Row[];orders:CasheaOrder[];
 sources:Source[];pending_transactions:number;pending_note:string};
const providerLabels:Record<Provider,string>={BDV:'Banco de Venezuela',BNC:'Banco Nacional de Crédito',
 CASHEA_TRANSACTIONS:'Cashea · cuotas cobradas',CASHEA_ORDERS:'Cashea · órdenes y saldo financiado'};
const localToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function csvValue(input:unknown){
 const s=String(input??'');
 // Treat imported descriptions, bank refs and customer-entered values as untrusted spreadsheet data.
 const safe=/^[\s]*[=+@-]/.test(s)||/^0\d{4,}$/.test(s)?"'"+s:s;
 return '"'+safe.replace(/"/g,'""')+'"';
}
function csvText(lines:unknown[][]){return '\uFEFF'+lines.map(line=>line.map(csvValue).join(';')).join('\r\n');}
function saveCsv(name:string,lines:unknown[][]){
 const text=csvText(lines);
 const blob=new Blob([text],{type:'text/csv;charset=utf-8'});
 const link=document.createElement('a'),url=URL.createObjectURL(blob);
 link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function transactionRows(report:Report,provider:Provider):unknown[][]{
 const header=['Fuente','Fecha y hora Caracas','Referencia','Descripción','Entrada/Salida','Importe original','Moneda',
 'Monto referencial USD','Asignado USD Cashea','Saldo banco VES','Orden Cashea','Orden OS','Pertenencia','Naturaleza','Categoría','Importe relacionado','Estado conciliación','Reporte verificado','Justificación','Coincidencia BNC-Cashea','Referencia contraparte','Orden Cashea vinculada'];
 const rows=report.transactions.filter(row=>row.provider===provider).map(t=>[
 providerLabels[provider],t.time_precision==='DATE_ONLY'?t.occurred_at.slice(0,10)+' · hora no disponible':t.occurred_at,t.reference,t.description,t.direction,t.amount,t.currency,t.amount_ref,t.assigned_ref,
 t.balance,t.external_order,t.order_number,t.ownership_status,t.nature,t.category,t.amount_alloc,t.reconciliation_status,
 t.report_verified?'SÍ':'NO',t.reconciliation_reason,t.bank_cashea_match||'NO',t.paired_reference||'',t.paired_order||''
 ]);
 return [header,...rows];
}
function transactionCsv(report:Report,provider:Provider){saveCsv(`Lubricenter_${provider}_${report.from}_${report.to}.csv`,transactionRows(report,provider));}
function orderRows(report:Report):unknown[][]{
 const header=['Orden Cashea','Factura externa','OS vinculada','Fecha compra','Estado Cashea','Total USD','Inicial USD',
 'Financiado USD (calculado)','Estado relación','Reporte verificado','Cronograma original JSON'];
 const rows=report.orders.map(o=>[o.external_order,o.invoice_no,o.order_number,o.purchased_on,o.status,o.total_ref,o.initial_ref,
 (Number(o.total_ref)-Number(o.initial_ref)).toFixed(4),o.relation_status,o.report_verified?'SÍ':'NO',JSON.stringify(o.installments)]);
 return [header,...rows];
}
function orderCsv(report:Report){saveCsv(`Lubricenter_CASHEA_ORDENES_${report.from}_${report.to}.csv`,orderRows(report));}
function summaryRows(report:Report):unknown[][]{
 const header=['Fuente','Movimientos importados','Entradas totales Bs','Entradas vinculadas OS/cuenta propia Bs','Entradas NO atribuidas Bs','Salidas Bs','Movimientos pendientes','Cobertura'];
 const rows=report.sources.map(s=>[providerLabels[s.provider],s.provider==='CASHEA_ORDERS'?report.orders.length:s.records,
 s.in_ves,s.own_in_ves,s.unattributed_in_ves,s.out_ves,s.not_final,s.coverage]);
 rows.push(['ESTADO GENERAL',report.status,'','','','','',report.pending_note]);
 return [header,...rows];
}
function summaryCsv(report:Report){saveCsv(`Lubricenter_RESUMEN_CONCILIACION_${report.from}_${report.to}.csv`,summaryRows(report));}
function exportPackage(report:Report){
 const date=report.from+'_'+report.to;
 const files=[
  {name:'00_RESUMEN_'+date+'.csv',content:csvText(summaryRows(report))},
  {name:'01_BDV_'+date+'.csv',content:csvText(transactionRows(report,'BDV'))},
  {name:'02_BNC_'+date+'.csv',content:csvText(transactionRows(report,'BNC'))},
  {name:'03_CASHEA_COBROS_'+date+'.csv',content:csvText(transactionRows(report,'CASHEA_TRANSACTIONS'))},
  {name:'04_CASHEA_ORDENES_'+date+'.csv',content:csvText(orderRows(report))},
  {name:'LEEME_'+date+'.txt',content:[
    'LUBRICENTER OS — RESUMEN DE CONCILIACIÓN',
    'Período: '+report.from+' a '+report.to,
    'Generado: '+report.generated_at,
    'ESTADO: '+report.status,
    'Pendientes: '+report.pending_transactions,
    '',
    report.pending_note,
    '',
    'BDV y BNC: fuentes bancarias; Cashea: evidencia de ventas/cuotas.',
    'Un abono BNC y su fila Cashea NO representan dos ingresos.',
    'Una coincidencia BNC/Cashea no asigna la operación automáticamente a Cabudare.',
    'SIN_EXTRACTO significa que la fuente no fue cargada o verificada.',
    'NO atribuir automáticamente importes de Cashea sin orden OS.',
    'Los saldos iniciales y finales no se inventan.',
  ].join('\n')}
 ];
 const zip=createAuditZip(files);
 const binary=new Uint8Array(zip.length);binary.set(zip);
 const blob=new Blob([binary.buffer],{type:'application/zip'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='Lubricenter_CONCILIACION_'+date+'.zip';
 document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export default function FinanceExportPage(){
 const [from,setFrom]=useState('2026-10-05'),[to,setTo]=useState('2026-10-10');
 const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(){
  setError('');setBusy(true);setReport(null);
  try{
   if(from>to||to>localToday())throw Error('Selecciona un período terminado o hasta la fecha actual.');
   const r=await supabase.rpc('finance_export_period',{p_from:from,p_to:to});
   if(r.error)throw r.error;
   setReport(r.data as Report);
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 return <main className="container stack">
  <section className="brand-hero"><div><div className="eyebrow">FINANCE CORE · AUDITORÍA</div><h1>Exportar conciliación</h1>
   <p>Un resumen y cuatro anexos independientes: BDV, BNC, cobros Cashea y órdenes Cashea. La plataforma no oculta los movimientos pendientes ni mezcla cuotas antiguas con nuevas ventas.</p></div>
   <Link className="btn" href="/finance">Central financiera</Link>
  </section>
  {error&&<section className="error" role="alert">{error}</section>}
  <section className="card stack"><h2>Período a exportar</h2>
   <div className="grid grid-2">
    <label>Desde <input type="date" className="input" value={from} onChange={e=>setFrom(e.target.value)} max={to}/></label>
    <label>Hasta <input type="date" className="input" value={to} onChange={e=>setTo(e.target.value)} min={from} max={localToday()}/></label>
   </div>
   <button className="btn btn-primary" onClick={refresh} disabled={busy}>{busy?'Consultando evidencias…':'Generar resumen y anexos'}</button>
   <p className="muted small">Los CSV se descargan a tu computadora, compatibles con Excel. Solo usuarios financieros autorizados pueden consultar la información. Los cobros Cashea sin orden OS se muestran como evidencia externa NO atribuida a Cabudare.</p>
  </section>
  {report&&<section className="card stack">
    <div className="row-between"><h2>Conciliación del {report.from} al {report.to}</h2><span className={report.status==="CONCILIADO"?"pill ok":"pill"}>{report.status==="CONCILIADO"?"CONCILIACIÓN CERRADA":report.status==="CIERRE_CON_EXCEPCIONES"?"CIERRE CON EXCEPCIONES":"BORRADOR · NO CERRADO"}</span></div>
    {report.status!=="CONCILIADO"&&<p className="finance-warning">Este documento no certifica el cierre semanal. Deben verificarse los extractos bancarios, los movimientos pendientes y los saldos de cada cuenta. Los pagos Cashea del BNC son una sola entrada de dinero, aunque figuren en dos evidencias.</p>}
    <div className="row-between"><div><strong>Resumen general</strong><p className="muted small">{report.pending_transactions} transacciones sin conciliación final según los archivos importados.</p></div>
     <div className="row"><button className="btn" onClick={()=>summaryCsv(report)}>Resumen CSV</button><button className="btn btn-primary" onClick={()=>exportPackage(report)}>Descargar informe completo ZIP</button></div></div>
    {report.sources.map(s=><div className="order-item row-between" key={s.provider}>
      <div><strong>{providerLabels[s.provider]}</strong>
       <div className="muted small">{s.provider==='CASHEA_ORDERS'?report.orders.length:s.records} registros · {s.not_final} movimientos sin conciliación final</div>
       <div className="muted small">{s.coverage}</div>
      </div>
      <button className="btn" onClick={()=>s.provider==='CASHEA_ORDERS'?orderCsv(report):transactionCsv(report,s.provider)}>
       Descargar {s.provider==='CASHEA_ORDERS'?'órdenes':'movimientos'} CSV
      </button>
    </div>)}
    <p className="muted small">Cada archivo contiene referencias y estados de vinculación individuales. Si un banco aún no tiene extracto importado, su anexo estará vacío y se mostrará SIN EXTRACTO, no conciliado.</p>
    <Link href="/finance/inbox" className="btn btn-ghost">Revisar operaciones pendientes</Link>
  </section>}
 </main>;
}

"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
import {fmtRef,fmtVes,fmtRate} from "@/lib/format";
type Work={id:string;employee_id:string;order_id:string;order_number:string;description:string;currency:string;original_amount:number;amount:number;obligation_usd:number|null;payout_mode:'HARD_USD'|'BCV_VES'|null;decision:string;reason:string|null;version:number;earned_at:string;reversal_of:string|null};
type OrderTotal={id:string;total_ves:number;total_ref:number;total_cash_usd_equivalent:number};
function money(n:number,c:string){return c==='USD'?`$${Number(n).toFixed(2)} USD`:fmtVes(n);}
function start(end:string){const d=new Date(end+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-5);return d.toISOString().slice(0,10);}
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas'}).format(new Date());}
function currentPayrollEnd(){const d=new Date(today()+'T12:00:00Z');const day=d.getUTCDay();d.setUTCDate(d.getUTCDate()+(day===0?-1:6-day));return d.toISOString().slice(0,10);}
function grouped(rows:Work[]){return Object.values(rows.reduce<Record<string,{id:string;number:string;rows:Work[]}>>((groups,w)=>{(groups[w.order_id]??={id:w.order_id,number:w.order_number,rows:[]}).rows.push(w);return groups;},{}));}
export default function PayrollReview(){
 const [end,setEnd]=useState(currentPayrollEnd);
 const [paymentDate,setPaymentDate]=useState(today);
 const [bcv,setBcv]=useState<{value:number;effective_at:string}|null>(null);
 const [orders,setOrders]=useState<Record<string,OrderTotal>>({});
 const [work,setWork]=useState<Work[]>([]),[employees,setEmployees]=useState<any[]>([]),[rules,setRules]=useState<any[]>([]),[adjustments,setAdjustments]=useState<any[]>([]),[runs,setRuns]=useState<any[]>([]);
 const [balances,setBalances]=useState<Record<string,number>>({});
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[latest,setLatest]=useState('');
 const [edit,setEdit]=useState<Work|null>(null),[decision,setDecision]=useState('PAY'),[amount,setAmount]=useState(''),[reason,setReason]=useState(''),[confirm,setConfirm]=useState<any>(null),[history,setHistory]=useState<any[]|null>(null);
 const [adjEmployee,setAdjEmployee]=useState(''),[adjType,setAdjType]=useState('BONUS'),[adjAmount,setAdjAmount]=useState(''),[adjReason,setAdjReason]=useState('');
 const [transferFrom,setTransferFrom]=useState(''),[transferTo,setTransferTo]=useState(''),[transferAmount,setTransferAmount]=useState(''),[transferReason,setTransferReason]=useState('');
 const [transferReview,setTransferReview]=useState<string|null>(null),[transferEvidence,setTransferEvidence]=useState(''),[transferConsent,setTransferConsent]=useState(false);
 const [paidByRun,setPaidByRun]=useState<Record<string,number>>({});
 const [editAdjType,setEditAdjType]=useState('BONUS');
 const [editAdj,setEditAdj]=useState<any>(null),[editAdjDecision,setEditAdjDecision]=useState('PAY'),[editAdjAmount,setEditAdjAmount]=useState(''),[editAdjReason,setEditAdjReason]=useState('');
 async function load(){setReady(false);setError('');const [w,e,r,a,c]=await Promise.all([supabase.rpc('payroll_review',{p_end:end}),supabase.from('employees').select('id,name').eq('active',true).order('name'),supabase.from('payroll_runs').select('*,employees(name)').order('created_at',{ascending:false}).limit(20),supabase.from('payroll_adjustments').select('*').is('payroll_run_id',null).lte('occurred_on',end),supabase.from('compensation_rules').select('*').eq('rule_type','FIXED_WEEKLY').lte('valid_from',end).order('valid_from',{ascending:false})]);const bad=[w,e,r,a,c].find(x=>x.error);if(bad?.error)return setError(bad.error.message);const balancePairs=await Promise.all((e.data??[]).map(async(emp:any)=>{const result=await supabase.rpc('payroll_employee_open_balance',{p_employee_id:emp.id});return[emp.id,result.error?0:Number(result.data??0)] as const;}));setBalances(Object.fromEntries(balancePairs));const ids=[...new Set((w.data??[]).map((row:Work)=>row.order_id))];if(ids.length){const result=await supabase.from('orders').select('id,total_ves,total_ref,total_cash_usd_equivalent').in('id',ids);if(result.error)return setError(result.error.message);setOrders(Object.fromEntries((result.data??[]).map(row=>[row.id,row])));}else setOrders({});setWork(w.data??[]);setEmployees(e.data??[]);setRuns(r.data??[]);setAdjustments(a.data??[]);setRules(c.data??[]);
 const runIds=(r.data??[]).map(x=>x.id);
 if(runIds.length){const paid=await supabase.from('payroll_payments').select('payroll_run_id,usd_equivalent').in('payroll_run_id',runIds);
  if(paid.error)return setError(paid.error.message);
  const totals:Record<string,number>={};for(const item of paid.data??[]){totals[item.payroll_run_id]=(totals[item.payroll_run_id]||0)+Number(item.usd_equivalent);}
  setPaidByRun(totals);
 }else setPaidByRun({});
 setReady(true);}
 useEffect(()=>{void load();},[end]);
 useEffect(()=>{let active=true;setBcv(null);void supabase.from('exchange_rates').select('value,effective_at').eq('rate_type','BCV').lte('effective_at',`${paymentDate}T23:59:59-04:00`).order('effective_at',{ascending:false}).limit(1).then(({data})=>{if(active&&data?.[0])setBcv({value:Number(data[0].value),effective_at:data[0].effective_at});});return()=>{active=false;};},[paymentDate]);
 function summary(id:string){const rows=work.filter(w=>w.employee_id===id),pay=rows.filter(w=>w.decision==='PAY'),empAdj=adjustments.filter(a=>a.employee_id===id);return{rows,totalUsd:pay.reduce((s,w)=>s+Number(w.obligation_usd??0),0),hardUsd:pay.filter(w=>w.payout_mode==='HARD_USD').reduce((s,w)=>s+Number(w.obligation_usd??0),0),bcvUsd:pay.filter(w=>w.payout_mode==='BCV_VES').reduce((s,w)=>s+Number(w.obligation_usd??0),0),hold:rows.filter(w=>w.decision==='HOLD').length,exclude:rows.filter(w=>w.decision==='EXCLUDE').length,fixed:Number(rules.find(r=>r.employee_id===id&&(!r.valid_to||r.valid_to>=end))?.value??0),adj:empAdj.filter(a=>a.decision==='PAY').reduce((s,a)=>s+Number(a.amount_ref),0),adjHold:empAdj.filter(a=>a.decision==='HOLD').length,adjustments:empAdj,prior:Number(balances[id]??0)};}
 async function save(){if(!edit)return;setBusy(true);const {error}=await supabase.rpc('payroll_review_work_v3',{p_id:edit.id,p_version:edit.version,p_decision:decision,p_obligation_usd:Number(amount),p_reason:reason});setBusy(false);if(error)return setError(error.message);setEdit(null);await load();}
 async function settle(){setBusy(true);const expected=summary(confirm.id).rows.filter(w=>w.decision!=='HOLD').sort((a,b)=>a.id.localeCompare(b.id)).map(w=>({id:w.id,version:w.version}));const{data,error}=await supabase.rpc('payroll_settle',{p_employee_id:confirm.id,p_period_start:start(end),p_period_end:end,p_expected:{work:expected,fixed_ref:summary(confirm.id).fixed,adjustments:adjustments.filter(a=>a.employee_id===confirm.id&&a.decision!=='HOLD').sort((a,b)=>a.id.localeCompare(b.id)).map(a=>({id:a.id,version:Number(a.version??1),decision:a.decision??'PAY',amount_ref:Number(a.amount_ref)}))}});setBusy(false);setConfirm(null);if(error)return setError(error.message);setLatest(data);await load();}
 async function showHistory(id:string){const{data,error}=await supabase.from('payroll_work_history').select('*').eq('work_item_id',id).order('occurred_at',{ascending:false});if(error)return setError(error.message);setHistory(data??[]);}
 async function adjustment(){setBusy(true);const{error}=await supabase.rpc('add_payroll_adjustment',{p_employee_id:adjEmployee,p_adjustment_type:adjType,p_amount_ref:(adjType==='BONUS'?1:-1)*Math.abs(Number(adjAmount)),p_note:adjReason,p_occurred_on:today()});setBusy(false);if(error)return setError(error.message);setAdjAmount('');setAdjReason('');await load();}
 async function saveAdjustment(){if(!editAdj)return;setBusy(true);setError('');const{error}=await supabase.rpc('payroll_adjustment_update',{p_id:editAdj.id,p_version:Number(editAdj.version??1),p_type:editAdjType,p_decision:editAdjDecision,p_amount_ref:(editAdjType==='BONUS'?Math.abs(Number(editAdjAmount)):-Math.abs(Number(editAdjAmount))),p_note:editAdjReason});setBusy(false);if(error)return setError(error.message);setEditAdj(null);await load();}
 async function proposeTransfer(){
  if(!transferFrom||!transferTo||transferFrom===transferTo||!Number(transferAmount)||transferReason.trim().length<12)return;
  setBusy(true);setError('');
  const {error}=await supabase.rpc('payroll_transfer_draft',{p_from_employee:transferFrom,p_to_employee:transferTo,p_amount_usd:Number(transferAmount),p_reason:transferReason,p_occurred_on:today()});
  setBusy(false);if(error)return setError(error.message);
  setTransferReason('');setTransferAmount('');await load();
 }
 async function decideTransfer(id:string,action:'APPROVE'|'REJECT'){
  if(transferEvidence.trim().length<12)return setError('Registra al menos 12 caracteres de evidencia.');
  setBusy(true);setError('');
  const {error}=await supabase.rpc('payroll_transfer_decide',{p_transfer_id:id,p_action:action,p_evidence:transferEvidence.trim(),p_authorization_verified:action==='APPROVE'&&transferConsent});
  setBusy(false);if(error)return setError(error.message);
  setTransferReview(null);setTransferEvidence('');setTransferConsent(false);await load();
 }
 const paired=Array.from(new Set(adjustments.filter(a=>a.transfer_id).map(a=>a.transfer_id as string)))
  .map(id=>({id,rows:adjustments.filter(a=>a.transfer_id===id)}))
  .filter(t=>t.rows.length===2);
 const employeeName=(id:string)=>employees.find(e=>e.id===id)?.name??'Empleado';
 const lastRunFor=(id:string)=>runs.find(r=>r.employee_id===id&&r.payroll_version>=3);
 const canClose=end<=today();
 return <main className="container stack"><div className="row-between" style={{flexWrap:"wrap"}}><h1>Nómina · revisar, liquidar y pagar</h1><Link className="btn btn-primary" href="/payroll/history">Historial administrativo</Link></div><div className="card stack">
 <strong>El proceso tiene dos pasos distintos:</strong>
 <div><strong>1. Liquidar:</strong> calcular y congelar cuánto se debe a cada empleado. <strong>No mueve dinero.</strong></div>
 <div><strong>2. Registrar pago:</strong> elegir cuenta, moneda, monto y referencia. <strong>Este paso sí registra una salida real en caja.</strong></div>
 <p className="muted small">Puedes hacer pagos parciales; cada factura muestra su saldo pendiente.</p></div>
 <div className="row" style={{flexWrap:'wrap'}}><label><span className="label">Cierre de semana</span><input className="input" type="date" value={end} disabled={busy} onChange={e=>{if(e.target.value)setEnd(e.target.value);}}/><span className="muted small">Semana de nómina: lunes {start(end)} → sábado {end}. Las comisiones de semanas anteriores todavía sin liquidar también aparecen como arrastradas.</span></label><label><span className="label">Fecha prevista de pago</span><input className="input" type="date" max={today()} value={paymentDate} onChange={e=>setPaymentDate(e.target.value)}/><span className="muted small">Solo para estimar bolívares. La tasa real se guarda al registrar el pago.</span></label></div>
 <p className="muted small">{bcv?`Tasa BCV de referencia: ${fmtRate(bcv.value)} por $1 · publicada ${new Date(bcv.effective_at).toLocaleDateString('es-VE',{timeZone:'America/Caracas'})}`:'Sin tasa BCV disponible para esa fecha.'}</p>
 {!canClose&&<div className="card muted">Semana en curso. Puedes revisar el borrador; se podrá liquidar al llegar el {end}.</div>}{error&&<div className="error" role="alert">{error}</div>}{latest&&<div className="success"><strong>Liquidación guardada; el sueldo aún NO fue pagado.</strong> <Link className="btn btn-primary" href={`/payroll/${latest}/receipt`}>Registrar pago ahora →</Link></div>}{!ready&&!error&&<p>Cargando trabajos…</p>}
 {ready&&employees.map(emp=>{const s=summary(emp.id);return <section className="card stack" key={emp.id}>
 <h2>{emp.name}</h2>{lastRunFor(emp.id)&&<div className="row" style={{flexWrap:'wrap'}}>
  <Link className="btn btn-primary" href={`/payroll/${lastRunFor(emp.id).id}/receipt`}>
   {Number(lastRunFor(emp.id).total_ref)>Number(paidByRun[lastRunFor(emp.id).id]||0)+0.01
     ?`Registrar pago pendiente: ${Math.max(0,Number(lastRunFor(emp.id).total_ref)-Number(paidByRun[lastRunFor(emp.id).id]||0)).toFixed(2)}`
     :'Ver liquidación pagada'}
  </Link>
  <span className="muted small">Período {lastRunFor(emp.id).period_start} a {lastRunFor(emp.id).period_end}</span></div>}{s.prior>0&&<div className="error"><strong>Saldo anterior a favor: ${s.prior.toFixed(2)}</strong><div className="muted small">Ya fue liquidado antes; falta pagarlo.</div></div>}<strong>Comisiones acumuladas: ${s.totalUsd.toFixed(2)}</strong><div className="muted small">En USD reales: ${s.hardUsd.toFixed(2)} · En Bs al BCV del pago: ${s.bcvUsd.toFixed(2)}{bcv?` ≈ ${fmtVes(s.bcvUsd*bcv.value)}`:''}</div>
 <div>Sueldo fijo: {fmtRef(s.fixed)} de referencia {bcv&&s.fixed>0?`≈ ${fmtVes(s.fixed*bcv.value)} si se paga el ${paymentDate}`:''}</div>
 <div>Ajustes aplicados: {fmtRef(s.adj)} de referencia</div>
 <div className="muted small">{s.adjHold} ajuste(s) prorrogado(s) · {s.hold} trabajo(s) pendientes · {s.exclude} excluido(s).</div>
 <details><summary>Ver trabajos y órdenes ({s.rows.length})</summary><div className="stack" style={{marginTop:12}}>
 {grouped(s.rows).map(group=>{const total=orders[group.id];return <article className="card stack" key={group.id}>
 <div><Link href={`/orders/${group.id}`}><strong>{group.number}</strong></Link></div>
 {total&&<div>Total de la orden: <strong>{fmtVes(total.total_ves)}</strong> · {fmtRef(total.total_ref)} de referencia{Number(total.total_cash_usd_equivalent)>0?` · ${fmtRef(total.total_cash_usd_equivalent)} pactados en divisas`:''}</div>}
 {group.rows.map(w=><div className="stack" key={w.id} style={{borderTop:'1px solid var(--border, #ddd)',paddingTop:8}}>
 <div><strong>{w.description}</strong> · {new Date(w.earned_at).toLocaleDateString('es-VE',{timeZone:'America/Caracas'})} · {{PAY:'Pagar',HOLD:'Pendiente',EXCLUDE:'Excluido'}[w.decision]}{new Date(w.earned_at).toLocaleDateString('en-CA',{timeZone:'America/Caracas'}) < start(end)?' · ARRASTRADO':''}</div>
 <div>Le corresponde: <strong>{w.decision==='PAY'?`${Number(w.obligation_usd??0).toFixed(2)}`:'No se paga'}</strong>{w.decision==='PAY'&&<span className="muted small"> · {w.payout_mode==='HARD_USD'?'se paga en USD':bcv?`se paga en Bs: ${fmtVes(Number(w.obligation_usd??0)*bcv.value)} al BCV del ${paymentDate}`:'se paga en Bs a BCV del día de pago'}</span>}</div>
 <div className="muted small">Origen del cobro: {money(w.original_amount,w.currency)}{w.reason?` · Motivo: ${w.reason}`:''}</div>
 <div className="row" style={{flexWrap:'wrap'}}><button className="btn" disabled={busy} onClick={()=>{setEdit(w);setDecision(w.decision);setAmount(String(w.obligation_usd??0));setReason('');setError('');}}>Revisar / ajustar</button><button className="btn btn-ghost" onClick={()=>showHistory(w.id)}>Historial</button></div>
 </div>)}
 </article>;})}
 {!s.rows.length&&<p>Sin comisiones cobradas pendientes.</p>}
 {/* Los ajustes aparecen visibles directamente debajo, sin esconderse entre órdenes. */}
 </div></details>
 <div className="stack"><h3>Bonos y descuentos del empleado</h3>
 {s.adjustments.length===0&&<p className="muted small">No tiene ajustes pendientes de esta nómina.</p>}
 {s.adjustments.map(a=><div className="card stack" key={a.id}>
 <div><strong>{Number(a.amount_ref)>0?'+':''}${Number(a.amount_ref).toFixed(2)} · {a.adjustment_type==='BONUS'?'Bono':a.transfer_id?'Reasignación vinculada':'Deducción/ajuste'}</strong></div>
 <div>{a.note}</div>
 <div className="muted small">{a.decision==='PAY'?'Se incluye en liquidación':a.decision==='HOLD'?'Retenido; no afecta la liquidación':'Excluido; no afecta el pago'}
 {a.transfer_id?' · Vinculado con otro empleado':''}</div>
 {!a.transfer_id&&<button className="btn" disabled={busy} onClick={()=>{setEditAdj(a);setEditAdjType(Number(a.amount_ref)>0?'BONUS':'DEBT');setEditAdjDecision(a.decision??'PAY');setEditAdjAmount(String(Math.abs(Number(a.amount_ref))));setEditAdjReason(a.note??'');setError('');}}>Editar / aplazar / quitar de la nómina</button>}
 </div>)}</div>
 <button className="btn btn-primary" disabled={busy||!canClose||(!s.rows.some(w=>w.decision!=="HOLD")&&!s.fixed&&!s.adj)} onClick={()=>setConfirm(emp)}>Revisar factura y liquidar</button><p className="muted small">Liquidar congela la factura; el pago se registra aparte y puede ser parcial.</p>
 </section>;})}
 <section className="card stack"><h2>Agregar bono o descuento</h2>
 <p className="muted">Escribe siempre el importe positivo. Selecciona si <strong>SUMA</strong> o <strong>RESTA</strong>; el sistema aplica el signo automáticamente.</p>
 <label><span className="label">Empleado</span><select className="select" value={adjEmployee} onChange={e=>setAdjEmployee(e.target.value)}>
 <option value="">Selecciona empleado</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
 <label><span className="label">Concepto</span><select className="select" value={adjType} onChange={e=>setAdjType(e.target.value)}>
 <option value="BONUS">+ BONO: dinero adicional a pagar</option>
 <option value="DEBT">− DESCUENTO: solo con autorización legítima</option>
 <option value="ADVANCE">− ADELANTO ya recibido</option>
 <option value="SUPPLIES">− INSUMOS debidamente autorizados</option>
 </select></label>
 <label><span className="label">Importe en USD de referencia, sin signo</span>
 <input className="input" type="number" min="0.01" step="0.01" value={adjAmount} onChange={e=>setAdjAmount(e.target.value)} placeholder="Ej. 10.00"/></label>
 <div className="card"><strong>Impacto sobre la nómina: {adjType==='BONUS'?'+':'−'}${Math.abs(Number(adjAmount||0)).toFixed(2)}</strong></div>
 {adjType!=='BONUS'&&<p className="muted small">Los descuentos del salario requieren fundamento y autorización legal. No utilices este control para imponer pérdidas por errores de caja.</p>}
 <label><span className="label">Motivo / comprobante</span><textarea className="input" value={adjReason} onChange={e=>setAdjReason(e.target.value)} placeholder="Explica a qué corresponde"/></label>
 <button className="btn btn-primary" disabled={!ready||busy||!adjEmployee||!Number(adjAmount)||Number(adjAmount)<=0||adjReason.trim().length<8} onClick={adjustment}>Agregar al borrador</button>
 </section>
 <section className="card stack"><h2>Reasignación entre empleados</h2>
 <p className="muted">Ejemplo: Cheo −$10 / Alexis +$10. Se crea una <strong>propuesta retenida</strong>, sin descontar todavía dinero ni afectar la liquidación. Debes revisar la procedencia legal y la autorización antes de aplicar las dos líneas.</p>
 <label><span className="label">Empleado de origen (posible deducción)</span><select className="select" value={transferFrom} onChange={e=>setTransferFrom(e.target.value)}>
 <option value="">Selecciona</option>{employees.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
 <label><span className="label">Empleado beneficiario (bono)</span><select className="select" value={transferTo} onChange={e=>setTransferTo(e.target.value)}>
 <option value="">Selecciona</option>{employees.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
 <label><span className="label">Importe USD</span><input className="input" type="number" step="0.01" min="0.01" value={transferAmount} onChange={e=>setTransferAmount(e.target.value)} placeholder="10.00"/></label>
 <label><span className="label">Explicación del incidente</span><textarea className="input" value={transferReason} onChange={e=>setTransferReason(e.target.value)} placeholder="Ej. Trabajo de Alexis cotizado $40 y cobrado por Cheo en $30. Propuesta de acuerdo pendiente."/></label>
 <div className="card"><strong>Vista previa</strong><div>{employeeName(transferFrom)}: −${Math.abs(Number(transferAmount||0)).toFixed(2)}</div>
 <div>{employeeName(transferTo)}: +${Math.abs(Number(transferAmount||0)).toFixed(2)}</div>
 <div><strong>Variación neta entre empleados: $0.00</strong></div></div>
 <button className="btn" disabled={busy||!transferFrom||!transferTo||transferFrom===transferTo||Number(transferAmount)<=0||transferReason.trim().length<12} onClick={proposeTransfer}>Guardar propuesta pendiente de revisión</button>
 {paired.map(t=><div className="card stack" key={t.id}><strong>Reasignación · $ ${Math.abs(Number(t.rows.find(x=>x.transfer_role==='TO')?.amount_ref??0)).toFixed(2)}</strong>
  <div>{t.rows.map(x=>employeeName(x.employee_id)+(x.transfer_role==='FROM'?' −':' +')+' USD '+Math.abs(Number(x.amount_ref)).toFixed(2)).join(' / ')}</div>
 <div className="muted small">{t.rows[0]?.decision==='HOLD'?'PENDIENTE: no aplicada':t.rows[0]?.decision==='PAY'?'APROBADA':'DESCARTADA'}</div>
 {t.rows.every(x=>x.decision==='HOLD')&&<button className="btn" disabled={busy} onClick={()=>{setTransferReview(t.id);setTransferEvidence('');setTransferConsent(false);}}>Revisar y decidir</button>}
 </div>)}
 </section>
 <section className="card stack"><h2>Últimas facturas de nómina</h2>{runs.map(r=>{const paid=Number(paidByRun[r.id]||0),due=Math.max(0,Number(r.total_ref)-paid);
 return <div className="card row-between" key={r.id}><div><strong>{r.employees?.name}</strong> · {r.period_start.slice(0,10)} — {r.period_end.slice(0,10)}
 <div className="muted small">{due>0.01?'LIQUIDADA, AÚN POR PAGAR / PAGO PARCIAL':'PAGADA'} · Total ${Number(r.total_ref).toFixed(2)} · Abonado ${paid.toFixed(2)} · Pendiente ${due.toFixed(2)}</div></div>
 <Link className={due>0.01?'btn btn-primary':'btn'} href={`/payroll/${r.id}/receipt`}>{due>0.01?'Registrar pago':'Ver recibo'}</Link></div>;})}</section>
 {edit&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Revisar trabajo"><h2>{edit.description}</h2><div>Obligación actual: ${Number(edit.obligation_usd??0).toFixed(2)} · {edit.payout_mode==='HARD_USD'?'pago en USD':'pago en Bs a BCV'}</div><label><span className="label">Decisión</span><select className="select" value={decision} onChange={e=>setDecision(e.target.value)}><option value="PAY">Pagar</option><option value="HOLD">Dejar pendiente</option><option value="EXCLUDE">Excluir del pago</option></select></label><label><span className="label">Monto adeudado en USD</span><input className="input" type="number" step="0.01" value={amount} disabled={!!edit.reversal_of} onChange={e=>setAmount(e.target.value)}/></label><label><span className="label">Motivo obligatorio</span><textarea className="input" value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<div className="error">{error}</div>}<button className="btn btn-primary" disabled={busy||reason.trim().length<5||amount===''||!Number.isFinite(Number(amount))} onClick={save}>Guardar con historial</button><button className="btn" disabled={busy} onClick={()=>setEdit(null)}>Cancelar</button></section></div>}
 {confirm&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Resumen de nómina"><h2>{confirm.name} · resumen</h2><strong>Comisiones: ${summary(confirm.id).totalUsd.toFixed(2)}</strong><div>USD reales: ${summary(confirm.id).hardUsd.toFixed(2)}</div><div>Convertibles a Bs al BCV del pago: ${summary(confirm.id).bcvUsd.toFixed(2)}{bcv?` ≈ ${fmtVes(summary(confirm.id).bcvUsd*bcv.value)}`:''}</div><div>Sueldo fijo: {fmtRef(summary(confirm.id).fixed)} REF</div><div>Ajustes: {fmtRef(summary(confirm.id).adj)} REF</div><p>{summary(confirm.id).hold} trabajos quedan pendientes. {summary(confirm.id).exclude} se excluyen sin pagarlos.</p><button className="btn btn-primary" disabled={busy} onClick={settle}>Confirmar liquidación</button><button className="btn" disabled={busy} onClick={()=>setConfirm(null)}>Volver a revisar</button></section></div>}
 {editAdj&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Editar ajuste"><h2>Editar / anular ajuste no liquidado</h2><label><span className="label">Tipo</span>
 <select className="select" value={editAdjType} onChange={e=>setEditAdjType(e.target.value)}>
 <option value="BONUS">+ Bono</option><option value="DEBT">− Descuento</option></select></label>
 <label><span className="label">Decisión</span><select className="select" value={editAdjDecision} onChange={e=>setEditAdjDecision(e.target.value)}><option value="PAY">Aplicar esta semana</option><option value="HOLD">Prorrogar a la siguiente</option><option value="EXCLUDE">Quitar del cálculo (conservar auditoría)</option></select></label><label><span className="label">Importe positivo, el sistema aplica el signo</span><input className="input" type="number" step="0.01" min="0.01" value={editAdjAmount} onChange={e=>setEditAdjAmount(e.target.value)}/></label><label><span className="label">Motivo</span><textarea className="input" value={editAdjReason} onChange={e=>setEditAdjReason(e.target.value)}/></label><button className="btn btn-primary" disabled={busy||Number(editAdjAmount)<=0||editAdjReason.trim().length<8} onClick={saveAdjustment}>Guardar ajuste y auditoría</button><button className="btn" disabled={busy} onClick={()=>setEditAdj(null)}>Cancelar</button></section></div>}
 {transferReview&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Revisar transferencia">
 <h2>Revisar reasignación retenida</h2>
 <p>Ambos ajustes permanecen detenidos hasta que se autoricen correctamente. Aprobar hará efectivos simultáneamente el bono y la deducción, pero no creará ninguna entrada o salida bancaria.</p>
 <label><span className="label">Evidencia, autorización y revisión laboral</span><textarea className="input" value={transferEvidence} onChange={e=>setTransferEvidence(e.target.value)} placeholder="Registra acuerdo y soporte documental comprobados"/></label>
 <label className="row"><input type="checkbox" checked={transferConsent} onChange={e=>setTransferConsent(e.target.checked)}/>
 Confirmo que existe autorización válida y que el descuento es legalmente procedente.</label>
 <button className="btn btn-primary" disabled={busy||!transferConsent||transferEvidence.trim().length<12} onClick={()=>void decideTransfer(transferReview,'APPROVE')}>Aprobar ambos ajustes</button>
 <button className="btn" disabled={busy||transferEvidence.trim().length<12} onClick={()=>void decideTransfer(transferReview,'REJECT')}>Descartar ambos (sin efecto económico)</button>
 <button className="btn" onClick={()=>setTransferReview(null)}>Cerrar sin decidir</button>
 </section></div>}
 {history&&<div className="overlay"><section className="sheet stack" role="dialog" aria-modal="true" aria-label="Historial"><h2>Historial</h2>{!history.length&&<p>Sin ajustes manuales.</p>}{history.map(h=><div className="card" key={h.id}><strong>{h.reason}</strong><div>{h.before_data.decision} → {h.after_data.decision} · {money(h.before_data.amount,h.before_data.currency)} → {money(h.after_data.amount,h.after_data.currency)}</div><div className="muted small">{new Date(h.occurred_at).toLocaleString('es-VE')} · Usuario {h.actor_id}</div></div>)}<button className="btn" onClick={()=>setHistory(null)}>Cerrar</button></section></div>}
 </main>;
}

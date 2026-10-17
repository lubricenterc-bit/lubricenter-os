"use client";
import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import {supabase} from "@/lib/supabase";
type Employee={id:string;name:string};
type Account={id:string;code:string;name:string;currency:string;account_type:string};
type Advance={id:string;employee_id:string;employee_name:string;paid_on:string;intended_period_end:string;currency:string;
  amount_original:number;usd_equivalent:number;reference:string|null;note:string;account_code:string;movement_id:string;
  applied_usd?:number;allocated_usd:number;unapplied_usd:number;
  applications:{run_id:string;usd_applied:number;period_end:string}[]};
function today(){return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas"}).format(new Date());}
function saturday(day:string){const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+(6-d.getUTCDay()+7)%7);return d.toISOString().slice(0,10);}
export default function PayrollAdvances(){
 const [employees,setEmployees]=useState<Employee[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[advances,setAdvances]=useState<Advance[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[accountId,setAccountId]=useState(""),[paidOn,setPaidOn]=useState(today);
 const [periodEnd,setPeriodEnd]=useState(saturday(today())),[amount,setAmount]=useState(""),[claimedUsd,setClaimedUsd]=useState("");
 const [reference,setReference]=useState(""),[note,setNote]=useState("");
 const [rate,setRate]=useState<number|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[confirm,setConfirm]=useState(false);
 const selectedAccount=accounts.find(a=>a.id===accountId);
 const expected=useMemo(()=>{const n=Number(amount);if(!(n>0))return 0;return selectedAccount?.currency==="VES"?rate?Math.round(n/rate*100)/100:0:n;},[amount,selectedAccount,rate]);
 async function load(){
   setError("");
   const [a,e,h]=await Promise.all([
     supabase.from("financial_accounts").select("id,code,name,currency,account_type").eq("active",true).in("currency",["VES","USD"]).in("account_type",["BANK","CASH","CLEARING"]).neq("code","MOBILE").order("name"),
     supabase.from("employees").select("id,name").eq("active",true).order("name"),
     supabase.rpc("payroll_advance_admin_history")
   ]);
   const bad=[a,e,h].find(x=>x.error);if(bad?.error)throw bad.error;
   setAccounts((a.data??[]) as Account[]);setEmployees((e.data??[]) as Employee[]);
   setAdvances((h.data??[]) as Advance[]);
   setAccountId(current=>current||a.data?.[0]?.id||"");
   setEmployeeId(current=>current||e.data?.[0]?.id||"");
 }
 useEffect(()=>{let alive=true;void (async()=>{try{const auth=await supabase.rpc("can_administer_orders");
   if(auth.error||auth.data!==true)throw new Error("Solo administración puede registrar anticipos de nómina.");
   await load();
 }catch(e){if(alive)setError((e as Error).message);}finally{if(alive)setLoading(false);}})();return()=>{alive=false;};},[]);
 useEffect(()=>{if(!paidOn)return;let alive=true;setRate(null);
   void supabase.from("exchange_rates").select("value").eq("rate_type","BCV")
     .lte("effective_at",paidOn+"T23:59:59-04:00").order("effective_at",{ascending:false}).limit(1)
     .then(({data})=>{if(alive)setRate(data?.[0]?Number(data[0].value):null);});
   return()=>{alive=false;};},[paidOn]);
 function changeDate(next:string){setPaidOn(next);setPeriodEnd(saturday(next));setConfirm(false);}
 async function save(){
   if(busy||!confirm||!employeeId||!selectedAccount||!Number(amount)||note.trim().length<8||!periodEnd)return;
   setBusy(true);setError("");setNotice("");
   try{
     const r=await supabase.rpc("payroll_record_advance",{
       p_employee_id:employeeId,p_paid_on:paidOn,p_intended_period_end:periodEnd,p_account_id:accountId,
       p_amount_original:Number(amount),p_reference:reference.trim()||null,p_note:note.trim(),
       p_expected_usd:claimedUsd.trim()?Number(claimedUsd):null
     });
     if(r.error)throw r.error;
     setNotice(`Anticipo registrado: $${Number(r.data?.usd_equivalent||0).toFixed(2)} · ${paidOn}. Descontará de la liquidación al cerrarla, sin volver a mover caja.`);
     setAmount("");setClaimedUsd("");setReference("");setNote("");setConfirm(false);
     await load();
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <main className="container stack">
  <div className="row-between" style={{flexWrap:"wrap"}}><div><div className="eyebrow">NÓMINA · EGRESO INDEPENDIENTE</div>
    <h1>Anticipos ya entregados</h1><p className="muted">Registra dinero real entregado antes del sábado. No es un descuento de comisión ni un segundo pago al liquidar.</p></div>
    <div className="row"><Link className="btn" href="/payroll">Volver</Link><Link className="btn" href="/payroll/history">Historial administrativo</Link></div>
  </div>
  {error&&<div className="error" role="alert">{error}</div>}
  {notice&&<div className="success" role="status">{notice}</div>}
  {loading?<p>Cargando cuentas y anticipos…</p>:<section className="card stack">
    <h2>Registrar anticipo histórico real</h2>
    <div className="grid grid-2">
      <label><span className="label">Empleado</span><select className="select" value={employeeId} onChange={e=>setEmployeeId(e.target.value)}>
       {employees.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
      <label><span className="label">Fecha real en que se entregó</span><input className="input" type="date" max={today()} value={paidOn} onChange={e=>changeDate(e.target.value)}/></label>
      <label><span className="label">Cuenta desde donde salió</span><select className="select" value={accountId} onChange={e=>setAccountId(e.target.value)}>
       {accounts.map(a=><option value={a.id} key={a.id}>{a.name} · {a.currency}</option>)}</select></label>
      <label><span className="label">Monto que salió de la cuenta ({selectedAccount?.currency||"USD/Bs"})</span>
        <input className="input" type="number" min=".01" step=".01" value={amount} onChange={e=>{setAmount(e.target.value);setConfirm(false);}}/></label>
      <label><span className="label">Monto acordado como anticipo en USD (para verificación)</span>
        <input className="input" type="number" min=".01" step=".01" value={claimedUsd} onChange={e=>{setClaimedUsd(e.target.value);setConfirm(false);}} placeholder="Ej. 32.00"/></label>
      <label><span className="label">Referencia de pago {selectedAccount?.account_type==="BANK"?"(obligatoria)":""}</span>
       <input className="input" value={reference} onChange={e=>{setReference(e.target.value);setConfirm(false);}} placeholder="Últimos 4 dígitos o referencia completa"/></label>
      <label><span className="label">Sábado de la nómina a la que se aplicará</span>
       <input className="input" type="date" value={periodEnd} onChange={e=>{setPeriodEnd(e.target.value);setConfirm(false);}}/></label>
    </div>
    <label><span className="label">Motivo y trabajos que está adelantando</span>
      <textarea className="textarea" value={note} onChange={e=>{setNote(e.target.value);setConfirm(false);}}
      placeholder="Ej. Anticipo de $32 entregado el miércoles: $16 OS-000167 Silverado + $16 arranque adicional pendiente de facturar." rows={3}/></label>
    <div className="card"><div>Equivalente calculado: <strong>${expected>0?"$"+expected.toFixed(2):"Indica el monto y la tasa"}</strong></div>
      <div className="muted small">BCV de ese día: {rate?rate.toFixed(4)+" Bs/$":"No disponible"}. El banco o la caja tendrán una única salida histórica por la fecha indicada.</div></div>
    <label className="row"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>
      Confirmo que este dinero ya fue entregado, que he elegido la cuenta real y que no existe otra salida registrada por el mismo pago.</label>
    <button className="btn btn-primary" onClick={save}
      disabled={busy||!confirm||!amount||!employeeId||!accountId||!rate||note.trim().length<8||!periodEnd||!(expected>0)|| (selectedAccount?.account_type==="BANK"&&reference.replace(/\D/g,"").length<4)}>
      {busy?"Registrando egreso…":"Registrar anticipo real"}</button>
    <p className="muted small">El sistema bloquea referencias bancarias duplicadas. Si el dinero ya aparece como egreso manual o pago de nómina, no lo registres nuevamente: primero se debe vincular el egreso existente.</p>
  </section>}
  <section className="card stack"><h2>Historial de anticipos</h2>
   {advances.length===0&&<p className="muted">Sin anticipos registrados todavía.</p>}
   {advances.map(a=><article className="card stack" key={a.id}>
    <div className="row-between"><div><strong>{a.employee_name} · $${Number(a.usd_equivalent).toFixed(2)}</strong><div className="muted small">{a.paid_on} · {a.account_code} · {a.currency==="VES"?"Bs ":"$"}{Number(a.amount_original).toFixed(2)}</div></div>
      <span className="pill">{Number(a.unapplied_usd)>0.01?"Pendiente de aplicar":"Aplicado"}</span></div>
    <div>{a.note}</div><div className="muted small">Ref. {a.reference||"Sin referencia"} · Aplicado $${Number(a.allocated_usd).toFixed(2)} · Resto $${Number(a.unapplied_usd).toFixed(2)} · Nómina prevista: {a.intended_period_end}</div>
    {a.applications?.map((x,i)=><div className="muted small" key={i}>Descontado de liquidación del {x.period_end}: $${Number(x.usd_applied).toFixed(2)}</div>)}
   </article>)}
  </section>
 </main>;
}

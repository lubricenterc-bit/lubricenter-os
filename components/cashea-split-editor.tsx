"use client";
import { useEffect } from "react";
import { fmtVes } from "@/lib/format";
import { D } from "@/lib/finance/money";
import {
  CASHEA_INITIAL_METHODS, casheaAutoAmount, casheaCurrency,
  casheaPaymentPreview, isCasheaBank, isCasheaElectronic,
  newCasheaSplitLine, type CasheaSplitLine, type CasheaInitialMethod
} from "@/lib/cashea-split";

export function CasheaSplitEditor({
  lines,onChange,requiredVes,bcv,previouslyPaidVes=0,disabled=false
}:{
  lines:CasheaSplitLine[];
  onChange:(next:CasheaSplitLine[])=>void;
  requiredVes:number;bcv:number;previouslyPaidVes?:number;disabled?:boolean;
}){
  const preview=casheaPaymentPreview(lines,requiredVes,bcv);

  useEffect(()=>{
    if(lines.length!==1||!lines[0].autoFill)return;
    if(requiredVes<=0){
      onChange([]);
      return;
    }
    const target=casheaAutoAmount(requiredVes,lines[0].method,bcv);
    if(target!==lines[0].amount)onChange([{...lines[0],amount:target}]);
  },[lines,requiredVes,bcv,onChange]);

  function update(id:string,patch:Partial<CasheaSplitLine>){
    onChange(lines.map(line=>line.id===id?{...line,...patch}:line));
  }
  function fillRemaining(id:string){
    const current=lines.find(row=>row.id===id);
    if(!current)return;
    let used=new D(0);
    for(const row of lines){
      if(row.id===id||!/^\d+(?:\.\d{1,2})?$/.test(row.amount)||Number(row.amount)<=0)continue;
      const amount=new D(row.amount);
      used=used.plus(casheaCurrency(row.method)==="USD"?amount.mul(bcv).toDecimalPlaces(2):amount);
    }
    const remainder=new D(requiredVes).minus(used);
    if(remainder.lte(0))return;
    update(id,{amount:casheaAutoAmount(Number(remainder),current.method,bcv),autoFill:false});
  }
  return <section className="cashea-split stack" aria-label="Desglose de pagos de la inicial">
    <div className="row-between" style={{gap:12,flexWrap:"wrap"}}>
      <div>
        <strong>¿A dónde llegó cada parte de la inicial?</strong>
        <div className="muted small">Selecciona el banco real o la caja. Puedes combinar varios métodos.</div>
      </div>
      <span className="pill">BCV · {Number(bcv).toLocaleString("es-VE")} Bs/USD</span>
    </div>
    {previouslyPaidVes>0&&<div className="card" style={{padding:11}}>
      <div className="row-between"><span>Pagos registrados anteriormente en esta orden</span><strong>{fmtVes(previouslyPaidVes)}</strong></div>
      <div className="muted small">Se conservan con su banco y referencia originales; aquí completas únicamente el faltante de la inicial.</div>
    </div>}
    {lines.map((row,i)=>{
      const usd=casheaCurrency(row.method)==="USD";
      const bank=isCasheaBank(row.method);
      return <div className="card stack" key={row.id} style={{padding:13,borderColor:"rgba(255,140,66,.28)",gap:10}}>
        <div className="row-between">
          <strong className="small">Cobro {i+1}</strong>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={()=>{
            const next=lines.filter(p=>p.id!==row.id).map(p=>({...p,autoFill:false}));
            onChange(next);
          }} aria-label={"Quitar cobro "+(i+1)}>Quitar</button>
        </div>
        <label><span className="label">Cuenta que recibió el dinero</span>
          <select className="select" value={row.method} disabled={disabled}
            onChange={e=>update(row.id,{method:e.target.value as CasheaInitialMethod,reference:""})}>
            {CASHEA_INITIAL_METHODS.map(([code,label])=><option value={code} key={code}>{label}</option>)}
          </select>
        </label>
        <div className="grid grid-2">
          <label><span className="label">Importe recibido · {usd?"USD":"Bs"}</span>
            <input className="input" type="number" inputMode="decimal" min="0.01" step="0.01"
              value={row.amount} disabled={disabled}
              onChange={e=>update(row.id,{amount:e.target.value,autoFill:false})}
              placeholder={usd?"Ej. 10.00":"Ej. 3500.00"}/>
          </label>
          {isCasheaElectronic(row.method)?<label><span className="label">{bank?"Últimos 4+ dígitos de referencia":"Referencia de operación"} · obligatorio</span>
            <input className="input" value={row.reference} disabled={disabled}
              onChange={e=>update(row.id,{reference:e.target.value})}
              inputMode={bank?"numeric":"text"} maxLength={100}
              placeholder={bank?"Ej. 4298":"ID o referencia del cobro"}/>
          </label>:<div className="muted small" style={{alignSelf:"center"}}>Este importe entra a la caja de {usd?"divisas":"bolívares"}.</div>}
        </div>
        <div className="row-between" style={{flexWrap:"wrap",gap:10}}>
          {usd&&<span className="muted small">Valor a BCV: {Number(row.amount)>0?fmtVes(Number(new D(row.amount||0).mul(bcv).toDecimalPlaces(2))):"—"}</span>}
          <button type="button" className="btn btn-ghost" disabled={disabled||requiredVes<=0}
            onClick={()=>fillRemaining(row.id)}>Completar faltante con este método</button>
        </div>
      </div>;
    })}
    {lines.length<8&&requiredVes>0&&<button type="button" className="btn btn-ghost btn-block" disabled={disabled}
      onClick={()=>onChange([...lines.map(r=>({...r,autoFill:false})),{...newCasheaSplitLine("split-"+crypto.randomUUID()),amount:"",autoFill:false}])}>
      + Otro método de pago
    </button>}
    <div className="card stack" style={{padding:13,borderColor:preview.valid?"rgba(63,190,115,.50)":"rgba(255,106,26,.45)"}}>
      <div className="row-between"><span>Por recibir ahora</span><strong>{fmtVes(requiredVes)}</strong></div>
      <div className="row-between"><span>Desglosado por método</span><strong>{fmtVes(preview.paidVes)}</strong></div>
      <div className="divider"/>
      <div className="row-between"><strong>{preview.valid?"Inicial cuadrada":"Diferencia por cuadrar"}</strong>
        <strong>{fmtVes(Math.abs(preview.differenceVes))}</strong></div>
      {preview.error&&<div className="error" role="status">{preview.error}</div>}
      {preview.valid&&<div className="success small">Cada cobro irá únicamente a la cuenta que seleccionaste. El monto financiado se registra aparte, sin entrada de efectivo.</div>}
    </div>
  </section>;
}

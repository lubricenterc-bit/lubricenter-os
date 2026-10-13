// Pure calendar selection. BCV future Fecha Valor never becomes operational
// before midnight in Venezuela; publication timestamp is audit metadata only.
export type BcvRateDateValue={effective_date:string;USD:number;updated_at:string};
export function caracasCalendarDate(now:Date):string {
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit",
  }).format(now);
}
export function selectCurrentRate<T extends {effective_date:string;USD:number}>(
  entries:T[],caracasDate:string
):T|null {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(caracasDate))throw Error("Fecha inválida");
  return entries.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.effective_date) &&
    Number.isFinite(x.USD)&&x.USD>0&&x.effective_date<=caracasDate)
    .sort((a,b)=>b.effective_date.localeCompare(a.effective_date))[0]??null;
}
export function isSafeBcvSnapshot(rate:BcvRateDateValue,now:Date) {
  const date=caracasCalendarDate(now);
  const captured=new Date(rate.updated_at);
  if(!Number.isFinite(captured.getTime())||
    captured.getTime()>now.getTime()+300_000 ||
    now.getTime()-captured.getTime()>21*86400000)return false;
  const value=selectCurrentRate([rate],date);
  // A published, dated rate is allowed to be future-dated but no more than ten days.
  const dayDelta=(Date.parse(rate.effective_date+"T00:00:00Z")
    -Date.parse(date+"T00:00:00Z"))/86400000;
  return Number.isFinite(rate.USD)&&rate.USD>0&&rate.USD<1e6
    &&Number.isFinite(dayDelta)&&dayDelta>=-14&&dayDelta<=10
    &&(!value || value.effective_date===rate.effective_date);
}

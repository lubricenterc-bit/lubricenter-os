import { D } from './money';

export function changeQuote(remainingVes: string | number, received: string | number, currency: string, paymentRate: string | number, changeRate: string | number, fixedUsd?:number) {
  const remaining = new D(remainingVes), tender = new D(received), rate = new D(paymentRate), exchange = new D(changeRate);
  if (![remaining,tender,rate,exchange].every(n=>n.isFinite() && n.gt(0))) throw new Error('Indica importes y tasas positivos.');
  if(fixedUsd!==undefined&&(!Number.isFinite(fixedUsd)||fixedUsd<=0))throw new Error('Indica el precio USD pactado.');
  if (tender.decimalPlaces()>2 || rate.decimalPlaces()>6 || exchange.decimalPlaces()>6) throw new Error('Usa dos decimales para el dinero y hasta seis para la tasa.');
  const due = (currency==='USD'?remaining.div(rate):fixedUsd!==undefined?new D(fixedUsd).mul(exchange):remaining).toDecimalPlaces(2);
  const applied = D.min(tender,due);
  const extra = tender.sub(applied);
  const change=(currency==='USD'?extra:extra.div(exchange)).toDecimalPlaces(2);
  return { due:due.toFixed(2), applied:applied.toFixed(2), changeUsd:change.toFixed(2), roundingVes:currency==='VES'?extra.sub(change.mul(exchange)).toFixed(2):'0.00', coveredVes:tender.gte(due)?remaining.toFixed(2):currency==='VES'&&fixedUsd!==undefined?applied.div(exchange).mul(rate).toFixed(2):applied.mul(currency==='USD'?rate:1).toFixed(2) };
}

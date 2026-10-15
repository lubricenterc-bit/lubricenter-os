export type ReceiptRequest = {
  p_request_id: string;
  p_invoice_id: string;
  p_location_id: string;
  p_received_on: string;
  p_items: Array<{line_id:string;quantity:number}>;
  p_notes: string|null;
};

export const receiptStorageKey = (invoiceId:string) => `lubricenter:receipt:${invoiceId}`;

export function validateReceiptQuantities(lines:Array<{id:string;quantity:number;received_quantity:number}>, quantities:Record<string,number>) {
  for (const line of lines) {
    const qty=quantities[line.id]??0;
    if (!Number.isFinite(qty)||qty<0||qty>Number(line.quantity)-Number(line.received_quantity))
      return "Cada cantidad debe estar entre cero y la cantidad pendiente.";
  }
  return lines.some(line=>(quantities[line.id]??0)>0)?null:"Selecciona al menos una cantidad para recibir.";
}

export function readPendingReceipt(storage:Pick<Storage,"getItem">, invoiceId:string):ReceiptRequest|null {
  const raw=storage.getItem(receiptStorageKey(invoiceId));
  if (!raw) return null;
  const request=JSON.parse(raw) as ReceiptRequest;
  if(request.p_invoice_id!==invoiceId||!request.p_request_id||!Array.isArray(request.p_items))
    throw Error("La recepción pendiente no se pudo recuperar. Revisa su estado antes de recibir de nuevo.");
  return request;
}

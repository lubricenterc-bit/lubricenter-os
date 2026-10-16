export const OFFICIAL_BCV_URL = "https://www.bcv.org.ve/";

/** Parse only the official USD block and its machine-readable Fecha Valor. */
export function parseOfficialBcv(html: string, observedAt = new Date()) {
  if (html.length > 2_000_000) throw Error("La página BCV excede el tamaño permitido");
  const blocks = [...html.matchAll(/\bid=["']dolar["']([\s\S]{0,2500}?)(?=\bFecha\s+Valor)/gi)];
  const dates = [...html.matchAll(/Fecha\s+Valor\s*:\s*<span\b[^>]*\bcontent=["'](\d{4}-\d{2}-\d{2})T00:00:00-04:00["']/gi)];
  if (blocks.length !== 1 || dates.length !== 1) throw Error("BCV no contiene un único dólar y fecha valor verificables");
  const amounts = [...blocks[0][1].matchAll(/<strong\b[^>]*>\s*((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2,8})\s*<\/strong>/gi)];
  if (amounts.length !== 1) throw Error("El importe oficial USD tiene un formato inesperado");
  const value = amounts[0][1].replaceAll(".", "").replace(",", ".");
  if (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) >= 1_000_000) throw Error("La tasa oficial está fuera de rango");
  const date = dates[0][1];
  const effectiveAt = new Date(`${date}T00:00:00-04:00`);
  if (!Number.isFinite(effectiveAt.getTime()) || effectiveAt.toISOString().slice(0,10) !== date) throw Error("Fecha valor BCV inválida");
  const localToday = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(observedAt);
  const distance = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${localToday}T00:00:00Z`)) / 86_400_000;
  if (distance < -14 || distance > 10) throw Error("La fecha valor BCV está fuera de la ventana admitida");
  return {value, valueDate: date, effectiveAt: effectiveAt.toISOString(), sourceUrl: OFFICIAL_BCV_URL};
}

export async function readOfficialHtml(response: Response) {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw Error(`Respuesta oficial BCV inesperada (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw Error("BCV devolvió una respuesta vacía");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 2_000_000) throw Error("La página BCV excede el tamaño permitido");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", {fatal:true}).decode(bytes);
}

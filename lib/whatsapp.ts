// Enlace único para abrir WhatsApp con texto precargado.
//
// No usar https://wa.me/…?text=…: WhatsApp redirige wa.me a api.whatsapp.com/send
// y en esa redirección los emojis llegan rotos (un rombo o triángulo con «?»).
// Yendo directo a api.whatsapp.com/send los emojis se ven bien en teléfono,
// WhatsApp Web y la app de escritorio.
export function whatsappUrl(phone?: string | null, text?: string | null) {
  const params: string[] = [];
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits) params.push(`phone=${digits}`);
  if (text) {
    // Un emoji partido a la mitad haría fallar encodeURIComponent; se reemplaza en vez de romper el botón.
    const safe = text.normalize("NFC").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    params.push(`text=${encodeURIComponent(safe)}`);
  }
  return `https://api.whatsapp.com/send${params.length ? `?${params.join("&")}` : ""}`;
}

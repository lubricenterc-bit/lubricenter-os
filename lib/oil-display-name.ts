// Nombre de aceite para MOSTRAR (CRM, historial, recibos). No reescribe service_records:
// el historial conserva lo que se escribió. Propuesta del Frente G-4 (pendiente de aprobación;
// tabla completa en docs/propuesta-nombres-aceite.md).
//   «Valvoline 15w40 Semi», «VALVOLINE 15W-40 SEMISINTETICO» → «Valvoline 15W-40 Semisintético»
//   «6 litros de Sky Evolub 20W50 mineral», «Lirax 20W50 mineral granel» → «Sky Evolub 20W-50 Mineral», «Lirax 20W-50 Mineral»
//   «15w40 Valvoline» → «Valvoline 15W-40»

/** Correcciones de marca escritas mal (clave en minúsculas). El dueño aprueba esta lista. */
export const OIL_BRAND_ALIASES: Record<string, string> = {
  "chornus": "Chronus",
  "movil delmac": "Mobil Delvac",
  "mobil delmac": "Mobil Delvac",
  "movil": "Mobil",
  "dr care": "Dr. Care",
  "motorcraft": "Motorcraft",
};

const VISCOSITY = /\b(0|5|10|12|15|20|25)\s*w?e?\s*-?\s*(20|30|40|50|60)\b/i;
const SAE = /\bsae\s*(30|40|50|60)\b/i;
const QUANTITY = /\(\s*[\d\s/]+\)|\b\d+\s*(litros?|lit|ltr|lts?|l)\b\.?|\b(litros?|litro|lit|ltr|lts)\b\.?/gi;
const PACKAGING = /\b(a\s+granel|garrafa|granel|gal[oó]n|tambor|pote)\b/gi;
const SEMI = /\bsemi\s*-?\s*(s[iy]nt[eé]tico)?\b|\bsem[ie]\s*s[iy]nt[eé]tico\b/i;
const MINERAL = /\bminerale?s?\b|\bminera\b/i;
const FULL = /\bfull(\s*-?\s*s[iy]nt[eé]tico)?\b|\bs[iy]nt[eé]tico\b/i;

function word(w: string): string {
  if (/\d/.test(w) || /^(sae)$/i.test(w)) return w.toUpperCase();
  return w.split("/").map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("/");
}

export function oilDisplayName(raw: string | null | undefined): string {
  let text = ` ${(raw ?? "").replace(/\s+/g, " ").trim()} `;
  if (!text.trim()) return "";
  let viscosity = "";
  const v = text.match(VISCOSITY);
  if (v) { viscosity = `${v[1]}W-${v[2]}`; text = text.replace(VISCOSITY, " "); }
  else { const s = text.match(SAE); if (s) { viscosity = `SAE ${s[1]}`; text = text.replace(SAE, " "); } }
  text = text.replace(QUANTITY, " ").replace(PACKAGING, " ");
  let kind = "";
  if (SEMI.test(text)) { kind = "Semisintético"; text = text.replace(SEMI, " "); }
  else if (MINERAL.test(text)) { kind = "Mineral"; text = text.replace(MINERAL, " "); }
  else if (FULL.test(text)) { kind = "Sintético"; text = text.replace(FULL, " "); }
  // Cantidades sueltas al inicio («4 Valvoline», «6 de …») y la preposición «de».
  text = text.replace(/^\s*\d{1,2}\s+(?=\D)/, " ").replace(/\bde\b/gi, " ");
  let brand = text.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
  const alias = Object.keys(OIL_BRAND_ALIASES).sort((a, b) => b.length - a.length)
    .find(k => brand.toLowerCase() === k || brand.toLowerCase().startsWith(k + " "));
  brand = alias ? OIL_BRAND_ALIASES[alias] + brand.slice(alias.length) : brand;
  brand = brand.split(" ").filter(Boolean).map((w, i) => (i === 0 && alias ? w : word(w))).join(" ");
  return [brand, viscosity, kind].filter(Boolean).join(" ");
}

export function matchesSearch(value: string, query: string) {
  const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = normalize(value);
  return normalize(query).split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
}


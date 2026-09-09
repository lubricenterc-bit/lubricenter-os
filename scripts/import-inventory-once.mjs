const url = process.env.INVENTORY_IMPORT_URL;

if (!url) {
  console.log("[inventory-import] no import URL configured; skipping");
  process.exit(0);
}

console.log("[inventory-import] importing opening inventory snapshot...");
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
const text = await response.text();
if (!response.ok) {
  console.error(`[inventory-import] failed ${response.status}: ${text}`);
  process.exit(1);
}
console.log(`[inventory-import] completed: ${text}`);

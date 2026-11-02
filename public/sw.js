const CACHE = "lubricenter-os-v0.8-static-assets";
// Archivos con hash de Next (/_next/static/...) nunca cambian de contenido:
// se guardan en una caché propia que sobrevive a los despliegues y se sirven
// sin red. Así la PWA abre al instante aunque la conexión del local sea lenta.
const STATIC_CACHE = "lubricenter-os-static-v1";
const STATIC_MAX_ENTRIES = 300;
const KEEP = [CACHE, STATIC_CACHE];
const DEV_HOSTS = ["localhost", "127.0.0.1"];
const SHELL = ["/", "/orders", "/orders/new", "/inventory", "/customers", "/reminders", "/payroll", "/settings", "/manifest.webmanifest", "/api/brand/isotipo.png", "/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function offlineApiResponse() {
  return new Response(JSON.stringify({error:"Sin conexión. Intenta nuevamente cuando vuelva la red."}), {
    status:503,
    statusText:"Service Unavailable",
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

function offlinePageResponse() {
  return new Response("Sin conexión. Recarga cuando vuelva la red.", {
    status:503,
    statusText:"Service Unavailable",
    headers:{
      "Content-Type":"text/plain; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/") && !DEV_HOSTS.includes(self.location.hostname);
}

function isBrandAsset(url) {
  return url.pathname.startsWith("/pwa/") || url.pathname.startsWith("/brand/") || url.pathname.startsWith("/api/brand/") ||
    /^\/(icon-\d+\.png|lubricenter-[\w-]+\.(png|svg))$/.test(url.pathname);
}

async function trimStaticCache(cache) {
  const keys = await cache.keys();
  const extra = keys.length - STATIC_MAX_ENTRIES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

// Cache-first: el contenido de un archivo con hash no cambia nunca.
async function immutableResponse(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      trimStaticCache(cache).catch(() => undefined);
    }
    return response;
  } catch {
    return offlinePageResponse();
  }
}

// Stale-while-revalidate: logos e iconos salen de caché y se refrescan por detrás.
async function brandResponse(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then(async response => {
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  try { return await network; } catch { return offlinePageResponse(); }
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isImmutableAsset(url)) { event.respondWith(immutableResponse(event.request)); return; }
  if (isBrandAsset(url)) { event.respondWith(brandResponse(event)); return; }

  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch {
      if (url.pathname.startsWith("/api/")) return offlineApiResponse();

      const cached = await caches.match(event.request);
      if (cached) return cached;

      if (event.request.mode === "navigate") {
        const shell = await caches.match("/");
        if (shell) return shell;
      }

      return offlinePageResponse();
    }
  })());
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || "Lubricenter", {
    body: data.body || "Revisa tus pendientes en la app.",
    tag: "lubricenter-finance-daily",
    data: { url: ["/finance/inbox", "/change"].includes(data.url) ? data.url : "/finance/inbox" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/finance/inbox", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    const client = clients.find(c => new URL(c.url).origin === self.location.origin);
    if (client) { await client.navigate(url); return client.focus(); }
    return self.clients.openWindow(url);
  }));
});

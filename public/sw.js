const CACHE = "lubricenter-os-v0.7-approved-brand";
const SHELL = ["/", "/orders", "/orders/new", "/inventory", "/customers", "/reminders", "/payroll", "/settings", "/manifest.webmanifest", "/api/brand/isotipo.png", "/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

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

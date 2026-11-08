const VERSION = "recetok-v13";
const FOTOS = "recetok-fotos-4k";
const SHELL = ["/", "/index.html", "/standalone.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== FOTOS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if(req.method === "GET" && url.pathname === "/api/foto"){                      // fotos de platos: se guardan para verlas sin internet
    e.respondWith(caches.open(FOTOS).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if(r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }))));
    return;
  }
  if(req.method !== "GET" || url.pathname.startsWith("/api/")) return;           // la IA siempre va a la red
  if(req.mode === "navigate"){                                                    // página: red primero, copia si no hay conexión
    const net = fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put("/index.html", cp)); return r; });
    const slow = new Promise((_, no) => setTimeout(no, 3500));                    // conexión lenta: abre la copia guardada
    e.respondWith(Promise.race([net, slow]).catch(() => caches.match("/index.html").then(h => h || net)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {                                   // resto (íconos, fuentes): caché y se actualiza
    const net = fetch(req).then(r => { if(r.ok || r.type === "opaque"){ const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});

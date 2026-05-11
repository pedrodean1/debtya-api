const SW_CACHE = "debtya-static-v109.1-confirm-manual-atomic-hardening";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/logo.png",
  "/icons/favicon-32.png",
  "/icons/apple-touch-icon.png",
  "/icons/debtya-192.png",
  "/icons/debtya-512.png",
  "/icons/debtya-192.svg",
  "/icons/debtya-512.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SW_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SW_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache private/authenticated API responses.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }

  const destination = req.destination;
  const isStaticAsset =
    destination === "script" ||
    destination === "style" ||
    destination === "image" ||
    destination === "font" ||
    url.pathname === "/manifest.webmanifest";

  if (isStaticAsset) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SW_CACHE).then((cache) => cache.put(req, copy)).catch(() => null);
          }
          return res;
        });
      })
    );
    return;
  }

  if (req.mode === "navigate" || destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SW_CACHE).then((cache) => cache.put("/index.html", copy)).catch(() => null);
          }
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
  }
});

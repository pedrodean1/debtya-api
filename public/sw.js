const SW_CACHE = "debtya-static-v118-paid-debts-next-line-btn";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/logo.png",
  "/icons/favicon-32.png",
  "/icons/apple-touch-icon.png",
  "/icons/debtya-192.png",
  "/icons/debtya-512.png"
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

function isVersionedScriptOrStyle(url) {
  return url.pathname === "/app.js" || url.pathname === "/styles.css";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const bypassPrefixes = [
    "/api/",
    "/auth/",
    "/debts",
    "/payment-intents",
    "/billing",
    "/notifications",
    "/stripe",
    "/guide-assistant",
    "/spinwheel",
    "/method",
    "/manual-plan",
    "/plaid",
    "/health",
    "/cron",
    "/ai-coach"
  ];
  const path = url.pathname;
  if (
    bypassPrefixes.some((p) =>
      p.endsWith("/") ? path.startsWith(p) || path === p.slice(0, -1) : path === p || path.startsWith(`${p}/`)
    )
  ) {
    return;
  }

  const destination = req.destination;
  const isStaticAsset =
    destination === "script" ||
    destination === "style" ||
    destination === "image" ||
    destination === "font" ||
    url.pathname === "/manifest.webmanifest";

  if (isStaticAsset && isVersionedScriptOrStyle(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SW_CACHE).then((cache) => cache.put(req, copy)).catch(() => null);
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

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

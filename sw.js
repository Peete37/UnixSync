const CACHE_NAME = "kofid-connect-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./supabase-config.js", // 👈 Pointing cleanly to your new setup file
  "./auth.service.js",
  "./post.service.js",
  "./location.service.js",
  "./create-post.ui.js",
  "./manifest.json"
];

/**
 * Install event: cache essential app shell
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

/**
 * Activate event: cleanup old caches
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/**
 * Fetch event: network-first for HTML, cache-first for static assets
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  // ─── SUPABASE & BROWSER EXTENSION BYPASS ────────────────────────────────────
  // We explicitly bypass Supabase HTTP API requests (.supabase.co) and browser extensions
  // so the service worker doesn't try to intercept or cache live database/auth operations.
  if (request.url.includes("supabase.co") || request.url.startsWith("chrome-extension")) {
    return;
  }

  const isPageRequest = request.headers.get("accept")?.includes("text/html");

  if (isPageRequest) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          return response;
        })
        .catch(() => caches.match(request).then((res) => res || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request).then((response) => {
          // Only cache standard first-party static assets (JavaScript, local UI scripts, CSS, etc.)
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          return response;
        }).catch(() => {
          // Silently fail if resources aren't online yet
        })
      );
    })
  );
});
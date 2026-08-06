// CampusMarket service worker
//
// Goal: cut down on repeat mobile-data usage for a campus app that the
// same students open many times a day on the same connection, without
// ever serving stale live data or a stale HTML shell while the app is
// still actively being developed.
//
// Two different strategies for two different kinds of files:
//
//   1. HTML page requests (index.html / navigations) — NETWORK-FIRST.
//      Always try the network first so a person always gets the latest
//      markup right after a deploy; only fall back to whatever's cached
//      if the network request fails (offline, flaky connection). This
//      matters especially right now since index.html is still actively
//      changing — a stale-while-revalidate approach here could show an
//      old version of the page for one load after every deploy.
//
//   2. Static shell assets (app.js, the Tailwind/FontAwesome/Google
//      Fonts CDN scripts, web fonts) — STALE-WHILE-REVALIDATE. These
//      rarely change between visits, so the cached copy is served
//      instantly (zero data used) while a background fetch quietly
//      refreshes the cache for next time.
//
// This deliberately never touches:
//   - Supabase REST/Realtime/Storage requests (posts, likes, comments,
//     DMs, profile data, uploaded media) — those must always be live,
//     never served stale from a cache.
//   - Anything that isn't a GET request.
//   - Browser extension requests (chrome-extension://) — these were
//     never meant to be intercepted and just generate noisy console
//     errors if handled.

const SHELL_CACHE = "campusmarket-shell-v3";

// Same-origin files that make up the app shell. Add to this list if new
// static assets are introduced (e.g. a manifest icon set). Keep this in
// sync with the actual files that exist in the project — cache.addAll()
// fails ENTIRELY (blocking the whole service worker install) if even one
// of these URLs 404s, so double check this list after renaming or
// removing any top-level file.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./main.css",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {
        // A single missing asset (e.g. manifest.json not deployed
        // yet) shouldn't block installation of the whole worker.
      }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

function isSupabaseRequest(url) {
  return url.hostname.endsWith(".supabase.co");
}

function isCdnShellAsset(url) {
  // Third-party libraries that only change when the person explicitly
  // ships a new version — safe to cache aggressively.
  return (
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "cdnjs.cloudflare.com" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com" ||
    url.hostname === "challenges.cloudflare.com" ||
    url.hostname === "js.sentry-cdn.com"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept live app data — always go straight to the network.
  if (isSupabaseRequest(url)) return;

  // Browser extensions sometimes route requests through page fetches —
  // these were never meant for this service worker to handle.
  if (url.protocol === "chrome-extension:") return;

  const isSameOriginShell = url.origin === self.location.origin;
  if (!isSameOriginShell && !isCdnShellAsset(url)) return;

  // HTML page navigations: network-first. Always prefer the freshest
  // markup; only fall back to cache (then to the cached index.html as
  // a last resort, so a deep link still opens something) if the
  // network request fails entirely.
  const isPageRequest = req.headers.get("accept")?.includes("text/html");
  if (isPageRequest) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const cloned = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, cloned));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((cached) => cached || caches.match("./index.html")),
        ),
    );
    return;
  }

  // Everything else in the shell (app.js, CDN scripts/fonts):
  // stale-while-revalidate. Serve the cached copy instantly if there
  // is one, and quietly refresh it in the background for next time.
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            // Only cache successful, non-opaque responses —
            // an opaque (type: 'opaque') response, e.g. from a
            // cross-origin request without CORS, can't be
            // reliably reused later and isn't safe to store.
            if (
              res &&
              res.ok &&
              (res.type === "basic" || res.type === "cors")
            ) {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached); // offline fallback to whatever's cached

        return cached || networkFetch;
      }),
    ),
  );
});

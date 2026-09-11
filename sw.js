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

const SHELL_CACHE = "campusmarket-shell-v4";
// Tiny persisted counter (not shell content) backing the home-screen app
// icon badge, so a push notification arriving while the app is fully
// closed can still bump the badge count — the app itself only has a
// chance to set the real count when a tab is actually open. Kept in its
// own cache, separate from SHELL_CACHE, so it isn't wiped by the shell
// cache-busting in activate() below on every deploy.
const BADGE_CACHE = "campusmarket-badge-count-v1";
const BADGE_KEY = new Request("https://campusmarket.local/__badge-count");

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

// Set in install, read in activate, within the same worker instance's
// lifetime — distinguishes a brand-new install (nothing was controlling
// the page before, so there's nothing to "update" from and no banner
// should show) from a real update superseding a previous version.
let isUpdate = false;

self.addEventListener("install", (event) => {
  isUpdate = !!self.registration.active;
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
            .filter((key) => key !== SHELL_CACHE && key !== BADGE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => {
        if (!isUpdate) return; // fresh install — no previous version to notify about
        // skipWaiting()+clients.claim() only change which service worker
        // handles requests GOING FORWARD — an already-open tab keeps
        // rendering whatever it already rendered until something tells
        // it to reload. Without this, someone with the app open during
        // a deploy could sit on stale content indefinitely with no
        // indication anything changed. This tells every open tab a new
        // version just took over, so the page can show a "new version
        // available" prompt instead of silently doing nothing.
        return self.clients.matchAll({ type: "window" }).then((clients) => {
          clients.forEach((client) =>
            client.postMessage({ type: "SW_UPDATED" }),
          );
        });
      }),
  );
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

// ─── APP ICON BADGE ─────────────────────────────────────────────────────────
// Additive only. Backs the home-screen/taskbar icon's unread-count number
// (the Badging API — navigator.setAppBadge). app.js already sets this
// directly while a tab is open; this half handles the case a tab isn't
// open at all, so a push notification can still bump the badge. The two
// halves stay in sync via postMessage: whenever app.js computes the real
// unread count, it tells this service worker via SET_BADGE_COUNT below, so
// the next push increments from the correct number instead of a stale one.

async function readBadgeCount() {
  try {
    const cache = await caches.open(BADGE_CACHE);
    const res = await cache.match(BADGE_KEY);
    if (!res) return 0;
    const n = parseInt(await res.text(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_) {
    return 0;
  }
}

async function writeBadgeCount(n) {
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.put(BADGE_KEY, new Response(String(n)));
  } catch (_) {}
}

async function applyBadge(n) {
  if (!("setAppBadge" in self.navigator)) return;
  try {
    if (n > 0) await self.navigator.setAppBadge(n);
    else await self.navigator.clearAppBadge();
  } catch (_) {}
}

// app.js posts this every time it recomputes the real unread count (new
// message read, DMs tab opened, sign-in, etc.) so this service worker's
// idea of the count never drifts from what's actually true.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "SET_BADGE_COUNT") return;
  const n = Math.max(0, Number(event.data.count) || 0);
  event.waitUntil(writeBadgeCount(n).then(() => applyBadge(n)));
});

// ─── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────
// Additive only — nothing above this point is touched. Fires when the
// send-push Edge Function delivers a payload of the shape
// { title, body, url } (see app.js's supabase.functions.invoke("send-push")
// call). Wrapped in event.waitUntil so the service worker isn't killed
// mid-notification, and every step has a fallback so a malformed/missing
// payload shows SOMETHING rather than silently doing nothing.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: "Unix-Sync", body: event.data?.text() || "" };
  }

  const title = payload.title || "Unix-Sync";
  const options = {
    body: payload.body || "",
    // Bug fix: this pointed at ./icon-192.png, a root-level file that
    // was never actually confirmed to exist (it was a guess when this
    // was first added) — the real manifest.json only has icon/S2.png
    // (192x192) and icon/S4.png (512x512), inside an icon/ subfolder
    // with different filenames entirely. A 404 here doesn't break the
    // notification — showNotification() still fires with a blank/
    // browser-default icon — but it does mean the app's actual icon
    // never showed up. icon/S2.png is the closest match to the old
    // 192x192 intent; badge stays small/monochrome-friendly so reusing
    // the same 192 asset is fine (badges render tiny and tinted by the
    // OS regardless of the source image's own colors).
    icon: "./icon/S2.png",
    badge: "./icon/S2.png",
    data: { url: payload.url || "./" },
  };

  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .then(() => readBadgeCount())
      .then((current) => {
        const next = current + 1;
        return writeBadgeCount(next).then(() => applyBadge(next));
      }),
  );
});

// Tapping the notification focuses an already-open tab if one exists
// (rather than always opening a new one) and navigates it to the
// relevant URL; only opens a fresh tab/window if none is open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        const existing = clientsArr.find(
          (c) => new URL(c.url).origin === self.location.origin,
        );
        if (existing) {
          existing.navigate(targetUrl);
          return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

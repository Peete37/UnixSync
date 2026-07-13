// ─── 1. IMPORTS ───────────────────────────────────────────────────────────────
import { supabase } from "./supabase-config.js";
import {
  onAuthChange,
  signInWithGoogle,
  signOutUser as authSignOut,
} from "./auth.service.js";

// ─── 2. CONSTANTS ─────────────────────────────────────────────────────────────
const FEED_PAGE_SIZE = 15; // posts per page for infinite scroll (was a single hard cap of 30 with no way to see more)
const FEED_LIMIT = FEED_PAGE_SIZE; // kept for any code that still references the old name
const SEARCH_LIMIT = 100;
const SEARCH_RESULTS_CAP = 20;

const GHANA_DATA = {
  "Greater Accra": [
    "University of Ghana (UG)",
    "University of Professional Studies Accra (UPSA)",
    "Ghana Institute of Management and Public Administration (GIMPA)",
    "Accra Technical University (ATU)",
    "Methodist University Ghana",
    "Central University",
    "Academic City University College",
    "Lancaster University Ghana",
    "University of Media Arts and Communication (UMAC)",
    "Radford University College",
  ],
  Ashanti: [
    "Kwame Nkrumah University of Science and Technology (KNUST)",
    "Kumasi Technical University (KsTU)",
    "Kumasi College of Health Sciences",
    "Pentecost University",
    "Christian Service University College",
    "Valley View University (Kumasi Campus)",
    "Sunyani Technical University",
  ],
  Eastern: [
    "Koforidua Technical University (KTU)",
    "University of Energy and Natural Resources (UENR)",
    "Akenten Appiah-Menka University of Skills Training and Entrepreneurial Development (AAMUSTED)",
    "Presbyterian University Ghana (Abetifi Campus)",
  ],
  Central: [
    "University of Cape Coast (UCC)",
    "Cape Coast Technical University (CCTU)",
    "University of Education Winneba (UEW)",
    "Winneba Technical University",
    "Takoradi Technical University",
  ],
  Western: [
    "University of Mines and Technology (UMaT)",
    "Takoradi Technical University (TTU)",
    "Western Technical University",
  ],
  Northern: [
    "University for Development Studies (UDS)",
    "Tamale Technical University",
    "SD Dombo University of Business and Integrated Development Studies (SDD-UBIDS)",
  ],
  "Upper East": [
    "University for Development Studies (UDS — Bolgatanga Campus)",
    "Bolgatanga Technical University",
  ],
  "Upper West": [
    "University for Development Studies (UDS — Wa Campus)",
    "Wa Technical University",
  ],
  Volta: [
    "Ho Technical University (HTU)",
    "University of Health and Allied Sciences (UHAS)",
  ],
  Oti: ["Oti Nursing and Midwifery Training College"],
  Bono: [
    "Sunyani Technical University",
    "University of Energy and Natural Resources (UENR — Sunyani Campus)",
  ],
  "Bono East": ["Techiman Nursing and Midwifery Training College"],
  Ahafo: ["Goaso College of Education"],
  Savannah: ["Damongo College of Education"],
  "North East": ["Nalerigu College of Health Sciences"],
  "Western North": ["Sefwi Wiawso College of Education"],
};

const ALL_REGIONS = Object.keys(GHANA_DATA).sort();
const ALL_INSTITUTIONS = [...new Set(Object.values(GHANA_DATA).flat())].sort();

// ─── 3. MODULE STATE ──────────────────────────────────────────────────────────
let currentUserData = null;
let currentFeedChan = null;
let currentCommentsChan = null;
let allCachedPosts = [];
let isAuthInitialized = false;
let isOnline = navigator.onLine;
let currentFeedType = "all"; // tracks active tab: all | following | product | skill

// ─── CAMPUS SCOPE STATE ────────────────────────────────────────────────────────
// Previously institution/region were pure display metadata — every tab
// showed every post from every campus mixed together nationwide, which
// defeats the point of a *campus* marketplace (a Legon student browsing
// past a fridge for sale in Tamale they can't realistically go pick up).
// Now the All/Products/Services tabs default to "mine" — the signed-in
// person's own institution — with an easy one-tap switch to "everywhere"
// for anyone who wants the full nationwide feed. Persisted so the choice
// survives a reload rather than resetting every visit.
let currentCampusScope = localStorage.getItem("campus_market_scope") || "mine"; // 'mine' | 'everywhere'

// ─── PAGINATION STATE ─────────────────────────────────────────────────────────
// Fix: the feed previously had a single hard cap (FEED_LIMIT posts) with
// no way to see anything older — once a tab had more than 30 listings,
// the rest were simply invisible forever. Now each tab tracks its own
// "base filter" (the type condition, independent of how many posts are
// currently loaded) plus how many pages have been loaded and whether more
// exist, so scrolling to the bottom can fetch the next page instead of
// just... stopping.
let currentFeedBaseFilter = null; // function(query) -> query, applies only the tab's type condition
let feedLoadedCount = 0;
let feedHasMore = true;
let isFeedLoadingMore = false;
let feedLoadMoreObserver = null;

// DM state
let currentConversationsChan = null;
let currentMessagesChan = null;
let activeConversationId = null;
let activeConversationPeer = null; // { id, name, avatar }
let conversationsCache = [];

// Fix: `last_read_by_me` was referenced when computing unread state but
// never actually written anywhere (a single boolean column can't
// correctly represent "read by ME" for a two-person conversation
// anyway), so unread detection was effectively broken. Tracked here
// client-side instead: conversationId -> ISO timestamp of the last time
// THIS user viewed that thread. A conversation is unread if its
// last_message_at is newer than the stored read timestamp AND the last
// message wasn't sent by this user.
const conversationLastRead = JSON.parse(
  localStorage.getItem("campus_market_dm_last_read") || "{}",
);

function markConversationRead(conversationId) {
  conversationLastRead[conversationId] = new Date().toISOString();
  localStorage.setItem(
    "campus_market_dm_last_read",
    JSON.stringify(conversationLastRead),
  );
  updateDmUnreadBadge();
}

function isConversationUnread(conv) {
  if (!currentUserData) return false;
  if (!conv.last_sender || conv.last_sender === currentUserData.id)
    return false;
  const lastRead = conversationLastRead[conv.id];
  if (!lastRead) return true;
  return new Date(conv.last_message_at) > new Date(lastRead);
}

function updateDmUnreadBadge() {
  const badge = document.getElementById("dms-unread-badge");
  if (!badge) return;
  const unreadCount = conversationsCache.filter(isConversationUnread).length;
  if (unreadCount > 0) {
    badge.textContent = unreadCount > 9 ? "9+" : unreadCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// Persistent state maps that survive feed re-renders
const likedPostIds = new Set(
  JSON.parse(localStorage.getItem("campus_market_likes") || "[]"),
);
const openCommentIds = new Set(); // tracks which comment sections are open

let userCartList = JSON.parse(
  localStorage.getItem("campus_market_cart") || "[]",
);

Object.defineProperty(window, "_currentUser", { get: () => currentUserData });
Object.defineProperty(window, "_userCartList", { get: () => userCartList });

// ─── 3b. MEDIA EDIT MODAL STATE (WhatsApp-style edit before upload) ──────────
// Files staged for review in the "Edit Media" modal before they're actually
// attached/uploaded. Each entry: { file, url (object URL), rotation, type }
let stagedMediaFiles = [];
let activeStagedIndex = 0;
let finalMediaFiles = []; // the files the user actually confirmed via "Use These Files"

// ─── 3c. HISTORY / BACK-BUTTON STATE ──────────────────────────────────────────
// Tracks which overlays (modals, comment sheets, DM threads) are open so the
// phone's hardware/gesture back button closes them one layer at a time
// instead of exiting/backgrounding the app.
const _uiStack = [];

function pushUiState(id, closeFn) {
  _uiStack.push({ id, close: closeFn });
  try {
    history.pushState({ uiLayer: id }, "");
  } catch (_) {}
}

function popUiState(id) {
  const idx = _uiStack.findIndex((l) => l.id === id);
  if (idx !== -1) _uiStack.splice(idx, 1);
}

window.addEventListener("popstate", () => {
  if (_uiStack.length > 0) {
    const top = _uiStack.pop();
    try {
      top.close(true);
    } catch (_) {}
    // Re-arm a history entry so the next back-press is caught again
    // if there's still something else open underneath.
    if (_uiStack.length > 0) {
      try {
        history.pushState({ uiLayer: _uiStack[_uiStack.length - 1].id }, "");
      } catch (_) {}
    }
  }
});

// Seed one base history entry so the first back-press when nothing is open
// behaves like a normal app (doesn't feel broken), while genuinely letting
// the browser/app handle exit navigation once the stack is empty.
try {
  history.replaceState({ uiLayer: "base" }, "");
} catch (_) {}

// ─── 4. UTILITIES ─────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function escAttr(str) {
  return esc(str).replace(/`/g, "&#x60;");
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// Lightweight registry mapping postId -> { id, title, price, image, type }.
// Populated whenever a card/detail view is rendered, so the "Contact" /
// "Contact Seller" buttons can look up full post context by ID instead of
// trying to smuggle a JSON blob through an inline onclick HTML attribute
// (which is fragile with quotes/backticks and easy to break on escaping).
const postContextRegistry = {};

function registerPostContext(id, d, firstMediaUrl) {
  postContextRegistry[id] = {
    id,
    title: d.title || "Listing",
    price: d.price || 0,
    image: firstMediaUrl || "",
    type: d.type || "product",
  };
}

function buildOptions(arr, selectedVal = "") {
  return arr
    .map(
      (v) =>
        `<option value="${esc(v)}" ${v === selectedVal ? "selected" : ""}>${esc(v)}</option>`,
    )
    .join("");
}

function buildInstitutionOptions(region, selectedVal = "") {
  const list =
    region && GHANA_DATA[region] ? GHANA_DATA[region] : ALL_INSTITUTIONS;
  return buildOptions(list, selectedVal);
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className =
    "fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] bg-slate-800 border border-slate-700 text-white text-xs font-bold px-4 py-2.5 rounded-2xl shadow-xl whitespace-nowrap";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}
window.showToast = showToast;

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatClockTime(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const activeAuthChange =
  typeof onAuthChange === "function"
    ? onAuthChange
    : typeof window.onAuthChange === "function"
      ? window.onAuthChange
      : null;

if (!activeAuthChange) {
  console.error(
    "[app.js] onAuthChange is not available. Auth will not function.",
  );
}

// ─── 5. ONBOARDING MODAL ──────────────────────────────────────────────────────
function injectOnboardingModal() {
  if (document.getElementById("onboarding-modal")) return;

  const modal = document.createElement("div");
  modal.id = "onboarding-modal";
  modal.className =
    "fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4";
  modal.innerHTML = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm space-y-5">
            <div class="text-center space-y-1">
                <p class="text-2xl">🎓</p>
                <h2 class="text-white font-black text-lg uppercase tracking-tight">Welcome to CampusMarket</h2>
                <p class="text-slate-400 text-xs">Tell us where you study so we can personalise your feed</p>
            </div>
            <div class="space-y-3">
                <div>
                    <label class="text-[10px] uppercase font-bold text-slate-500 tracking-widest">Region</label>
                    <select id="onboard-region"
                        class="w-full mt-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 focus:outline-none focus:border-amber-400"
                        onchange="window.onboardRegionChange(this.value)">
                        <option value="">— Select your region —</option>
                        ${buildOptions(ALL_REGIONS)}
                    </select>
                </div>
                <div>
                    <label class="text-[10px] uppercase font-bold text-slate-500 tracking-widest">Institution</label>
                    <select id="onboard-institution"
                        class="w-full mt-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 focus:outline-none focus:border-amber-400">
                        <option value="">— Select your institution —</option>
                        ${buildOptions(ALL_INSTITUTIONS)}
                    </select>
                </div>
            </div>
            <button
                onclick="window.saveOnboarding()"
                class="w-full bg-amber-400 text-black font-black py-3 rounded-2xl uppercase tracking-wider text-sm active:scale-95 transition-transform">
                Let's Go →
            </button>
        </div>`;

  document.body.appendChild(modal);
}

window.onboardRegionChange = function (region) {
  const instSelect = document.getElementById("onboard-institution");
  if (!instSelect) return;
  instSelect.innerHTML =
    `<option value="">— Select your institution —</option>` +
    buildInstitutionOptions(region);
};

window.saveOnboarding = async function () {
  const region = document.getElementById("onboard-region")?.value;
  const institution = document.getElementById("onboard-institution")?.value;

  if (!region) {
    alert("Please select your region.");
    return;
  }
  if (!institution) {
    alert("Please select your institution.");
    return;
  }
  if (!currentUserData) return;

  try {
    const metadata = currentUserData.user_metadata || {};

    const { error } = await supabase.from("profiles").upsert({
      id: currentUserData.id,
      name: metadata.full_name || "Student",
      avatar: metadata.avatar_url || "",
      email: currentUserData.email || "",
      institution,
      region,
      created_at: new Date().toISOString(),
    });

    if (error) throw error;

    currentUserData.institution = institution;
    currentUserData.region = region;

    applyLocationToUI(institution, region);
    document.getElementById("onboarding-modal")?.remove();

    // The person just set their institution for the first time —
    // refresh the campus scope banner (previously hidden since there
    // was nothing to scope by) and re-run the current feed so it
    // picks up campus scoping immediately, instead of waiting for
    // the next tab click or reload.
    updateCampusScopeBanner();
    if (["all", "product", "skill"].includes(currentFeedType)) {
      const clickedBtn = document.querySelector(".feed-tab-btn.text-amber-400");
      window.filterFeed(currentFeedType, clickedBtn);
    }
  } catch (err) {
    console.error("Onboarding save error:", err);
    alert("Could not save your details. Please try again.");
  }
};

function applyLocationToUI(institution, region) {
  const instEl = document.getElementById("profileInstitution");
  const regEl = document.getElementById("profileRegion");
  const locationEl = document.getElementById("profile-ui-location");

  if (instEl) {
    instEl.innerHTML = buildInstitutionOptions(region, institution);
    instEl.value = institution;
  }

  if (regEl) {
    regEl.innerHTML = buildOptions(ALL_REGIONS, region);
    regEl.value = region;
  }

  if (locationEl) locationEl.textContent = `${institution} · ${region}`;
}

// ─── 6. AUTH ACTIONS ──────────────────────────────────────────────────────────
window.login = async function () {
  try {
    document.getElementById("login-modal")?.classList.add("hidden");
    document.getElementById("signup-modal")?.classList.add("hidden");
    await signInWithGoogle();
  } catch (err) {
    console.error("Login failure:", err);
    showToast("Sign-in failed. Please try again.");
  }
};

window.logout = async function () {
  try {
    unsubscribeFeed();
    unsubscribeConversations();
    unsubscribeActiveThread();
    if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);
    await authSignOut();
    window.navigateTo("feed");
  } catch (err) {
    console.error("Logout failure:", err);
  }
};

window.signOutUser = async function () {
  await window.logout();
};

// ─── 7. FEED SUBSCRIPTION HELPERS ────────────────────────────────────────────
function unsubscribeFeed() {
  if (currentFeedChan) {
    supabase.removeChannel(currentFeedChan);
    currentFeedChan = null;
  }
}

function defaultFeedQuery() {
  return supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(FEED_PAGE_SIZE);
}

// Fetches posts using the tab's base filter (type condition only) plus an
// explicit range, so pagination and "refresh what's currently loaded"
// (used by the realtime handler) are both just different calls to the
// same underlying query builder instead of two divergent code paths.
function buildFeedQuery(baseFilter, rangeStart, rangeEnd) {
  let q = supabase.from("posts").select("*");
  if (baseFilter) q = baseFilter(q);
  return q
    .order("created_at", { ascending: false })
    .range(rangeStart, rangeEnd);
}

async function fetchFeedSnapshot(queryFactory = null) {
  const req = queryFactory ? queryFactory() : defaultFeedQuery();
  const { data, error } = await req;
  if (error) throw error;
  return data || [];
}

async function subscribeFeed(baseFilter = null) {
  unsubscribeFeed();
  currentFeedBaseFilter = baseFilter;
  feedLoadedCount = 0;
  feedHasMore = true;

  try {
    const data = await fetchFeedSnapshot(() =>
      buildFeedQuery(baseFilter, 0, FEED_PAGE_SIZE - 1),
    );
    allCachedPosts = data.map((item) => ({ id: item.id, data: item }));
    feedLoadedCount = data.length;
    feedHasMore = data.length === FEED_PAGE_SIZE;

    // Sync local bookmark view mapping if authenticated
    if (currentUserData) {
      const { data: remoteSaves } = await supabase
        .from("saves")
        .select("post_id")
        .eq("user_id", currentUserData.id);

      if (remoteSaves) {
        const savedIds = remoteSaves.map((s) => s.post_id);
        userCartList = userCartList.filter((item) =>
          savedIds.includes(item.id),
        );
        allCachedPosts.forEach(({ id, data: d }) => {
          if (savedIds.includes(id) && !userCartList.some((c) => c.id === id)) {
            userCartList.push({
              id,
              title: d.title,
              price: d.price,
              media_url: d.media_url || "",
              media_type: d.media_type || "image",
              institution: d.institution || "",
              type: d.type || "product",
              user_name: d.user_name || "Anonymous",
            });
          }
        });
        localStorage.setItem(
          "campus_market_cart",
          JSON.stringify(userCartList),
        );
      }

      // Fix: likedPostIds was only ever derived from localStorage,
      // which is per-browser and can be cleared, so a refresh (or a
      // new device) could show hearts as "unliked" even though the
      // like is recorded server-side. Now we reconcile against the
      // real `likes` table for the signed-in user on every feed load,
      // so the heart state always matches the database, not just
      // whatever happened to survive in this browser's storage.
      try {
        const { data: remoteLikes } = await supabase
          .from("likes")
          .select("post_id")
          .eq("user_id", currentUserData.id);

        if (remoteLikes) {
          likedPostIds.clear();
          remoteLikes.forEach((l) => likedPostIds.add(l.post_id));
          localStorage.setItem(
            "campus_market_likes",
            JSON.stringify([...likedPostIds]),
          );
        }
      } catch (likeSyncErr) {
        console.warn(
          "Likes sync failed, falling back to local cache:",
          likeSyncErr,
        );
      }
    }

    renderFeedFromCache();
  } catch (err) {
    console.error("Feed poll error:", err);
  }

  let _feedRefreshDebounceTimer = null;
  currentFeedChan = supabase
    .channel(`posts-live-feed-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "posts" },
      () => {
        // Debounced: multiple realtime events arriving in quick
        // succession (e.g. several people liking/commenting around
        // the same time) previously each triggered their own full
        // feed re-fetch + re-render, tearing down and rebuilding
        // every card and restarting every video repeatedly. Now
        // rapid bursts coalesce into a single refresh shortly after
        // things settle.
        //
        // Fix: this used to always re-fetch just the first
        // FEED_LIMIT posts, silently discarding anything the person
        // had already scrolled/loaded further down via "load more" —
        // a live update partway through browsing would snap the
        // feed back to page 1. Now it re-fetches exactly however
        // many posts are currently loaded, preserving pagination
        // progress.
        clearTimeout(_feedRefreshDebounceTimer);
        _feedRefreshDebounceTimer = setTimeout(async () => {
          try {
            const currentCount = Math.max(feedLoadedCount, FEED_PAGE_SIZE);
            const data = await fetchFeedSnapshot(() =>
              buildFeedQuery(baseFilter, 0, currentCount - 1),
            );
            allCachedPosts = data.map((item) => ({ id: item.id, data: item }));
            feedLoadedCount = data.length;
            feedHasMore = data.length >= currentCount;
            renderFeedFromCache();

            if (
              !document
                .getElementById("profile-container")
                ?.classList.contains("hidden")
            ) {
              loadProfileStats();
            }
          } catch (err) {
            console.error("Feed live refresh error:", err);
          }
        }, 400);
      },
    )
    .subscribe();
}

// Fetches the next page of posts for the currently active tab and appends
// them to allCachedPosts, then re-renders. Triggered by scrolling near
// the bottom of the feed (see setupFeedLoadMoreObserver).
async function loadNextFeedPage() {
  if (isFeedLoadingMore || !feedHasMore) return;
  isFeedLoadingMore = true;

  const sentinel = document.getElementById("feed-load-more-sentinel");
  if (sentinel) {
    sentinel.innerHTML = `<div class="py-6 text-center text-slate-500 text-[10px] uppercase tracking-widest animate-pulse">Loading more...</div>`;
  }

  try {
    const rangeStart = feedLoadedCount;
    const rangeEnd = feedLoadedCount + FEED_PAGE_SIZE - 1;
    const data = await fetchFeedSnapshot(() =>
      buildFeedQuery(currentFeedBaseFilter, rangeStart, rangeEnd),
    );

    const existingIds = new Set(allCachedPosts.map((p) => p.id));
    const newItems = data
      .filter((item) => !existingIds.has(item.id))
      .map((item) => ({ id: item.id, data: item }));

    allCachedPosts = allCachedPosts.concat(newItems);
    feedLoadedCount += data.length;
    feedHasMore = data.length === FEED_PAGE_SIZE;

    renderFeedFromCache();
  } catch (err) {
    console.error("Load more posts error:", err);
    showToast("Couldn't load more posts. Try scrolling again.");
  } finally {
    isFeedLoadingMore = false;
  }
}

// Watches a sentinel element placed after the last rendered card; once it
// scrolls into view, fetches the next page. Using an observer instead of
// a scroll listener avoids firing on every scroll pixel.
function setupFeedLoadMoreObserver() {
  if (feedLoadMoreObserver) {
    feedLoadMoreObserver.disconnect();
    feedLoadMoreObserver = null;
  }

  const sentinel = document.getElementById("feed-load-more-sentinel");
  if (!sentinel) return;

  feedLoadMoreObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (currentFeedType === "following") {
          loadNextFollowingPage();
        } else {
          loadNextFeedPage();
        }
      });
    },
    { root: null, rootMargin: "400px 0px" },
  );

  feedLoadMoreObserver.observe(sentinel);
}

// ─── 8. NAVIGATION CONTROL ────────────────────────────────────────────────────
function clearNavHighlights() {
  document
    .querySelectorAll("nav button, .bottom-nav button, nav a")
    .forEach((b) => {
      b.classList.remove("nav-active");
      b.classList.replace("text-white", "text-slate-400");
      b.querySelector("span:last-child")?.classList.replace(
        "text-white",
        "text-slate-400",
      );
    });
}

function setNavHighlight(btn, viewId) {
  if (btn) {
    btn.classList.add("nav-active");
    btn.classList.replace("text-slate-400", "text-white");
    btn
      .querySelector("span:last-child")
      ?.classList.replace("text-slate-400", "text-white");
    return;
  }

  const navMap = {
    feed: "nav-btn-feed",
    explore: "nav-btn-explore",
    dms: "nav-btn-dms",
    profile: "auth-profile-nav",
    cart: "nav-btn-cart",
  };

  const fallback = document.getElementById(navMap[viewId]);
  if (fallback) {
    fallback.classList.add("nav-active");
    fallback.classList.replace("text-slate-400", "text-white");
    fallback
      .querySelector("span:last-child")
      ?.classList.replace("text-slate-400", "text-white");
  }
}

window.navigateTo = function (viewId, btn = null) {
  // Stop all reel video audio whenever we leave the feed entirely, so
  // switching to Profile/DMs/etc never leaves background audio playing.
  if (viewId !== "feed") {
    pauseAllReelVideos();
  }

  [
    "feed-container",
    "profile-container",
    "explore-container",
    "dms-container",
    "cart-container",
  ].forEach((id) => document.getElementById(id)?.classList.add("hidden"));

  const targetId = viewId === "feed" ? "feed-container" : `${viewId}-container`;
  const targetElement = document.getElementById(targetId);
  if (targetElement) targetElement.classList.remove("hidden");

  // feed-tabs now lives in the merged header row (always visible), but
  // it only applies to the feed itself — hide it on other views the
  // same way the old two-row header did.
  const tabs = document.getElementById("feed-tabs");
  if (tabs) tabs.style.display = viewId === "feed" ? "flex" : "none";

  // Leaving the feed always exits Reels overlay mode so the header goes
  // back to its normal solid bar on Profile/DMs/Explore/Cart.
  if (viewId !== "feed") {
    document
      .getElementById("site-header")
      ?.classList.remove("header-reels-mode");
  }

  clearNavHighlights();
  setNavHighlight(btn, viewId);

  if (viewId === "profile") {
    const gate = document.getElementById("profile-auth-gate");
    const content = document.getElementById("profile-content");
    if (!currentUserData) {
      gate?.classList.remove("hidden");
      content?.classList.add("hidden");
    } else {
      gate?.classList.add("hidden");
      content?.classList.remove("hidden");
      loadProfileStats();
    }
  }

  if (viewId === "dms") {
    const gate = document.getElementById("dms-auth-gate");
    const content = document.getElementById("dms-content");
    if (!currentUserData) {
      gate?.classList.remove("hidden");
      content?.classList.add("hidden");
    } else {
      gate?.classList.add("hidden");
      content?.classList.remove("hidden");
      openInboxView();
    }
  } else {
    // leaving DMs view entirely (not opening a thread) — tear down thread listener
    if (viewId !== "dms-thread") unsubscribeActiveThread();
  }

  if (viewId === "cart") {
    renderCartListView();
  }
};

window.switchProfileTab = function (tabType, selectedBtn) {
  document
    .querySelectorAll(".profile-subview")
    .forEach((view) => view.classList.add("hidden"));

  document.querySelectorAll(".profile-subtab-btn").forEach((btn) => {
    btn.classList.replace("text-amber-400", "text-slate-400");
    btn.classList.replace("border-amber-400", "border-transparent");
  });

  document
    .getElementById(`profile-subview-${tabType}`)
    ?.classList.remove("hidden");
  selectedBtn.classList.replace("text-slate-400", "text-amber-400");
  selectedBtn.classList.replace("border-transparent", "border-amber-400");
};

window.togglePostModal = function () {
  if (!currentUserData) {
    window.openLoginModal();
    return;
  }
  const modal = document.getElementById("post-modal");
  if (!modal) return;
  const willOpen = modal.classList.contains("hidden");
  modal.classList.toggle("hidden");

  if (willOpen) {
    pushUiState("post-modal", () => {
      document.getElementById("post-modal")?.classList.add("hidden");
    });
  } else {
    popUiState("post-modal");
  }
};

// ─── 9. DETAIL MODAL ──────────────────────────────────────────────────────────
window.openDetail = async function (postId) {
  const modal = document.getElementById("detail-modal");
  const content = document.getElementById("detail-content");
  if (!modal || !content) return;

  modal.classList.remove("hidden");
  pushUiState("detail-modal", () => window.closeDetailModal(true));
  content.innerHTML = `<div class="p-20 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Syncing Details...</div>`;

  try {
    const { data: d, error } = await supabase
      .from("posts")
      .select("*")
      .eq("id", postId)
      .single();

    if (error || !d) {
      content.innerHTML = `<p class="p-10 text-center text-red-500 text-xs">Post not found.</p>`;
      return;
    }

    const viewer = currentUserData;
    const isOwn = viewer && d.user_id === viewer.id;
    const isFollowing =
      !isOwn && viewer ? await checkFollowing(d.user_id) : false;

    let mediaUrls = [];
    if (d.media_url) {
      if (d.media_url.startsWith("[")) {
        try {
          mediaUrls = JSON.parse(d.media_url);
        } catch (_) {
          mediaUrls = [d.media_url];
        }
      } else {
        mediaUrls = [d.media_url];
      }
    }

    let mediaBlock = "";
    if (mediaUrls.length > 1) {
      const slides = mediaUrls
        .map((url, i) =>
          d.media_type === "video"
            ? `<video class="carousel-slide w-full aspect-video object-cover shrink-0 snap-start" ${i === 0 ? "autoplay" : ""} controls src="${esc(url)}"></video>`
            : `<img class="carousel-slide w-full object-cover shrink-0 snap-start" src="${esc(url)}" alt="Image ${i + 1}">`,
        )
        .join("");
      mediaBlock = `
                <div class="relative w-full">
                    <div id="detail-carousel" class="flex overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar" style="scroll-snap-type:x mandatory;">
                        ${slides}
                    </div>
                    <div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                        ${mediaUrls.map((_, i) => `<div class="carousel-dot w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-amber-400" : "bg-white/40"}"></div>`).join("")}
                    </div>
                </div>`;
    } else if (mediaUrls.length === 1) {
      mediaBlock =
        d.media_type === "video"
          ? `<video class="w-full aspect-video object-cover" controls autoplay src="${esc(mediaUrls[0])}"></video>`
          : `<img class="w-full object-cover" src="${esc(mediaUrls[0])}" alt="Post Media">`;
    }

    const followBlock =
      !isOwn && viewer
        ? `
            <button
                id="follow-btn-detail"
                class="follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 ${isFollowing ? "bg-slate-700 text-slate-300 border border-slate-600" : "bg-amber-400 text-black"}"
                data-follow-uid="${esc(d.user_id)}"
                data-active="${isFollowing}"
                onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
                ${isFollowing ? "✓ Following" : "+ Follow"}
            </button>`
        : "";

    const isAddedToCart = userCartList.some((item) => item.id === d.id);
    const cartText = isAddedToCart ? "✓ Added to Chart" : "Add to Chart List";
    const cartColorClass = isAddedToCart
      ? "bg-slate-800 border border-slate-700 text-slate-400"
      : "bg-slate-900 border border-slate-700 text-white hover:border-amber-400";

    const ctaLabel = d.type === "skill" ? "Contact" : "Contact Seller";

    registerPostContext(d.id, d, mediaUrls[0] || "");

    content.innerHTML = `
            <div class="w-full bg-slate-950 relative">${mediaBlock}</div>
            <div class="p-6 space-y-4">
                <div class="flex justify-between items-center gap-4">
                    <h1 class="text-2xl font-bold text-white uppercase tracking-tighter">${esc(d.title) || "Campus Item"}</h1>
                    <span class="text-amber-400 font-black text-xl shrink-0">GH₵${esc(String(d.price || 0))}</span>
                </div>
                <div class="flex flex-wrap gap-2 text-[10px] uppercase font-bold tracking-wider">
                    <span class="bg-slate-800 text-amber-400 px-2 py-1 rounded border border-slate-700">${esc(d.institution) || "All Campuses"}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700">${esc(d.region) || "All Regions"}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700 capitalize">${esc(d.type) || "product"}</span>
                </div>
                <div class="flex items-center justify-between gap-3 p-3 bg-slate-900 rounded-xl border border-slate-800">
                    <div class="flex items-center gap-3 min-w-0">
                        <img src="${esc(d.user_avatar) || "https://ui-avatars.com/api/?name=User"}" data-avatar-for="${escAttr(d.user_id)}" class="w-10 h-10 rounded-full border border-amber-400 object-cover" alt="Avatar">
                        <div class="min-w-0">
                            <p class="text-xs text-slate-500 uppercase">Provider</p>
                            <p class="text-sm font-bold truncate">${esc(d.user_name) || "Anonymous Student"}</p>
                        </div>
                    </div>
                    ${followBlock}
                </div>
                <p class="text-slate-400 leading-relaxed font-light">${esc(d.description) || "No description provided."}</p>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
                    <button
                        id="detail-cart-btn-${escAttr(d.id)}"
                        onclick="window.toggleCartItem('${escAttr(d.id)}')"
                        class="w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs ${cartColorClass}">
                        <i class="fas fa-shopping-basket mr-1.5 text-[11px]"></i><span class="cart-btn-label">${cartText}</span>
                    </button>
                    <button onclick="contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}', '${escAttr(d.id)}')" class="w-full bg-amber-400 text-black font-black py-4 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                        ${esc(ctaLabel)}
                    </button>
                </div>
            </div>`;

    if (mediaUrls.length > 1) {
      const carousel = document.getElementById("detail-carousel");
      const dots = content.querySelectorAll(".carousel-dot");
      carousel?.addEventListener(
        "scroll",
        () => {
          const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
          dots.forEach((d, i) => {
            d.classList.toggle("bg-amber-400", i === idx);
            d.classList.toggle("bg-white/40", i !== idx);
          });
        },
        { passive: true },
      );
    }
  } catch (e) {
    console.error("Detail load error:", e);
    content.innerHTML = `<p class="p-10 text-center text-red-500 text-xs">Error loading post.</p>`;
  }
};

window.closeDetailModal = function (fromPop = false) {
  const modal = document.getElementById("detail-modal");
  // Stop any video playing inside the detail view immediately — without
  // this, closing the modal left the video (and its audio) running
  // silently behind the scenes since only the modal's visibility was
  // toggled, not the media element itself.
  modal?.querySelectorAll("video").forEach((video) => {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (_) {}
  });
  modal?.classList.add("hidden");
  if (!fromPop) popUiState("detail-modal");
};

// ─── 10. LOGIN MODAL ──────────────────────────────────────────────────────────
window.openLoginModal = function () {
  // Never show credential entry while offline — keeps the app feeling
  // professional instead of dumping a broken form on a dead connection.
  if (!isOnline) {
    showToast("You're offline. Reconnect to sign in.");
    return;
  }
  document.getElementById("signup-modal")?.classList.add("hidden");
  document.getElementById("login-modal")?.classList.remove("hidden");
  pushUiState("login-modal", () => window.closeLoginModal(true));
};

window.closeLoginModal = function (fromPop = false) {
  document.getElementById("login-modal")?.classList.add("hidden");
  document.getElementById("signup-modal")?.classList.add("hidden");
  if (!fromPop) popUiState("login-modal");
};

// ─── 10b. EMAIL AUTH ──────────────────────────────────────────────────────────
window.loginWithEmail = async function () {
  const email = document.getElementById("login-email")?.value.trim();
  const password = document.getElementById("login-password")?.value;
  if (!email || !password) {
    showToast("Fill in credentials");
    return;
  }
  await window.signInWithEmailPassword(email, password);
};

window.signUpWithEmail = async function () {
  const name = document.getElementById("signup-name")?.value.trim();
  const email = document.getElementById("signup-email")?.value.trim();
  const password = document.getElementById("signup-password")?.value;
  if (!name || !email || !password) {
    showToast("Complete all fields");
    return;
  }
  await window.registerWithEmail(name, email, password);
};

window.signInWithEmailPassword = async function (email, password) {
  if (!isOnline) {
    showToast("You're offline. Reconnect to sign in.");
    return;
  }
  const btn = document.querySelector(
    '#login-modal button[onclick="window.loginWithEmail()"]',
  );
  try {
    if (btn) {
      btn.textContent = "Signing in…";
      btn.disabled = true;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    document.getElementById("login-modal")?.classList.add("hidden");
    showToast("Welcome back! ✓");
  } catch (err) {
    console.error("Email sign-in error:", err);
    showToast(err.message || "Sign-in failed. Check your credentials.");
  } finally {
    if (btn) {
      btn.textContent = "Sign In";
      btn.disabled = false;
    }
  }
};

window.registerWithEmail = async function (name, email, password) {
  if (!isOnline) {
    showToast("You're offline. Reconnect to sign up.");
    return;
  }
  const btn = document.querySelector(
    '#signup-modal button[onclick="window.signUpWithEmail()"]',
  );
  try {
    if (btn) {
      btn.textContent = "Creating account…";
      btn.disabled = true;
    }
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } },
    });
    if (error) throw error;
    document.getElementById("signup-modal")?.classList.add("hidden");
    showToast("Account created! Check your email to confirm. ✓");
  } catch (err) {
    console.error("Email sign-up error:", err);
    showToast(err.message || "Sign-up failed. Please try again.");
  } finally {
    if (btn) {
      btn.textContent = "Create Account";
      btn.disabled = false;
    }
  }
};

// ─── 11. AVATAR UPLOAD ────────────────────────────────────────────────────────
window.handleAvatarUpload = async function (inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;

  if (!currentUserData) {
    showToast("Please sign in first.");
    return;
  }
  if (!file.type.startsWith("image/")) {
    showToast("Please choose an image file.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast("Image must be under 5 MB.");
    return;
  }

  const previewEl = document.getElementById("profile-ui-avatar");
  const localURL = URL.createObjectURL(file);
  if (previewEl) previewEl.src = localURL;

  showToast("Uploading avatar…");

  try {
    // Compress before upload (see compressImageFile) — this also
    // normalizes the output to JPEG, so every avatar upload lands at
    // the SAME storage path (avatar.jpg) regardless of what format
    // the original photo was in. That fixes a second bug: previously
    // uploading a .png after a .jpg (or vice versa) left the old file
    // sitting in storage forever, orphaned and never replaced.
    const compressed = await compressImageFile(file, {
      maxDimension: 800,
      quality: 0.85,
    });

    const storagePath = `${currentUserData.id}/avatar.jpg`;

    await withUploadRetry(
      async () => {
        const { error: uploadErr } = await supabase.storage
          .from("avatars")
          .upload(storagePath, compressed, {
            contentType: "image/jpeg",
            upsert: true,
          });
        if (uploadErr) throw uploadErr;
      },
      {
        retries: 3,
        onRetry: (attempt) =>
          showToast(`Connection lost — retrying (${attempt}/3)...`),
      },
    );

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(storagePath);
    // Cache-bust with a fresh timestamp every time, and — critically —
    // use THIS SAME cache-busted URL everywhere (DB, in-memory user
    // object, AND the visible <img> tag). Previously the on-screen
    // avatar was set to the plain, non-busted publicUrl, so browsers
    // would happily keep serving whatever was cached at that exact
    // path from a prior upload instead of the new photo.
    const dynamicUrl = `${publicUrl}?t=${Date.now()}`;

    const { error: dbErr } = await supabase
      .from("profiles")
      .update({ avatar: dynamicUrl })
      .eq("id", currentUserData.id);

    if (dbErr) throw dbErr;

    await supabase.auth.updateUser({ data: { avatar_url: dynamicUrl } });

    if (!currentUserData.user_metadata) currentUserData.user_metadata = {};
    currentUserData.user_metadata.avatar_url = dynamicUrl;

    // Fix: previously a new avatar only ever applied going forward —
    // every post you'd already published had its `user_avatar` value
    // frozen at upload time (posts store a denormalized snapshot of
    // the poster's avatar rather than looking it up live), so old
    // posts kept showing your old photo forever. Now we backfill
    // user_avatar across ALL of the person's existing posts whenever
    // they change their avatar, so past and future posts both show
    // the current photo.
    try {
      await supabase
        .from("posts")
        .update({ user_avatar: dynamicUrl })
        .eq("user_id", currentUserData.id);
    } catch (backfillErr) {
      console.warn(
        "Avatar backfill onto existing posts failed (non-fatal):",
        backfillErr,
      );
    }

    // Instantly reflect the new avatar on anything already rendered
    // in this session — the in-memory allCachedPosts snapshot, plus
    // every avatar <img> tagged as belonging to this user — instead
    // of waiting for the next full feed refresh.
    allCachedPosts.forEach(({ data: d }) => {
      if (d.user_id === currentUserData.id) d.user_avatar = dynamicUrl;
    });
    if (previewEl) previewEl.src = dynamicUrl;
    document
      .querySelectorAll(
        `img[data-avatar-for="${CSS.escape(currentUserData.id)}"]`,
      )
      .forEach((img) => {
        img.src = dynamicUrl;
      });

    showToast("Avatar updated everywhere! ✓");
  } catch (err) {
    console.error("Avatar upload error:", err);
    if (previewEl) {
      previewEl.src =
        currentUserData.user_metadata?.avatar_url ||
        "https://ui-avatars.com/api/?name=User";
    }
    showToast("Upload failed. Please try again.");
  } finally {
    inputEl.value = "";
  }
};

// ─── 11b. AVATAR LONG-PRESS MODAL ────────────────────────────────────────────
let _avatarPressTimer = null;
function _initAvatarLongPress() {
  const profileAvatar = document.getElementById("profile-ui-avatar");
  const avatarModal = document.getElementById("avatarModal");
  const modalAvatarImg = document.getElementById("modalAvatarImg");
  const closeAvatarBtn = document.getElementById("closeAvatarBtn");
  const copyImageBtn = document.getElementById("copyImageBtn");
  const downloadImageBtn = document.getElementById("downloadImageBtn");

  if (!profileAvatar || !avatarModal || !modalAvatarImg) return;

  function openAvatarModal(src) {
    modalAvatarImg.src = src;
    avatarModal.classList.remove("hidden");
    pushUiState("avatar-modal", () => {
      avatarModal.classList.add("hidden");
    });
  }
  function closeAvatarModalFn() {
    avatarModal.classList.add("hidden");
    popUiState("avatar-modal");
  }

  function startPress() {
    clearTimeout(_avatarPressTimer);
    _avatarPressTimer = setTimeout(() => {
      openAvatarModal(profileAvatar.src);
    }, 600);
  }

  function cancelPress() {
    clearTimeout(_avatarPressTimer);
  }

  profileAvatar.addEventListener("touchstart", startPress, { passive: true });
  profileAvatar.addEventListener("touchend", cancelPress);
  profileAvatar.addEventListener("touchmove", cancelPress);
  profileAvatar.addEventListener("mousedown", startPress);
  profileAvatar.addEventListener("mouseup", cancelPress);
  profileAvatar.addEventListener("mouseleave", cancelPress);

  // Belt-and-suspenders: some Android WebViews still surface their own
  // native "Open in browser / Share / Download" long-press menu on an
  // <img> even with -webkit-touch-callout: none set in CSS. Explicitly
  // blocking the contextmenu event here guarantees our in-app modal
  // wins instead of the OS-level share sheet from your screenshot.
  profileAvatar.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    return false;
  });

  closeAvatarBtn?.addEventListener("click", closeAvatarModalFn);
  avatarModal.addEventListener("click", (e) => {
    if (e.target === avatarModal) closeAvatarModalFn();
  });

  copyImageBtn?.addEventListener("click", async () => {
    try {
      const response = await fetch(modalAvatarImg.src);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      showToast("✓ Image copied to clipboard!");
    } catch (err) {
      console.error("Copy failed:", err);
      showToast("Failed to copy image.");
    }
  });

  downloadImageBtn?.addEventListener("click", async () => {
    try {
      const response = await fetch(modalAvatarImg.src);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `avatar-${Date.now()}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
      showToast("✓ Download started!");
    } catch (err) {
      console.error("Download failed:", err);
      showToast("Failed to download image.");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initAvatarLongPress);
} else {
  _initAvatarLongPress();
}

// ─── 11c. MEDIA EDIT MODAL (WhatsApp-style edit before upload) ──────────────
// Opened automatically whenever files are chosen via the mediaInput file
// picker. Lets the user preview, rotate, and remove files before they are
// actually attached to the listing (finalMediaFiles is what gets uploaded).
// Limits enforced when attaching media to a post — previously there was
// no validation at all, so someone could attach a 50-file batch or a
// huge multi-hundred-MB video and the app would just try (and likely
// fail slowly, or hammer the data usage fixes made elsewhere) instead of
// telling them up front what's allowed.
const MAX_MEDIA_FILES = 10;
const MAX_IMAGE_SIZE_MB = 15;
const MAX_VIDEO_SIZE_MB = 50;

window.openEditMediaModal = function (fileList) {
  const incoming = Array.from(fileList);

  const accepted = [];
  const rejectedReasons = [];

  for (const file of incoming) {
    if (accepted.length >= MAX_MEDIA_FILES) {
      rejectedReasons.push(
        `${file.name}: only ${MAX_MEDIA_FILES} files allowed per post`,
      );
      continue;
    }
    const isVideo = file.type.startsWith("video");
    const maxBytes =
      (isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB) * 1024 * 1024;
    if (file.size > maxBytes) {
      rejectedReasons.push(
        `${file.name}: over ${isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB}MB limit`,
      );
      continue;
    }
    accepted.push(file);
  }

  if (rejectedReasons.length > 0) {
    showToast(
      rejectedReasons.length === 1
        ? `Skipped 1 file — ${rejectedReasons[0]}`
        : `Skipped ${rejectedReasons.length} files that were too large or over the limit`,
    );
  }

  if (accepted.length === 0) {
    if (rejectedReasons.length === 0) showToast("No files selected.");
    return;
  }

  // Revoke any previously staged object URLs to avoid leaking memory
  stagedMediaFiles.forEach((f) => {
    try {
      URL.revokeObjectURL(f.url);
    } catch (_) {}
  });

  stagedMediaFiles = accepted.map((file) => ({
    file,
    url: URL.createObjectURL(file),
    rotation: 0,
    type: file.type.startsWith("video") ? "video" : "image",
  }));
  activeStagedIndex = 0;

  renderEditMediaModal();

  const modal = document.getElementById("editMediaModal");
  modal?.classList.remove("hidden");
  pushUiState("edit-media-modal", () => window.closeEditMediaModal(true));
};

function renderEditMediaModal() {
  const mainPreview = document.getElementById("editMainPreview");
  const thumbStrip = document.getElementById("editThumbStrip");
  if (!mainPreview || !thumbStrip) return;

  if (stagedMediaFiles.length === 0) {
    mainPreview.innerHTML = `<p class="text-slate-500 text-xs p-8">No files attached.</p>`;
    thumbStrip.innerHTML = "";
    return;
  }

  if (activeStagedIndex >= stagedMediaFiles.length)
    activeStagedIndex = stagedMediaFiles.length - 1;
  const active = stagedMediaFiles[activeStagedIndex];

  const rotationStyle = `transform: rotate(${active.rotation}deg);`;
  mainPreview.innerHTML =
    active.type === "video"
      ? `<video src="${active.url}" style="${rotationStyle}" controls muted></video>
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>`
      : `<img src="${active.url}" style="${rotationStyle}" alt="Preview">
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>`;

  thumbStrip.innerHTML = stagedMediaFiles
    .map(
      (f, i) => `
        <div class="edit-thumb ${i === activeStagedIndex ? "active-thumb" : ""}" onclick="window._selectStagedMedia(${i})">
            ${
              f.type === "video"
                ? `<video src="${f.url}" muted></video>`
                : `<img src="${f.url}" alt="thumb ${i + 1}">`
            }
            <button class="remove-thumb-btn" onclick="event.stopPropagation(); window._removeStagedMedia(${i})">✕</button>
        </div>
    `,
    )
    .join("");
}

window._selectStagedMedia = function (i) {
  activeStagedIndex = i;
  renderEditMediaModal();
};

window._rotateStagedMedia = function () {
  if (!stagedMediaFiles[activeStagedIndex]) return;
  stagedMediaFiles[activeStagedIndex].rotation =
    (stagedMediaFiles[activeStagedIndex].rotation + 90) % 360;
  renderEditMediaModal();
};

window._removeStagedMedia = function (i) {
  const removed = stagedMediaFiles.splice(i, 1)[0];
  if (removed) {
    try {
      URL.revokeObjectURL(removed.url);
    } catch (_) {}
  }
  if (activeStagedIndex >= stagedMediaFiles.length)
    activeStagedIndex = Math.max(0, stagedMediaFiles.length - 1);
  renderEditMediaModal();
  if (stagedMediaFiles.length === 0) {
    const countEl = document.getElementById("mediaFileCount");
    if (countEl) countEl.textContent = "";
  }
};

window.closeEditMediaModal = function (fromPop = false) {
  document.getElementById("editMediaModal")?.classList.add("hidden");
  if (!fromPop) popUiState("edit-media-modal");
};

// Applies rotation (if any) then compresses images by redrawing them to
// canvas, so the final uploaded file is both edited correctly AND
// meaningfully smaller than the original camera photo — this is the main
// data-usage improvement for posting: previously the raw, unmodified
// file (often several MB straight from a phone camera) was uploaded
// as-is. Videos are left untouched here; real video transcoding needs a
// much heavier tool than a browser canvas can provide, so for now we
// only compress images. Rotated + compressed happens in one pass to
// avoid re-encoding twice.
window.confirmEditedMedia = async function () {
  if (stagedMediaFiles.length === 0) {
    showToast("Please attach at least one file.");
    window.closeEditMediaModal();
    return;
  }

  showToast("Preparing media…");

  // Data Saver toggle (Settings) makes compression noticeably more
  // aggressive — smaller max dimension and lower quality — for people
  // who've explicitly said they want to minimize data usage over a
  // slightly sharper image.
  const dataSaverOn =
    typeof window.getAppSettings === "function" &&
    window.getAppSettings().dataSaver;
  const compressionOptions = dataSaverOn
    ? { maxDimension: 900, quality: 0.6 }
    : { maxDimension: 1280, quality: 0.75 };

  const processed = [];
  for (const item of stagedMediaFiles) {
    if (item.type === "image") {
      try {
        let workingFile = item.file;
        if (item.rotation !== 0) {
          workingFile = await rotateImageFile(workingFile, item.rotation);
        }
        const compressedFile = await compressImageFile(
          workingFile,
          compressionOptions,
        );
        processed.push(compressedFile);
      } catch (e) {
        console.warn("Rotate/compress failed, using original file:", e);
        processed.push(item.file);
      }
    } else {
      processed.push(item.file);
    }
  }

  finalMediaFiles = processed;

  const countEl = document.getElementById("mediaFileCount");
  if (countEl) {
    countEl.textContent = `${processed.length} file${processed.length > 1 ? "s" : ""} ready — tap Publish to upload`;
  }

  window.closeEditMediaModal();
  showToast("Media ready ✓");
};

function rotateImageFile(file, degrees) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const swap = degrees === 90 || degrees === 270;
      canvas.width = swap ? img.height : img.width;
      canvas.height = swap ? img.width : img.height;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objUrl);
          if (!blob) {
            reject(new Error("Canvas toBlob failed"));
            return;
          }
          resolve(
            new File([blob], file.name, { type: file.type || "image/jpeg" }),
          );
        },
        file.type || "image/jpeg",
        0.92,
      );
    };
    img.onerror = reject;
    img.src = objUrl;
  });
}

// Downscales and re-encodes an image to cut both upload and (later)
// download size significantly. This is a lossy step by design — the
// point is smaller files, which does mean a small drop in sharpness —
// but it's what actually reduces data consumption for people uploading
// and everyone viewing the feed afterward. Images already smaller than
// maxDimension in both axes are still re-encoded at the given quality
// (skipping that would leave big, poorly-compressed camera JPEGs as-is).
function compressImageFile(file, { maxDimension = 1280, quality = 0.75 } = {}) {
  // Never try to compress non-raster formats (e.g. animated GIFs would
  // lose their animation if redrawn to a single canvas frame).
  if (file.type === "image/gif") return Promise.resolve(file);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const targetW = Math.round(width * scale);
      const targetH = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, targetW, targetH);

      const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";

      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objUrl);
          if (!blob) {
            reject(new Error("Canvas toBlob failed during compression"));
            return;
          }
          // If compression somehow produced a LARGER file than the
          // original (can happen with tiny/simple source images),
          // just keep the original rather than penalizing the user.
          if (blob.size >= file.size) {
            resolve(file);
            return;
          }
          resolve(new File([blob], file.name, { type: outputType }));
        },
        outputType,
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      // If the image somehow fails to decode for compression,
      // fall back to uploading the original rather than blocking
      // the whole post.
      resolve(file);
    };
    img.src = objUrl;
  });
}

// ─── UPLOAD RETRY HELPER ──────────────────────────────────────────────────────
// Wraps a network operation (storage upload, DB write) with a short wait
// and a few retries before truly giving up. Without this, a brief
// connectivity blip mid-upload (a couple of seconds of no signal, a wifi
// handoff, walking through a dead zone on campus) immediately surfaced as
// "failed to upload" even though the connection came right back. Now we
// wait, try again, and only report a genuine failure after several
// attempts — and if the device is offline at the moment of failure, wait
// specifically for the 'online' event (up to a timeout) before retrying,
// rather than retrying blindly into a still-dead connection.
async function withUploadRetry(
  operation,
  { retries = 3, baseDelayMs = 1500, onRetry = null } = {},
) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      if (onRetry) onRetry(attempt, retries);

      if (!navigator.onLine) {
        // Wait specifically for connectivity to return (capped so
        // we don't hang forever), rather than immediately retrying
        // into a connection we already know is down.
        await waitForOnline(15000);
      } else {
        await sleep(baseDelayMs * attempt);
      }
    }
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      // Only worth retrying on what looks like a network-level
      // failure, not on things like a validation or auth error that
      // will just fail identically every time.
      const isNetworkish =
        !navigator.onLine ||
        err?.message?.toLowerCase().includes("network") ||
        err?.message?.toLowerCase().includes("fetch") ||
        err?.name === "TypeError";
      if (!isNetworkish) throw err;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOnline(timeoutMs) {
  return new Promise((resolve) => {
    if (navigator.onLine) {
      resolve();
      return;
    }
    const cleanup = () => {
      window.removeEventListener("online", handler);
      clearTimeout(timer);
      resolve();
    };
    const handler = () => cleanup();
    const timer = setTimeout(cleanup, timeoutMs);
    window.addEventListener("online", handler);
  });
}

// ─── 12. CARD RENDERERS ───────────────────────────────────────────────────────
// Tracks posts currently mid-like-toggle so a rapid double-tap can't fire
// two overlapping insert/delete calls racing each other against the same
// row (which could otherwise leave the DB counter and the UI disagreeing).
const likeInFlight = new Set();

window.likePost = async function (postId, btn) {
  if (!currentUserData) {
    showToast("Please sign in to like posts.");
    return;
  }
  if (!postId || postId === "undefined") {
    showToast("Error: Missing Post Identifier");
    return;
  }
  if (likeInFlight.has(postId)) return;
  likeInFlight.add(postId);

  const liked = likedPostIds.has(postId);
  const countEl = btn.querySelector(".like-count");
  const icon = btn.querySelector("i");
  let currentCount = parseInt(countEl?.textContent || 0);

  // 1. Optimistic UI update
  if (liked) {
    likedPostIds.delete(postId);
    icon.className = "far fa-heart text-slate-300";
    btn.classList.remove("text-rose-500");
    currentCount = Math.max(0, currentCount - 1);
  } else {
    likedPostIds.add(postId);
    icon.className = "fas fa-heart text-rose-500";
    btn.classList.add("text-rose-500");
    currentCount = currentCount + 1;
  }

  if (countEl) countEl.textContent = currentCount;
  localStorage.setItem(
    "campus_market_likes",
    JSON.stringify([...likedPostIds]),
  );

  // Keep the in-memory cache in sync so a re-render (tab switch, search,
  // etc.) before the next DB refresh doesn't show a stale count.
  const cachedEntry = allCachedPosts.find((p) => p.id === postId);
  if (cachedEntry?.data) cachedEntry.data.likes_count = currentCount;

  // 2. Execute Backend sync — this is what makes likes survive reload.
  // Uses atomic RPC counters (increment_post_likes / decrement_post_likes)
  // defined in migration.sql so concurrent likes never clobber each other.
  //
  // Fix: previously an insert/delete failure into the `likes` table was
  // swallowed silently (error checked but never surfaced or acted on),
  // so the heart stayed optimistically "liked" in the UI while nothing
  // was actually saved server-side — the exact cause of likes vanishing
  // on refresh. Now any real failure rolls the UI back to its prior
  // state and tells the person, instead of drifting out of sync with
  // the database until the next reload silently corrects it.
  try {
    if (liked) {
      const { error: deleteErr } = await supabase
        .from("likes")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", currentUserData.id);

      if (deleteErr) throw deleteErr;
      await supabase.rpc("decrement_post_likes", { post_id_input: postId });
    } else {
      const { error: insertErr } = await supabase.from("likes").insert({
        post_id: postId,
        user_id: currentUserData.id,
      });

      // A unique-constraint violation just means this like already
      // existed (e.g. a duplicate tap) — treat that as a harmless
      // no-op, not a failure. Any OTHER error means the like truly
      // didn't save, so we must roll back.
      const isDuplicate = insertErr && insertErr.code === "23505";
      if (insertErr && !isDuplicate) throw insertErr;
      if (!insertErr) {
        await supabase.rpc("increment_post_likes", { post_id_input: postId });
      }
    }
  } catch (e) {
    console.error("Like sync failed — reverting UI to match database:", e);

    // Roll back the optimistic UI exactly, since the write did not
    // actually persist.
    if (liked) {
      likedPostIds.add(postId);
      icon.className = "fas fa-heart text-rose-500";
      btn.classList.add("text-rose-500");
      currentCount = currentCount + 1;
    } else {
      likedPostIds.delete(postId);
      icon.className = "far fa-heart text-slate-300";
      btn.classList.remove("text-rose-500");
      currentCount = Math.max(0, currentCount - 1);
    }
    if (countEl) countEl.textContent = currentCount;
    localStorage.setItem(
      "campus_market_likes",
      JSON.stringify([...likedPostIds]),
    );
    if (cachedEntry?.data) cachedEntry.data.likes_count = currentCount;

    showToast("Couldn't save your like — please try again.");
  } finally {
    likeInFlight.delete(postId);
  }
};

window.sharePost = function (postId, title) {
  const text = `Check out "${title}" on CampusMarket!`;
  if (navigator.share) {
    navigator.share({ title, text, url: window.location.href }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(`${text} ${window.location.href}`);
    showToast("Link copied to clipboard!");
  }
};

window.downloadMedia = function (mediaUrl, title) {
  if (!mediaUrl) return;
  const a = document.createElement("a");
  a.href = mediaUrl;
  a.download = title || "campus-market";
  a.target = "_blank";
  a.click();
};

// Opens a real DM thread with the seller AND shares a small preview of the
// exact listing the person tapped "Contact" on, so the seller immediately
// sees which item/service the conversation is about instead of a blank
// chat with no context.
window.contactSeller = function (
  sellerId,
  userName,
  sellerAvatar,
  postTitle,
  postId = null,
) {
  if (!currentUserData) {
    showToast("Please sign in to contact the seller.");
    return;
  }
  if (!sellerId || sellerId === currentUserData.id) {
    window.navigateTo("dms");
    return;
  }
  const postContext = postId ? postContextRegistry[postId] : null;
  window.openDM(sellerId, userName, sellerAvatar, postContext);
};

// ─── Comment count tracking (keeps counters accurate without a full re-fetch) ──
const commentCountCache = {}; // postId -> count

function updateCommentCountUI(postId, count) {
  commentCountCache[postId] = count;
  document
    .querySelectorAll(`.comment-count-${CSS.escape(postId)}`)
    .forEach((el) => {
      el.textContent = count;
    });
}

async function fetchAndCacheCommentCount(postId) {
  try {
    const { count, error } = await supabase
      .from("comments")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);
    if (!error) updateCommentCountUI(postId, count || 0);
  } catch (_) {}
}

// Simple client-side cooldown against accidental rapid-fire comment
// spam (e.g. holding Enter, a stuck keypress, an eager double-tap).
// IMPORTANT: this is a UX safeguard only, not real security — anyone
// bypassing the UI and calling the API directly isn't affected by this.
// Real abuse prevention belongs at the database/RLS or Supabase project
// level (e.g. rate-limited RPC, or Supabase's own abuse protections).
let lastCommentPostedAt = 0;
const COMMENT_COOLDOWN_MS = 2000;

window.postComment = async function (postId, inputEl, parentCommentId = null) {
  const text = inputEl.value.trim();
  if (!text || !currentUserData) return;

  const now = Date.now();
  if (now - lastCommentPostedAt < COMMENT_COOLDOWN_MS) {
    showToast("You're commenting a bit fast — give it a second.");
    return;
  }
  lastCommentPostedAt = now;

  inputEl.value = "";

  try {
    const metadata = currentUserData.user_metadata || {};
    const insertPayload = {
      post_id: postId,
      user_id: currentUserData.id,
      user_name: metadata.full_name || "Anonymous Student",
      user_avatar: metadata.avatar_url || "",
      text,
      created_at: new Date().toISOString(),
    };
    if (parentCommentId) insertPayload.parent_comment_id = parentCommentId;
    await supabase.from("comments").insert(insertPayload);
  } catch (err) {
    console.error("Comment submission error:", err);
  }
};

// Tracks which comment (if any) is currently being replied to, per post,
// so the reply target is visible and Enter posts as a reply not a new
// top-level comment.
const activeReplyTarget = {};

window.startCommentReply = function (postId, commentId, commentAuthor) {
  activeReplyTarget[postId] = commentId;
  const input = document.querySelector(
    `#comments-${CSS.escape(postId)} input[type="text"]`,
  );
  if (input) {
    input.placeholder = `Replying to ${commentAuthor}…`;
    input.dataset.replyTo = commentId;
    input.focus();
  }
  const cancelBtn = document.getElementById(`cancel-reply-${postId}`);
  if (cancelBtn) cancelBtn.classList.remove("hidden");
};

window.cancelCommentReply = function (postId) {
  delete activeReplyTarget[postId];
  const input = document.querySelector(
    `#comments-${CSS.escape(postId)} input[type="text"]`,
  );
  if (input) {
    input.placeholder = "Add a comment…";
    delete input.dataset.replyTo;
  }
  const cancelBtn = document.getElementById(`cancel-reply-${postId}`);
  if (cancelBtn) cancelBtn.classList.add("hidden");
};

// Wraps postComment so the comment input's Enter key correctly posts as a
// reply when a reply target is active, then clears the reply state.
window.submitCommentFromInput = function (postId, inputEl) {
  const parentId = inputEl.dataset.replyTo || null;
  window.postComment(postId, inputEl, parentId);
  if (parentId) window.cancelCommentReply(postId);
};

const likedCommentIds = new Set(
  JSON.parse(localStorage.getItem("campus_market_comment_likes") || "[]"),
);

window.likeComment = async function (commentId, btn) {
  if (!currentUserData) {
    showToast("Please sign in to like comments.");
    return;
  }

  const liked = likedCommentIds.has(commentId);
  const countEl = btn.querySelector(".comment-like-count");
  const icon = btn.querySelector("i");
  let count = parseInt(countEl?.textContent || 0);

  if (liked) {
    likedCommentIds.delete(commentId);
    icon.className = "far fa-thumbs-up text-slate-400";
    count = Math.max(0, count - 1);
  } else {
    likedCommentIds.add(commentId);
    icon.className = "fas fa-thumbs-up text-amber-400";
    count = count + 1;
  }
  if (countEl) countEl.textContent = count;
  localStorage.setItem(
    "campus_market_comment_likes",
    JSON.stringify([...likedCommentIds]),
  );

  try {
    if (liked) {
      await supabase
        .from("comment_likes")
        .delete()
        .eq("comment_id", commentId)
        .eq("user_id", currentUserData.id);
      await supabase.rpc("decrement_comment_likes", {
        comment_id_input: commentId,
      });
    } else {
      const { error } = await supabase
        .from("comment_likes")
        .insert({ comment_id: commentId, user_id: currentUserData.id });
      if (!error)
        await supabase.rpc("increment_comment_likes", {
          comment_id_input: commentId,
        });
    }
  } catch (e) {
    console.warn("Comment like sync delayed:", e);
  }
};

// Fixed: previously scoped to .eq('user_id', ...) which silently failed
// whenever RLS/user id mismatched in any way and gave no feedback. Now we
// check ownership up front, surface real errors, and always refresh the
// count after a successful delete.
window.deleteComment = function (commentId, postId) {
  if (!currentUserData) {
    showToast("Please sign in.");
    return;
  }

  showConfirmDialog({
    title: "Delete this comment?",
    message: "This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      try {
        const { data, error } = await supabase
          .from("comments")
          .delete()
          .eq("id", commentId)
          .eq("user_id", currentUserData.id)
          .select();

        if (error) throw error;

        if (!data || data.length === 0) {
          showToast("You can only delete your own comments.");
          return;
        }

        document
          .querySelectorAll(`[id="comment-item-${commentId}"]`)
          .forEach((el) => el.remove());
        showToast("Comment deleted");

        const newCount = Math.max(0, (commentCountCache[postId] ?? 1) - 1);
        updateCommentCountUI(postId, newCount);
      } catch (err) {
        console.error("Error deleting comment:", err);
        showToast("Failed to delete comment.");
      }
    },
  });
};

function renderCommentItem(c, postId) {
  const isLiked = likedCommentIds.has(c.id);
  const heartClass = isLiked
    ? "fas fa-thumbs-up text-amber-400"
    : "far fa-thumbs-up text-slate-400";
  const isOwn = currentUserData && c.user_id === currentUserData.id;
  const indentClass = c.parent_comment_id ? "ml-7" : "";

  return `
        <div class="flex gap-2 items-start text-left mt-2 ${indentClass}" id="comment-item-${escAttr(c.id)}">
            <img src="${esc(c.user_avatar) || "https://ui-avatars.com/api/?name=U"}" class="w-6 h-6 rounded-full border border-slate-800 object-cover shrink-0 mt-0.5">
            <div class="bg-slate-800 rounded-2xl px-3 py-2 flex-1 border border-slate-700/20">
                <div class="flex items-start justify-between gap-2">
                    <p class="text-[9px] font-black text-amber-400 uppercase tracking-wide">${esc(c.user_name)}</p>
                    <button onclick="window.openCommentOptionsMenu('${escAttr(c.id)}', '${escAttr(postId)}', ${isOwn ? "true" : "false"})" class="text-slate-500 hover:text-white transition shrink-0 -mt-0.5 -mr-1 px-1.5 py-0.5" aria-label="More options">
                        <i class="fas fa-ellipsis-vertical text-[11px]"></i>
                    </button>
                </div>
                <p class="text-xs text-slate-200 mt-0.5">${esc(c.text)}</p>
                <div class="flex items-center gap-3 mt-1.5">
                    <button onclick="window.likeComment('${escAttr(c.id)}', this)" class="flex items-center gap-1">
                        <i class="${heartClass} text-[11px]"></i>
                        <span class="comment-like-count text-[10px] text-slate-400 font-semibold">${parseInt(c.likes_count || 0)}</span>
                    </button>
                    <button onclick="window.startCommentReply('${escAttr(postId)}', '${escAttr(c.id)}', '${escAttr(c.user_name)}')" class="text-[10px] text-slate-400 font-semibold hover:text-amber-400 transition">
                        Reply
                    </button>
                </div>
            </div>
        </div>`;
}

// TikTok-style comment sheet: works for both the inline feed card comment
// panel and the fixed bottom-sheet used on Reels (markup differs slightly
// but both use #comments-{id}, #comment-list-{id}).
window.toggleComments = async function (postId) {
  const commentSection = document.getElementById(`comments-${postId}`);
  const list = document.getElementById(`comment-list-${postId}`);
  if (!commentSection || !list) return;

  const isReelSheet = commentSection.classList.contains("reel-comments");
  const backdrop = document.getElementById("comments-global-backdrop");

  // Fix: on some mobile WebKit browsers, a `position: fixed` element
  // nested inside an `overflow: hidden` ancestor that also sits in a
  // CSS scroll-snap container (exactly what .reel-card is) gets
  // silently clipped/never actually renders on screen, even though the
  // element's "hidden" class was correctly removed and its open-state
  // class correctly added — the panel opens logically but never
  // becomes visible. Moving the sheet to be a direct child of <body>
  // the first time it opens sidesteps that clipping entirely, since it
  // no longer has any scroll-snap/overflow ancestor to be clipped by.
  if (isReelSheet && commentSection.parentElement !== document.body) {
    document.body.appendChild(commentSection);
  }

  const isOpen = isReelSheet
    ? commentSection.classList.contains("comments-open")
    : !commentSection.classList.contains("hidden");

  if (isOpen) {
    window._closeCommentSheet(postId, true);
    return;
  }

  // Close any other open reel comment sheet first
  document.querySelectorAll(".reel-comments.comments-open").forEach((el) => {
    if (el.id !== `comments-${postId}`) el.classList.remove("comments-open");
  });

  if (isReelSheet) {
    commentSection.classList.remove("hidden");
    requestAnimationFrame(() => commentSection.classList.add("comments-open"));
    backdrop?.classList.add("backdrop-open");
    pushUiState(`comments-${postId}`, () =>
      window._closeCommentSheet(postId, true),
    );
  } else {
    commentSection.classList.remove("hidden");
    pushUiState(`comments-${postId}`, () =>
      window._closeCommentSheet(postId, true),
    );
  }

  openCommentIds.add(postId);

  list.innerHTML = `<p class="text-[10px] text-slate-500 animate-pulse py-2 pl-1">Loading comments...</p>`;

  const fetchAndRender = async () => {
    const {
      data: comments,
      error,
      count,
    } = await supabase
      .from("comments")
      .select("*", { count: "exact" })
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    list.innerHTML = "";

    updateCommentCountUI(postId, count ?? (comments ? comments.length : 0));

    if (!comments || comments.length === 0) {
      list.innerHTML = `<p class="text-[10px] text-slate-600 italic py-2 pl-1">No comments yet. Start the chat!</p>`;
      return;
    }

    // Top-level comments first, replies immediately after their parent
    const topLevel = comments.filter((c) => !c.parent_comment_id);
    const replies = comments.filter((c) => c.parent_comment_id);

    topLevel.forEach((c) => {
      list.innerHTML += renderCommentItem(c, postId);
      replies
        .filter((r) => r.parent_comment_id === c.id)
        .forEach((r) => {
          list.innerHTML += renderCommentItem(r, postId);
        });
    });
  };

  try {
    await fetchAndRender();
  } catch (err) {
    console.error("Error loading comments:", err);
    list.innerHTML = `<p class="text-[10px] text-red-400 py-1 pl-1">Failed to sync comments.</p>`;
    return;
  }

  const chanId = `comments-live-${postId}`;
  if (currentCommentsChan?._topic === chanId) return;

  if (currentCommentsChan) {
    supabase.removeChannel(currentCommentsChan);
    currentCommentsChan = null;
  }

  currentCommentsChan = supabase
    .channel(chanId)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "comments",
        filter: `post_id=eq.${postId}`,
      },
      () => {
        fetchAndRender().catch(console.error);
      },
    )
    .subscribe();
};

// Shared close routine for both inline and bottom-sheet comment views.
window._closeCommentSheet = function (postId, fromPop = false) {
  const commentSection = document.getElementById(`comments-${postId}`);
  const backdrop = document.getElementById("comments-global-backdrop");
  if (!commentSection) return;

  if (commentSection.classList.contains("reel-comments")) {
    commentSection.classList.remove("comments-open");
    backdrop?.classList.remove("backdrop-open");
    setTimeout(() => commentSection.classList.add("hidden"), 280);
  } else {
    commentSection.classList.add("hidden");
  }
  openCommentIds.delete(postId);
  if (!fromPop) popUiState(`comments-${postId}`);
};

// Global backdrop click dismisses whichever reel comment sheet is open.
document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("comments-global-backdrop")) {
    const backdrop = document.createElement("div");
    backdrop.id = "comments-global-backdrop";
    backdrop.className = "comments-backdrop";
    backdrop.addEventListener("click", () => {
      const openSheet = document.querySelector(".reel-comments.comments-open");
      if (openSheet) {
        const postId = openSheet.id.replace("comments-", "");
        window._closeCommentSheet(postId);
      }
    });
    document.body.appendChild(backdrop);
  }
});

// ─── OPTIONS MENU (3-dot action sheet) ───────────────────────────────────────
// Replaces the old always-visible trash-bin delete icon on posts and the
// bare "Delete" text link on comments with a single "..." entry point that
// opens a small bottom-sheet menu — the same pattern Instagram, TikTok, and
// WhatsApp use so a destructive action isn't sitting exposed at a glance.
// ─── IN-APP CONFIRM DIALOG ────────────────────────────────────────────────────
// Replaces the browser's native window.confirm() for destructive actions
// with a dialog styled to match the rest of the app, consistent with how
// the options menu above also avoids native browser chrome.
function showConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
}) {
  let modal = document.getElementById("confirm-dialog-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "confirm-dialog-modal";
    modal.className =
      "hidden fixed inset-0 z-[95] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4";
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
        <div class="bg-[#0f172a] border border-slate-800/80 rounded-3xl p-5 w-full max-w-xs space-y-4 shadow-2xl">
            <div class="text-center space-y-1.5">
                <p class="text-white font-black text-sm">${esc(title)}</p>
                <p class="text-slate-400 text-xs leading-relaxed">${esc(message)}</p>
            </div>
            <div class="flex gap-2">
                <button id="confirm-dialog-cancel" class="flex-1 bg-slate-800 text-slate-300 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition">
                    Cancel
                </button>
                <button id="confirm-dialog-confirm" class="flex-1 ${danger ? "bg-red-500 text-white" : "bg-amber-400 text-black"} font-black py-2.5 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition">
                    ${esc(confirmLabel)}
                </button>
            </div>
        </div>`;

  modal.classList.remove("hidden");
  pushUiState("confirm-dialog", () => closeConfirmDialog(true));

  document.getElementById("confirm-dialog-cancel").onclick = () =>
    closeConfirmDialog();
  document.getElementById("confirm-dialog-confirm").onclick = () => {
    closeConfirmDialog();
    onConfirm();
  };
}

function closeConfirmDialog(fromPop = false) {
  document.getElementById("confirm-dialog-modal")?.classList.add("hidden");
  if (!fromPop) popUiState("confirm-dialog");
}

function ensureOptionsMenuDom() {
  if (document.getElementById("options-menu-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.id = "options-menu-backdrop";
  backdrop.className = "options-menu-backdrop";
  backdrop.addEventListener("click", closeOptionsMenu);

  const sheet = document.createElement("div");
  sheet.id = "options-menu-sheet";
  sheet.className = "options-menu-sheet";
  sheet.innerHTML = `<div class="options-menu-handle"></div><div id="options-menu-items"></div>`;

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

function openOptionsMenu(items) {
  ensureOptionsMenuDom();
  const backdrop = document.getElementById("options-menu-backdrop");
  const sheet = document.getElementById("options-menu-sheet");
  const itemsEl = document.getElementById("options-menu-items");
  if (!backdrop || !sheet || !itemsEl) return;

  itemsEl.innerHTML = items
    .map((item, i) => {
      if (item.divider) return `<div class="options-menu-divider"></div>`;
      return `
            <button onclick="window._runOptionsMenuAction(${i})" class="${item.danger ? "danger" : ""}">
                <i class="${item.icon}"></i> ${esc(item.label)}
            </button>`;
    })
    .join("");

  window._optionsMenuActions = items.map((item) => item.action || null);

  backdrop.classList.add("menu-open");
  requestAnimationFrame(() => sheet.classList.add("menu-open"));
  pushUiState("options-menu", () => closeOptionsMenu(true));
}

function closeOptionsMenu(fromPop = false) {
  document
    .getElementById("options-menu-backdrop")
    ?.classList.remove("menu-open");
  document.getElementById("options-menu-sheet")?.classList.remove("menu-open");
  if (!fromPop) popUiState("options-menu");
}

window._runOptionsMenuAction = function (index) {
  const action = window._optionsMenuActions?.[index];
  closeOptionsMenu();
  if (typeof action === "function") {
    // Small delay so the sheet's close animation isn't interrupted by
    // whatever the action does next (e.g. an immediate confirm dialog).
    setTimeout(action, 200);
  }
};

// ─── REPORTING ────────────────────────────────────────────────────────────────
// Previously "Report" just showed a toast and did nothing at all — no
// record was kept anywhere, so it was a dead end dressed up as a real
// feature. This writes to a `reports` table if one exists in your
// Supabase project (target_type/target_id/reporter_id/reason/created_at).
// If that table doesn't exist yet, reports are queued in localStorage
// instead of silently vanishing, and the person is told plainly that
// their report was saved locally pending a moderation table — rather
// than pretending it was received by a backend that isn't there.
async function submitReport(targetType, targetId, reason = "unspecified") {
  if (!currentUserData) {
    showToast("Please sign in to report content.");
    return;
  }

  const payload = {
    target_type: targetType, // 'post' | 'comment'
    target_id: targetId,
    reporter_id: currentUserData.id,
    reason,
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("reports").insert(payload);
    if (error) throw error;
    showToast("Report submitted — thank you for flagging this.");
  } catch (err) {
    // Table likely doesn't exist yet (or an RLS policy blocks it) —
    // queue locally so the report isn't just lost, and be upfront
    // that it hasn't reached a real moderation backend yet.
    console.warn("Report insert failed, queuing locally:", err);
    const queued = JSON.parse(
      localStorage.getItem("campus_market_pending_reports") || "[]",
    );
    queued.push(payload);
    localStorage.setItem(
      "campus_market_pending_reports",
      JSON.stringify(queued),
    );
    showToast(
      "Report saved on this device — add a `reports` table to receive these centrally.",
    );
  }
}

// Post options: only the owner gets a real "Delete listing"; everyone
// else gets a "Report" action that now actually persists (see
// submitReport above) instead of being a dead-end toast.
window.openPostOptionsMenu = function (postId, isOwn) {
  const items = isOwn
    ? [
        {
          label: "Delete listing",
          icon: "fas fa-trash-can",
          danger: true,
          action: () => window.deletePost(postId),
        },
      ]
    : [
        {
          label: "Report listing",
          icon: "fas fa-flag",
          action: () => submitReport("post", postId),
        },
      ];
  openOptionsMenu(items);
};

// Comment options: owner gets Delete; everyone else gets Report.
window.openCommentOptionsMenu = function (commentId, postId, isOwn) {
  const items = isOwn
    ? [
        {
          label: "Delete comment",
          icon: "fas fa-trash-can",
          danger: true,
          action: () => window.deleteComment(commentId, postId),
        },
      ]
    : [
        {
          label: "Report comment",
          icon: "fas fa-flag",
          action: () => submitReport("comment", commentId),
        },
      ];
  openOptionsMenu(items);
};

function renderFeedCard(id, d) {
  const viewer = currentUserData;
  const showFollow = viewer && d.user_id !== viewer.id;
  const isOwnPost = viewer && d.user_id === viewer.id;

  let mediaUrls = [];
  if (d.media_url) {
    if (d.media_url.startsWith("[")) {
      try {
        mediaUrls = JSON.parse(d.media_url);
      } catch (_) {
        mediaUrls = [d.media_url];
      }
    } else {
      mediaUrls = [d.media_url];
    }
  }

  // Feed card media now uses a taller 4:5 ratio (Instagram-style) instead
  // of a hard square crop, since most phone-shot photos/videos are
  // portrait and a 1:1 crop was cutting off large parts of the frame.
  // Videos also drop eager autoplay/preload here — they're lazy-played
  // only when scrolled into view (see setupFeedVideoObserver), which
  // meaningfully cuts data usage since off-screen cards no longer
  // silently download their full video.
  let mediaBlock = "";
  if (mediaUrls.length > 1) {
    const slides = mediaUrls
      .map((url, i) =>
        d.media_type === "video"
          ? `<video class="feed-lazy-video w-full aspect-[4/5] object-cover shrink-0 snap-start bg-slate-950" muted loop playsinline preload="none" data-src="${esc(url)}" poster=""></video>`
          : `<img class="w-full aspect-[4/5] object-cover shrink-0 snap-start" src="${esc(url)}" alt="${esc(d.title)} ${i + 1}" loading="lazy">`,
      )
      .join("");
    mediaBlock = `
            <div class="relative w-full" onclick="openDetail('${escAttr(id)}')">
                <div class="feed-carousel-${escAttr(id)} flex overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar cursor-pointer" style="scroll-snap-type:x mandatory;">
                    ${slides}
                </div>
                <div class="absolute top-2 right-2 bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                    <span class="carousel-counter-${escAttr(id)}">1</span>/${mediaUrls.length}
                </div>
            </div>`;
  } else if (mediaUrls.length === 1) {
    mediaBlock =
      d.media_type === "video"
        ? `<div onclick="openDetail('${escAttr(id)}')" class="w-full bg-black cursor-pointer">
                <video class="feed-lazy-video w-full aspect-[4/5] object-cover bg-slate-950" muted loop playsinline preload="none" data-src="${esc(mediaUrls[0])}"></video>
               </div>`
        : `<div onclick="openDetail('${escAttr(id)}')" class="w-full cursor-pointer">
                <img class="w-full aspect-[4/5] object-cover" src="${esc(mediaUrls[0])}" alt="${esc(d.title)}" loading="lazy">
               </div>`;
  }

  const followBlock = showFollow
    ? `
        <button
            class="follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700 ml-2"
            data-follow-uid="${esc(d.user_id)}"
            data-active="false"
            onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
            + Follow
        </button>`
    : "";

  const deleteBlock = `
        <button
            onclick="event.stopPropagation(); window.openPostOptionsMenu('${escAttr(id)}', ${isOwnPost ? "true" : "false"})"
            class="post-options-trigger"
            aria-label="More options">
            <i class="fas fa-ellipsis-vertical"></i>
        </button>`;

  const isLiked = likedPostIds.has(id);
  const heartClass = isLiked
    ? "fas fa-heart text-rose-500"
    : "far fa-heart text-slate-300";
  const likedData = isLiked ? "true" : "false";

  // likes_count now comes straight from the DB and is kept accurate via
  // the RPC counters, so this reflects the true persisted count on load.
  const displayLikes = parseInt(d.likes_count || 0);
  const displayComments =
    commentCountCache[id] ?? parseInt(d.comments_count || 0);

  const isAddedToCart = userCartList.some((item) => item.id === id);
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-slate-300";

  registerPostContext(id, d, mediaUrls[0] || "");

  return `
    <div class="bg-slate-900 border-b border-slate-800/60 w-full" id="feed-card-${escAttr(id)}">

        <div class="flex items-center justify-between px-3 py-2.5">
            <div class="feed-profile-trigger flex items-center gap-2.5 min-w-0 cursor-pointer">
                <img src="${esc(d.user_avatar) || "https://ui-avatars.com/api/?name=User"}" data-avatar-for="${escAttr(d.user_id)}" class="w-8 h-8 rounded-full border border-slate-700 object-cover shrink-0" alt="">
                <div class="min-w-0">
                    <p class="text-[12px] font-bold text-white leading-tight truncate">${esc(d.user_name) || "Student"}</p>
                    <p class="text-[10px] text-slate-500 leading-tight truncate">${esc(d.institution) || ""}</p>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                ${followBlock}
                ${deleteBlock}
            </div>
        </div>

        ${mediaBlock}

        <div class="px-3 pt-2.5 pb-1 flex items-center justify-between">
            <div class="flex items-center gap-4">
                <button onclick="likePost('${escAttr(id)}', this)" data-liked="${likedData}" class="flex items-center gap-1 active:scale-90 transition ${isLiked ? "text-rose-500" : ""}">
                    <i class="${heartClass} text-xl"></i>
                    <span class="like-count text-xs font-semibold text-slate-300">${displayLikes}</span>
                </button>
                <button onclick="toggleComments('${escAttr(id)}')" class="flex items-center gap-1 text-slate-300 hover:text-amber-400 transition active:scale-90">
                    <i class="far fa-comment text-xl"></i>
                    <span class="comment-count-${escAttr(id)} text-xs font-semibold text-slate-300">${displayComments}</span>
                </button>
                <button onclick="sharePost('${escAttr(id)}', '${escAttr(d.title)}')" class="text-slate-300 hover:text-green-400 transition active:scale-90">
                    <i class="far fa-paper-plane text-xl"></i>
                </button>
            </div>
            <div class="flex items-center gap-3">
                <button id="feed-cart-icon-${escAttr(id)}" onclick="window.toggleCartItem('${escAttr(id)}')" class="hover:text-amber-400 transition active:scale-90">
                    <i class="${bookmarkClass} text-xl"></i>
                </button>
                <button onclick="downloadMedia('${escAttr(mediaUrls[0] || "")}', '${escAttr(d.title)}')" class="text-slate-400 hover:text-purple-400 transition">
                    <i class="fas fa-arrow-down text-base"></i>
                </button>
            </div>
        </div>

        <div class="px-3 pb-1">
            <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-amber-400 font-black text-sm">GH₵${esc(String(d.price || 0))}</span>
                <span class="text-[10px] text-slate-500 uppercase font-semibold">${esc(d.type) || "product"}</span>
            </div>
            <p class="text-white text-[13px] font-semibold mt-0.5 leading-snug line-clamp-2">${esc(d.title)}</p>
        </div>

        <div class="px-3 pb-3">
            <button
                onclick="contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}', '${escAttr(id)}')"
                class="w-full flex items-center justify-center gap-1.5 bg-amber-400 text-black font-extrabold py-2.5 rounded-xl text-[11px] uppercase tracking-wider transition active:scale-[0.98]">
                <i class="fas fa-bolt text-[10px]"></i> ${d.type === "skill" ? "Contact" : "Contact Seller"}
            </button>
        </div>

        <div id="comments-${escAttr(id)}" class="hidden px-3 pb-3 space-y-2 border-t border-slate-800/60 pt-2">
            <div class="flex items-center gap-1.5">
                <input
                    type="text"
                    placeholder="Add a comment…"
                    class="flex-1 bg-slate-800/80 border border-slate-700/50 text-white text-xs rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-amber-400 transition"
                    onkeydown="if(event.key==='Enter') window.submitCommentFromInput('${escAttr(id)}', this)"
                >
                <button id="cancel-reply-${escAttr(id)}" onclick="window.cancelCommentReply('${escAttr(id)}')" class="hidden text-[10px] text-slate-500 hover:text-white px-1">✕</button>
            </div>
            <div id="comment-list-${escAttr(id)}" class="max-h-36 overflow-y-auto space-y-1.5 custom-scrollbar"></div>
        </div>
    </div>`;
}

// ─── 12c. PRODUCT GRID RENDERER (4-square style, Products tab only) ──────────
function renderProductGridCard(id, d) {
  let mediaUrl = "";
  if (d.media_url) {
    if (d.media_url.startsWith("[")) {
      try {
        mediaUrl = JSON.parse(d.media_url)[0];
      } catch (_) {
        mediaUrl = d.media_url;
      }
    } else {
      mediaUrl = d.media_url;
    }
  }

  const isVideo = d.media_type === "video";
  const isAddedToCart = userCartList.some((item) => item.id === id);
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-white/80";

  return `
    <div class="bg-slate-900 border border-slate-800/60 rounded-2xl overflow-hidden" id="grid-card-${escAttr(id)}">
        <div class="relative aspect-square w-full bg-slate-950 cursor-pointer" onclick="openDetail('${escAttr(id)}')">
            ${
              isVideo
                ? `<video class="w-full h-full object-cover" muted loop playsinline autoplay src="${esc(mediaUrl)}"></video>`
                : `<img class="w-full h-full object-cover" src="${esc(mediaUrl)}" alt="${esc(d.title)}" loading="lazy">`
            }
            <button
                onclick="event.stopPropagation(); window.toggleCartItem('${escAttr(id)}')"
                class="absolute top-2 right-2 w-7 h-7 flex items-center justify-center bg-black/50 rounded-full active:scale-90 transition">
                <i class="${bookmarkClass} text-xs"></i>
            </button>
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5">
                <span class="text-amber-400 font-black text-[11px]">GH₵${esc(String(d.price || 0))}</span>
            </div>
        </div>
        <div class="p-2">
            <p class="text-white text-[11px] font-semibold leading-snug line-clamp-1">${esc(d.title)}</p>
            <p class="text-slate-500 text-[9px] truncate mt-0.5">${esc(d.user_name) || "Student"}</p>
        </div>
    </div>`;
}

function renderProductGrid() {
  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.add("grid-mode");

  const products = allCachedPosts.filter(
    ({ data: d }) => (d.type || "product") === "product",
  );

  if (products.length === 0) {
    const isScopedEmpty =
      currentCampusScope === "mine" && currentUserData?.institution;
    feed.innerHTML = isScopedEmpty
      ? `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">📦</p>
                <p class="font-bold text-white">No products from ${esc(currentUserData.institution)} yet</p>
                <p class="text-slate-500 text-xs">Be the first to list one, or check other campuses.</p>
                <button onclick="window.toggleCampusScope()" class="mt-2 bg-amber-400 text-black font-black px-5 py-2 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition">
                    Show Everywhere
                </button>
            </div>`
      : `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📦</p>
                <p class="font-bold text-white">No products yet</p>
                <p class="text-slate-500 text-xs">Be the first to list one!</p>
            </div>`;
    return;
  }

  feed.innerHTML = `<div class="grid grid-cols-2 gap-2.5 py-2">${products
    .map(({ id, data: d }) => renderProductGridCard(id, d))
    .join("")}</div>`;

  feed.innerHTML += `
        <div id="feed-load-more-sentinel" class="py-6">
            ${feedHasMore ? "" : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`}
        </div>`;
  setupFeedLoadMoreObserver();
}

// ─── 12d. REELS FEED (TikTok-style full-bleed vertical video) ────────────────
// Only the reel currently in view should play with sound / play at all;
// every other reel is paused and muted so scrolling past a video never
// leaves its audio running in the background.
let reelsIntersectionObserver = null;
let feedVideoIntersectionObserver = null;

// Fully tears down every video currently playing anywhere in the app
// (Reels tab AND regular feed cards). This is what stops a video's audio
// from continuing in the background — including showing up as a phantom
// media session in the phone's notification bar — the moment the person
// navigates away, switches tabs, or backgrounds the app.
function pauseAllReelVideos() {
  document
    .querySelectorAll(".reel-video, .feed-lazy-video")
    .forEach((video) => {
      try {
        video.pause();
        video.muted = true;
        // Fully release the source rather than just pausing, so the
        // browser drops any active media session / background decode
        // buffer instead of keeping it warm for a quick resume.
        if (video.classList.contains("feed-lazy-video") && video.src) {
          video.removeAttribute("src");
          video.load();
          video.dataset.loaded = "false";
        }
      } catch (_) {}
    });
  if (reelsIntersectionObserver) {
    reelsIntersectionObserver.disconnect();
    reelsIntersectionObserver = null;
  }
  if (feedVideoIntersectionObserver) {
    feedVideoIntersectionObserver.disconnect();
    feedVideoIntersectionObserver = null;
  }
  // Close and remove any reel comment sheets that were relocated to
  // document.body (see toggleComments) — leaving them around after
  // navigating away from Reels would keep a dangling, invisible
  // full-width fixed element sitting in the DOM.
  document
    .querySelectorAll("body > .reel-comments")
    .forEach((el) => el.remove());
  document
    .getElementById("comments-global-backdrop")
    ?.classList.remove("backdrop-open");
}

// Lazy-loads and lazy-plays videos inside regular feed cards (All /
// Services / Following / search results — anywhere renderFeedCard is
// used). A video's real `src` is only attached, and playback only
// started, once the card is actually visible — this is the main data
// saving: previously every video in the feed downloaded in full the
// instant the card was inserted into the DOM, whether seen or not.
function setupFeedVideoObserver() {
  if (feedVideoIntersectionObserver) {
    feedVideoIntersectionObserver.disconnect();
    feedVideoIntersectionObserver = null;
  }

  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feedVideoIntersectionObserver = new IntersectionObserver(
    (entries) => {
      const autoplayEnabled =
        typeof window.getAppSettings !== "function" ||
        window.getAppSettings().autoplay;
      entries.forEach((entry) => {
        const video = entry.target;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (video.dataset.loaded !== "true" && video.dataset.src) {
            video.src = video.dataset.src;
            video.dataset.loaded = "true";
          }
          if (autoplayEnabled) {
            video.play().catch(() => {});
          }
        } else {
          video.pause();
        }
      });
    },
    { root: null, threshold: [0, 0.5, 1] },
  );

  document.querySelectorAll(".feed-lazy-video").forEach((video) => {
    feedVideoIntersectionObserver.observe(video);
  });
}

let feedCommentAutoCloseObserver = null;

// Auto-closes an open inline comment panel (All / Services / Following /
// search feed cards — NOT the Reels bottom sheet, which has its own
// dismiss behavior) once its parent card has scrolled mostly out of
// view. Without this, an open comment panel stayed expanded underneath
// whatever the person scrolled to next, which read as broken/stuck UI.
function setupFeedCommentAutoClose() {
  if (feedCommentAutoCloseObserver) {
    feedCommentAutoCloseObserver.disconnect();
    feedCommentAutoCloseObserver = null;
  }

  feedCommentAutoCloseObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) return;

        const card = entry.target;
        const postId = card.id.replace("feed-card-", "");
        const commentSection = document.getElementById(`comments-${postId}`);
        if (
          commentSection &&
          !commentSection.classList.contains("reel-comments") &&
          !commentSection.classList.contains("hidden")
        ) {
          window._closeCommentSheet(postId);
        }
      });
    },
    { root: null, threshold: 0, rootMargin: "-20% 0px -20% 0px" },
  );

  document.querySelectorAll('[id^="feed-card-"]').forEach((card) => {
    feedCommentAutoCloseObserver.observe(card);
  });
}

function setupReelsIntersectionObserver() {
  if (reelsIntersectionObserver) {
    reelsIntersectionObserver.disconnect();
    reelsIntersectionObserver = null;
  }

  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  reelsIntersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const video = entry.target.querySelector(".reel-video");
        if (!video) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          // This reel is the one in view: play it, unmuted only if the
          // user hasn't explicitly muted it before (default unmuted
          // like TikTok, matching tap-to-mute behavior already wired).
          document.querySelectorAll(".reel-video").forEach((v) => {
            if (v !== video) {
              v.pause();
              v.muted = true;
              v.currentTime = v.currentTime;
            }
          });
          video.muted = video.dataset.userMuted === "true";
          video.play().catch(() => {});
        } else {
          video.pause();
          video.muted = true;
        }
      });
    },
    { root: feed, threshold: [0, 0.6, 1] },
  );

  document
    .querySelectorAll(".reel-card")
    .forEach((card) => reelsIntersectionObserver.observe(card));
}

function renderReelCard(id, d) {
  let mediaUrls = [];
  if (d.media_url) {
    if (d.media_url.startsWith("[")) {
      try {
        mediaUrls = JSON.parse(d.media_url);
      } catch (_) {
        mediaUrls = [d.media_url];
      }
    } else {
      mediaUrls = [d.media_url];
    }
  }
  const videoUrl = mediaUrls[0] || "";

  const isLiked = likedPostIds.has(id);
  const heartClass = isLiked
    ? "fas fa-heart text-rose-500"
    : "far fa-heart text-white";
  const displayLikes = parseInt(d.likes_count || 0);
  const displayComments =
    commentCountCache[id] ?? parseInt(d.comments_count || 0);
  const isAddedToCart = userCartList.some((item) => item.id === id);
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-white";
  const isOwnPost = currentUserData && d.user_id === currentUserData.id;

  const deleteBlock = `
        <button onclick="event.stopPropagation(); window.openPostOptionsMenu('${escAttr(id)}', ${isOwnPost ? "true" : "false"})" class="reel-action-btn">
            <i class="fas fa-ellipsis-vertical text-white text-lg"></i>
        </button>`;

  registerPostContext(id, d, videoUrl ? "" : mediaUrls[0] || "");

  return `
    <div class="reel-card" id="reel-card-${escAttr(id)}">
        <video class="reel-video" src="${esc(videoUrl)}" loop playsinline data-user-muted="false"
            onclick="window._toggleReelMute(this)"></video>

        <div class="reel-actions">
            <button onclick="likePost('${escAttr(id)}', this)" data-liked="${isLiked ? "true" : "false"}" class="reel-action-btn flex flex-col items-center">
                <i class="${heartClass} text-2xl"></i>
                <span class="like-count text-white text-[10px] font-bold mt-1">${displayLikes}</span>
            </button>
            <button onclick="toggleComments('${escAttr(id)}')" class="reel-action-btn flex flex-col items-center">
                <i class="far fa-comment text-2xl text-white"></i>
                <span class="comment-count-${escAttr(id)} text-white text-[10px] font-bold mt-1">${displayComments}</span>
            </button>
            <button onclick="window.toggleCartItem('${escAttr(id)}')" class="reel-action-btn">
                <i class="${bookmarkClass} text-2xl"></i>
            </button>
            <button onclick="sharePost('${escAttr(id)}', '${escAttr(d.title)}')" class="reel-action-btn">
                <i class="far fa-paper-plane text-2xl text-white"></i>
            </button>
            ${deleteBlock}
        </div>

        <div class="reel-info">
            <div class="flex items-center gap-2 mb-1.5">
                <img src="${esc(d.user_avatar) || "https://ui-avatars.com/api/?name=User"}" data-avatar-for="${escAttr(d.user_id)}" class="w-8 h-8 rounded-full border border-white/40 object-cover shrink-0" alt="">
                <p class="text-white font-bold text-sm leading-tight truncate">${esc(d.user_name) || "Student"}</p>
            </div>
            <p class="text-white text-sm font-semibold leading-snug line-clamp-2">${esc(d.title)}</p>
            <p class="text-amber-400 font-black text-sm mt-1">GH₵${esc(String(d.price || 0))}</p>
            <button
                onclick="event.stopPropagation(); contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}', '${escAttr(id)}')"
                class="mt-2 flex items-center gap-1.5 bg-amber-400 text-black font-extrabold py-2 px-4 rounded-xl text-[11px] uppercase tracking-wider active:scale-[0.97] transition w-fit">
                <i class="fas fa-bolt text-[10px]"></i> ${d.type === "skill" ? "Contact" : "Contact Seller"}
            </button>
        </div>

        <div id="comments-${escAttr(id)}" class="hidden reel-comments">
            <div class="comments-header">
                <div class="comments-drag-handle"></div>
                <p class="text-white text-xs font-black uppercase tracking-wider">
                    <span class="comment-count-${escAttr(id)}">${displayComments}</span> Comments
                </p>
                <button class="comments-close-btn" onclick="window._closeCommentSheet('${escAttr(id)}')"><i class="fas fa-times text-xs"></i></button>
            </div>
            <div id="comment-list-${escAttr(id)}" class="comments-scroll-area"></div>
            <div class="comments-input-row flex items-center gap-1.5">
                <input
                    type="text"
                    placeholder="Add a comment…"
                    class="flex-1 bg-white/10 border border-white/20 text-white text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-amber-400 transition"
                    onkeydown="if(event.key==='Enter') window.submitCommentFromInput('${escAttr(id)}', this)"
                >
                <button id="cancel-reply-${escAttr(id)}" onclick="window.cancelCommentReply('${escAttr(id)}')" class="hidden text-[10px] text-white/60 hover:text-white px-1">✕</button>
            </div>
        </div>
    </div>`;
}

// Tap-to-mute toggle, remembers the user's explicit choice on the element
// so the intersection observer doesn't fight with a manual unmute/mute.
window._toggleReelMute = function (video) {
  video.muted = !video.muted;
  video.dataset.userMuted = video.muted ? "true" : "false";
};

function renderReelsFeed() {
  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.remove("grid-mode");
  feed.classList.add("reels-mode");

  // Comment sheets get relocated to document.body when opened (see
  // toggleComments) to escape a mobile WebKit clipping bug. Before
  // regenerating the reel cards below, remove any such relocated
  // sheets from body — otherwise the fresh markup would create new
  // elements with the same #comments-{id}, leaving stale duplicates
  // behind with the same ID.
  document
    .querySelectorAll("body > .reel-comments")
    .forEach((el) => el.remove());

  const reels = allCachedPosts.filter(
    ({ data: d }) => d.media_type === "video",
  );

  if (reels.length === 0) {
    feed.innerHTML = `
            <div class="h-full flex items-center justify-center text-center py-16 space-y-3 px-6">
                <div>
                    <p class="text-4xl mb-3">🎬</p>
                    <p class="font-bold text-white">No reels yet</p>
                    <p class="text-slate-400 text-xs mt-1">Post a video to be the first!</p>
                </div>
            </div>`;
    return;
  }

  feed.innerHTML = reels
    .map(({ id, data: d }) => renderReelCard(id, d))
    .join("");
  setupReelsIntersectionObserver();
}

// ─── 12b. CHART / CART LIST LOGIC (NOW BACKEND POWERED!) ──────────────────────
window.toggleCartItem = async function (postId) {
  if (!currentUserData) {
    showToast("Please sign in to save items.");
    return;
  }

  let postRecord = null;
  const found = allCachedPosts.find(
    (p) => p.id === postId || p.data?.id === postId,
  );
  if (found) postRecord = found.data ? found.data : found;

  if (!postRecord) {
    const cardEl = document.getElementById(`feed-card-${postId}`);
    if (cardEl) {
      const nameEl = Array.from(cardEl.querySelectorAll("p")).find((el) =>
        el.classList.contains("text-[12px]"),
      );
      postRecord = {
        title:
          cardEl.querySelector("p.text-white")?.textContent || "Campus Item",
        price:
          cardEl
            .querySelector(".text-amber-400")
            ?.textContent?.replace("GH₵", "") || "0",
        user_name: nameEl?.textContent || "Student",
      };
    }
  }

  if (!postRecord) {
    showToast("Cannot link listing instance data.");
    return;
  }

  const index = userCartList.findIndex((item) => item.id === postId);
  const isRemoving = index > -1;

  // 1. Optimistic UI: Handle local mutations instantly
  if (isRemoving) {
    userCartList.splice(index, 1);
    showToast("Removed from Chart List");
  } else {
    userCartList.push({
      id: postId,
      title: postRecord.title,
      price: postRecord.price,
      media_url: postRecord.media_url || "",
      media_type: postRecord.media_type || "image",
      institution: postRecord.institution || "",
      type: postRecord.type || "product",
      user_name: postRecord.user_name || "Anonymous",
    });
    showToast("Added to Chart List! ✓");
  }

  localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));

  // Instantly update icons/buttons on current cards
  const feedIcon = document
    .getElementById(`feed-cart-icon-${postId}`)
    ?.querySelector("i");
  if (feedIcon) {
    feedIcon.className = !isRemoving
      ? "fas fa-bookmark text-amber-400"
      : "far fa-bookmark text-slate-300";
  }

  const gridBtn = document
    .getElementById(`grid-card-${postId}`)
    ?.querySelector("button i");
  if (gridBtn) {
    gridBtn.className = !isRemoving
      ? "fas fa-bookmark text-amber-400 text-xs"
      : "far fa-bookmark text-white/80 text-xs";
  }

  const detailBtn = document.getElementById(`detail-cart-btn-${postId}`);
  if (detailBtn) {
    const labelText = detailBtn.querySelector(".cart-btn-label");
    if (labelText)
      labelText.textContent = !isRemoving
        ? "✓ Added to Chart"
        : "Add to Chart List";
    detailBtn.className = !isRemoving
      ? "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-800 border border-slate-700 text-slate-400"
      : "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-900 border border-slate-700 text-white hover:border-amber-400";
  }

  if (
    !document.getElementById("cart-container")?.classList.contains("hidden")
  ) {
    renderCartListView();
  }

  // 2. Background Sync with Supabase saves table
  try {
    if (isRemoving) {
      await supabase
        .from("saves")
        .delete()
        .eq("user_id", currentUserData.id)
        .eq("post_id", postId);
    } else {
      await supabase
        .from("saves")
        .insert({ user_id: currentUserData.id, post_id: postId });
    }
  } catch (err) {
    console.warn("Saves table background sync failed/delayed:", err);
  }
};

function renderCartListView() {
  const container = document.getElementById("cart-items-wrapper");
  if (!container) return;
  if (userCartList.length === 0) {
    container.innerHTML = `<p class="p-10 text-center text-slate-500 text-xs uppercase">Your list is empty</p>`;
    return;
  }
  container.innerHTML = userCartList
    .map(
      (item) => `
        <div class="flex items-center justify-between p-3 bg-slate-900 rounded-xl border border-slate-800">
            <div class="min-w-0 flex-1 cursor-pointer" onclick="openDetail('${escAttr(item.id)}')">
                <p class="text-white font-bold text-sm truncate">${esc(item.title)}</p>
                <p class="text-amber-400 font-extrabold text-xs">GH₵${esc(String(item.price))}</p>
            </div>
            <button onclick="window.toggleCartItem('${escAttr(item.id)}')" class="text-red-400 p-2"><i class="fas fa-trash-can"></i></button>
        </div>
    `,
    )
    .join("");
}

// ─── 13. FOLLOW SYSTEM ────────────────────────────────────────────────────────
async function checkFollowing(targetUserId) {
  if (!currentUserData || !targetUserId) return false;
  try {
    const { data, error } = await supabase
      .from("follows")
      .select("id")
      .eq("follower_id", currentUserData.id)
      .eq("following_id", targetUserId)
      .maybeSingle();
    return !!data && !error;
  } catch {
    return false;
  }
}

window.toggleFollow = async function (targetUserId, targetName, targetAvatar) {
  if (!currentUserData) {
    alert("Please login first.");
    return;
  }
  if (targetUserId === currentUserData.id) return;

  try {
    const { data: existing } = await supabase
      .from("follows")
      .select("id")
      .eq("follower_id", currentUserData.id)
      .eq("following_id", targetUserId)
      .maybeSingle();

    if (existing) {
      await supabase.from("follows").delete().eq("id", existing.id);
      updateFollowButtons(targetUserId, false);
    } else {
      const metadata = currentUserData.user_metadata || {};
      await supabase.from("follows").insert({
        follower_id: currentUserData.id,
        follower_name: metadata.full_name || "Student",
        follower_avatar: metadata.avatar_url || "",
        following_id: targetUserId,
        following_name: targetName,
        following_avatar: targetAvatar,
        created_at: new Date().toISOString(),
      });
      updateFollowButtons(targetUserId, true);
    }

    if (
      !document
        .getElementById("profile-container")
        ?.classList.contains("hidden")
    ) {
      loadProfileStats();
    }
  } catch (err) {
    console.error("Follow toggle error:", err);
  }
};

function updateFollowButtons(targetUserId, isFollowing) {
  const cardClass = isFollowing
    ? "follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600 ml-2"
    : "follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700 ml-2";

  const detailClass = isFollowing
    ? "follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600"
    : "follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-amber-400 text-black";

  const label = isFollowing ? "✓ Following" : "+ Follow";

  document
    .querySelectorAll(`[data-follow-uid="${CSS.escape(targetUserId)}"]`)
    .forEach((btn) => {
      btn.textContent = label;
      btn.dataset.active = String(isFollowing);
      btn.className = btn.id === "follow-btn-detail" ? detailClass : cardClass;
    });
}

async function refreshFollowButtonStates() {
  if (!currentUserData) return;
  try {
    const { data } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", currentUserData.id);
    data?.forEach((row) => updateFollowButtons(row.following_id, true));
  } catch (err) {
    console.warn("refreshFollowButtonStates failed silently:", err);
  }
}

window.deletePost = function (postId) {
  if (!currentUserData) return;

  showConfirmDialog({
    title: "Delete this listing?",
    message:
      "This will permanently remove the listing and its media. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      try {
        const { data: currentPost, error: fetchErr } = await supabase
          .from("posts")
          .select("media_url")
          .eq("id", postId)
          .single();

        if (fetchErr) throw fetchErr;

        if (currentPost?.media_url) {
          const targets = currentPost.media_url.startsWith("[")
            ? JSON.parse(currentPost.media_url)
            : [currentPost.media_url];
          for (const url of targets) {
            const pathParts = url.split("/storage/v1/object/public/posts/");
            const storagePath = pathParts[1];
            if (storagePath)
              await supabase.storage.from("posts").remove([storagePath]);
          }
        }

        const { error: dbDeleteErr } = await supabase
          .from("posts")
          .delete()
          .eq("id", postId)
          .eq("user_id", currentUserData.id);

        if (dbDeleteErr) throw dbDeleteErr;

        const cartIndex = userCartList.findIndex((item) => item.id === postId);
        if (cartIndex > -1) {
          userCartList.splice(cartIndex, 1);
          localStorage.setItem(
            "campus_market_cart",
            JSON.stringify(userCartList),
          );
        }

        showToast("Post deleted successfully! ✓");
        allCachedPosts = allCachedPosts.filter((item) => item.id !== postId);
        renderFeedFromCache();
      } catch (err) {
        console.error("Error deleting post from database:", err);
        showToast("Failed to delete post.");
      }
    },
  });
};

// ─── 14. FEED VIEWS ──────────────────────────────────────────────────────────
let followingFeedIds = []; // cached so loadMore doesn't need to re-fetch the follows list every page

async function loadFollowingFeed() {
  if (!currentUserData) return;

  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.remove("grid-mode", "reels-mode");
  pauseAllReelVideos();
  feed.innerHTML =
    '<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading following feed...</div>';

  feedLoadedCount = 0;
  feedHasMore = true;

  try {
    const { data: followingData } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", currentUserData.id);

    followingFeedIds = followingData?.map((s) => s.following_id) || [];

    if (followingFeedIds.length === 0) {
      feed.innerHTML = `
                <div class="text-center py-16 space-y-3">
                    <p class="text-4xl">👥</p>
                    <p class="font-bold text-white">No one followed yet</p>
                    <p class="text-slate-500 text-xs">Tap + Follow on any post to see their content here</p>
                </div>`;
      return;
    }

    const { data: posts, error } = await supabase
      .from("posts")
      .select("*")
      .in("user_id", followingFeedIds)
      .order("created_at", { ascending: false })
      .range(0, FEED_PAGE_SIZE - 1);

    if (error) throw error;

    if (!posts || posts.length === 0) {
      feed.innerHTML =
        '<div class="text-center py-12 text-slate-500 text-sm">People you follow haven\'t posted yet.</div>';
      return;
    }

    allCachedPosts = posts.map((item) => ({ id: item.id, data: item }));
    feedLoadedCount = posts.length;
    feedHasMore = posts.length === FEED_PAGE_SIZE;

    feed.innerHTML = "";
    posts.forEach((d) => {
      feed.innerHTML += renderFeedCard(d.id, d);
      wireCarouselCounters(d.id);
      fetchAndCacheCommentCount(d.id);
    });

    feed.innerHTML += `
            <div id="feed-load-more-sentinel" class="py-6">
                ${feedHasMore ? "" : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`}
            </div>`;

    setupFeedVideoObserver();
    setupFeedCommentAutoClose();
    setupFeedLoadMoreObserver();
    refreshFollowButtonStates();
  } catch (err) {
    console.error("Following feed error:", err);
  }
}

// Following tab's own "load more", since it filters by followingFeedIds
// rather than the type-based baseFilter used everywhere else.
async function loadNextFollowingPage() {
  if (isFeedLoadingMore || !feedHasMore || followingFeedIds.length === 0)
    return;
  isFeedLoadingMore = true;

  const sentinel = document.getElementById("feed-load-more-sentinel");
  if (sentinel) {
    sentinel.innerHTML = `<div class="py-6 text-center text-slate-500 text-[10px] uppercase tracking-widest animate-pulse">Loading more...</div>`;
  }

  try {
    const rangeStart = feedLoadedCount;
    const rangeEnd = feedLoadedCount + FEED_PAGE_SIZE - 1;
    const { data: posts, error } = await supabase
      .from("posts")
      .select("*")
      .in("user_id", followingFeedIds)
      .order("created_at", { ascending: false })
      .range(rangeStart, rangeEnd);

    if (error) throw error;

    const existingIds = new Set(allCachedPosts.map((p) => p.id));
    const newItems = (posts || [])
      .filter((item) => !existingIds.has(item.id))
      .map((item) => ({ id: item.id, data: item }));

    allCachedPosts = allCachedPosts.concat(newItems);
    feedLoadedCount += (posts || []).length;
    feedHasMore = (posts || []).length === FEED_PAGE_SIZE;

    renderFeedFromCache();
  } catch (err) {
    console.error("Load more (following) error:", err);
    showToast("Couldn't load more posts. Try scrolling again.");
  } finally {
    isFeedLoadingMore = false;
  }
}

function renderFeedFromCache() {
  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  // Reels tab: full-bleed vertical video feed, TikTok-style
  if (currentFeedType === "reels") {
    renderReelsFeed();
    allCachedPosts
      .filter(({ data: d }) => d.media_type === "video")
      .forEach(({ id }) => fetchAndCacheCommentCount(id));
    return;
  }

  // Any time we're NOT rendering reels, make sure no reel video is still
  // playing audio in the background (e.g. switching All -> Products).
  pauseAllReelVideos();

  // Products tab renders as a 4-square grid instead of the snap-scroll feed
  if (currentFeedType === "product") {
    renderProductGrid();
    return;
  }

  feed.classList.remove("grid-mode", "reels-mode");

  if (allCachedPosts.length === 0) {
    const isScopedEmpty =
      currentCampusScope === "mine" &&
      currentUserData?.institution &&
      currentFeedType !== "following";
    feed.innerHTML = isScopedEmpty
      ? `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">📭</p>
                <p class="font-bold text-white">No posts from ${esc(currentUserData.institution)} yet</p>
                <p class="text-slate-500 text-xs">Be the first to post, or check what's happening at other campuses.</p>
                <button onclick="window.toggleCampusScope()" class="mt-2 bg-amber-400 text-black font-black px-5 py-2 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition">
                    Show Everywhere
                </button>
            </div>`
      : `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📭</p>
                <p class="font-bold text-white">No posts yet</p>
                <p class="text-slate-500 text-xs">Be the first to post on campus!</p>
            </div>`;
    return;
  }

  feed.innerHTML = "";
  allCachedPosts.forEach(({ id, data: d }) => {
    feed.innerHTML += renderFeedCard(id, d);
    wireCarouselCounters(id);
    fetchAndCacheCommentCount(id);
  });

  // Infinite scroll: a sentinel div at the end of the list triggers
  // loading the next page once it scrolls into view. Shows a small
  // "you're all caught up" message once there's genuinely nothing left,
  // instead of just silently stopping with no feedback.
  feed.innerHTML += `
        <div id="feed-load-more-sentinel" class="py-6">
            ${
              feedHasMore
                ? ""
                : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`
            }
        </div>`;

  setupFeedVideoObserver();
  setupFeedCommentAutoClose();
  setupFeedLoadMoreObserver();

  openCommentIds.forEach((postId) => {
    const section = document.getElementById(`comments-${postId}`);
    if (section) {
      section.classList.remove("hidden");
      const list = document.getElementById(`comment-list-${postId}`);
      if (list) {
        supabase
          .from("comments")
          .select("*")
          .eq("post_id", postId)
          .order("created_at", { ascending: true })
          .then(({ data: comments }) => {
            if (!comments || comments.length === 0) return;
            list.innerHTML = "";
            const topLevel = comments.filter((c) => !c.parent_comment_id);
            const replies = comments.filter((c) => c.parent_comment_id);
            topLevel.forEach((c) => {
              list.innerHTML += renderCommentItem(c, postId);
              replies
                .filter((r) => r.parent_comment_id === c.id)
                .forEach((r) => {
                  list.innerHTML += renderCommentItem(r, postId);
                });
            });
          })
          .catch(() => {});
      }
    }
  });

  refreshFollowButtonStates();
}

// ─── 15. FILTERING ────────────────────────────────────────────────────────────
window.filterFeed = function (type, clickedBtn = null) {
  if (!isAuthInitialized) return;

  const previousType = currentFeedType;
  currentFeedType = type;

  // Leaving Reels: stop any playing video audio immediately.
  if (previousType === "reels" && type !== "reels") {
    pauseAllReelVideos();
  }

  if (clickedBtn) {
    document.querySelectorAll(".feed-tab-btn").forEach((btn) => {
      btn.classList.replace("text-amber-400", "text-slate-500");
      btn.classList.replace("border-amber-400", "border-transparent");
    });
    clickedBtn.classList.replace("text-slate-500", "text-amber-400");
    clickedBtn.classList.replace("border-transparent", "border-amber-400");
  }

  // Reels tab: TikTok-style overlay header, and the feed shows video
  // posts only (media_type = 'video'), not a "type" column filter —
  // reels are a view of existing video posts, not a new post type.
  const header = document.getElementById("site-header");
  if (type === "reels") {
    header?.classList.add("header-reels-mode");
  } else {
    header?.classList.remove("header-reels-mode");
  }

  if (type === "following") {
    unsubscribeFeed();
    loadFollowingFeed();
    return;
  }

  const feed = document.getElementById("posts-feed");
  if (feed) {
    feed.innerHTML =
      '<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading...</div>';
  }

  // Product tab still fetches ALL posts (so grid + other tabs share cache)
  // but renderFeedFromCache() switches to grid layout based on currentFeedType.
  //
  // This is now just the TYPE condition — no .limit()/.range() baked in
  // here, since subscribeFeed applies pagination on top of whatever
  // this returns. Products/Reels/Skills tabs still page normally; the
  // grid view just renders everything currently loaded as a grid
  // instead of a snap-scroll list.
  //
  // Campus scope layers on top of the type condition: when scoped to
  // "mine" and the person has a saved institution, results are
  // restricted to posts from that same institution. Reels is
  // deliberately left unscoped (the banner is hidden there too) since
  // reels tend to be browsed more broadly, not as a literal pickup-item
  // search.
  const baseFilter = (q) => {
    if (type === "reels") {
      return q.eq("media_type", "video");
    }

    if (type !== "all" && type !== "product") {
      q = q.eq("type", type);
    }

    if (currentCampusScope === "mine" && currentUserData?.institution) {
      q = q.eq("institution", currentUserData.institution);
    }

    return q;
  };

  updateCampusScopeBanner();
  subscribeFeed(baseFilter);
};

// Shows/hides and updates the text of the campus-scope banner above the
// feed. Hidden entirely on Reels/Following (scope doesn't apply there)
// and for anyone without a saved institution yet (nothing to scope by —
// they'd just see an empty toggle that does nothing).
function updateCampusScopeBanner() {
  const banner = document.getElementById("campus-scope-banner");
  const label = document.getElementById("campus-scope-label");
  if (!banner || !label) return;

  const hasInstitution = !!currentUserData?.institution;
  const applicableTab = ["all", "product", "skill"].includes(currentFeedType);

  if (!hasInstitution || !applicableTab) {
    banner.classList.add("hidden");
    return;
  }

  banner.classList.remove("hidden");
  label.textContent =
    currentCampusScope === "mine" ? currentUserData.institution : "Everywhere";
}

// Toggles between "mine" (the person's own institution) and "everywhere"
// (the full nationwide feed), persists the choice, and re-runs the
// current tab's query with the new scope applied.
window.toggleCampusScope = function () {
  if (!currentUserData?.institution) return;

  currentCampusScope = currentCampusScope === "mine" ? "everywhere" : "mine";
  localStorage.setItem("campus_market_scope", currentCampusScope);

  showToast(
    currentCampusScope === "mine"
      ? `Showing posts from ${currentUserData.institution}`
      : "Showing posts from everywhere",
  );

  // Re-apply the current tab with the new scope. Reels/Following
  // aren't affected by scope, so nothing to re-run there — but this
  // button is hidden on those tabs anyway.
  if (["all", "product", "skill"].includes(currentFeedType)) {
    const clickedBtn = document.querySelector(".feed-tab-btn.text-amber-400");
    window.filterFeed(currentFeedType, clickedBtn);
  }
};

// ─── 16. SEARCH ──────────────────────────────────────────────────────────────
// Debounced entry point: the actual search/filter/render work only runs
// after typing pauses briefly, instead of on every keystroke. Previously
// each keystroke triggered a full array filter plus a full re-render of
// every matching card (including re-wiring video observers), which is
// wasted work mid-typing and made the UI feel less responsive than it
// should on a phone.
let _searchDebounceTimer = null;
window.runSearch = function (term) {
  clearTimeout(_searchDebounceTimer);

  // Clearing the field should still feel instant — no need to wait.
  if (!term.trim()) {
    _runSearchImmediate(term);
    return;
  }

  _searchDebounceTimer = setTimeout(() => {
    _runSearchImmediate(term);
  }, 300);
};

async function _runSearchImmediate(term) {
  const resultsEl = document.getElementById("search-results");
  if (!resultsEl) return;

  const trimmedTerm = term.trim();
  if (!trimmedTerm) {
    window.navigateTo("feed");
    return;
  }

  window.navigateTo("explore");
  resultsEl.innerHTML = `<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Searching Campus...</div>`;
  const lower = trimmedTerm.toLowerCase();

  if (!allCachedPosts || allCachedPosts.length === 0) {
    try {
      const { data } = await supabase
        .from("posts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(SEARCH_LIMIT);

      if (data) {
        allCachedPosts = data.map((item) => ({ id: item.id, data: item }));
      }
    } catch (e) {
      console.warn("Search initialization fallback mismatch:", e);
    }
  }

  const matches = allCachedPosts.filter((item) => {
    const d = item.data ? item.data : item;
    if (!d) return false;
    return (
      (d.title || "").toLowerCase().includes(lower) ||
      (d.description || "").toLowerCase().includes(lower) ||
      (d.user_name || "").toLowerCase().includes(lower) ||
      (d.institution || "").toLowerCase().includes(lower) ||
      (d.type || "").toLowerCase().includes(lower) ||
      (d.region || "").toLowerCase().includes(lower)
    );
  });

  if (matches.length === 0) {
    resultsEl.innerHTML = `
            <div class="text-center py-14 space-y-2">
                <p class="text-4xl">🔍</p>
                <p class="text-slate-400 font-bold text-sm">No results for "${esc(trimmedTerm)}"</p>
                <p class="text-slate-600 text-xs">Try searching for alternative keys, items, or skills</p>
            </div>`;
    return;
  }

  resultsEl.innerHTML = `
        <p class="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-3">
            ${matches.length} campus result${matches.length !== 1 ? "s" : ""} found
        </p>`;

  matches.slice(0, SEARCH_RESULTS_CAP).forEach((item) => {
    const id = item.id;
    const d = item.data ? item.data : item;
    resultsEl.innerHTML += renderFeedCard(id, d);
    wireCarouselCounters(id);
    fetchAndCacheCommentCount(id);
  });

  setupFeedVideoObserver();
  setupFeedCommentAutoClose();
  refreshFollowButtonStates();
}

// ─── 17. POST SUBMISSION ─────────────────────────────────────────────────────
// Guard flag + visible button state so a double-tap (or slow network retry)
// can never fire two uploads of the same files.
let isSubmittingPost = false;

window.handlePostSubmission = async function () {
  if (!currentUserData) {
    window.openLoginModal();
    return;
  }

  if (isSubmittingPost) {
    showToast("Already uploading — please wait...");
    return;
  }

  const title = document.getElementById("postTitle")?.value.trim();
  const description = document.getElementById("postDescription")?.value.trim();
  const type = document.getElementById("postType")?.value;
  const price = document.getElementById("postPrice")?.value;

  // Prefer the reviewed/edited (already-compressed) files from the
  // WhatsApp-style edit modal; fall back to the raw file input if the
  // user somehow skipped it — but still compress raw images here too,
  // so compression is guaranteed regardless of which path was taken.
  const rawInputFiles = document.getElementById("mediaInput")?.files;
  let mediaFiles =
    finalMediaFiles && finalMediaFiles.length > 0
      ? finalMediaFiles
      : rawInputFiles
        ? Array.from(rawInputFiles)
        : [];

  if (!finalMediaFiles || finalMediaFiles.length === 0) {
    mediaFiles = await Promise.all(
      mediaFiles.map(async (f) => {
        if (f.type && f.type.startsWith("image/")) {
          try {
            return await compressImageFile(f, {
              maxDimension: 1280,
              quality: 0.75,
            });
          } catch (_) {
            return f;
          }
        }
        return f;
      }),
    );
  }

  const submitBtn = document.getElementById("publishPostBtn");
  const submitBtnLabel = document.getElementById("publishPostBtnLabel");
  const attachBtn = document.getElementById("attachMediaBtn");

  if (!title) {
    showToast("Please enter a title.");
    return;
  }
  if (!mediaFiles || mediaFiles.length === 0) {
    showToast("Please attach at least one image or video.");
    return;
  }

  // Final safety-net validation — normally already enforced when files
  // were first attached (see openEditMediaModal), but this covers the
  // raw fallback path too in case the edit modal was somehow bypassed.
  if (mediaFiles.length > MAX_MEDIA_FILES) {
    showToast(`Please attach no more than ${MAX_MEDIA_FILES} files.`);
    return;
  }
  const oversizedFile = mediaFiles.find((f) => {
    const isVideo = f.type && f.type.startsWith("video");
    const maxBytes =
      (isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB) * 1024 * 1024;
    return f.size > maxBytes;
  });
  if (oversizedFile) {
    const isVideo =
      oversizedFile.type && oversizedFile.type.startsWith("video");
    showToast(
      `One file is over the ${isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB}MB limit. Please remove it and try again.`,
    );
    return;
  }

  // Lock the UI immediately: disable Publish AND the attach button, add a
  // spinner, so there is a clear, visible sign the upload is in progress
  // and it's impossible to trigger a second submission of the same files.
  isSubmittingPost = true;
  if (submitBtn) submitBtn.disabled = true;
  if (attachBtn) attachBtn.disabled = true;
  if (submitBtn) submitBtn.classList.add("opacity-70", "cursor-not-allowed");
  if (submitBtnLabel)
    submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Uploading 0/${mediaFiles.length}...`;

  try {
    const publicUrls = [];
    let primaryMediaType = "image";

    // Multi-file upload: every file the user attached is uploaded and
    // stored as a JSON array in media_url, which both the feed carousel
    // and detail-view carousel already render as a swipeable gallery.
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
      const ext = (file.name || "file").split(".").pop();
      const storagePath = `${currentUserData.id}/${Date.now()}-${i}.${ext}`;

      if (submitBtnLabel)
        submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Uploading ${i + 1}/${mediaFiles.length}...`;

      await withUploadRetry(
        async () => {
          const { error: uploadError } = await supabase.storage
            .from("posts")
            .upload(storagePath, file, { contentType: file.type });
          if (uploadError) throw uploadError;
        },
        {
          retries: 3,
          onRetry: (attempt) => {
            if (submitBtnLabel) {
              submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Connection lost — retrying (${attempt}/3)...`;
            }
          },
        },
      );

      const {
        data: { publicUrl },
      } = supabase.storage.from("posts").getPublicUrl(storagePath);
      publicUrls.push(publicUrl);

      if (i === 0 && file.type.startsWith("video")) {
        primaryMediaType = "video";
      }
    }

    if (submitBtnLabel)
      submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Publishing...`;

    const institution =
      currentUserData.institution ||
      document.getElementById("profileInstitution")?.value ||
      "Global";
    const region =
      currentUserData.region ||
      document.getElementById("profileRegion")?.value ||
      "Global";
    const metadata = currentUserData.user_metadata || {};

    const { error: insertError } = await supabase.from("posts").insert({
      title,
      description,
      type,
      price: parseFloat(price) || 0,
      media_url: JSON.stringify(publicUrls),
      media_type: primaryMediaType,
      institution,
      region,
      user_name: metadata.full_name || "Anonymous Student",
      user_avatar: metadata.avatar_url || "",
      user_id: currentUserData.id,
      likes_count: 0,
      created_at: new Date().toISOString(),
    });

    if (insertError) throw insertError;

    document.getElementById("postTitle").value = "";
    document.getElementById("postDescription").value = "";
    document.getElementById("postPrice").value = "";
    document.getElementById("mediaInput").value = "";
    document.getElementById("mediaFileCount").textContent = "";

    // Clear staged/final media state so re-opening the modal never
    // silently reuses a previous upload's files.
    stagedMediaFiles.forEach((f) => {
      try {
        URL.revokeObjectURL(f.url);
      } catch (_) {}
    });
    stagedMediaFiles = [];
    finalMediaFiles = [];

    window.togglePostModal();
    showToast(
      `Post published with ${publicUrls.length} file${publicUrls.length > 1 ? "s" : ""}! 🎉`,
    );
  } catch (err) {
    console.error("Post submission error:", err);
    const message = !navigator.onLine
      ? "Failed to upload — no internet connection. Please try again once you're back online."
      : "Failed to upload. Please check your connection and try again.";
    showToast(message);
  } finally {
    isSubmittingPost = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove("opacity-70", "cursor-not-allowed");
    }
    if (attachBtn) attachBtn.disabled = false;
    if (submitBtnLabel) submitBtnLabel.textContent = "Publish Instantly";
  }
};

// ─── 18. PROFILE STATS ───────────────────────────────────────────────────────
async function loadProfileStats() {
  if (!currentUserData) return;
  try {
    const [followersRes, followingRes, postsRes] = await Promise.all([
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("following_id", currentUserData.id),
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("follower_id", currentUserData.id),
      supabase
        .from("posts")
        .select("id, title, media_url, media_type, price")
        .eq("user_id", currentUserData.id)
        .order("created_at", { ascending: false }),
    ]);

    const postsCount = postsRes.data ? postsRes.data.length : 0;
    setEl("profile-followers-count", followersRes.count || 0);
    setEl("profile-following-count", followingRes.count || 0);
    setEl("profile-posts-count", postsCount);

    const grid = document.getElementById("profile-grid");
    if (grid) {
      grid.innerHTML = "";
      postsRes.data?.forEach((d) => {
        grid.innerHTML += renderGridItem(d.id, d);
      });
    }
  } catch (err) {
    console.warn("Profile stats error:", err);
  }
}

// ─── 19. SETTINGS PERSISTENCE ────────────────────────────────────────────────
window.initProfileSelects = function () {
  const regEl = document.getElementById("profileRegion");
  const instEl = document.getElementById("profileInstitution");

  if (regEl && !regEl.dataset.populated) {
    regEl.innerHTML = buildOptions(ALL_REGIONS);
    regEl.dataset.populated = "true";
    regEl.addEventListener("change", () => {
      if (instEl)
        instEl.innerHTML = buildInstitutionOptions(regEl.value, instEl.value);
    });
  }
  if (instEl && !instEl.dataset.populated) {
    instEl.innerHTML = buildOptions(ALL_INSTITUTIONS);
    instEl.dataset.populated = "true";
  }

  populateAccountSettings();
  initSettingsToggles();
};

// ─── ACCOUNT SETTINGS ─────────────────────────────────────────────────────────
function populateAccountSettings() {
  if (!currentUserData) return;
  const nameInput = document.getElementById("settingsDisplayName");
  const emailInput = document.getElementById("settingsEmail");
  const metadata = currentUserData.user_metadata || {};

  if (nameInput && !nameInput.dataset.userEdited) {
    nameInput.value = metadata.full_name || "";
  }
  if (emailInput) {
    emailInput.value = currentUserData.email || "";
  }
}

document
  .getElementById("settingsDisplayName")
  ?.addEventListener("input", function () {
    this.dataset.userEdited = "true";
  });

document
  .getElementById("saveAccountBtn")
  ?.addEventListener("click", async () => {
    if (!currentUserData) return;
    const nameInput = document.getElementById("settingsDisplayName");
    const newName = nameInput?.value.trim();

    if (!newName) {
      showToast("Please enter a display name.");
      return;
    }

    try {
      await supabase.auth.updateUser({ data: { full_name: newName } });

      const { error } = await supabase
        .from("profiles")
        .update({ name: newName })
        .eq("id", currentUserData.id);
      if (error) throw error;

      // Same staleness problem as avatars: posts store a denormalized
      // snapshot of the poster's name, so backfill it across existing
      // posts too, otherwise a name change would only apply going
      // forward.
      await supabase
        .from("posts")
        .update({ user_name: newName })
        .eq("user_id", currentUserData.id);

      if (!currentUserData.user_metadata) currentUserData.user_metadata = {};
      currentUserData.user_metadata.full_name = newName;

      allCachedPosts.forEach(({ data: d }) => {
        if (d.user_id === currentUserData.id) d.user_name = newName;
      });

      const nameEl = document.getElementById("profile-ui-name");
      if (nameEl) nameEl.textContent = newName;

      if (nameInput) delete nameInput.dataset.userEdited;
      showToast("Name updated everywhere! ✓");
    } catch (err) {
      console.error("Save name error:", err);
      showToast("Failed to update name. Please try again.");
    }
  });

// ─── DATA / AUTOPLAY / NOTIFICATION TOGGLES (persisted locally) ──────────────
const APP_SETTINGS_KEY = "campus_market_app_settings";

function getAppSettings() {
  return {
    dataSaver: false,
    autoplay: true,
    notifyMessages: true,
    notifyEngagement: true,
    notifyFollows: true,
    ...JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) || "{}"),
  };
}

function saveAppSettings(partial) {
  const merged = { ...getAppSettings(), ...partial };
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

// Exposed so other parts of the app (media pipeline, video observers) can
// check the current preference without re-reading localStorage directly.
window.getAppSettings = getAppSettings;

function initSettingsToggles() {
  const settings = getAppSettings();
  const map = {
    settingsDataSaver: "dataSaver",
    settingsAutoplay: "autoplay",
    settingsNotifyMessages: "notifyMessages",
    settingsNotifyEngagement: "notifyEngagement",
    settingsNotifyFollows: "notifyFollows",
  };

  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (!el || el.dataset.wired) return;
    el.checked = settings[key];
    el.dataset.wired = "true";
    el.addEventListener("change", () => {
      saveAppSettings({ [key]: el.checked });
      if (key === "dataSaver") {
        showToast(
          el.checked ? "Data Saver on — lower quality media" : "Data Saver off",
        );
      } else if (key === "autoplay") {
        showToast(el.checked ? "Autoplay enabled" : "Autoplay disabled");
        if (!el.checked) pauseAllReelVideos();
      } else {
        showToast("Preference saved");
      }
    });
  });
}

// ─── ACCOUNT DELETION ─────────────────────────────────────────────────────────
// Full account deletion (auth user + all data) generally needs a
// privileged server-side call (service role key), which a browser client
// can't safely hold. What we CAN safely do client-side is scrub the
// person's own content and sign them out, then direct them to contact
// support to finish removing the underlying auth account — being upfront
// about that limitation rather than silently doing nothing or pretending
// to fully delete the account.
window.confirmDeleteAccount = function () {
  if (!currentUserData) return;

  showConfirmDialog({
    title: "Delete your account?",
    message:
      "This removes your posts, comments, profile info, and your account itself from CampusMarket. This can't be undone.",
    confirmLabel: "Delete Account",
    danger: true,
    onConfirm: async () => {
      try {
        showToast("Deleting your data…");

        const { data: myPosts } = await supabase
          .from("posts")
          .select("id, media_url")
          .eq("user_id", currentUserData.id);

        for (const post of myPosts || []) {
          if (post.media_url) {
            const targets = post.media_url.startsWith("[")
              ? JSON.parse(post.media_url)
              : [post.media_url];
            for (const url of targets) {
              const storagePath = url.split(
                "/storage/v1/object/public/posts/",
              )[1];
              if (storagePath)
                await supabase.storage.from("posts").remove([storagePath]);
            }
          }
        }

        await supabase.from("posts").delete().eq("user_id", currentUserData.id);
        await supabase
          .from("comments")
          .delete()
          .eq("user_id", currentUserData.id);
        await supabase
          .from("follows")
          .delete()
          .eq("follower_id", currentUserData.id);
        await supabase
          .from("follows")
          .delete()
          .eq("following_id", currentUserData.id);
        await supabase.from("saves").delete().eq("user_id", currentUserData.id);
        await supabase.from("likes").delete().eq("user_id", currentUserData.id);
        await supabase.from("profiles").delete().eq("id", currentUserData.id);

        // A browser client can never safely hold the service-role
        // key needed to actually delete the underlying Supabase
        // Auth user, so that step happens via a dedicated Edge
        // Function (see supabase-edge-function-delete-account.ts).
        // If that function isn't deployed yet, we fall back to
        // just signing the person out with an honest message —
        // their data IS gone, but the empty auth account record
        // itself will need the Edge Function deployed to fully
        // disappear too.
        showToast("Removing your account…");
        try {
          const { error: fnError } =
            await supabase.functions.invoke("delete-account");
          if (fnError) throw fnError;
          showToast("Your account has been fully deleted. Signing out…");
        } catch (fnErr) {
          console.warn(
            "delete-account Edge Function unavailable, falling back to sign-out only:",
            fnErr,
          );
          showToast(
            "Your data was removed. Deploy the delete-account Edge Function to also remove the account record itself.",
          );
        }

        setTimeout(() => window.logout(), 1800);
      } catch (err) {
        console.error("Account deletion error:", err);
        showToast(
          "Something went wrong deleting your data. Please contact support.",
        );
      }
    },
  });
};

document
  .getElementById("saveLocationBtn")
  ?.addEventListener("click", async () => {
    if (!currentUserData) return;
    const institution = document.getElementById("profileInstitution")?.value;
    const region = document.getElementById("profileRegion")?.value;

    if (!institution || !region) {
      showToast("Please select both a region and institution.");
      return;
    }

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ institution, region })
        .eq("id", currentUserData.id);
      if (error) throw error;

      currentUserData.institution = institution;
      currentUserData.region = region;

      const locationEl = document.getElementById("profile-ui-location");
      if (locationEl) locationEl.textContent = `${institution} · ${region}`;
      showToast("Settings updated ✓");

      // Institution may have just changed — refresh the scope banner
      // label and, if currently viewing a campus-scoped tab, re-run it
      // so the feed reflects the new institution right away.
      updateCampusScopeBanner();
      if (["all", "product", "skill"].includes(currentFeedType)) {
        const clickedBtn = document.querySelector(
          ".feed-tab-btn.text-amber-400",
        );
        window.filterFeed(currentFeedType, clickedBtn);
      }
    } catch (err) {
      console.error("Save settings error:", err);
      showToast("Failed to save. Please try again.");
    }
  });

// ─── 20. DMs — WHATSAPP-STYLE INBOX + CHAT THREAD ────────────────────────────
// Requires migration.sql to have been run (conversations + messages tables,
// get_or_create_conversation RPC). See that file for schema/RLS.

function unsubscribeConversations() {
  if (currentConversationsChan) {
    supabase.removeChannel(currentConversationsChan);
    currentConversationsChan = null;
  }
}

let currentTypingChan = null;
let typingStopTimer = null;

function unsubscribeActiveThread() {
  if (currentMessagesChan) {
    supabase.removeChannel(currentMessagesChan);
    currentMessagesChan = null;
  }
  if (currentTypingChan) {
    supabase.removeChannel(currentTypingChan);
    currentTypingChan = null;
  }
  clearTimeout(typingStopTimer);
  activeConversationId = null;
  activeConversationPeer = null;
}

function dmPeerInfo(conv) {
  // conversations store user_a/user_b symmetrically; figure out which
  // side is "me" and return the other person's display info.
  const isA = conv.user_a === currentUserData.id;
  return {
    id: isA ? conv.user_b : conv.user_a,
    name: (isA ? conv.user_b_name : conv.user_a_name) || "Student",
    avatar:
      (isA ? conv.user_b_avatar : conv.user_a_avatar) ||
      "https://ui-avatars.com/api/?name=Student",
  };
}

async function openInboxView() {
  const content = document.getElementById("dms-content");
  if (!content || !currentUserData) return;

  content.innerHTML = `<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading chats...</div>`;

  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .or(`user_a.eq.${currentUserData.id},user_b.eq.${currentUserData.id}`)
      .order("last_message_at", { ascending: false });

    if (error) throw error;
    conversationsCache = data || [];
    renderInboxList();
    subscribeConversationsList();
    updateDmUnreadBadge();
  } catch (err) {
    console.error("Inbox load error:", err);
    content.innerHTML = `<div class="p-12 text-center text-red-400 text-xs">Couldn't load your chats. Pull to refresh.</div>`;
  }
}

function renderInboxList() {
  const content = document.getElementById("dms-content");
  if (!content) return;

  if (conversationsCache.length === 0) {
    content.innerHTML = `
            <div class="text-center py-16 space-y-3 bg-slate-900 border border-slate-800/60 rounded-3xl p-6">
                <p class="text-3xl">💬</p>
                <p class="font-black text-white uppercase tracking-tight text-sm">No chats yet</p>
                <p class="text-slate-500 text-xs max-w-xs mx-auto">Tap "Contact Seller" on any listing to start a conversation.</p>
            </div>`;
    return;
  }

  content.innerHTML = `<div class="divide-y divide-slate-800/60 bg-slate-900 border border-slate-800/60 rounded-3xl overflow-hidden">${conversationsCache
    .map((conv) => {
      const peer = dmPeerInfo(conv);
      const isUnread = isConversationUnread(conv);
      const previewText =
        conv.last_message && conv.last_message.startsWith("post_share:")
          ? "📎 Shared a listing"
          : esc(conv.last_message) || "Say hello 👋";
      return `
            <button
                onclick="window.openDM('${escAttr(peer.id)}','${escAttr(peer.name)}','${escAttr(peer.avatar)}')"
                class="w-full flex items-center gap-3 p-3.5 text-left active:bg-slate-800/60 transition">
                <img src="${esc(peer.avatar)}" class="w-12 h-12 rounded-full object-cover border border-slate-700 shrink-0" alt="">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-white font-bold text-sm truncate">${esc(peer.name)}</p>
                        <span class="text-[10px] text-slate-500 shrink-0">${esc(timeAgo(conv.last_message_at))}</span>
                    </div>
                    <p class="text-xs ${isUnread ? "text-slate-200 font-semibold" : "text-slate-500"} truncate mt-0.5">${previewText}</p>
                </div>
                ${isUnread ? '<div class="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0"></div>' : ""}
            </button>`;
    })
    .join("")}</div>`;
}

function subscribeConversationsList() {
  unsubscribeConversations();
  if (!currentUserData) return;

  currentConversationsChan = supabase
    .channel(`conversations-live-${currentUserData.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "conversations" },
      async () => {
        try {
          const { data } = await supabase
            .from("conversations")
            .select("*")
            .or(
              `user_a.eq.${currentUserData.id},user_b.eq.${currentUserData.id}`,
            )
            .order("last_message_at", { ascending: false });
          conversationsCache = data || [];
          // Only re-render the list if we're actually looking at it
          if (!activeConversationId) renderInboxList();
          updateDmUnreadBadge();
        } catch (_) {}
      },
    )
    .subscribe();
}

// Opens (or creates) a conversation and renders the WhatsApp-style thread view.
window.openDM = async function (
  otherUserId,
  otherUserName,
  otherUserAvatar,
  postContext = null,
) {
  if (!currentUserData) {
    window.openLoginModal();
    return;
  }
  if (!otherUserId) {
    window.navigateTo("dms");
    return;
  }
  if (otherUserId === currentUserData.id) return;

  window.navigateTo("dms");
  const content = document.getElementById("dms-content");
  if (!content) return;

  unsubscribeActiveThread();
  content.innerHTML = `<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Opening chat...</div>`;

  try {
    const metadata = currentUserData.user_metadata || {};
    const { data: convId, error } = await supabase.rpc(
      "get_or_create_conversation",
      {
        other_user_id: otherUserId,
        other_user_name: otherUserName || "Student",
        other_user_avatar: otherUserAvatar || "",
        my_name: metadata.full_name || "Student",
        my_avatar: metadata.avatar_url || "",
      },
    );

    if (error) throw error;

    activeConversationId = convId;
    activeConversationPeer = {
      id: otherUserId,
      name: otherUserName || "Student",
      avatar: otherUserAvatar || "https://ui-avatars.com/api/?name=Student",
    };

    // Opening the thread means the person has now seen it — mark it
    // read immediately so the unread dot/badge clears right away
    // rather than waiting for the next inbox refresh.
    markConversationRead(convId);

    renderChatThreadShell();
    await loadAndRenderMessages();
    subscribeActiveThreadMessages();

    // If this open came from a "Contact"/"Contact Seller" tap on a
    // specific listing, share a small preview of that post as the
    // opening message — using a structured `post_share:` prefix in
    // the existing text column (no schema change needed) so
    // renderChatBubble can detect and render it as a card instead of
    // plain text. This only fires from a fresh contact tap, never
    // when simply reopening an existing conversation from the inbox.
    if (postContext && postContext.id) {
      await sendPostSharePreview(postContext);
    }

    // Register this thread as a back-nav layer: hardware/gesture back
    // while inside a chat thread returns to the inbox list instead of
    // leaving the DMs tab (or the app).
    pushUiState("dm-thread", () => {
      window.closeDMThread(true);
    });
  } catch (err) {
    console.error("Open DM error:", err);
    content.innerHTML = `<div class="p-12 text-center text-red-400 text-xs">Couldn't open this chat. Try again.</div>`;
  }
};

// Sends a lightweight "shared listing" message so the seller can see the
// exact item being asked about right in the chat, without needing a
// dedicated messages table column. The payload is JSON, prefixed so it's
// unambiguous and never collides with a person typing a normal message
// that happens to start with the same characters.
async function sendPostSharePreview(postContext) {
  const payload = {
    id: postContext.id,
    title: postContext.title || "Listing",
    price: postContext.price ?? 0,
    image: postContext.image || "",
    type: postContext.type || "product",
  };
  const text = `post_share:${JSON.stringify(payload)}`;

  const optimisticMsg = {
    id: `local-${Date.now()}`,
    sender_id: currentUserData.id,
    text,
    created_at: new Date().toISOString(),
  };

  const container = document.getElementById("chat-messages");
  if (container) {
    const emptyState = container.querySelector("p");
    if (emptyState && container.children.length === 1) container.innerHTML = "";
    container.innerHTML += renderChatBubble(optimisticMsg);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const { error: msgErr } = await supabase.from("messages").insert({
      conversation_id: activeConversationId,
      sender_id: currentUserData.id,
      text,
    });
    if (msgErr) throw msgErr;

    await supabase
      .from("conversations")
      .update({
        last_message: `Shared: ${payload.title}`,
        last_message_at: new Date().toISOString(),
        last_sender: currentUserData.id,
      })
      .eq("id", activeConversationId);
  } catch (err) {
    console.error("Post share send error:", err);
    // Non-fatal: the person can still type a normal message even if
    // the preview card failed to send.
  }
}

function renderChatThreadShell() {
  const content = document.getElementById("dms-content");
  if (!content || !activeConversationPeer) return;

  content.innerHTML = `
        <div class="flex flex-col" style="height: calc(100vh - 220px);">
            <div class="flex items-center gap-3 pb-3 border-b border-slate-800/60 mb-3">
                <button onclick="window.closeDMThread()" class="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 text-slate-300 active:scale-90 transition shrink-0">
                    <i class="fas fa-arrow-left text-xs"></i>
                </button>
                <img src="${esc(activeConversationPeer.avatar)}" class="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0" alt="">
                <div class="min-w-0">
                    <p class="text-white font-bold text-sm truncate">${esc(activeConversationPeer.name)}</p>
                    <p id="chat-typing-status" class="text-amber-400 text-[10px] font-semibold h-3.5"></p>
                </div>
            </div>
            <div id="chat-messages" class="flex-1 overflow-y-auto space-y-2 px-1 pb-2"></div>
            <div class="flex items-center gap-2 pt-2 border-t border-slate-800/60">
                <input
                    type="text"
                    id="chat-input"
                    placeholder="Message..."
                    class="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-full px-4 py-2.5 focus:outline-none focus:border-amber-400 transition"
                    onkeydown="if(event.key==='Enter') window.sendChatMessage()"
                    oninput="window._handleTypingInput()"
                >
                <button onclick="window.sendChatMessage()" class="w-10 h-10 flex items-center justify-center bg-amber-400 text-black rounded-full active:scale-90 transition shrink-0">
                    <i class="fas fa-paper-plane text-xs"></i>
                </button>
            </div>
        </div>`;
}

function renderChatBubble(msg) {
  const isMe = msg.sender_id === currentUserData.id;

  // Shared-listing messages (from "Contact"/"Contact Seller") are
  // encoded as post_share:{...json...} in the same text column — detect
  // and render them as a small tappable product card instead of a
  // plain text bubble, so the seller sees exactly what's being asked
  // about.
  if (typeof msg.text === "string" && msg.text.startsWith("post_share:")) {
    try {
      const payload = JSON.parse(msg.text.slice("post_share:".length));
      return renderPostSharePreviewBubble(payload, isMe, msg.created_at);
    } catch (_) {
      // Malformed payload — fall through to plain text rendering
      // below rather than showing nothing.
    }
  }

  return `
        <div class="flex ${isMe ? "justify-end" : "justify-start"}">
            <div class="max-w-[75%] ${isMe ? "bg-amber-400 text-black" : "bg-slate-800 text-white"} rounded-2xl ${isMe ? "rounded-br-sm" : "rounded-bl-sm"} px-3.5 py-2">
                <p class="text-sm break-words">${esc(msg.text)}</p>
                <p class="text-[9px] ${isMe ? "text-black/50" : "text-slate-400"} mt-1 text-right">${esc(formatClockTime(msg.created_at))}</p>
            </div>
        </div>`;
}

function renderPostSharePreviewBubble(payload, isMe, createdAt) {
  return `
        <div class="flex ${isMe ? "justify-end" : "justify-start"}">
            <div
                onclick="window.closeDMThread(); setTimeout(() => openDetail('${escAttr(payload.id)}'), 50)"
                class="max-w-[78%] ${isMe ? "bg-amber-400/10 border-amber-400/30" : "bg-slate-800 border-slate-700"} border rounded-2xl ${isMe ? "rounded-br-sm" : "rounded-bl-sm"} p-2 cursor-pointer active:scale-[0.98] transition">
                <div class="flex items-center gap-2.5">
                    <div class="w-12 h-12 rounded-xl bg-slate-950 overflow-hidden shrink-0 border border-slate-700/50">
                        ${
                          payload.image
                            ? `<img src="${esc(payload.image)}" class="w-full h-full object-cover" alt="">`
                            : `<div class="w-full h-full flex items-center justify-center text-slate-600"><i class="fas fa-image text-sm"></i></div>`
                        }
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-[9px] uppercase tracking-widest font-bold ${isMe ? "text-amber-500" : "text-slate-500"}">
                            ${payload.type === "skill" ? "Shared Service" : "Shared Listing"}
                        </p>
                        <p class="text-xs font-bold ${isMe ? "text-white" : "text-white"} truncate">${esc(payload.title)}</p>
                        <p class="text-amber-400 font-black text-xs">GH₵${esc(String(payload.price))}</p>
                    </div>
                </div>
                <p class="text-[9px] ${isMe ? "text-black/40" : "text-slate-500"} mt-1.5 text-right">${esc(formatClockTime(createdAt))}</p>
            </div>
        </div>`;
}

async function loadAndRenderMessages() {
  const container = document.getElementById("chat-messages");
  if (!container || !activeConversationId) return;

  container.innerHTML = `<p class="text-center text-[10px] text-slate-500 animate-pulse py-4">Loading messages...</p>`;

  try {
    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", activeConversationId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    if (!messages || messages.length === 0) {
      container.innerHTML = `<p class="text-center text-[11px] text-slate-500 py-6">No messages yet. Say hello 👋</p>`;
    } else {
      container.innerHTML = messages.map(renderChatBubble).join("");
      container.scrollTop = container.scrollHeight;
    }

    // Mark incoming messages as read
    supabase
      .from("messages")
      .update({ read: true })
      .eq("conversation_id", activeConversationId)
      .neq("sender_id", currentUserData.id)
      .eq("read", false)
      .then(() => {})
      .catch(() => {});
  } catch (err) {
    console.error("Load messages error:", err);
    container.innerHTML = `<p class="text-center text-[11px] text-red-400 py-6">Couldn't load messages.</p>`;
  }
}

function subscribeActiveThreadMessages() {
  if (currentMessagesChan) {
    supabase.removeChannel(currentMessagesChan);
    currentMessagesChan = null;
  }
  if (!activeConversationId) return;

  currentMessagesChan = supabase
    .channel(`messages-live-${activeConversationId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${activeConversationId}`,
      },
      (payload) => {
        const container = document.getElementById("chat-messages");
        if (!container) return;
        // Avoid duplicating our own optimistically-rendered bubble
        if (container.dataset.lastOptimisticId === String(payload.new.id))
          return;
        const emptyState = container.querySelector("p");
        if (emptyState && container.children.length === 1)
          container.innerHTML = "";
        container.innerHTML += renderChatBubble(payload.new);
        container.scrollTop = container.scrollHeight;

        // Any incoming message implicitly means the peer stopped
        // typing — clear the indicator right away instead of waiting
        // for their typing-stopped broadcast.
        setTypingStatusVisible(false);
      },
    )
    .subscribe();

  subscribeTypingPresence();
}

// Typing indicator via Supabase Presence — deliberately avoids any
// schema change (no new column/table) by using a presence channel keyed
// to the conversation, where each side just broadcasts a boolean typing
// flag that the other side listens for.
function subscribeTypingPresence() {
  if (currentTypingChan) {
    supabase.removeChannel(currentTypingChan);
    currentTypingChan = null;
  }
  if (!activeConversationId || !currentUserData) return;

  currentTypingChan = supabase.channel(`typing-${activeConversationId}`, {
    config: { presence: { key: currentUserData.id } },
  });

  currentTypingChan
    .on("presence", { event: "sync" }, () => {
      const state = currentTypingChan.presenceState();
      const peerIsTyping = Object.keys(state)
        .filter((uid) => uid !== currentUserData.id)
        .some((uid) => state[uid]?.[0]?.typing);
      setTypingStatusVisible(peerIsTyping);
    })
    .subscribe();
}

function setTypingStatusVisible(visible) {
  const el = document.getElementById("chat-typing-status");
  if (!el || !activeConversationPeer) return;
  el.textContent = visible
    ? `${activeConversationPeer.name.split(" ")[0]} is typing…`
    : "";
}

// Called on every keystroke in the chat input (debounced): broadcasts
// "typing" presence immediately, then automatically broadcasts
// "stopped typing" after a short pause, so the peer's indicator clears
// on its own if the person stops without sending.
window._handleTypingInput = function () {
  if (!currentTypingChan || !currentUserData) return;

  currentTypingChan.track({ typing: true });

  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    currentTypingChan?.track({ typing: false });
  }, 2000);
};

window.sendChatMessage = async function () {
  const input = document.getElementById("chat-input");
  const text = input?.value.trim();
  if (!text || !activeConversationId || !currentUserData) return;

  input.value = "";
  clearTimeout(typingStopTimer);
  currentTypingChan?.track({ typing: false });

  const optimisticMsg = {
    id: `local-${Date.now()}`,
    sender_id: currentUserData.id,
    text,
    created_at: new Date().toISOString(),
  };

  const container = document.getElementById("chat-messages");
  if (container) {
    const emptyState = container.querySelector("p");
    if (emptyState && container.children.length === 1) container.innerHTML = "";
    container.innerHTML += renderChatBubble(optimisticMsg);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const { error: msgErr } = await supabase.from("messages").insert({
      conversation_id: activeConversationId,
      sender_id: currentUserData.id,
      text,
    });
    if (msgErr) throw msgErr;

    await supabase
      .from("conversations")
      .update({
        last_message: text,
        last_message_at: new Date().toISOString(),
        last_sender: currentUserData.id,
      })
      .eq("id", activeConversationId);
  } catch (err) {
    console.error("Send message error:", err);
    showToast("Message failed to send.");
  }
};

window.closeDMThread = function (fromPop = false) {
  unsubscribeActiveThread();
  openInboxView();
  if (!fromPop) popUiState("dm-thread");
};

// Legacy stub kept for any old call sites that don't pass full peer info.
window.openDM_legacy = function (targetUserId, targetName) {
  console.warn(
    `[DMs] openDM called with incomplete info for ${targetUserId} (${targetName}).`,
  );
};

// ─── 21. AUTH OBSERVER ───────────────────────────────────────────────────────
if (activeAuthChange) {
  activeAuthChange(async (user) => {
    // Bug fix: previously any auth-null event (including ones triggered
    // by a network drop) would force the login modal open. Now we only
    // treat this as a "signed out" transition when we're actually online,
    // so losing connectivity never dumps credential fields on screen.
    if (!navigator.onLine) {
      console.warn(
        "[Auth Observer] Network is offline. Ignoring auth state evaluation.",
      );
      return;
    }

    currentUserData = user;
    const authProfileNav = document.getElementById("auth-profile-nav");

    if (typeof window.updateAuthButton === "function") {
      window.updateAuthButton(user);
    }

    if (user) {
      const metadata = user.user_metadata || {};
      document.getElementById("login-modal")?.classList.add("hidden");
      document.getElementById("signup-modal")?.classList.add("hidden");
      document.getElementById("onboarding-modal")?.remove();

      if (authProfileNav) {
        authProfileNav.innerHTML = `<i class="fas fa-user text-lg"></i><span class="text-[10px] uppercase font-bold tracking-wider">Profile</span>`;
        authProfileNav.onclick = function (e) {
          e.stopPropagation();
          window.navigateTo("profile", authProfileNav);
        };
      }

      const avatarEl = document.getElementById("profile-ui-avatar");
      const nameEl = document.getElementById("profile-ui-name");

      try {
        const { data: savedUserRow } = await supabase
          .from("profiles")
          .select("avatar, institution, region")
          .eq("id", user.id)
          .maybeSingle();
        const savedAvatar =
          savedUserRow?.avatar ||
          metadata.avatar_url ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(metadata.full_name || "User")}`;

        if (!currentUserData.user_metadata) currentUserData.user_metadata = {};
        currentUserData.user_metadata.avatar_url = savedAvatar;

        if (avatarEl) avatarEl.src = savedAvatar;
        if (nameEl) nameEl.textContent = metadata.full_name || "Campus Student";

        window.initProfileSelects();

        if (
          !savedUserRow ||
          !savedUserRow.institution ||
          !savedUserRow.region
        ) {
          injectOnboardingModal();
        } else {
          currentUserData.institution = savedUserRow.institution || "";
          currentUserData.region = savedUserRow.region || "";
          applyLocationToUI(
            savedUserRow.institution || "",
            savedUserRow.region || "",
          );
        }
      } catch (err) {
        console.warn("User doc sync bypassed (using local auth state):", err);
        if (avatarEl)
          avatarEl.src =
            metadata.avatar_url ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(metadata.full_name || "User")}`;
        if (nameEl) nameEl.textContent = metadata.full_name || "Campus Student";
        window.initProfileSelects();
      }

      document.getElementById("profile-auth-gate")?.classList.add("hidden");
      document.getElementById("profile-content")?.classList.remove("hidden");
      document.getElementById("dms-auth-gate")?.classList.add("hidden");
      document.getElementById("dms-content")?.classList.remove("hidden");

      // Fix: the very first feed load after sign-in previously
      // called subscribeFeed() with no filter at all, bypassing
      // campus scoping entirely — so someone with "My Campus"
      // selected would still see everyone nationwide until they
      // manually clicked a tab. Now the initial load applies the
      // same "all" tab base filter (including campus scope) that
      // filterFeed('all', ...) would.
      updateCampusScopeBanner();
      subscribeFeed((q) => {
        if (currentCampusScope === "mine" && currentUserData?.institution) {
          return q.eq("institution", currentUserData.institution);
        }
        return q;
      });
      try {
        loadProfileStats();
      } catch (_) {}
      _initAvatarLongPress();

      // Populate the DMs unread badge immediately on sign-in,
      // rather than only after the person happens to open the DMs
      // tab for the first time.
      try {
        const { data: convData } = await supabase
          .from("conversations")
          .select("*")
          .or(`user_a.eq.${currentUserData.id},user_b.eq.${currentUserData.id}`)
          .order("last_message_at", { ascending: false });
        conversationsCache = convData || [];
        updateDmUnreadBadge();
      } catch (_) {}
    } else {
      unsubscribeFeed();
      unsubscribeConversations();
      unsubscribeActiveThread();
      if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);

      if (authProfileNav) {
        authProfileNav.innerHTML = `<i class="fas fa-sign-in-alt text-lg"></i><span class="text-[10px] uppercase font-bold tracking-wider">Sign In</span>`;
        authProfileNav.onclick = function (e) {
          e.stopPropagation();
          window.openLoginModal();
        };
      }

      setEl("profile-ui-name", "Campus Student");
      setEl("profile-ui-location", "Global Network");
      setEl("profile-followers-count", "0");
      setEl("profile-following-count", "0");
      setEl("profile-posts-count", "0");

      conversationsCache = [];
      document.getElementById("dms-unread-badge")?.classList.add("hidden");

      const grid = document.getElementById("profile-grid");
      if (grid) grid.innerHTML = "";

      document.getElementById("profile-auth-gate")?.classList.remove("hidden");
      document.getElementById("profile-content")?.classList.add("hidden");
      document.getElementById("dms-auth-gate")?.classList.remove("hidden");
      document.getElementById("dms-content")?.classList.add("hidden");

      document.getElementById("campus-scope-banner")?.classList.add("hidden");
      subscribeFeed();
      // Only auto-open the login modal on a genuine signed-out state
      // while online — never as a side-effect of connectivity loss.
      if (typeof window.openLoginModal === "function" && navigator.onLine) {
        window.openLoginModal();
      }
    }

    isAuthInitialized = true;
    if (
      !document.querySelector(
        ".bottom-nav button.nav-active, nav button.nav-active, nav a.nav-active",
      )
    ) {
      document.getElementById("nav-btn-feed")?.classList.add("nav-active");
    }
  });
}

// ─── 22. SCROLL DIRECTION DETECTOR FOR NAVBAR ────────────────────────────────
let lastScrollY = window.scrollY;
window.addEventListener(
  "scroll",
  () => {
    const bottomNav = document.querySelector(".bottom-nav-container");
    if (!bottomNav) return;
    const currentScrollY = window.scrollY;

    if (currentScrollY < 20) {
      bottomNav.classList.remove("bottom-nav-hidden");
      return;
    }
    if (currentScrollY > lastScrollY) {
      bottomNav.classList.add("bottom-nav-hidden");
    } else {
      bottomNav.classList.remove("bottom-nav-hidden");
    }
    lastScrollY = currentScrollY;
  },
  { passive: true },
);

// ─── 23. DELEGATED CLICK FOR FEED PROFILE LINKS ──────────────────────────────
document.body.addEventListener("click", (event) => {
  const profileClickTarget = event.target.closest(".feed-profile-trigger");
  if (profileClickTarget) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.navigateTo === "function") {
      window.navigateTo("profile");
    }
  }
});

// ─── 24. NATIVE INTERNET CONNECTIVITY DETECTOR ───────────────────────────────
// Fix: previously going offline could still leave login/signup modals open
// or let them be triggered by the auth observer. Now we explicitly close
// any open credential modals the moment connectivity drops, and show a
// calm, professional toast instead — matching how other production apps
// (WhatsApp, Instagram) handle connectivity loss.
window.addEventListener("offline", () => {
  isOnline = false;
  document.getElementById("login-modal")?.classList.add("hidden");
  document.getElementById("signup-modal")?.classList.add("hidden");

  showToast("You're offline");
  const submitBtn = document.getElementById("publishPostBtn");
  const submitBtnLabel = document.getElementById("publishPostBtnLabel");
  if (submitBtn && !isSubmittingPost) {
    submitBtn.dataset.originalText = submitBtnLabel
      ? submitBtnLabel.textContent
      : "";
    if (submitBtnLabel)
      submitBtnLabel.textContent = "Waiting for connection...";
    submitBtn.disabled = true;
  }
});

window.addEventListener("online", () => {
  isOnline = true;
  showToast("Back online");
  const submitBtn = document.getElementById("publishPostBtn");
  const submitBtnLabel = document.getElementById("publishPostBtnLabel");
  if (submitBtn && submitBtn.dataset.originalText && !isSubmittingPost) {
    if (submitBtnLabel)
      submitBtnLabel.textContent = submitBtn.dataset.originalText;
    submitBtn.disabled = false;
  }
  // Fix: this previously called subscribeFeed() with no filter at all,
  // which silently dropped campus scoping (and any type filter) the
  // moment connectivity returned — someone browsing "My Campus" would
  // get bounced to the nationwide feed after a brief signal drop with
  // no indication why. Now it re-applies whichever filter the current
  // tab + scope combination should actually have.
  if (typeof subscribeFeed === "function") {
    if (currentFeedType === "following") {
      loadFollowingFeed();
    } else {
      const baseFilter = (q) => {
        if (currentFeedType === "reels") {
          return q.eq("media_type", "video");
        }
        if (currentFeedType !== "all" && currentFeedType !== "product") {
          q = q.eq("type", currentFeedType);
        }
        if (currentCampusScope === "mine" && currentUserData?.institution) {
          q = q.eq("institution", currentUserData.institution);
        }
        return q;
      };
      subscribeFeed(baseFilter);
    }
  }
});

// ─── GLOBAL ERROR HANDLING ────────────────────────────────────────────────────
// Previously there was no catch-all: any error thrown outside an explicit
// try/catch (a bug, an unexpected null, a rejected promise nobody
// awaited) failed completely silently — nothing shown to the person,
// nothing but a console line only a developer would ever see. This
// doesn't fix underlying bugs, but it means the person using the app
// always gets SOME feedback that something went wrong instead of the UI
// just quietly not doing what they expected, with a debounce so a
// cascade of related errors doesn't spam multiple toasts at once.
let _lastGlobalErrorToastAt = 0;
function showGlobalErrorToast(context, err) {
  console.error(`[Global Error Handler] ${context}:`, err);
  const now = Date.now();
  if (now - _lastGlobalErrorToastAt < 4000) return; // avoid toast spam from a cascade of related errors
  _lastGlobalErrorToastAt = now;
  showToast("Something went wrong. Please try again.");
}

window.addEventListener("error", (event) => {
  showGlobalErrorToast("Uncaught error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showGlobalErrorToast("Unhandled promise rejection", event.reason);
});

// ─── UTILITY FUNCTION: WIRE CAROUSEL COUNTERS ───────────────────────────────
function wireCarouselCounters(postId) {
  const carousel = document.querySelector(
    `.feed-carousel-${CSS.escape(postId)}`,
  );
  const counter = document.querySelector(
    `.carousel-counter-${CSS.escape(postId)}`,
  );
  if (!carousel || !counter) return;

  carousel.addEventListener(
    "scroll",
    () => {
      const width = carousel.offsetWidth;
      if (width <= 0) return;
      const index = Math.round(carousel.scrollLeft / width) + 1;
      counter.textContent = index;
    },
    { passive: true },
  );
}

// ─── UTILITY FUNCTION: RENDER PROFILE GRID ITEM ─────────────────────────────
function renderGridItem(id, post) {
  const d = post.data ? post.data : post;

  let mediaUrl = "";
  if (d.media_url) {
    if (d.media_url.startsWith("[")) {
      try {
        mediaUrl = JSON.parse(d.media_url)[0];
      } catch (_) {
        mediaUrl = d.media_url;
      }
    } else {
      mediaUrl = d.media_url;
    }
  }

  const fallbackImage =
    "https://images.unsplash.com/photo-1563013544-824ae1d704d3?w=300";
  const isVideo = d.media_type === "video";

  return `
    <div onclick="openDetail('${id}')" class="relative aspect-square w-full bg-slate-950 border border-slate-800 rounded-xl overflow-hidden cursor-pointer group hover:border-amber-400/50 transition">
        ${
          isVideo
            ? `<video class="w-full h-full object-cover" src="${mediaUrl}"></video>
               <div class="absolute top-1.5 right-1.5 text-white drop-shadow text-[10px]"><i class="fas fa-video"></i></div>`
            : `<img class="w-full h-full object-cover group-hover:scale-105 transition duration-300" src="${mediaUrl || fallbackImage}" alt="" loading="lazy">`
        }
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
            <p class="text-[10px] text-white font-black truncate w-full">GH₵${d.price || 0}</p>
        </div>
    </div>`;
}

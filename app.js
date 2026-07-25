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
const MAX_SAVED_ALERTS = 12;
const FEED_SELECT_COLUMNS = [
  "id",
  "title",
  "description",
  "price",
  "original_price",
  "sold_at",
  "sale_ends_at",
  "media_url",
  "media_type",
  "institution",
  "region",
  "user_name",
  "user_avatar",
  "user_id",
  "likes_count",
  "comments_count",
  "type",
  "created_at",
].join(", ");
const FEED_DECAY_HALF_LIFE_HOURS = 72;
const FEED_DECAY_ENGAGEMENT_WEIGHT = 0.18;
const SAVED_ALERTS_KEY = "campus_market_saved_alerts";
const ALERT_NOTIFIED_POSTS_KEY = "campus_market_alert_notified_posts";
const DEFAULT_SAFE_SWAP_ZONES = {
  default: [
    "Main campus security post",
    "Library forecourt or reading hall entrance",
    "Student affairs or administration block frontage",
    "Busy cafeteria frontage during daylight hours",
  ],
  "Greater Accra": [
    "Main security gate or checkpoint",
    "Library forecourt / main reading area entrance",
    "Departmental admin block frontage",
    "Student centre or SRC forecourt",
  ],
  Ashanti: [
    "Campus police or security barrier",
    "Main library entrance",
    "Engineering / department quadrangle",
    "Popular hall frontage with CCTV or porter presence",
  ],
  Central: [
    "Campus security office frontage",
    "Library square",
    "Student centre / auditorium forecourt",
    "Faculty administration block frontage",
  ],
};

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

function safeStorageJsonParse(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`Ignoring corrupted localStorage value for ${key}:`, err);
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    return fallback;
  }
}

// ─── 3. MODULE STATE ──────────────────────────────────────────────────────────
let currentUserData = null;
let currentFeedChan = null;
let currentCommentsChan = null;
let allCachedPosts = [];
let isAuthInitialized = false;
// Fix: Supabase's onAuthStateChange can legitimately fire more than once
// for a single page load (INITIAL_SESSION, then SIGNED_IN, sometimes
// TOKEN_REFRESHED) — every one of those events used to re-run the ENTIRE
// signed-in boot sequence below (re-fetching the profile, re-syncing
// blocked users, and critically, re-calling filterFeed -> subscribeFeed,
// which re-ran the whole likes-table sync and re-subscribed to
// realtime). Confirmed directly in the Network tab: a single refresh
// produced SIX separate GET requests to the likes table and THREE
// duplicate-key 409 Conflicts on POST to likes, all within about a
// second of each other — exactly what repeated boot runs would produce.
// This flag ensures the expensive one-time boot work only ever runs
// once per real page load, regardless of how many auth events fire.
let hasBootedFeedForSession = false;
let isOnline = navigator.onLine;
// Fix: this used to be hardcoded to 'all', so any refresh silently
// bounced the person back to the All tab no matter what they were
// viewing (Reels, Products, Services, Following). Restoring it from
// localStorage here means the boot sequence below (which calls
// filterFeed(currentFeedType, ...)) naturally lands back on the right
// tab. Falls back to 'all' for first-ever visits or an unrecognized
// stored value.
const _validFeedTabs = [
  "all",
  "reels",
  "following",
  "product",
  "skill",
  "deals",
];
const _savedFeedTab = localStorage.getItem("campus_market_feed_tab");
let currentFeedType = _validFeedTabs.includes(_savedFeedTab)
  ? _savedFeedTab
  : "all"; // tracks active tab: all | reels | following | product | skill | deals
let _feedLoadGeneration = 0;
let _lastRenderedFeedGeneration = -1;

// ─── CAMPUS SCOPE STATE ────────────────────────────────────────────────────────
// Previously institution/region were pure display metadata — every tab
// showed every post from every campus mixed together nationwide, which
// defeats the point of a *campus* marketplace (a Legon student browsing
// past a fridge for sale in Tamale they can't realistically go pick up).
// Now the All/Products/Services tabs default to "mine" — the signed-in
// person's own institution — with an easy one-tap switch to "everywhere"
// Three-tier feed scope: 'institution' (the person's own campus, the
// tightest/default view) -> 'region' (their wider region, e.g. all of
// Greater Accra) -> 'everywhere' (nationwide, no scope at all). Each tier
// is explicit and persisted, rather than silently auto-expanding — the
// person always knows which one they're looking at and chose to move to
// a wider one themselves, whether via the banner toggle or the
// end-of-feed "want to see more?" prompt.
const _validCampusScopes = ["institution", "region", "everywhere"];
const _savedCampusScope = localStorage.getItem("campus_market_scope");
// 'mine' was the old value from before region scoping existed — treat it
// as 'institution' so anyone's existing saved preference still maps
// sensibly instead of silently resetting.
let currentCampusScope =
  _savedCampusScope === "mine"
    ? "institution"
    : _validCampusScopes.includes(_savedCampusScope)
      ? _savedCampusScope
      : "institution";

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
let feedCursor = null;
let followingFeedCursor = null;

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
const conversationLastRead = safeStorageJsonParse(
  "campus_market_dm_last_read",
  {},
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
  const unreadCount = conversationsCache.filter(isConversationUnread).length;
  [
    document.getElementById("dms-unread-badge"),
    document.getElementById("dms-unread-badge-desktop"),
  ].forEach((badge) => {
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? "9+" : unreadCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  });
}

// Fix: post ids come back from Supabase as a JS `number` (posts.id is
// bigint), but the same id also flows through HTML onclick attributes
// (e.g. onclick="likePost('123', this)") which always stringifies it to
// "123". Set membership is strict-equality based, so 123 !== "123" and a
// Set mixing both types silently fails half its lookups — this was the
// real cause of likes (and bookmarks) reading as "unliked"/"unsaved"
// after a refresh or a fresh scroll-in render even though the DB had the
// like recorded correctly. Every id is now funneled through this helper
// before being stored in or checked against an id-keyed Set, so
// comparisons are always string-to-string regardless of where the id
// originated.
const idKey = (id) => String(id);
const savedSearchAlerts = safeStorageJsonParse(SAVED_ALERTS_KEY, []);
const alertedPostIds = new Set(
  safeStorageJsonParse(ALERT_NOTIFIED_POSTS_KEY, []).map(idKey),
);

// Persistent state maps that survive feed re-renders
const likedPostIds = new Set(
  safeStorageJsonParse("campus_market_likes", []).map(idKey),
);
const openCommentIds = new Set(); // tracks which comment sections are open

// Theme mode — persisted 'dark' | 'light' | 'system' (default 'dark' for
// new users; 'system' means follow prefers-color-scheme; otherwise forced
// dark or light). The actual data-theme attribute on <html> is set by
// the inline bootstrap script in index.html (before first paint) and
// then re-applied if the user changes it via the settings UI.
const _validThemeModes = ["dark", "light", "system"];
const _savedThemeMode = localStorage.getItem("campus_market_theme");
let currentThemeMode = _validThemeModes.includes(_savedThemeMode)
  ? _savedThemeMode
  : "dark";
const systemPrefersLight = () =>
  window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: light)").matches;

// Applies the theme mode to <html>. Both the resolved value (dark/light)
// and the mode the user picked are stored on the element so CSS and the
// settings UI can read either. System mode listens for OS-level changes
// and re-applies automatically.
window.applyTheme = function (mode) {
  const valid = ["dark", "light", "system"];
  if (!valid.includes(mode)) mode = "dark";
  const resolved =
    mode === "system" ? (systemPrefersLight() ? "light" : "dark") : mode;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-mode", mode);
  currentThemeMode = mode;
  try {
    localStorage.setItem("campus_market_theme", mode);
  } catch (_) {}
  // Sync the UI selector if it exists yet (settings may not have been
  // initialized when this fires).
  const sel = document.getElementById("settingsThemeSelect");
  if (sel) sel.value = mode;
};

// Wire up the live OS-preference listener exactly once — system mode
// re-applies whenever the device's dark/light setting flips while the
// app is open.
if (_savedThemeMode === "system" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (currentThemeMode === "system") window.applyTheme("system");
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

let userCartList = safeStorageJsonParse("campus_market_cart", []);

Object.defineProperty(window, "_currentUser", { get: () => currentUserData });
Object.defineProperty(window, "_userCartList", { get: () => userCartList });
// Debug helper: likedPostIds is a module-scoped const, so it's private
// to this module and was never reachable from the browser console
// directly (typing `likedPostIds` there throws "not defined" — that's
// expected JS module behavior, not a bug). Exposing it read-only here,
// the same way _currentUser/_userCartList already are, so it can
// actually be inspected: type `[..._likedPostIds]` in the console to
// see its contents as a plain array.
Object.defineProperty(window, "_likedPostIds", { get: () => likedPostIds });

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
// Tracks which overlays (modals, comment sheets, DM threads) are open so the
// phone's hardware/gesture back button closes them one layer at a time
// instead of exiting/backgrounding the app.
const _uiStack = [];

// ─── VIEW HISTORY (Hardware/Gesture back navigation across views) ────────────
// Fix: the previous popstate handler only closed overlays. Pressing the
// hardware/gesture back button while on Profile (or any non-feed view with
// nothing open above it) silently exited/backgrounded the app instead of
// returning to the Feed tab the way the bottom-nav button does. A separate
// _viewHistory stack records the last view the user came from so the back
// button reverses navigateTo() layer-by-layer the way every modern mobile
// app does (Instagram, TikTok, WhatsApp, Twitter all behave this way).
//
// _isViewNavInProgress prevents an internal navigateTo() (triggered when
// the user pops a view) from immediately pushing itself back onto the
// stack — otherwise back-then-tap would loop or stick.
const _viewHistory = [];
// Tracks drilling into a "You might also like" post from within an
// already-open detail modal, so the back button can return to the post
// you came FROM instead of closing the whole modal (see openDetail()).
let _detailPostStack = [];
let _currentDetailPostId = null;

window.addEventListener("popstate", () => {
  // Highest priority: a still-open overlay (modal/sheet/DM thread).
  // Close it first, leave the underlying view alone.
  if (_uiStack.length > 0) {
    const top = _uiStack.pop();
    try {
      top.close(true);
    } catch (_) {}
    if (_uiStack.length > 0) {
      try {
        history.pushState({ uiLayer: _uiStack[_uiStack.length - 1].id }, "");
      } catch (_) {}
    }
    // We handled the back-press ourselves; don't also navigate views.
    try {
      history.pushState({ uiView: "keep" }, "");
    } catch (_) {}
    return;
  }

  // No overlays open: walk back through prior top-level views. The stack
  // records viewId so we can call navigateTo() with the previous one.
  if (_viewHistory.length > 1) {
    // Drop the current view (last entry) and pop the one before it.
    _viewHistory.pop();
    const prev = _viewHistory[_viewHistory.length - 1];
    if (prev) {
      const insideProgrammaticNav = true;
      window._isViewNavInProgress = insideProgrammaticNav;
      try {
        window.navigateTo(prev);
      } finally {
        window._isViewNavInProgress = false;
      }
    }
    try {
      history.pushState(
        { uiView: _viewHistory[_viewHistory.length - 1] || "base" },
        "",
      );
    } catch (_) {}
    return;
  }

  // Nothing reachable — let the browser/app handle exit as a normal web
  // history pop (closes PWA, tabs back, etc).
});
// ─── FEED REFRESH COALESCING ──────────────────────────────────────────────────
// Hoisted to module scope on purpose: when the user switches across feed
// tabs (Products → All → Reels) rapidly, each new subscribeFeed() runs
// inside its own closure. If the debounce timer lived inside subscribeFeed,
// a queued callback from the just-unsubscribed previous subscription
// could still fire and call buildFeedQuery() with the *previous* tab's
// baseFilter, silently overwriting the new feed's allCachedPosts with
// mismatched data. Module-scoping lets us clear ANY pending timer
// (regardless of which subscribeFeed() call spawned it) before installing
// a new subscription.
let _feedRefreshDebounceTimer = null;

// Defense-in-depth URL safety wrapper. Use this anywhere a user-controlled
// string is about to land in an `src=` or `href=` attribute rather than
// relying solely on esc/eAttr — those handle HTML-specials and quotes but
// don't strip `javascript:` / `data:text/html` / `vbscript:` payload URLs.
// This is a wrapping layer; full sanitization for color etc. should still
// happen upstream where the value is saved (Supabase side).
function safeUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  // Allow only http, https, mailto, and protocol-relative safe forms;
  // nuke anything else (javascript:, data:, vbscript:, file:, etc.) and
  // anything that doesn't even look like a URL/uri.
  if (/^(https?:|mailto:|\/)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    console.warn("[safeUrl] blocked non-http(s) URL:", s);
    return "";
  }
  return s;
}

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
  // escAttr is used almost everywhere a value gets interpolated into
  // onclick="window.someFn('${escAttr(x)}')" — that's TWO nested
  // contexts at once: an HTML attribute (delimited by ") wrapping a JS
  // string literal (delimited by '). esc() alone only protects the
  // outer HTML layer. The single-quote entity it produces (&#x27;)
  // looks safe, but the browser decodes HTML entities in an attribute's
  // value BEFORE compiling that value as the inline event handler's JS
  // — so &#x27; simply turns back into a raw ' at the moment the click
  // actually fires, breaking out of the JS string. Any title/name with
  // a real apostrophe (e.g. "E's Pop Crave") then corrupts that handler
  // and every attribute after it on the same tag — this is exactly what
  // threw "Uncaught SyntaxError: Unexpected identifier 'fas'" the
  // instant Add to Cart was tapped on such a card.
  //
  // Backslash-escaping the quote first makes it survive that entity
  // round-trip as \' (a valid escaped quote inside a JS string) instead
  // of a bare, string-breaking '.
  const jsSafe = String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
  return esc(jsSafe).replace(/`/g, "&#x60;");
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

function getPostCursor(post) {
  if (!post?.created_at || post?.id == null) return null;
  return { created_at: post.created_at, id: post.id };
}

function applyCursorToPostQuery(q, cursor) {
  if (!cursor?.created_at || cursor?.id == null) return q;
  return q.or(
    `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
  );
}

function updateFeedCursorFromPosts(posts, target = "feed") {
  const cursor = posts?.length ? getPostCursor(posts[posts.length - 1]) : null;
  if (target === "following") followingFeedCursor = cursor;
  else feedCursor = cursor;
}

function getPostAgeHours(post) {
  if (!post?.created_at) return Number.POSITIVE_INFINITY;
  const created = new Date(post.created_at).getTime();
  if (!Number.isFinite(created)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - created) / 36e5);
}

function getFeedScore(post) {
  const ageHours = getPostAgeHours(post);
  const freshness = Math.exp(-ageHours / FEED_DECAY_HALF_LIFE_HOURS);
  const engagement =
    parseInt(post?.likes_count || 0, 10) * 1.35 +
    parseInt(post?.comments_count || 0, 10) * 2.1;
  return freshness * (1 + engagement * FEED_DECAY_ENGAGEMENT_WEIGHT);
}

// Module-scope reels cache — invalidated by every allCachedPosts mutation
// (see subscribeFeed, loadFollowingFeed, loadNextFollowingPage, and the
// timed refresh path). Lets renderReelsFeed() skip re-filtering the
// post-list on every realtime update.
let allReelsCache = [];

// Separate pool for the All feed's "Suggested Reels" injection (see
// interleaveSuggestedReels) — deliberately NOT the same data as
// allReelsCache/allCachedPosts, since those only ever reflect whatever
// page of the main feed happens to be currently loaded. This pulls its
// own broader set of recent/popular video posts, independent of
// whatever the person has scrolled to, matching how Instagram's
// suggested content is a genuinely separate recommendation surface
// rather than a reshuffling of what's already on screen.
let suggestedReelsPool = [];
let _suggestedReelsFetchedAt = 0;

// Interleaving cursor state, made persistent across page loads (rather
// than local to a single interleaveSuggestedReels call) specifically so
// incremental load-more appends continue the same 3-6-post rhythm the
// feed already had, instead of restarting the gap countdown from zero
// at every page boundary — which would visibly cluster suggested reels
// right after each "load more" instead of flowing naturally through the
// whole scroll. Reset only on a genuine fresh feed load (see
// resetSuggestedReelsInterleaveState, called from subscribeFeed).
let _reelInterleavePoolIndex = 0;
let _reelInterleaveSinceLastInsert = 0;
let _reelInterleaveNextGap = 3 + Math.floor(Math.random() * 4);

function resetSuggestedReelsInterleaveState() {
  _reelInterleavePoolIndex = 0;
  _reelInterleaveSinceLastInsert = 0;
  _reelInterleaveNextGap = 3 + Math.floor(Math.random() * 4);
}

async function fetchSuggestedReelsPool() {
  // Refetching on every single render would be wasteful for content
  // that's explicitly supplementary — five minutes is a reasonable
  // balance between "feels fresh" and "not hammering the DB every
  // time someone opens the All tab".
  if (
    Date.now() - _suggestedReelsFetchedAt < 5 * 60 * 1000 &&
    suggestedReelsPool.length > 0
  ) {
    return suggestedReelsPool;
  }
  try {
    const { data, error } = await supabase
      .from("posts")
      .select(FEED_SELECT_COLUMNS)
      .eq("media_type", "video")
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .limit(60);
    if (error) throw error;
    suggestedReelsPool = (data || [])
      .map((d) => ({ id: d.id, data: d, score: getFeedScore(d) }))
      .sort((a, b) => b.score - a.score);
    _suggestedReelsFetchedAt = Date.now();
  } catch (err) {
    console.error("Suggested reels fetch error:", err);
    // Leave whatever pool (even empty) already exists rather than
    // throwing — this is supplementary content, a failed fetch here
    // should never block or break the main feed rendering.
  }
  return suggestedReelsPool;
}

// Weaves suggested-reel cards in among the regular feed cards at
// semi-random spacing (3-6 posts apart) rather than a fixed interval —
// matching the request that there shouldn't be one specific predictable
// spot, the same way Instagram doesn't inject its Suggested Reels at an
// exact fixed cadence either. Cards already visible as regular posts in
// this feed page are skipped so the same post never appears twice.
function interleaveSuggestedReels(regularCardsHtml, pool, alreadyShownIds) {
  if (!pool || pool.length === 0) return regularCardsHtml;

  const available = pool.filter(({ id }) => !alreadyShownIds.has(idKey(id)));
  if (available.length === 0) return regularCardsHtml;

  let poolIndex = 0;
  let sinceLastInsert = 0;
  let nextGap = 3 + Math.floor(Math.random() * 4); // 3-6 posts apart
  const merged = [];

  for (const cardHtml of regularCardsHtml) {
    merged.push(cardHtml);
    sinceLastInsert++;
    if (sinceLastInsert >= nextGap && poolIndex < available.length) {
      const { id, data: d } = available[poolIndex++];
      merged.push(renderFeedMasonryCard(id, d, { suggested: true }));
      sinceLastInsert = 0;
      nextGap = 3 + Math.floor(Math.random() * 4);
    }
  }
  return merged;
}

// Incremental sibling of interleaveSuggestedReels: same 3-6-post gap
// logic, but reads/advances the persistent module-level cursor
// (_reelInterleave*) instead of starting fresh each call, so calling
// this once per load-more page continues the same rhythm the full
// render would have produced across the whole scroll.
function interleaveSuggestedReelsIncremental(
  regularCardsHtml,
  pool,
  alreadyShownIds,
) {
  if (!pool || pool.length === 0) return regularCardsHtml;

  const available = pool.filter(({ id }) => !alreadyShownIds.has(idKey(id)));
  if (available.length === 0) return regularCardsHtml;

  const merged = [];
  for (const cardHtml of regularCardsHtml) {
    merged.push(cardHtml);
    _reelInterleaveSinceLastInsert++;
    if (
      _reelInterleaveSinceLastInsert >= _reelInterleaveNextGap &&
      _reelInterleavePoolIndex < available.length
    ) {
      const { id, data: d } = available[_reelInterleavePoolIndex++];
      merged.push(renderFeedMasonryCard(id, d, { suggested: true }));
      _reelInterleaveSinceLastInsert = 0;
      _reelInterleaveNextGap = 3 + Math.floor(Math.random() * 4);
    }
  }
  return merged;
}

function refreshReelsCache() {
  allReelsCache = allCachedPosts.filter(
    ({ data: d }) => d?.media_type === "video",
  );
  return allReelsCache;
}

// Stable-feed cache sort. Preserves the previous visible order whenever
// scores are equal so the feed never re-shuffles cards back and forth on
// state mutations (likes, comments, follows) or realtime refreshes. This
// matters because getFeedScore depends on likes_count: a card touched by a
// fresh like can otherwise outrank neighbors and reorder mid-scroll.
let _rankOrdinal = 0;
function applyFeedRankingToCache() {
  // First pass: assign monotonically-increasing ordinals to current
  // positions, so the next re-sort has a stable secondary key.
  if (allCachedPosts.length && !allCachedPosts[0].__ordinal) {
    _rankOrdinal = 0;
    for (const entry of allCachedPosts) entry.__ordinal = ++_rankOrdinal;
  }
  allCachedPosts.sort((a, b) => {
    const aScore = getFeedScore(a?.data || a);
    const bScore = getFeedScore(b?.data || b);
    if (Math.abs(bScore - aScore) > 0.0001) return bScore - aScore;
    // Tiebreaker #1: most-recent created_at first (still useful for
    // genuinely equal scores on a fresh vs older fetch).
    const aTime = new Date(a?.data?.created_at || 0).getTime();
    const bTime = new Date(b?.data?.created_at || 0).getTime();
    if (bTime !== aTime) return bTime - aTime;
    // Tiebreaker #2: PRESERVE previous display order. This is the
    // crucial guard — without it, after a like, two posts with new
    // equal scores would swap positions purely due to Array.sort's
    // non-stable spec.
    const aOrd = a.__ordinal || 0;
    const bOrd = b.__ordinal || 0;
    if (aOrd !== bOrd) return aOrd - bOrd;
    // Final deterministic tiebreaker so two truly identical entries
    // never get reshuffled by the engine.
    return (
      Number((b?.data?.id ?? b?.id) || 0) - Number((a?.data?.id ?? a?.id) || 0)
    );
  });
  // Refreshing ordinals after each sort keeps secondary keys consistent.
  _rankOrdinal = 0;
  for (const entry of allCachedPosts) entry.__ordinal = ++_rankOrdinal;
}

// Alias to keep the realtime-refresh path semantically identical (it
// explicitly remembers "previous display order" so a card ordering from
// a moment ago is still preserved across this one refresh).
function applyStableFeedRankingToCache(previousById) {
  // Use the previous display order when present so a fresh fetch that
  // drops or adds posts doesn't visually reshuffle what the user was
  // already looking at.
  if (previousById) {
    let ord = 0;
    for (const [, entry] of previousById) {
      if (entry && typeof ord === "number" && entry.__ordinal === undefined) {
        entry.__ordinal = ++ord;
      }
    }
  }
  applyFeedRankingToCache();
}

function getSafeSwapZoneSuggestions(post) {
  const byInstitution = DEFAULT_SAFE_SWAP_ZONES[post?.institution];
  if (Array.isArray(byInstitution) && byInstitution.length > 0)
    return byInstitution;
  const byRegion = DEFAULT_SAFE_SWAP_ZONES[post?.region];
  if (Array.isArray(byRegion) && byRegion.length > 0) return byRegion;
  return DEFAULT_SAFE_SWAP_ZONES.default;
}

function renderSafeSwapZoneCard(post) {
  if ((post?.type || "product") !== "product") return "";
  const zones = getSafeSwapZoneSuggestions(post);
  if (!zones?.length) return "";
  return `
        <div class="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
            <div class="flex items-center justify-between gap-2">
                <p class="text-[11px] font-black uppercase tracking-[0.22em] text-emerald-300">Safe Swap Zones</p>
                <span class="text-[10px] text-emerald-200/70 uppercase">Campus pickup</span>
            </div>
            <p class="text-xs text-slate-300 leading-relaxed">Suggested public meetup spots near ${esc(post?.institution || post?.region || "campus")} to reduce handover risk.</p>
            <div class="flex flex-wrap gap-2">
                ${zones.map((zone) => `<span class="px-2.5 py-1 rounded-full bg-slate-900/80 border border-emerald-400/20 text-[10px] text-emerald-100">${esc(zone)}</span>`).join("")}
            </div>
        </div>`;
}

// ─── SMART RECOMMENDATIONS ("Similar listings") ─────────────────────────────
// Honest scope note: this is a same-category/same-campus heuristic, not a
// personalized ML recommender — building genuine collaborative filtering
// or embeddings-based similarity would need a lot more user behavior data
// than this app currently collects (no view-history table, no purchase
// signal), plus infra this file can't stand up on its own. What's here
// is the useful, buildable version: from whatever's already loaded in
// allCachedPosts, surface other active listings of the same type,
// preferring same institution first, then same region, most recent
// first — the same signals a person would use browsing manually, just
// automated.
function renderSimilarListingsBlock(post) {
  if (!post?.id || !allCachedPosts?.length) return "";

  const targetType = post.type || "product";
  const candidates = allCachedPosts
    .map((item) => (item.data ? item.data : item))
    .filter(
      (d) =>
        d &&
        idKey(d.id) !== idKey(post.id) &&
        (d.type || "product") === targetType,
    );

  if (!candidates.length) return "";

  const scored = candidates.map((d) => {
    let score = 0;
    if (d.institution && d.institution === post.institution) score += 10;
    else if (d.region && d.region === post.region) score += 5;
    return { d, score, createdAt: d.created_at || "" };
  });
  scored.sort(
    (a, b) => b.score - a.score || (b.createdAt > a.createdAt ? 1 : -1),
  );

  // A large-but-fixed batch (not infinite scroll) — matches the Temu
  // reference's visual density without the added complexity of a
  // second infinite-scroll/pagination system living inside a modal
  // that already has its own scroll container.
  const picks = scored.slice(0, 24).map((s) => s.d);
  if (!picks.length) return "";

  return `
        <div class="pt-2">
            <p class="text-[11px] font-black uppercase tracking-[0.22em] text-slate-400 mb-3">You might also like</p>
            <div class="masonry-columns-feed">
                ${picks.map((d) => renderFeedMasonryCard(idKey(d.id), d)).join("")}
            </div>
        </div>`;
}

function persistSavedAlerts() {
  localStorage.setItem(SAVED_ALERTS_KEY, JSON.stringify(savedSearchAlerts));
}

function persistAlertedPostIds() {
  localStorage.setItem(
    ALERT_NOTIFIED_POSTS_KEY,
    JSON.stringify([...alertedPostIds]),
  );
}

function normalizeSearchAlertTerm(term) {
  return String(term || "")
    .trim()
    .toLowerCase();
}

function postMatchesSavedAlert(post, alert) {
  if (!post || !alert?.term) return false;
  const haystack = [
    post.title,
    post.description,
    post.user_name,
    post.institution,
    post.region,
    post.type,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  if (!haystack.includes(alert.term)) return false;
  if (
    alert.postType &&
    alert.postType !== "all" &&
    (post.type || "product") !== alert.postType
  )
    return false;
  if (
    alert.scope === "institution" &&
    currentUserData?.institution &&
    post.institution !== currentUserData.institution
  )
    return false;
  if (
    alert.scope === "region" &&
    currentUserData?.region &&
    post.region !== currentUserData.region
  )
    return false;
  return true;
}

function notifySavedAlertsForPosts(posts, { source = "feed" } = {}) {
  if (
    !Array.isArray(posts) ||
    posts.length === 0 ||
    savedSearchAlerts.length === 0
  )
    return;
  const matched = [];
  posts.forEach((post) => {
    const key = idKey(post?.id);
    if (!key || alertedPostIds.has(key)) return;
    if (
      post?.user_id &&
      currentUserData?.id &&
      post.user_id === currentUserData.id
    )
      return;
    const hit = savedSearchAlerts.find((alert) =>
      postMatchesSavedAlert(post, alert),
    );
    if (!hit) return;
    alertedPostIds.add(key);
    matched.push({ post, alert: hit });
  });
  if (matched.length === 0) return;
  persistAlertedPostIds();
  const preview = matched[0];
  const label =
    preview.alert.term.length > 28
      ? `${preview.alert.term.slice(0, 28)}…`
      : preview.alert.term;
  showToast(
    matched.length === 1
      ? `Alert: "${label}" matched ${preview.post?.title || "a new listing"}`
      : `Alert: ${matched.length} new posts matched "${label}"`,
  );
}

function renderSavedAlertPills(activeTerm = "") {
  if (!savedSearchAlerts.length) return "";
  const normalizedActive = normalizeSearchAlertTerm(activeTerm);
  // Fix: the pill button and its ✕ remove button used to be flex
  // siblings glued together with a negative margin (-ml-1). That only
  // looks attached when both happen to land on the same flex-wrap line;
  // once the row wraps at a narrow width, the ✕ can end up on the next
  // line, detached from the pill it's meant to remove. Wrapping each
  // pair in its own inline-flex container keeps them physically
  // together no matter where the wrap point falls.
  return `
        <div class="flex flex-wrap gap-2 mb-3">
            ${savedSearchAlerts
              .map(
                (alert) => `
                <div class="inline-flex items-center">
                    <button onclick="window.runSearch('${escAttr(alert.term)}')" class="px-3 py-1.5 rounded-full border text-[10px] uppercase tracking-wider font-black transition ${normalizedActive === alert.term ? "border-amber-400 text-amber-300 bg-amber-400/10" : "border-slate-700 text-slate-300 bg-slate-900"}">${esc(alert.term)}</button>
                    <button onclick="window.removeSearchAlert('${escAttr(alert.term)}')" class="-ml-1 px-2 py-1.5 rounded-full text-[10px] text-slate-500 hover:text-red-300" aria-label="Remove alert ${escAttr(alert.term)}">✕</button>
                </div>
            `,
              )
              .join("")}
        </div>`;
}

window.saveSearchAlert = function (term) {
  const normalized = normalizeSearchAlertTerm(term);
  if (!normalized) {
    showToast("Type a keyword before saving an alert.");
    return;
  }
  if (savedSearchAlerts.some((alert) => alert.term === normalized)) {
    showToast("That alert is already saved.");
    return;
  }
  if (savedSearchAlerts.length >= MAX_SAVED_ALERTS) savedSearchAlerts.shift();
  savedSearchAlerts.push({
    term: normalized,
    postType: currentFeedType === "all" ? "all" : currentFeedType,
    scope: currentCampusScope,
    created_at: new Date().toISOString(),
  });
  persistSavedAlerts();
  showToast(`Saved alert for "${normalized}"`);
  const searchInput = document.getElementById("campus-global-search");
  window.runSearch(searchInput?.value || normalized);
};

window.removeSearchAlert = function (term) {
  const normalized = normalizeSearchAlertTerm(term);
  const idx = savedSearchAlerts.findIndex((alert) => alert.term === normalized);
  if (idx === -1) return;
  savedSearchAlerts.splice(idx, 1);
  persistSavedAlerts();
  showToast(`Removed alert for "${normalized}"`);
  const searchInput = document.getElementById("campus-global-search");
  window.runSearch(searchInput?.value || "");
};

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

// Renders a flash-sale end time as a countdown string. Days-out sales
// still show a coarse "Nd left" (a live second-by-second tick wouldn't
// mean much a week out), but once under 24h it renders H:MM:SS so the
// badge visibly ticks — see the setInterval below that updates every
// element carrying this text once a second via its data-sale-ends
// attribute, rather than only refreshing whenever the card happens to
// re-render.
function countdownText(endsAtStr) {
  if (!endsAtStr) return "";
  const remainingMs = new Date(endsAtStr).getTime() - Date.now();
  if (remainingMs <= 0) return "";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Ticks every visible flash-sale badge once a second. Badges are found
// by class rather than tracked individually, so this stays correct
// across feed re-renders/scroll recycling without extra bookkeeping.
// Once a sale's time is up the badge is simply removed from the DOM —
// the post itself is never touched, matching "no auto-delete."
setInterval(() => {
  document.querySelectorAll(".sale-countdown-badge").forEach((el) => {
    const endsAt = el.getAttribute("data-sale-ends");
    if (!endsAt) return;
    const text = countdownText(endsAt);
    if (!text) {
      el.remove();
    } else if (el.textContent !== text) {
      el.textContent = text;
    }
  });
  // Fix: the crossed-out original price used to be rendered once and
  // never revisited, so it kept showing indefinitely after a flash
  // sale's countdown ran out — the badge vanished but the "cancelled"
  // price stayed stuck on screen, which is exactly the confusing state
  // that was reported. This removes it the same way, the moment its
  // sale_ends_at passes.
  document.querySelectorAll(".sale-strike-price").forEach((el) => {
    const endsAt = el.getAttribute("data-sale-ends");
    if (endsAt && !countdownText(endsAt)) el.remove();
  });
}, 1000);

// Fetches every rating for a seller and computes the average/count
// client-side — the seller_ratings_select_all RLS policy already allows
// any authenticated user to read all rows, so no aggregate DB function
// is needed here; for a marketplace this size the row count per seller
// is small enough that this is simpler than maintaining a separate
// summary function would be.
async function loadAndRenderSellerRating(sellerId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const { data, error } = await supabase
    .from("seller_ratings")
    .select("stars")
    .eq("seller_id", sellerId);

  if (error || !data) return;

  if (data.length === 0) {
    container.innerHTML = `<span class="text-[11px] text-slate-500">No ratings yet</span>`;
    return;
  }

  const average = data.reduce((sum, r) => sum + r.stars, 0) / data.length;
  const rounded = Math.round(average * 10) / 10;
  const fullStars = Math.round(average);

  const starsHtml = Array.from(
    { length: 5 },
    (_, i) =>
      `<i class="${i < fullStars ? "fas" : "far"} fa-star text-amber-400 text-[11px]"></i>`,
  ).join("");

  container.innerHTML = `
        <div class="flex items-center gap-1">
            ${starsHtml}
            <span class="text-[11px] text-slate-400 ml-0.5">${rounded} (${data.length})</span>
        </div>`;
}

window.openRateSellerSheet = async function (sellerId, sellerName) {
  if (!currentUserData) {
    showToast("Please sign in to leave a rating.");
    return;
  }
  if (sellerId === currentUserData.id) {
    showToast("You can't rate yourself.");
    return;
  }

  const modal = document.getElementById("manage-listing-modal");
  const content = document.getElementById("manage-listing-content");
  if (!modal || !content) return;

  content.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm"><i class="fas fa-circle-notch fa-spin"></i></div>`;
  modal.classList.remove("hidden");
  pushUiState("manage-listing-modal", () =>
    window.closeManageListingSheet(true),
  );

  // Pre-fill with the rater's existing rating for this seller, if any,
  // so re-rating feels like editing rather than starting from scratch.
  const { data: existing } = await supabase
    .from("seller_ratings")
    .select("stars, comment")
    .eq("seller_id", sellerId)
    .eq("rater_id", currentUserData.id)
    .maybeSingle();

  const currentStars = existing?.stars || 0;

  content.innerHTML = `
        <div class="p-6 space-y-5">
            <h2 class="text-lg font-bold text-white">Rate ${esc(sellerName)}</h2>
            <div class="flex items-center justify-center gap-2" id="rateSellerStars">
                ${Array.from(
                  { length: 5 },
                  (_, i) => `
                    <button type="button" onclick="window._setRateSellerStars(${i + 1})" data-star="${i + 1}" class="text-3xl transition active:scale-90 ${i < currentStars ? "text-amber-400" : "text-slate-700"}">
                        <i class="fas fa-star"></i>
                    </button>`,
                ).join("")}
            </div>
            <textarea id="rateSellerComment" rows="3" maxlength="500" placeholder="Optional comment about this seller..." class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-amber-400 transition text-sm resize-none">${esc(existing?.comment || "")}</textarea>
            <button onclick="window._submitSellerRating('${escAttr(sellerId)}')" class="w-full bg-amber-400 text-black font-black py-3 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                Submit Rating
            </button>
        </div>`;

  window._rateSellerCurrentStars = currentStars;
};

window._setRateSellerStars = function (stars) {
  window._rateSellerCurrentStars = stars;
  document.querySelectorAll("#rateSellerStars button").forEach((btn) => {
    const btnStars = parseInt(btn.dataset.star, 10);
    btn.classList.toggle("text-amber-400", btnStars <= stars);
    btn.classList.toggle("text-slate-700", btnStars > stars);
  });
};

window._submitSellerRating = async function (sellerId) {
  const stars = window._rateSellerCurrentStars || 0;
  if (stars < 1 || stars > 5) {
    showToast("Please select a star rating.");
    return;
  }

  const commentEl = document.getElementById("rateSellerComment");
  const comment = commentEl ? commentEl.value.trim().slice(0, 500) : "";

  // Upsert on (seller_id, rater_id) so re-rating updates the existing
  // row instead of erroring on a duplicate — matches the "one rating
  // per rater per seller" intent the table's own design already
  // reflects (seller_ratings_update_own policy exists specifically to
  // support this).
  const { error } = await supabase
    .from("seller_ratings")
    .upsert(
      {
        seller_id: sellerId,
        rater_id: currentUserData.id,
        stars,
        comment: comment || null,
      },
      { onConflict: "seller_id,rater_id" },
    );

  if (error) {
    console.error("Rating submit error:", error);
    showToast("Couldn't save your rating. Try again.");
    return;
  }

  showToast("Thanks for your rating!");
  window.closeManageListingSheet();
  loadAndRenderSellerRating(sellerId, `seller-rating-${idKey(sellerId)}`);
};

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

  // Fix: these used to use native alert(), which ignored the app's own
  // styling and couldn't be styled/dismissed consistently with the rest
  // of the UI. showToast keeps the same blocking-visibility (toast
  // persists for ~2.8s) but matches the dark theme.
  if (!region) {
    showToast("Please select your region.");
    return;
  }
  if (!institution) {
    showToast("Please select your institution.");
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
    // Fix: native alert() replaced with showToast for consistency.
    showToast("Could not save your details. Please try again.");
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
    // Let the button's own :active press state actually get painted
    // before the modal disappears — closing it in the same tick as
    // the click left no visible sign the tap registered at all, even
    // though sign-in itself worked correctly underneath.
    await new Promise((resolve) => setTimeout(resolve, 150));
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
  return (
    supabase
      .from("posts")
      .select(FEED_SELECT_COLUMNS)
      // Archived posts (owner-deleted via the soft-archive flow, or
      // auto-hidden by checkAutoModerationThreshold after enough
      // reports) shouldn't show up in normal browsing — is_archived
      // exists on posts now (see the SQL migration), so this filter
      // actually takes effect rather than being a no-op.
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(FEED_PAGE_SIZE)
  );
}

// Fetches posts using the tab's base filter (type condition only) plus a
// stable cursor, so newly inserted rows don't shift older rows between
// pages while someone is already scrolling the feed.
function buildFeedQuery(baseFilter, cursor = null, limit = FEED_PAGE_SIZE) {
  let q = supabase
    .from("posts")
    .select(FEED_SELECT_COLUMNS)
    .eq("is_archived", false);
  if (baseFilter) q = baseFilter(q);
  q = q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  q = applyCursorToPostQuery(q, cursor);
  return q.limit(limit);
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
  feedCursor = null;
  resetSuggestedReelsInterleaveState();
  const myGeneration = _feedLoadGeneration;

  try {
    const data = await fetchFeedSnapshot(() =>
      buildFeedQuery(baseFilter, null, FEED_PAGE_SIZE),
    );
    if (myGeneration !== _feedLoadGeneration) return; // superseded by a newer tab switch
    allCachedPosts = data.map((item) => ({ id: item.id, data: item }));
    feedLoadedCount = data.length;
    feedHasMore = data.length === FEED_PAGE_SIZE;
    updateFeedCursorFromPosts(data, "feed");
    applyFeedRankingToCache();

    // Sync local bookmark view mapping if authenticated
    if (currentUserData) {
      const { data: remoteSaves } = await supabase
        .from("saves")
        .select("post_id")
        .eq("user_id", currentUserData.id);

      if (remoteSaves) {
        // Same string/number mismatch as likes (posts.id is bigint,
        // but ids flowing through onclick attributes are strings) —
        // normalize both sides through idKey so a saved item never
        // silently reads as "not bookmarked" after a refresh.
        const savedIds = remoteSaves.map((s) => idKey(s.post_id));
        userCartList = userCartList.filter((item) =>
          savedIds.includes(idKey(item.id)),
        );
        allCachedPosts.forEach(({ id, data: d }) => {
          if (
            savedIds.includes(idKey(id)) &&
            !userCartList.some((c) => idKey(c.id) === idKey(id))
          ) {
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
        const { data: remoteLikes, error: likesFetchErr } = await supabase
          .from("likes")
          .select("post_id")
          .eq("user_id", currentUserData.id);

        if (likesFetchErr) {
          // Surfacing this (rather than swallowing it) matters:
          // if this query errors — e.g. an RLS policy blocking
          // the read, or a column type mismatch on the likes
          // table — likedPostIds silently keeps whatever was
          // last in localStorage instead of actually
          // reconciling with the database, which can look
          // exactly like "likes disappearing on refresh" when
          // the real problem is this sync failing every time.
          console.error("Likes sync query failed:", likesFetchErr);
        }

        if (remoteLikes) {
          likedPostIds.clear();
          remoteLikes.forEach((l) => likedPostIds.add(idKey(l.post_id)));
          localStorage.setItem(
            "campus_market_likes",
            JSON.stringify([...likedPostIds]),
          );
        }
      } catch (likeSyncErr) {
        console.error(
          "Likes sync failed, falling back to local cache:",
          likeSyncErr,
        );
      }
    }

    if (myGeneration >= _lastRenderedFeedGeneration) {
      _lastRenderedFeedGeneration = myGeneration;
      renderFeedFromCache();
    }
  } catch (err) {
    console.error("Feed poll error:", err);
  }

  // Hoisted: clear any pending coalesce from a previous subscription
  // BEFORE installing this channel's listener, so a queued callback
  // from the just-unsubscribed previous one can't fire with the
  // previous tab's baseFilter and silently overwrite the new feed.
  clearTimeout(_feedRefreshDebounceTimer);
  _feedRefreshDebounceTimer = null;
  currentFeedChan = supabase
    .channel(`posts-live-feed-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "posts" },
      (payload) => {
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
        if (payload?.eventType === "INSERT" && payload?.new) {
          notifySavedAlertsForPosts([payload.new], { source: "realtime" });
        }
        clearTimeout(_feedRefreshDebounceTimer);
        _feedRefreshDebounceTimer = setTimeout(async () => {
          try {
            const currentCount = Math.max(feedLoadedCount, FEED_PAGE_SIZE);
            const data = await fetchFeedSnapshot(() =>
              buildFeedQuery(baseFilter, null, currentCount),
            );

            // Fix: liking a post writes to posts.likes_count via
            // increment_post_likes, which itself fires THIS very
            // listener. If that refresh's fresh fetch lands before
            // your own increment has actually committed server-side,
            // it would silently overwrite your optimistic count with
            // the stale pre-like number — which is exactly why likes
            // could appear to "revert" seemingly at random shortly
            // after tapping them. Any post with a like operation
            // still in flight (see likeInFlight, set/cleared in
            // likePost) keeps whatever likes_count is already showing
            // locally instead of being blindly replaced here.
            const previousById = new Map(
              allCachedPosts.map((p) => [idKey(p.id), p.data]),
            );
            allCachedPosts = data.map((item) => {
              if (likeInFlight.has(idKey(item.id))) {
                const prev = previousById.get(idKey(item.id));
                if (prev)
                  return {
                    id: item.id,
                    data: { ...item, likes_count: prev.likes_count },
                  };
              }
              return { id: item.id, data: item };
            });

            feedLoadedCount = data.length;
            feedHasMore = data.length >= currentCount;
            updateFeedCursorFromPosts(data, "feed");
            // Fix: tapping the like (heart) button on a post used to
            // visibly move the post up/down the list, swapping places
            // with whatever rank had a slightly higher score after the
            // ranking sort ran. The rank changes because likes_count
            // is one of the inputs to getFeedScore via FEED_DECAY_-
            // ENGAGEMENT_WEIGHT — a tap that went from 0 likes to 1
            // like could push a low-freshness post above a higher-
            // freshness one and reorder the array, which rendered as
            // the post "jumping".
            //
            // Always re-rank, but use a STABLE sort that preserves
            // the previous display order when engagement ties. The
            // order someone saw before the tap is now remembered as
            // a per-post "rank" so compare-by-rank is part of the
            // secondary break — meaning identical scores never
            // visually reorder cards.
            applyStableFeedRankingToCache(previousById);
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
    const data = await fetchFeedSnapshot(() =>
      buildFeedQuery(currentFeedBaseFilter, feedCursor, FEED_PAGE_SIZE),
    );

    const existingIds = new Set(allCachedPosts.map((p) => p.id));
    const newItems = data
      .filter((item) => !existingIds.has(item.id))
      .map((item) => ({ id: item.id, data: item }));

    allCachedPosts = allCachedPosts.concat(newItems);
    feedLoadedCount += data.length;
    feedHasMore = data.length === FEED_PAGE_SIZE;
    updateFeedCursorFromPosts(data, "feed");
    applyFeedRankingToCache();

    appendFeedCards(newItems);
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
function getNavLabelEl(btn) {
  if (!btn) return null;
  return (
    [...btn.querySelectorAll("span")].find(
      (el) =>
        !el.classList.contains("nav-cart-badge") &&
        !el.classList.contains("badge-dot"),
    ) || null
  );
}

function clearNavHighlights() {
  document
    .querySelectorAll("nav button, .bottom-nav button, nav a")
    .forEach((b) => {
      b.classList.remove("nav-active");
      b.classList.replace("text-white", "text-slate-400");
      getNavLabelEl(b)?.classList.replace("text-white", "text-slate-400");
    });
}

function setNavHighlight(btn, viewId) {
  if (btn) {
    btn.classList.add("nav-active");
    btn.classList.replace("text-slate-400", "text-white");
    getNavLabelEl(btn)?.classList.replace("text-slate-400", "text-white");
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
    getNavLabelEl(fallback)?.classList.replace("text-slate-400", "text-white");
  }
}

window.navigateTo = function (viewId, btn = null) {
  // Fix: the header search bar (and its results) used to stay open on
  // screen after switching tabs — the only thing that closed it was
  // tapping the search icon a second time. Closing it here means
  // moving to Feed/Explore/DMs/Profile/Cart always leaves a clean
  // header behind. _runSearchImmediate() also routes through
  // navigateTo('explore') on every keystroke to show results, so we
  // skip the auto-close in that one case — otherwise it would wipe
  // out the query the person is still typing.
  // Record view transitions in the back-history stack so the hardware/
  // gesture back button can return to the previous tab, except when this
  // navigateTo() call IS the back-navigation itself (silent re-entry —
  // pushed from the popstate handler). Skip pushes for the same view
  // the user is already on so repeated taps don't grow the stack.
  if (!window._isViewNavInProgress) {
    const last = _viewHistory[_viewHistory.length - 1];
    if (last !== viewId) {
      _viewHistory.push(viewId);
      // Cap so the stack never grows unbounded if someone calls
      // navigateTo() programmatically many times in a row.
      if (_viewHistory.length > 8) _viewHistory.shift();
    }
  }

  if (
    typeof window.closeHeaderSearch === "function" &&
    !window._searchNavInProgress
  ) {
    window.closeHeaderSearch();
  }

  // Stop all reel video audio whenever we leave the feed entirely, so
  // switching to Profile/DMs/etc never leaves background audio playing.
  if (viewId !== "feed") {
    pauseAllReelVideos();

    // A reel's comment sheet is moved to document.body the first time
    // it opens (see toggleComments — this sidesteps a WebKit clipping
    // bug), which means it's no longer inside feed-container and
    // won't get hidden by the container toggle below. Close it
    // explicitly so switching to Profile/DMs/etc never leaves it
    // floating on screen over whatever view comes next.
    document.querySelectorAll(".reel-comments.comments-open").forEach((el) => {
      const reelId = el.id.replace("comments-", "");
      window._closeCommentSheet(reelId);
    });
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

  // Fix: feed-tab-all/feed-tab-grid on <body> (desktop column width +
  // right-rail visibility) previously only got set/cleared by
  // filterFeed(), never by navigateTo() — so switching away from the
  // feed left them stuck on <body>, over-widening (or hiding the rail
  // on) Profile/DMs/Explore/Cart. Sync them on every navigation instead.
  if (viewId === "feed") {
    syncFeedTabBodyClasses(currentFeedType);
  } else {
    document.body.classList.remove(
      "feed-tab-all",
      "feed-tab-grid",
      "feed-tab-deals",
    );
  }
  document.body.classList.toggle("profile-tab", viewId === "profile");

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

function syncProfileTabChrome(tabType, selectedBtn = null) {
  const subtabButtons = [...document.querySelectorAll(".profile-subtab-btn")];
  const settingsBtn = document.getElementById("profile-open-settings-btn");
  const savedQuickBtn = document.getElementById("profile-saved-quick-btn");

  subtabButtons.forEach((btn) => {
    btn.classList.remove("is-active");
    btn.setAttribute("aria-pressed", "false");
  });

  [settingsBtn, savedQuickBtn].forEach((btn) => {
    if (!btn) return;
    btn.classList.remove("is-active");
    btn.setAttribute("aria-pressed", "false");
  });

  const subtabByType = {
    posts: document.getElementById("profile-tab-posts"),
    saved: document.getElementById("profile-tab-saved"),
  };

  const activeSubtab = selectedBtn || subtabByType[tabType] || null;
  if (activeSubtab && activeSubtab.classList.contains("profile-subtab-btn")) {
    activeSubtab.classList.add("is-active");
    activeSubtab.setAttribute("aria-pressed", "true");
  }

  if (tabType === "settings" && settingsBtn) {
    settingsBtn.classList.add("is-active");
    settingsBtn.setAttribute("aria-pressed", "true");
  }
  if (tabType === "saved" && savedQuickBtn) {
    savedQuickBtn.classList.add("is-active");
    savedQuickBtn.setAttribute("aria-pressed", "true");
  }
}

function renderSavedItemsLoadError(targetId = "profile-saved-items-wrapper") {
  const wrapper = document.getElementById(targetId);
  if (!wrapper) return;
  wrapper.innerHTML = `
        <div class="p-5 text-center bg-slate-900 border border-slate-800/70 rounded-3xl space-y-3">
            <p class="text-slate-300 text-sm font-black uppercase tracking-wider">Couldn't load saved items</p>
            <p class="text-slate-500 text-xs">Please try again.</p>
            <button onclick="window.switchProfileTab('saved', document.getElementById('profile-tab-saved'))" class="inline-flex items-center gap-2 bg-amber-400 text-black font-black px-4 py-2.5 rounded-xl text-[11px] uppercase tracking-wider active:scale-[0.98] transition">
                <i class="fas fa-rotate-right text-[10px]"></i> Retry
            </button>
        </div>`;
}

window.switchProfileTab = function (tabType, selectedBtn = null) {
  document
    .querySelectorAll(".profile-subview")
    .forEach((view) => view.classList.add("hidden"));
  document
    .getElementById(`profile-subview-${tabType}`)
    ?.classList.remove("hidden");
  syncProfileTabChrome(tabType, selectedBtn);

  if (tabType === "saved") {
    renderCartListView().catch((err) => {
      console.error("Saved Items render failed:", err);
      renderSavedItemsLoadError("profile-saved-items-wrapper");
    });
  }
};

window.openCampusSettings = function () {
  window.switchProfileTab("settings");
};

window.openUserDashboard = function (userId) {
  if (!userId) return;
  if (currentUserData && idKey(userId) === idKey(currentUserData.id)) {
    // Fix: navigateTo('profile') switches which container is visible
    // underneath, but tapping "Provider" on your own listing happens
    // from INSIDE the still-open detail modal — so the profile view
    // was rendering behind it with nothing on screen ever changing.
    // Close any overlay that could be sitting on top before navigating.
    if (typeof window.closeDetailModal === "function")
      window.closeDetailModal();
    if (typeof window.closePublicProfile === "function")
      window.closePublicProfile();
    window.navigateTo("profile");
    return;
  }
  window.openPublicProfile(userId);
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
window.openDetail = async function (postId, fromBack = false) {
  const modal = document.getElementById("detail-modal");
  const content = document.getElementById("detail-content");
  if (!modal || !content) return;

  const wasOpen = !modal.classList.contains("hidden");

  if (!fromBack) {
    if (
      wasOpen &&
      _currentDetailPostId &&
      idKey(_currentDetailPostId) !== idKey(postId)
    ) {
      // Drilling into a related post from inside an already-open
      // modal — remember where we came from so Back retraces the
      // trail instead of closing the whole modal.
      _detailPostStack.push(_currentDetailPostId);
      pushUiState("detail-modal", () => window._goBackInDetailModal());
    } else if (!wasOpen) {
      _detailPostStack = [];
      pushUiState("detail-modal", () => window.closeDetailModal(true));
    }
  }
  _currentDetailPostId = postId;

  modal.classList.remove("hidden");
  // Fix: nothing previously stopped the page underneath from also
  // scrolling while the detail modal was open — on mobile, touch-
  // scrolling inside the modal could bleed through to the feed behind
  // it (rubber-banding), visibly showing the background feed sliding
  // underneath instead of the modal fully occupying the screen.
  document.body.style.overflow = "hidden";
  // Fix: this used to unconditionally push ANOTHER 'detail-modal' history
  // entry here, on top of whatever the if/else block above already
  // pushed. When drilling into a "you might also like" post, that block
  // correctly pushes a _goBackInDetailModal handler — but this second,
  // redundant push then landed on top of it with a plain closeDetailModal
  // handler instead. Since Back pops the LAST entry, pressing Back always
  // closed the whole modal instead of stepping back through the trail.
  // The if/else block above already pushes exactly the right handler for
  // every case (drill-in vs fresh open vs fromBack), so nothing further
  // needs to happen here.
  content.innerHTML = `<div class="p-20 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Syncing Details...</div>`;

  try {
    const { data: d, error } = await supabase
      .from("posts")
      .select(FEED_SELECT_COLUMNS)
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

    // Tags the modal with the post's own type (product/skill/etc) so
    // desktop CSS can give Products its own layout — same width as
    // the default side-by-side view, but with details stacked below
    // the media instead of beside it (see #detail-modal.is-product-detail
    // in main.css).
    modal.classList.remove("is-product-detail");
    if (d.type === "product") modal.classList.add("is-product-detail");

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
            ? `<video class="carousel-slide w-full h-[420px] object-contain bg-black shrink-0 snap-start" ${i === 0 ? "autoplay" : ""} controls src="${esc(url)}"></video>`
            : `<img class="carousel-slide w-full h-[420px] object-contain bg-black shrink-0 snap-start" src="${esc(url)}" alt="Image ${i + 1}">`,
        )
        .join("");
      mediaBlock = `
                <div class="relative w-full">
                    <div id="detail-carousel" class="flex overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar h-[420px]" style="scroll-snap-type:x mandatory;">
                        ${slides}
                    </div>
                    <div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                        ${mediaUrls.map((_, i) => `<div class="carousel-dot w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-amber-400" : "bg-white/40"}"></div>`).join("")}
                    </div>
                </div>`;
    } else if (mediaUrls.length === 1) {
      mediaBlock =
        d.media_type === "video"
          ? `<video class="w-full max-h-[600px] object-contain bg-black" controls autoplay src="${esc(mediaUrls[0])}"></video>`
          : `<img class="w-full object-contain bg-black" src="${esc(mediaUrls[0])}" alt="Post Media">`;
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

    const isAddedToCart = userCartList.some(
      (item) => idKey(item.id) === idKey(d.id),
    );
    const cartText = isAddedToCart ? "✓ In Cart" : "Add to Cart";
    const cartColorClass = isAddedToCart
      ? "bg-slate-800 border border-slate-700 text-slate-400"
      : "bg-slate-900 border border-slate-700 text-white hover:border-amber-400";

    const ctaLabel = d.type === "skill" ? "Contact" : "Contact Seller";
    const safeSwapBlock = renderSafeSwapZoneCard(d);
    const isSoldDetail = !!d.sold_at;
    const saleActiveDetail =
      d.sale_ends_at && new Date(d.sale_ends_at).getTime() > Date.now();
    // Fix: this used to ignore saleActiveDetail entirely, so the
    // crossed-out original price kept showing forever after a flash
    // sale's countdown ran out — only the countdown badge itself ever
    // disappeared. Requiring saleActiveDetail here means the price
    // reverts to a plain listing price the moment the sale ends,
    // matching what already happens to the countdown badge.
    const hasDiscountDetail =
      saleActiveDetail &&
      d.original_price != null &&
      Number(d.original_price) > 0 &&
      Number(d.original_price) !== Number(d.price || 0);
    const detailActionsBlock = isSoldDetail
      ? `<p class="text-center text-slate-500 text-xs uppercase tracking-widest py-2">This listing is no longer available</p>`
      : isOwn
        ? `<button disabled class="w-full bg-slate-900 border border-slate-800 text-slate-500 font-black py-4 rounded-2xl uppercase tracking-wider text-xs cursor-not-allowed mt-1">Your Listing</button>`
        : `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                    <button
                        id="detail-cart-btn-${escAttr(d.id)}"
                        onclick="window.toggleCartItem('${escAttr(d.id)}')"
                        class="w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs ${cartColorClass}">
                        <i class="fas fa-shopping-basket mr-1.5 text-[11px]"></i><span class="cart-btn-label">${cartText}</span>
                    </button>
                    <button onclick="contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}', '${escAttr(d.id)}')" class="w-full bg-amber-400 text-black font-black py-4 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                        ${esc(ctaLabel)}
                    </button>
                </div>`;

    const isLikedDetail = likedPostIds.has(idKey(d.id));
    const heartClassDetail = isLikedDetail
      ? "fas fa-heart text-rose-500"
      : "far fa-heart text-slate-300";
    const displayLikesDetail = parseInt(d.likes_count || 0);
    const displayCommentsDetail =
      commentCountCache[d.id] ?? parseInt(d.comments_count || 0);

    registerPostContext(d.id, d, mediaUrls[0] || "");

    content.innerHTML = `
            <div class="w-full bg-slate-950 relative">${mediaBlock}</div>
            <div class="p-6 space-y-4 bg-[#0f172a] rounded-t-3xl relative shadow-[0_-12px_24px_-8px_rgba(0,0,0,0.5)]">
                <div class="w-10 h-1 rounded-full bg-slate-700/60 mx-auto -mt-1 mb-1"></div>
                <div class="flex items-start justify-between gap-4 -mt-1">
                    <div class="flex items-baseline gap-2 flex-wrap">
                        ${isSoldDetail ? `<span class="bg-slate-800 text-slate-400 text-[10px] font-black uppercase tracking-[0.2em] px-2.5 py-1 rounded-full border border-slate-700">Sold</span>` : ""}
                        <span class="text-amber-400 font-black text-3xl leading-none">GH₵${esc(String(d.price || 0))}</span>
                        ${hasDiscountDetail ? `<span class="sale-strike-price text-slate-500 text-base line-through" data-sale-ends="${escAttr(d.sale_ends_at)}">GH₵${esc(String(d.original_price))}</span>` : ""}
                        ${!isSoldDetail && saleActiveDetail ? `<span class="sale-countdown-badge bg-rose-500/90 text-white text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full" data-sale-ends="${escAttr(d.sale_ends_at)}">${esc(countdownText(d.sale_ends_at))}</span>` : ""}
                    </div>
                    <button onclick="window.openPostOptionsMenu('${escAttr(d.id)}', ${isOwn ? "true" : "false"}, '${escAttr(d.user_id)}', '${escAttr(d.user_name)}')" class="text-slate-400 hover:text-white transition px-1 shrink-0">
                        <i class="fas fa-ellipsis-vertical text-xl"></i>
                    </button>
                </div>
                <h1 class="text-lg font-bold text-white leading-snug">${esc(d.title) || "Campus Item"}</h1>
                <div class="flex items-center gap-4 pt-1 pb-1 border-y border-slate-800/60">
                    <button onclick="likePost('${escAttr(d.id)}', this)" data-liked="${isLikedDetail ? "true" : "false"}" class="flex items-center gap-1.5 active:scale-90 transition ${isLikedDetail ? "text-rose-500" : "text-slate-300"}">
                        <i class="${heartClassDetail} text-2xl"></i>
                        <span class="like-count text-sm font-semibold text-slate-300">${displayLikesDetail}</span>
                    </button>
                    <button onclick="toggleComments('${escAttr(d.id)}')" class="flex items-center gap-1.5 text-slate-300 hover:text-amber-400 transition active:scale-90">
                        <i class="far fa-comment text-2xl"></i>
                        <span class="comment-count-${escAttr(d.id)} text-sm font-semibold text-slate-300">${displayCommentsDetail}</span>
                    </button>
                    <button onclick="sharePost('${escAttr(d.id)}', '${escAttr(d.title)}')" class="text-slate-300 hover:text-green-400 transition active:scale-90">
                        <i class="far fa-paper-plane text-2xl"></i>
                    </button>
                </div>
                <div class="flex flex-wrap gap-2 text-[10px] uppercase font-bold tracking-wider">
                    <span class="bg-slate-800 text-amber-400 px-2 py-1 rounded border border-slate-700">${esc(d.institution) || "All Campuses"}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700">${esc(d.region) || "All Regions"}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700 capitalize">${esc(d.type) || "product"}</span>
                </div>
                <div class="flex items-center justify-between gap-3 p-3 bg-slate-900 rounded-xl border border-slate-800">
                    <button type="button" onclick="event.stopPropagation(); window.openUserDashboard('${escAttr(d.user_id)}')" class="feed-profile-trigger flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer active:scale-[0.99] transition" data-user-id="${escAttr(d.user_id)}">
                        <img src="${esc(d.user_avatar) || "https://ui-avatars.com/api/?name=User"}" data-avatar-for="${escAttr(d.user_id)}" class="w-10 h-10 rounded-full border border-amber-400 object-cover" alt="Avatar">
                        <div class="min-w-0 flex-1">
                            <p class="text-xs text-slate-500 uppercase">Provider</p>
                            <p class="text-sm font-bold truncate">${esc(d.user_name) || "Anonymous Student"}</p>
                            <div id="seller-rating-${escAttr(d.user_id)}" class="mt-0.5"><span class="text-[11px] text-slate-600">Loading rating...</span></div>
                        </div>
                        <span class="text-[10px] uppercase tracking-[0.18em] text-amber-400 font-black shrink-0">Dashboard</span>
                    </button>
                    <div class="flex flex-col items-end gap-1.5 shrink-0">
                        ${followBlock}
                        ${!isOwn && viewer ? `<button onclick="window.openRateSellerSheet('${escAttr(d.user_id)}', '${escAttr(d.user_name)}')" class="text-[10px] text-amber-400 hover:text-amber-300 transition uppercase tracking-widest font-bold">Rate seller</button>` : ""}
                    </div>
                </div>
                <p class="text-slate-400 leading-relaxed font-light">${esc(d.description) || "No description provided."}</p>
                ${detailActionsBlock}
                <div id="comment-preview-${escAttr(d.id)}" class="space-y-2">
                    <p class="text-[10px] text-slate-600 animate-pulse">Loading comments...</p>
                </div>
                ${safeSwapBlock}
                ${renderSimilarListingsBlock(d)}
            </div>
            <div id="comments-${escAttr(d.id)}" class="hidden reel-comments">
                <div class="comments-header">
                    <div class="comments-drag-handle"></div>
                    <p class="text-white text-xs font-black uppercase tracking-wider">
                        <span class="comment-count-${escAttr(d.id)}">${displayCommentsDetail}</span> Comments
                    </p>
                    <button class="comments-close-btn" onclick="window._closeCommentSheet('${escAttr(d.id)}')"><i class="fas fa-times text-xs"></i></button>
                </div>
                <div id="comment-list-${escAttr(d.id)}" class="comments-scroll-area"></div>
                <div class="comments-input-row flex items-center gap-1.5">
                    <input
                        type="text"
                        inputmode="text"
                        maxlength="500"
                        placeholder="Add a comment…"
                        class="comment-input-field flex-1 bg-white/10 border border-white/20 text-white text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-amber-400 transition"
                        oninput="window._syncCommentSendState('${escAttr(d.id)}', this)"
                        onkeydown="if(event.key==='Enter') window.submitCommentFromInput('${escAttr(d.id)}', this)"
                    >
                    <button id="cancel-reply-${escAttr(d.id)}" onclick="window.cancelCommentReply('${escAttr(d.id)}')" class="hidden text-[10px] text-white/60 hover:text-white px-1">✕</button>
                    <button
                        id="comment-send-${escAttr(d.id)}"
                        disabled
                        onclick="window._submitFromSendBtn('${escAttr(d.id)}')"
                        class="comment-send-btn shrink-0 w-8 h-8 rounded-xl bg-amber-400 text-black flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
                        aria-label="Send comment"
                    >
                        <i class="fas fa-paper-plane text-[11px]"></i>
                    </button>
                </div>
            </div>`;

    loadAndRenderSellerRating(d.user_id, `seller-rating-${idKey(d.user_id)}`);
    loadCommentPreview(idKey(d.id));

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
  document.body.style.overflow = "";
  _detailPostStack = [];
  _currentDetailPostId = null;
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

// Handles the browser/gesture Back action while inside a "You might also
// like" trail: steps back to the post you drilled in FROM. openDetail is
// called with fromBack=true so it just reloads that post's content
// without pushing yet another history entry. Once the trail is empty,
// Back behaves exactly like closing the modal normally.
window._goBackInDetailModal = function () {
  const prevId = _detailPostStack.pop();
  if (prevId) {
    window.openDetail(prevId, true);
  } else {
    window.closeDetailModal(true);
  }
};

// ─── 9b. MANAGE LISTING (mark sold / discount price / flash sale) ───────────
// Deliberately narrow in scope rather than a full post editor (no title,
// description, or image editing here) — see conversation: the ask was
// specifically for sold-status and sale-pricing controls on an existing
// listing, not general editing.
window.openManageListingSheet = async function (postId) {
  if (!currentUserData) return;

  const modal = document.getElementById("manage-listing-modal");
  const content = document.getElementById("manage-listing-content");
  if (!modal || !content) return;

  content.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm"><i class="fas fa-circle-notch fa-spin"></i></div>`;
  modal.classList.remove("hidden");
  pushUiState("manage-listing-modal", () =>
    window.closeManageListingSheet(true),
  );

  const { data: post, error } = await supabase
    .from("posts")
    .select("id, title, price, original_price, sold_at, sale_ends_at, user_id")
    .eq("id", postId)
    .single();

  if (error || !post || post.user_id !== currentUserData.id) {
    content.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm">Couldn't load this listing.</div>`;
    return;
  }

  const isSold = !!post.sold_at;
  // datetime-local inputs need "YYYY-MM-DDTHH:mm" with no timezone
  // suffix — slicing an ISO string to 16 chars gives exactly that.
  const saleEndsValue = post.sale_ends_at
    ? new Date(post.sale_ends_at).toISOString().slice(0, 16)
    : "";

  content.innerHTML = `
        <div class="p-6 space-y-5">
            <h2 class="text-lg font-bold text-white">Manage Listing</h2>
            <p class="text-xs text-slate-500 -mt-3">${esc(post.title)}</p>

            <div>
                <label for="managePrice" class="block text-[10px] uppercase font-bold text-slate-500 mb-1 tracking-widest">Listing price (GH₵)</label>
                <p class="text-[10px] text-slate-500 mb-1.5">Change your listing price without re-uploading. Saving marks the post as new in the feed.</p>
                <input type="number" id="managePrice" min="0" max="1000000" step="0.01" value="${post.price ?? 0}" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-amber-400 transition text-sm">
            </div>

            <label class="flex items-center justify-between p-3 bg-slate-900 rounded-xl border border-slate-800 cursor-pointer">
                <span class="text-sm font-semibold text-white">Mark as Sold</span>
                <input type="checkbox" id="manageSoldToggle" ${isSold ? "checked" : ""} class="w-5 h-5 accent-amber-400">
            </label>
            <p class="text-[10px] text-slate-500 -mt-3">Sold listings are hidden from browsing and automatically removed after 48 hours.</p>

            <div>
                <label class="block text-[10px] uppercase font-bold text-slate-500 mb-1 tracking-widest">Discount price (optional, any amount)</label>
                <p class="text-[10px] text-slate-500 mb-1.5">Set any ORIGINAL price (typically higher) — your listing shows a strikethrough on the old price next to the deal.</p>
                <input type="number" id="manageOriginalPrice" min="0" max="1000000" step="0.01" value="${post.original_price ?? ""}" placeholder="e.g. ${(Number(post.price || 0) * 1.2).toFixed(2)}" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-amber-400 transition text-sm">
            </div>

            <div>
                <label class="block text-[10px] uppercase font-bold text-slate-500 mb-1 tracking-widest">Flash sale ends (optional)</label>
                <input type="datetime-local" id="manageSaleEndsAt" value="${saleEndsValue}" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-amber-400 transition text-sm">
            </div>

            <button onclick="window._saveManageListing('${escAttr(postId)}')" class="w-full bg-amber-400 text-black font-black py-3 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                Save Changes
            </button>
        </div>`;
};

window.closeManageListingSheet = function (fromPop = false) {
  document.getElementById("manage-listing-modal")?.classList.add("hidden");
  if (!fromPop) popUiState("manage-listing-modal");
};

window._saveManageListing = async function (postId) {
  const soldToggle = document.getElementById("manageSoldToggle");
  const priceInput = document.getElementById("managePrice");
  const originalPriceInput = document.getElementById("manageOriginalPrice");
  const saleEndsInput = document.getElementById("manageSaleEndsAt");
  if (
    !soldToggle ||
    !priceInput ||
    !originalPriceInput ||
    !saleEndsInput ||
    !currentUserData
  )
    return;

  const newPriceRaw = priceInput.value.trim();
  const parsedPrice = newPriceRaw !== "" ? parseFloat(newPriceRaw) : null;
  if (newPriceRaw !== "" && (isNaN(parsedPrice) || parsedPrice < 0)) {
    showToast("Price can't be negative.");
    return;
  }
  if (parsedPrice !== null && parsedPrice > 1000000) {
    showToast("That price seems too high — please double-check it.");
    return;
  }

  const originalPriceRaw = originalPriceInput.value.trim();
  const parsedOriginalPrice = originalPriceRaw
    ? parseFloat(originalPriceRaw)
    : null;
  if (
    originalPriceRaw &&
    (isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0)
  ) {
    showToast("Discount price can't be negative.");
    return;
  }
  if (parsedOriginalPrice !== null && parsedOriginalPrice > 1000000) {
    showToast("That price seems too high — please double-check it.");
    return;
  }

  const saleEndsRaw = saleEndsInput.value;
  const saleEndsIso = saleEndsRaw ? new Date(saleEndsRaw).toISOString() : null;
  if (saleEndsIso && new Date(saleEndsIso).getTime() <= Date.now()) {
    showToast("Flash sale end time must be in the future.");
    return;
  }

  const updates = {
    sold_at: soldToggle.checked ? new Date().toISOString() : null,
  };
  if (parsedPrice !== null) {
    updates.price = parsedPrice;
  }
  if (originalPriceRaw === "") {
    updates.original_price = null;
  } else if (parsedOriginalPrice !== null) {
    updates.original_price = parsedOriginalPrice;
  }
  if (!saleEndsRaw) {
    updates.sale_ends_at = null;
  } else if (saleEndsIso) {
    updates.sale_ends_at = saleEndsIso;
  }

  const { error } = await supabase
    .from("posts")
    .update(updates)
    .eq("id", postId)
    .eq("user_id", currentUserData.id);

  if (error) {
    console.error("Manage listing save error:", error);
    showToast("Couldn't save changes. Try again.");
    return;
  }

  const cached = allCachedPosts.find(({ id }) => idKey(id) === idKey(postId));
  if (cached?.data)
    Object.assign(cached.data, {
      ...updates,
      created_at: new Date().toISOString(),
    });

  showToast("Listing updated.");
  window.closeManageListingSheet();
  renderFeedFromCache();
};

// ─── 10. LOGIN MODAL ──────────────────────────────────────────────────────────

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
      // Fix: this used to fall back to '' if user_metadata was
      // missing avatar_url, which silently cleared the preview on a
      // failed upload. Always reserve the avatar-letter-placeholder
      // as the ultimate fallback so the preview never goes blank.
      const fallbackAvatar =
        currentUserData.user_metadata?.avatar_url ||
        currentUserData.user_metadata?.avatar ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserData.user_metadata?.full_name || "User")}`;
      previewEl.src = fallbackAvatar;
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
const MAX_VIDEO_SIZE_MB = 30;

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
  const cropOverlayHtml = `
        <div id="cropOverlay">
          <div class="crop-dim"></div>
          <div class="crop-box" id="cropBox">
            <div class="crop-handle nw" data-handle="nw"></div>
            <div class="crop-handle ne" data-handle="ne"></div>
            <div class="crop-handle sw" data-handle="sw"></div>
            <div class="crop-handle se" data-handle="se"></div>
          </div>
        </div>`;
  mainPreview.innerHTML =
    active.type === "video"
      ? `<video src="${active.url}" style="${rotationStyle}" controls muted></video>
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>`
      : `<img id="editPreviewImg" src="${active.url}" style="${rotationStyle}" alt="Preview">
           <button class="crop-btn" onclick="window._toggleCropMode()" aria-label="Crop"><i class="fas fa-crop-simple text-sm"></i></button>
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>
           ${cropOverlayHtml}`;

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
  // renderEditMediaModal() rebuilds the preview (including cropOverlay)
  // from scratch, which naturally drops crop mode for the OLD image —
  // but the footer buttons live outside that rebuilt subtree, so their
  // crop-mode classes need to be reset explicitly here too.
  window._cancelCrop();
  renderEditMediaModal();
};

window._rotateStagedMedia = function () {
  if (!stagedMediaFiles[activeStagedIndex]) return;
  stagedMediaFiles[activeStagedIndex].rotation =
    (stagedMediaFiles[activeStagedIndex].rotation + 90) % 360;
  // Rotating invalidates any crop the person already drew, since the
  // rect was drawn against the old orientation — simplest and least
  // surprising is to just clear it rather than try to remap coordinates
  // through a rotation.
  delete stagedMediaFiles[activeStagedIndex].cropRect;
  renderEditMediaModal();
};

// ─── CROP ───────────────────────────────────────────────────────────────────
// A lightweight, dependency-free crop tool: drag inside the box to move
// it, drag a corner handle to resize it. The crop rect is stored as
// fractions of the image's natural (rotated) dimensions (0–1 for
// x/y/width/height), not pixels — that way it's completely independent
// of whatever size the preview happens to be rendered at on screen, and
// maps directly onto the full-resolution source image when actually
// applying the crop in confirmEditedMedia.
let _cropDragState = null; // { mode: 'move'|'resize', handle, startX, startY, startRect }

window._toggleCropMode = function () {
  const item = stagedMediaFiles[activeStagedIndex];
  if (!item || item.type !== "image") return;

  const overlay = document.getElementById("cropOverlay");
  const footer = document.getElementById("editMainFooter");
  const cropFooter = document.getElementById("cropFooter");
  if (!overlay) return;

  const enteringCropMode = !overlay.classList.contains("crop-active");
  overlay.classList.toggle("crop-active", enteringCropMode);
  footer?.classList.toggle("crop-active-hide", enteringCropMode);
  cropFooter?.classList.toggle("crop-active", enteringCropMode);

  if (enteringCropMode) {
    // Start from whatever crop was previously set for this image, or
    // default to a centered 80% box so there's immediately something
    // visible and adjustable rather than a jarring full-bleed box.
    const rect = item.cropRect || { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    _setCropBoxRect(rect);
    _wireCropHandlers();
  }
};

window._cancelCrop = function () {
  document.getElementById("cropOverlay")?.classList.remove("crop-active");
  document
    .getElementById("editMainFooter")
    ?.classList.remove("crop-active-hide");
  document.getElementById("cropFooter")?.classList.remove("crop-active");
};

window._applyCrop = function () {
  const item = stagedMediaFiles[activeStagedIndex];
  const box = document.getElementById("cropBox");
  const overlay = document.getElementById("cropOverlay");
  if (item && box && overlay) {
    const rect = _readCropBoxRect(box, overlay);
    // Ignore a crop that's barely different from "no crop" (e.g. a
    // tiny accidental drag) so we don't force a needless re-encode.
    const isNoOp =
      rect.x < 0.01 && rect.y < 0.01 && rect.width > 0.98 && rect.height > 0.98;
    item.cropRect = isNoOp ? null : rect;
  }
  window._cancelCrop();
  renderEditMediaModal();
};

// Fix: #editMainPreview is a fixed 1:1 square with object-fit: contain,
// so any non-square photo is letterboxed inside it — the actual pixels
// only occupy part of that square, with black bars filling the rest.
// The crop overlay spans the FULL square container, so without this
// correction, a percentage-based crop rect computed against the overlay
// would be calibrated against empty letterbox space for part of its
// range, producing a crop that's shifted/wrong-sized relative to what
// the person visually saw and dragged over. This computes the real
// visible image rect (in the same coordinate space as the overlay) so
// both reading and writing the crop box can be anchored to actual image
// pixels, not the surrounding square.
function _getRenderedImageRect(overlay) {
  const img = overlay.parentElement?.querySelector("img");
  const overlayRect = overlay.getBoundingClientRect();
  if (!img || !img.naturalWidth || !img.naturalHeight) {
    // No image to measure against (shouldn't normally happen since
    // crop mode only opens for images) — fall back to treating the
    // whole overlay as the image area rather than crashing.
    return {
      left: overlayRect.left,
      top: overlayRect.top,
      width: overlayRect.width,
      height: overlayRect.height,
    };
  }

  const containerRatio = overlayRect.width / overlayRect.height;
  const imageRatio = img.naturalWidth / img.naturalHeight;

  let renderedWidth, renderedHeight;
  if (imageRatio > containerRatio) {
    // Image is wider than the container: full width, letterboxed
    // top/bottom.
    renderedWidth = overlayRect.width;
    renderedHeight = overlayRect.width / imageRatio;
  } else {
    // Image is taller than (or equal to) the container: full height,
    // letterboxed left/right.
    renderedHeight = overlayRect.height;
    renderedWidth = overlayRect.height * imageRatio;
  }

  return {
    left: overlayRect.left + (overlayRect.width - renderedWidth) / 2,
    top: overlayRect.top + (overlayRect.height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  };
}

function _setCropBoxRect(rect) {
  const box = document.getElementById("cropBox");
  const overlay = document.getElementById("cropOverlay");
  if (!box || !overlay) return;

  // Convert the image-relative fraction back into overlay-relative
  // percentages, since that's the coordinate space box.style.left/top
  // actually operates in (it's a child of the overlay, not the image).
  const overlayRect = overlay.getBoundingClientRect();
  const imgRect = _getRenderedImageRect(overlay);

  const leftPx = imgRect.left - overlayRect.left + rect.x * imgRect.width;
  const topPx = imgRect.top - overlayRect.top + rect.y * imgRect.height;
  const widthPx = rect.width * imgRect.width;
  const heightPx = rect.height * imgRect.height;

  box.style.left = `${(leftPx / overlayRect.width) * 100}%`;
  box.style.top = `${(topPx / overlayRect.height) * 100}%`;
  box.style.width = `${(widthPx / overlayRect.width) * 100}%`;
  box.style.height = `${(heightPx / overlayRect.height) * 100}%`;
}

function _readCropBoxRect(box, overlay) {
  const boxRect = box.getBoundingClientRect();
  const imgRect = _getRenderedImageRect(overlay);

  // Express the box's position/size as fractions of the ACTUAL visible
  // image area, not the surrounding square — this is what
  // cropImageFile's rect.x/y/width/height are documented to mean (see
  // its own comment), and now they actually are.
  return {
    x: (boxRect.left - imgRect.left) / imgRect.width,
    y: (boxRect.top - imgRect.top) / imgRect.height,
    width: boxRect.width / imgRect.width,
    height: boxRect.height / imgRect.height,
  };
}

const CROP_MIN_SIZE_FRACTION = 0.12; // don't allow shrinking below 12% of the image in either axis

function _wireCropHandlers() {
  const overlay = document.getElementById("cropOverlay");
  const box = document.getElementById("cropBox");
  if (!overlay || !box) return;

  // Re-query handles fresh each time since renderEditMediaModal rebuilds
  // this DOM subtree from scratch on every render.
  const handles = box.querySelectorAll(".crop-handle");

  const onPointerDown = (e, mode, handle = null) => {
    e.preventDefault();
    e.stopPropagation();
    const imgRect = _getRenderedImageRect(overlay);
    _cropDragState = {
      mode,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      // Deltas need to be expressed as fractions of the actual
      // visible image, matching the coordinate space startRect is
      // already in (see _readCropBoxRect) — using the full,
      // possibly-letterboxed overlay dimensions here instead would
      // make the box drift out of sync with the cursor on any
      // non-square photo.
      imageWidth: imgRect.width,
      imageHeight: imgRect.height,
      startRect: _readCropBoxRect(box, overlay),
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const onPointerMove = (e) => {
    if (!_cropDragState) return;
    const dxFrac =
      (e.clientX - _cropDragState.startClientX) / _cropDragState.imageWidth;
    const dyFrac =
      (e.clientY - _cropDragState.startClientY) / _cropDragState.imageHeight;
    const { startRect, mode, handle } = _cropDragState;

    if (mode === "move") {
      const newX = _clamp(startRect.x + dxFrac, 0, 1 - startRect.width);
      const newY = _clamp(startRect.y + dyFrac, 0, 1 - startRect.height);
      _setCropBoxRect({ ...startRect, x: newX, y: newY });
      return;
    }

    // Resize: each corner drags its own two edges, clamped so the box
    // never shrinks below the minimum or crosses outside the image.
    let { x, y, width, height } = startRect;
    if (handle === "se") {
      width = _clamp(
        startRect.width + dxFrac,
        CROP_MIN_SIZE_FRACTION,
        1 - startRect.x,
      );
      height = _clamp(
        startRect.height + dyFrac,
        CROP_MIN_SIZE_FRACTION,
        1 - startRect.y,
      );
    } else if (handle === "sw") {
      const newWidth = _clamp(
        startRect.width - dxFrac,
        CROP_MIN_SIZE_FRACTION,
        startRect.x + startRect.width,
      );
      x = startRect.x + startRect.width - newWidth;
      width = newWidth;
      height = _clamp(
        startRect.height + dyFrac,
        CROP_MIN_SIZE_FRACTION,
        1 - startRect.y,
      );
    } else if (handle === "ne") {
      width = _clamp(
        startRect.width + dxFrac,
        CROP_MIN_SIZE_FRACTION,
        1 - startRect.x,
      );
      const newHeight = _clamp(
        startRect.height - dyFrac,
        CROP_MIN_SIZE_FRACTION,
        startRect.y + startRect.height,
      );
      y = startRect.y + startRect.height - newHeight;
      height = newHeight;
    } else if (handle === "nw") {
      const newWidth = _clamp(
        startRect.width - dxFrac,
        CROP_MIN_SIZE_FRACTION,
        startRect.x + startRect.width,
      );
      const newHeight = _clamp(
        startRect.height - dyFrac,
        CROP_MIN_SIZE_FRACTION,
        startRect.y + startRect.height,
      );
      x = startRect.x + startRect.width - newWidth;
      y = startRect.y + startRect.height - newHeight;
      width = newWidth;
      height = newHeight;
    }
    _setCropBoxRect({ x, y, width, height });
  };

  const onPointerUp = () => {
    _cropDragState = null;
    window.removeEventListener("pointermove", onPointerMove);
  };

  box.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".crop-handle")) return; // handles have their own listener below
    onPointerDown(e, "move");
  });

  handles.forEach((h) => {
    h.addEventListener("pointerdown", (e) =>
      onPointerDown(e, "resize", h.dataset.handle),
    );
  });
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

window._removeStagedMedia = function (i) {
  const removed = stagedMediaFiles.splice(i, 1)[0];
  if (removed) {
    try {
      URL.revokeObjectURL(removed.url);
    } catch (_) {}
  }
  if (activeStagedIndex >= stagedMediaFiles.length)
    activeStagedIndex = Math.max(0, stagedMediaFiles.length - 1);
  window._cancelCrop();
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
        // Crop is applied after rotation (the stored cropRect is
        // relative to the rotated image, matching what the person
        // actually saw and dragged the box over) and before
        // compression, so the final encode only has to happen
        // once on the already-cropped pixels rather than cropping
        // a full-size image and re-encoding twice.
        if (item.cropRect) {
          workingFile = await cropImageFile(workingFile, item.cropRect);
        }
        const compressedFile = await compressImageFile(
          workingFile,
          compressionOptions,
        );
        processed.push(compressedFile);
      } catch (e) {
        console.warn("Rotate/crop/compress failed, using original file:", e);
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

// Crops an image to the given rect, where rect.x/y/width/height are all
// fractions (0–1) of the image's own natural dimensions — the same
// resolution-independent format the crop UI in _readCropBoxRect stores,
// so this works correctly regardless of what size the crop box preview
// was actually displayed at on screen.
function cropImageFile(file, rect) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      const sx = rect.x * img.width;
      const sy = rect.y * img.height;
      const sw = rect.width * img.width;
      const sh = rect.height * img.height;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
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

  // Normalize once: postId arrives as a string (it's read out of an HTML
  // attribute), but everywhere else in the app (allCachedPosts, the RPC
  // calls, etc.) may hold it as the raw bigint number from the DB. Doing
  // every lookup/comparison through the same string key keeps this
  // function's behavior consistent regardless of which type shows up.
  const key = idKey(postId);
  if (likeInFlight.has(key)) return;
  likeInFlight.add(key);

  const liked = likedPostIds.has(key);
  const countEl = btn.querySelector(".like-count");
  const icon = btn.querySelector("i");
  let currentCount = parseInt(countEl?.textContent || 0);

  // 1. Optimistic UI update
  if (liked) {
    likedPostIds.delete(key);
    icon.className = "far fa-heart text-slate-300";
    btn.classList.remove("text-rose-500");
    currentCount = Math.max(0, currentCount - 1);
  } else {
    likedPostIds.add(key);
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
  // etc.) before the next DB refresh doesn't show a stale count. Compare
  // via idKey too, since allCachedPosts ids come straight from Supabase
  // (numbers for a bigint column) while postId here is a string.
  const cachedEntry = allCachedPosts.find((p) => idKey(p.id) === key);
  if (cachedEntry?.data) cachedEntry.data.likes_count = currentCount;

  // 2. Execute Backend sync — this is what makes likes survive reload.
  //
  // Fix: this used to also call increment_post_likes/decrement_post_likes
  // RPCs after the insert/delete succeeded, to keep posts.likes_count
  // up to date. That's now redundant and was actually a source of
  // unnecessary fragility: the likes_count_sync trigger (added
  // separately, directly on the likes table) already recalculates
  // posts.likes_count from a real COUNT(*) on every insert/delete,
  // automatically, with no RPC involved — so the count was already
  // being kept correct by the time this RPC call ran. Keeping the RPC
  // around meant a single network hiccup or naming mismatch on THAT
  // call alone could throw and roll back an otherwise fully successful
  // like/unlike action, even though the actual likes row (and the
  // trigger-maintained count) were already correct. Removing it
  // matches the simpler, standard pattern most apps use: write the
  // row, let the database keep the derived count in sync — nothing
  // else needed.
  //
  // Also fixed previously: an insert/delete failure into the `likes`
  // table used to be swallowed silently (error checked but never
  // surfaced or acted on), so the heart stayed optimistically "liked"
  // in the UI while nothing was actually saved server-side. Any real
  // failure now rolls the UI back to its prior state and tells the
  // person, instead of drifting out of sync with the database until
  // the next reload silently corrects it.
  try {
    if (liked) {
      const { error: deleteErr } = await supabase
        .from("likes")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", currentUserData.id);

      if (deleteErr) throw deleteErr;
    } else {
      const { error: insertErr } = await supabase.from("likes").insert({
        post_id: postId,
        user_id: currentUserData.id,
      });

      // A 23505 conflict is only harmless if the exact same
      // (user_id, post_id) like row already exists. If the likes
      // table was accidentally given a wrong unique constraint
      // (for example UNIQUE(user_id) instead of UNIQUE(user_id,
      // post_id)), then liking a *different* post would also throw
      // 23505 — and treating every duplicate as success would make
      // the UI look liked even though the new row was never saved.
      // So on conflict we verify that THIS specific like row exists;
      // otherwise we surface the error and roll the optimistic UI
      // back.
      const isDuplicate = insertErr && insertErr.code === "23505";
      if (insertErr) {
        if (!isDuplicate) throw insertErr;

        const { data: existingLike, error: verifyErr } = await supabase
          .from("likes")
          .select("post_id")
          .eq("user_id", currentUserData.id)
          .eq("post_id", postId)
          .maybeSingle();

        if (verifyErr || !existingLike) throw insertErr;
      }
    }
  } catch (e) {
    console.error("Like sync failed — reverting UI to match database:", e);

    // Roll back the optimistic UI exactly, since the write did not
    // actually persist.
    if (liked) {
      likedPostIds.add(key);
      icon.className = "fas fa-heart text-rose-500";
      btn.classList.add("text-rose-500");
      currentCount = currentCount + 1;
    } else {
      likedPostIds.delete(key);
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
    likeInFlight.delete(key);
  }
};

window.sharePost = function (postId, title) {
  const text = `Check out "${title}" on CampusMarket!`;
  if (navigator.share) {
    // Fix: navigator.share used to silently swallow every error path
    // (rejected promise, user dismissal, browser quota, etc.) so the
    // tap had no feedback at all on failure. We now distinguish
    // "user cancelled" (AbortError — silent, intentional) from a real
    // error (log + clipboard fallback toast) so the share UX is never
    // a no-op again.
    const fallbackCopy = () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(`${text} ${window.location.href}`)
          .then(() => showToast("Share failed — link copied instead."))
          .catch(() => showToast("Couldn't share or copy the link."));
      } else {
        showToast("Couldn't share the link.");
      }
    };
    navigator.share({ title, text, url: window.location.href }).then(
      () => showToast("Shared! ✓"),
      (err) => {
        if (err?.name === "AbortError") return; // user-initiated cancel
        console.warn("navigator.share failed:", err);
        fallbackCopy();
      },
    );
  } else {
    navigator.clipboard?.writeText(`${text} ${window.location.href}`);
    showToast("Link copied to clipboard!");
  }
};

// Copies a real, working link to this specific post (?post=ID) — unlike
// sharePost's fallback (which just copies window.location.href, the
// generic app URL), this actually resolves to the post when opened, since
// the app checks for ?post=ID on boot and opens that detail view.
window.copyPostLink = function (postId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("post", postId);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(url.toString())
      .then(() => showToast("Link copied! ✓"))
      .catch(() => showToast("Couldn't copy the link."));
  } else {
    showToast("Couldn't copy the link.");
  }
};

// downloadMedia was removed entirely — post media (photos/videos) is no
// longer downloadable from anywhere in the app. This is separate from the
// avatar long-press "Save" button, which only ever lets someone save
// their OWN profile picture and is unaffected by this change.

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
  window._syncCommentSendState(postId, inputEl);

  // Fix: posting used to clear the input and then just wait silently for
  // the realtime echo to repaint the list — on any network lag it looked
  // like the tap did nothing. This appends an immediate "sending…"
  // placeholder bubble so the comment appears the instant it's sent; the
  // next realtime-triggered fetchAndRender() (see toggleComments) does a
  // full re-render from the DB and naturally replaces this placeholder
  // with the real row, so there's no separate cleanup or dedupe needed.
  const list = document.getElementById(`comment-list-${postId}`);
  const emptyState = list
    ?.querySelector(".far.fa-comment-dots")
    ?.closest("div");
  if (emptyState) emptyState.remove();
  if (list) {
    const metadata = currentUserData.user_metadata || {};
    list.insertAdjacentHTML(
      "beforeend",
      renderCommentItem(
        {
          id: `pending-${now}`,
          user_id: currentUserData.id,
          user_name: metadata.full_name || "Anonymous Student",
          user_avatar: metadata.avatar_url || "",
          text,
          parent_comment_id: parentCommentId,
          created_at: new Date().toISOString(),
          likes_count: 0,
        },
        postId,
      ),
    );
    const pendingEl = document.getElementById(`comment-item-pending-${now}`);
    if (pendingEl) {
      pendingEl.style.opacity = "0.55";
      pendingEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    }
    list.scrollTop = list.scrollHeight;
  }

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
    const { error } = await supabase.from("comments").insert(insertPayload);
    if (error) throw error;
  } catch (err) {
    console.error("Comment submission error:", err);
    // RLS policies added for blocking (see blocked_users_rls.sql) reject
    // the insert outright if either person has blocked the other —
    // this is the only way to know that happened when it's the OTHER
    // person who blocked you, since your local blockedUserIds set has
    // no way of knowing about a block made from their side.
    const isBlockRejection =
      err?.code === "42501" || /row-level security/i.test(err?.message || "");
    showToast(
      isBlockRejection
        ? "This comment couldn't be posted."
        : "Couldn't post your comment — please try again.",
    );
    document.getElementById(`comment-item-pending-${now}`)?.remove();
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

// Enables/disables the paper-plane send button based on whether there's
// actual (trimmed) text to send — mirrors the disabled feel of iMessage/
// WhatsApp send buttons rather than always looking tappable.
window._syncCommentSendState = function (postId, inputEl) {
  const sendBtn = document.getElementById(`comment-send-${postId}`);
  if (sendBtn) sendBtn.disabled = inputEl.value.trim().length === 0;
};

// The Send button doesn't have a direct reference to its input the way
// the onkeydown handler does, so it looks the input up by shared
// container instead of relying on DOM sibling order (which would break
// silently if the markup around it ever changes).
window._submitFromSendBtn = function (postId) {
  const input = document.querySelector(
    `#comments-${CSS.escape(postId)} .comment-input-field`,
  );
  if (input) window.submitCommentFromInput(postId, input);
};

// Same string/number id mismatch as posts (comments.id is also a bigint
// primary key) — normalized through idKey for the same reason.
const likedCommentIds = new Set(
  safeStorageJsonParse("campus_market_comment_likes", []).map(idKey),
);

window.likeComment = async function (commentId, btn) {
  if (!currentUserData) {
    showToast("Please sign in to like comments.");
    return;
  }

  const key = idKey(commentId);
  const liked = likedCommentIds.has(key);
  const countEl = btn.querySelector(".comment-like-count");
  const icon = btn.querySelector("i");
  let count = parseInt(countEl?.textContent || 0);

  if (liked) {
    likedCommentIds.delete(key);
    icon.className = "far fa-heart text-slate-400";
    count = Math.max(0, count - 1);
  } else {
    likedCommentIds.add(key);
    icon.className = "fas fa-heart text-rose-500";
    count = count + 1;
  }
  if (countEl) countEl.textContent = count;
  localStorage.setItem(
    "campus_market_comment_likes",
    JSON.stringify([...likedCommentIds]),
  );

  // Fix: this used to swallow every failure into a console.warn with
  // no toast and no UI rollback — meaning if this insert/delete ever
  // failed for any reason (including the exact same kind of orphaned-
  // row duplicate-key conflict that turned out to be the real post-
  // likes bug), nobody would ever see it happen. "Comment likes work
  // well" may partly reflect that failures here were simply invisible
  // rather than genuinely rarer. Real failures now roll back the
  // optimistic UI and show a toast, matching likePost's behavior.
  try {
    if (liked) {
      const { error } = await supabase
        .from("comment_likes")
        .delete()
        .eq("comment_id", commentId)
        .eq("user_id", currentUserData.id);
      if (error) throw error;
      const { error: decErr } = await supabase.rpc("decrement_comment_likes", {
        comment_id_input: commentId,
      });
      if (decErr) throw decErr;
    } else {
      const { error } = await supabase
        .from("comment_likes")
        .insert({ comment_id: commentId, user_id: currentUserData.id });
      const isDuplicate = error && error.code === "23505";
      if (error && !isDuplicate) throw error;
      if (!error) {
        const { error: incErr } = await supabase.rpc(
          "increment_comment_likes",
          { comment_id_input: commentId },
        );
        if (incErr) throw incErr;
      }
    }
  } catch (e) {
    console.error("Comment like sync failed — reverting:", e);
    if (liked) {
      likedCommentIds.add(key);
      icon.className = "fas fa-heart text-rose-500";
      count = count + 1;
    } else {
      likedCommentIds.delete(key);
      icon.className = "far fa-heart text-slate-400";
      count = Math.max(0, count - 1);
    }
    if (countEl) countEl.textContent = count;
    localStorage.setItem(
      "campus_market_comment_likes",
      JSON.stringify([...likedCommentIds]),
    );
    showToast("Couldn't save your like — please try again.");
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

// Expands a collapsed reply group (see fetchAndRender inside
// toggleComments) and hides the "View N more replies" toggle that
// revealed it.
window._expandReplies = function (groupId) {
  document.getElementById(groupId)?.classList.remove("hidden");
  document.getElementById(`toggle-${groupId}`)?.classList.add("hidden");
};

function renderCommentItem(c, postId, options = {}) {
  const isPreview = !!options.preview;
  const isLiked = likedCommentIds.has(idKey(c.id));
  const heartClass = isLiked
    ? "fas fa-heart text-rose-500"
    : "far fa-heart text-slate-400";
  const isOwn = currentUserData && c.user_id === currentUserData.id;
  const indentClass = c.parent_comment_id ? "ml-7" : "";
  const avatarFallback = `https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(c.user_name || "U")}`;
  const bubbleClass = isOwn
    ? "bg-amber-400/10 border-amber-400/25"
    : "bg-slate-800 border-slate-700/20";

  return `
        <div class="flex gap-2 items-start text-left mt-2.5 ${indentClass}" id="comment-item-${escAttr(c.id)}">
            <div class="feed-profile-trigger flex gap-2 items-start flex-1 min-w-0 cursor-pointer" data-user-id="${escAttr(c.user_id)}">
                <img src="${esc(c.user_avatar) || avatarFallback}" onerror="this.onerror=null; this.src='${avatarFallback}'" class="w-7 h-7 rounded-full border border-slate-800 object-cover shrink-0 mt-0.5" alt="${escAttr(c.user_name) || "Commenter"}">
                <div class="${bubbleClass} rounded-2xl px-3 py-2 flex-1 border min-w-0">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-baseline gap-1.5 min-w-0">
                            <p class="text-[9px] font-black text-amber-400 uppercase tracking-wide truncate">${esc(c.user_name)}</p>
                            ${isOwn ? '<span class="text-[8px] text-amber-400/60 font-bold uppercase shrink-0">You</span>' : ""}
                            <span class="text-[9px] text-slate-500 shrink-0">· ${timeAgo(c.created_at)}</span>
                        </div>
                        <button onclick="event.stopPropagation(); window.openCommentOptionsMenu('${escAttr(c.id)}', '${escAttr(postId)}', ${isOwn ? "true" : "false"}, '${escAttr(c.user_id)}', '${escAttr(c.user_name)}')" class="text-slate-500 hover:text-white transition shrink-0 -mt-0.5 -mr-1 px-1.5 py-0.5" aria-label="More options">
                            <i class="fas fa-ellipsis-vertical text-[11px]"></i>
                        </button>
                    </div>
                    <p class="text-xs text-slate-200 mt-0.5 break-words">${esc(c.text)}</p>
                    <div class="flex items-center gap-3 mt-1.5">
                        <button onclick="event.stopPropagation(); window.likeComment('${escAttr(c.id)}', this)" class="flex items-center gap-1 active:scale-90 transition">
                            <i class="${heartClass} text-[11px]"></i>
                            <span class="comment-like-count text-[10px] text-slate-400 font-semibold">${parseInt(c.likes_count || 0)}</span>
                        </button>
                        ${
                          isPreview
                            ? ""
                            : `
                        <button onclick="event.stopPropagation(); window.startCommentReply('${escAttr(postId)}', '${escAttr(c.id)}', '${escAttr(c.user_name)}')" class="text-[10px] text-slate-400 font-semibold hover:text-amber-400 transition">
                            Reply
                        </button>`
                        }
                    </div>
                </div>
            </div>
        </div>`;
}

// Inline comment preview for the detail view (Temu-style: a few reviews
// visible directly on the page, with a link through to the full list) —
// distinct from the full comment sheet (#comments-{id}/toggleComments
// below), which still opens for the complete, scrollable, repliable
// experience. Shows only top-level comments (no reply threads) since this
// is meant to be a quick preview, not a duplicate of the full sheet.
const COMMENT_PREVIEW_COUNT = 3;
async function loadCommentPreview(postId) {
  const container = document.getElementById(`comment-preview-${postId}`);
  if (!container) return;

  const {
    data: comments,
    error,
    count,
  } = await supabase
    .from("comments")
    .select("*", { count: "exact" })
    .eq("post_id", postId)
    .is("parent_comment_id", null)
    .order("created_at", { ascending: false })
    .limit(COMMENT_PREVIEW_COUNT);

  if (error) {
    container.innerHTML = "";
    return;
  }

  if (!comments || comments.length === 0) {
    container.innerHTML = `<p class="text-xs text-slate-600">No comments yet — be the first to say something.</p>`;
    return;
  }

  const previewHtml = comments
    .map((c) => renderCommentItem(c, postId, { preview: true }))
    .join("");
  const viewAllLabel =
    count && count > comments.length
      ? `View all ${count} comments`
      : "View comments";

  container.innerHTML = `
        ${previewHtml}
        <button onclick="toggleComments('${escAttr(postId)}')" class="text-[11px] text-amber-400 hover:text-amber-300 transition font-bold uppercase tracking-widest">
            ${esc(viewAllLabel)}
        </button>`;
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
      list.innerHTML = `
                <div class="flex flex-col items-center justify-center text-center py-8 px-4">
                    <i class="far fa-comment-dots text-2xl text-slate-700 mb-2"></i>
                    <p class="text-xs text-slate-400 font-semibold">No comments yet</p>
                    <p class="text-[10px] text-slate-600 mt-0.5">Be the first to say something</p>
                </div>`;
      return;
    }

    // Top-level comments first, replies immediately after their parent.
    // idKey() here matters for the same reason it does everywhere else
    // in the app — comment ids are bigints from the DB, and comparing
    // them without normalizing types silently drops replies from view.
    const topLevel = comments.filter((c) => !c.parent_comment_id);
    const replies = comments.filter((c) => c.parent_comment_id);
    const REPLY_PREVIEW_COUNT = 2;

    topLevel.forEach((c) => {
      list.innerHTML += renderCommentItem(c, postId);
      const childReplies = replies.filter(
        (r) => idKey(r.parent_comment_id) === idKey(c.id),
      );
      if (childReplies.length === 0) return;

      if (childReplies.length <= REPLY_PREVIEW_COUNT) {
        childReplies.forEach((r) => {
          list.innerHTML += renderCommentItem(r, postId);
        });
        return;
      }

      // Long threads start collapsed to a couple of replies with a
      // "View N more replies" toggle, instead of always dumping every
      // reply into view — keeps a busy thread scannable.
      const groupId = `replies-${idKey(c.id)}`;
      childReplies.slice(0, REPLY_PREVIEW_COUNT).forEach((r) => {
        list.innerHTML += renderCommentItem(r, postId);
      });
      list.innerHTML += `
                <button
                    id="toggle-${groupId}"
                    onclick="window._expandReplies('${escAttr(groupId)}')"
                    class="ml-7 mt-1 text-[10px] text-amber-400/80 hover:text-amber-400 font-bold flex items-center gap-1.5"
                >
                    <span class="w-5 h-px bg-slate-700"></span>
                    View ${childReplies.length - REPLY_PREVIEW_COUNT} more repl${childReplies.length - REPLY_PREVIEW_COUNT === 1 ? "y" : "ies"}
                </button>
                <div id="${groupId}" class="hidden">
                    ${childReplies
                      .slice(REPLY_PREVIEW_COUNT)
                      .map((r) => renderCommentItem(r, postId))
                      .join("")}
                </div>`;
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

  // Stop watching for new comments on this post now that its sheet is
  // closed — otherwise the realtime subscription just keeps running in
  // the background, re-rendering into a sheet nobody can see (and,
  // worse, into DOM nodes that may since have been destroyed by a
  // later feed re-render).
  if (currentCommentsChan?._topic === `comments-live-${postId}`) {
    supabase.removeChannel(currentCommentsChan);
    currentCommentsChan = null;
  }

  if (!fromPop) popUiState(`comments-${postId}`);
};

// Global backdrop click dismisses whichever reel comment sheet is open.
// Measures the ACTUAL rendered height of the bottom nav bar (icons +
// labels + its own padding, all of which can vary by device font
// rendering, safe-area insets, etc.) and stores it as a CSS custom
// property so #posts-feed.reels-mode's bottom inset is always exactly
// right instead of relying on a guessed pixel constant that can drift
// out of sync with reality and leave a sliver of video peeking out from
// under the nav. Re-measures on resize/orientation change since mobile
// browsers frequently resize the visual viewport when their address bar
// shows/hides, which can also change how much of the safe-area inset is
// actually reserved.
function measureBottomNavHeight() {
  const nav = document.querySelector(".bottom-nav-container");
  if (!nav) return;
  const height = nav.getBoundingClientRect().height;
  if (height > 0) {
    document.documentElement.style.setProperty(
      "--real-nav-height",
      `${height}px`,
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  measureBottomNavHeight();
  // A second pass shortly after load catches any late font-swap or
  // layout shift that changed the nav's rendered height after the
  // very first measurement.
  setTimeout(measureBottomNavHeight, 300);

  // Seed the view-history stack with the initial view the app boots
  // into ('feed'), so the hardware/gesture back button has somewhere
  // meaningful to land BEFORE the user makes any tab switch.
  if (!_viewHistory.length) _viewHistory.push("feed");

  // ─── ZOOM DISABLED APP-WIDE ────────────────────────────────────────────
  // Fix: touch-action: pinch-zoom was previously applied to every
  // <img>/<video> so a post's media could be pinch-zoomed. In practice
  // this doesn't scope the zoom to that element — it only tells the
  // browser "allow your normal page-level pinch-zoom gesture starting
  // here" — and since images/videos cover most of the feed, pinching
  // (or trackpad-pinching on desktop) almost anywhere zoomed the ENTIRE
  // app, not the photo. scopeZoomToMedia() below now keeps every
  // element, media included, pan-only.
  scopeZoomToMedia();
  setTimeout(scopeZoomToMedia, 600); // catch late-rendered hero media
});
window.addEventListener("resize", measureBottomNavHeight);
window.addEventListener("orientationchange", () =>
  setTimeout(measureBottomNavHeight, 200),
);

// Safety net for the offline-auth fix above: if currentUserData somehow
// never got populated (e.g. a connectivity blip during the very first
// load), re-check auth as soon as the browser reports it's back online,
// so Profile/DMs/Create self-heal instead of staying stuck behind the
// sign-in gate until the person manually refreshes.
window.addEventListener("online", async () => {
  if (currentUserData) return;
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user) {
      console.warn(
        "[Auth Observer] Back online — recovered a session that was missed while offline.",
      );
      // onAuthStateChange doesn't automatically refire just because
      // getUser() succeeded, so nudge the same gates/state directly.
      location.reload();
    }
  } catch (_) {
    /* still no session — nothing to recover */
  }
});

// Re-apply the touch-action scope every time any media element is added
// to the DOM. Each MutationObserver callback debounces so a busy render
// frame doesn't pile up dozens of recomputes.
let _zoomScopeRaf = null;
function scheduleZoomScopeRescan() {
  if (_zoomScopeRaf) return;
  _zoomScopeRaf = requestAnimationFrame(() => {
    _zoomScopeRaf = null;
    scopeZoomToMedia();
  });
}

try {
  const zoomObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Adding nodes: anything containing an <img>/<video> triggers a rescan.
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.matches?.("img, video, picture")) {
          scheduleZoomScopeRescan();
          break;
        }
        if (n.querySelector?.("img, video, picture")) {
          scheduleZoomScopeRescan();
          break;
        }
      }
      // Same logic for any element whose class was swapped to reveal media.
      if (
        m.type === "attributes" &&
        m.target instanceof Element &&
        m.target.matches?.("img, video, picture")
      ) {
        scheduleZoomScopeRescan();
      }
    }
  });
  zoomObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "class"],
  });
} catch (_) {
  /* MutationObserver isn't supported (very old browser) — fall back silently */
}

// Walks the DOM and keeps every <img>/<video> pan-only, same as the rest
// of the app — no element permits the browser's native pinch/double-tap
// zoom gesture, since that gesture zooms the whole viewport rather than
// just the element being touched.
function scopeZoomToMedia() {
  document.querySelectorAll("img, video").forEach((el) => {
    try {
      el.style.touchAction = "pan-x pan-y";
    } catch (_) {}
  });
}

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

// ─── BLOCKING ───────────────────────────────────────────────────────────────
// Blocking a person hides their posts from your feed and hides/prevents
// DMs with them — it does NOT delete anything they've already posted or
// notify them in any way. Mirrors the `reports` table's fallback pattern:
// if a `blocked_users` table isn't set up yet in Supabase, blocks are kept
// in localStorage on this device so the feature still works end-to-end
// (including unblocking) rather than being a dead end.
//
// Suggested table (create this in Supabase for the block to sync across
// devices and actually filter server-side data other people send you):
//   create table blocked_users (
//     id bigint generated always as identity primary key,
//     blocker_id uuid not null references auth.users(id),
//     blocked_id uuid not null references auth.users(id),
//     blocked_name text,
//     created_at timestamptz not null default now(),
//     unique (blocker_id, blocked_id)
//   );
//   alter table blocked_users enable row level security;
//   create policy "read own blocks" on blocked_users for select using (auth.uid() = blocker_id);
//   create policy "insert own blocks" on blocked_users for insert with check (auth.uid() = blocker_id);
//   create policy "delete own blocks" on blocked_users for delete using (auth.uid() = blocker_id);
const blockedUserIds = new Set(
  safeStorageJsonParse("campus_market_blocked_users", []).map(idKey),
);
// Keeps display names alongside ids so the Blocked Users settings list has
// something to show even before/without a `blocked_users` table (which
// would otherwise require a join back to `profiles` to get a name).
let blockedUserNames = safeStorageJsonParse("campus_market_blocked_names", {});

// Bulk-loaded set of user ids the viewer currently follows — lets every
// feed card render its Follow/Following button with the CORRECT state
// up front (previously hardcoded to data-active="false" on every card,
// so a person you already followed still showed "+ Follow" until you
// tapped it once). Same pattern as blockedUserIds: synced from Supabase
// once at boot, kept in sync locally by toggleFollow's own success path.
const followingUserIds = new Set();

async function syncFollowingIds() {
  if (!currentUserData) return;
  try {
    const { data, error } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", currentUserData.id);
    if (error) throw error;
    followingUserIds.clear();
    (data || []).forEach((row) =>
      followingUserIds.add(idKey(row.following_id)),
    );
  } catch (err) {
    console.error("Following sync error:", err);
  }
}

// ─── Verification badge + seller ratings caches ─────────────────────────────
// Both are populated on demand (profile view, feed render) rather than
// fetched for every post up front, since most feed scrolling never visits
// a given seller's profile. `null` in verifiedUserCache means "checked,
// not verified" (distinct from "not yet checked", which is simply absent
// from the map) so we don't re-query the same unverified user repeatedly.
const verifiedUserCache = {}; // userId -> boolean
const sellerRatingCache = {}; // userId -> { average: number, count: number }

function _persistBlockedLocally() {
  localStorage.setItem(
    "campus_market_blocked_users",
    JSON.stringify([...blockedUserIds]),
  );
  localStorage.setItem(
    "campus_market_blocked_names",
    JSON.stringify(blockedUserNames),
  );
}

// Pulls the signed-in person's block list from Supabase (if the table
// exists) so blocks made on another device are respected here too, then
// falls back to whatever's in localStorage if the table isn't there yet.
async function syncBlockedUsers() {
  if (!currentUserData) return;
  try {
    const { data, error } = await supabase
      .from("blocked_users")
      .select("blocked_id, blocked_name")
      .eq("blocker_id", currentUserData.id);
    if (error) throw error;

    blockedUserIds.clear();
    blockedUserNames = {};
    (data || []).forEach((row) => {
      const key = idKey(row.blocked_id);
      blockedUserIds.add(key);
      if (row.blocked_name) blockedUserNames[key] = row.blocked_name;
    });
    _persistBlockedLocally();
  } catch (err) {
    // No table yet (or RLS not set up) — silently keep using whatever
    // is already in localStorage from a previous local-only block.
    console.warn("Blocked-users sync skipped (using local list):", err);
  }
}

window.blockUser = function (userId, userName = "this student") {
  if (!currentUserData) {
    showToast("Please sign in to block someone.");
    return;
  }
  if (!userId) {
    showToast("Couldn't identify this user — please try again.");
    return;
  }
  if (idKey(userId) === idKey(currentUserData.id)) return;

  showConfirmDialog({
    title: `Block ${userName}?`,
    message:
      "You won't see their posts anymore, and neither of you can message the other. You can unblock them anytime from Campus Settings.",
    confirmLabel: "Block",
    danger: true,
    onConfirm: async () => {
      const key = idKey(userId);
      blockedUserIds.add(key);
      blockedUserNames[key] = userName;
      _persistBlockedLocally();

      // A blocked person's existing posts/threads are already on
      // screen in some cases (feed cache, open inbox) — refresh
      // whatever's currently visible so the block takes effect
      // immediately instead of only on next reload.
      try {
        renderFeedFromCache();
      } catch (_) {}
      try {
        if (document.getElementById("dms-content") && !activeConversationId)
          renderInboxList();
      } catch (_) {}
      if (activeConversationPeer && idKey(activeConversationPeer.id) === key) {
        window.closeDMThread();
      }

      try {
        const { error } = await supabase.from("blocked_users").insert({
          blocker_id: currentUserData.id,
          blocked_id: userId,
          blocked_name: userName,
        });
        if (error) throw error;
      } catch (err) {
        console.warn("Block insert failed, kept locally only:", err);
      }

      // Blocking someone also breaks any follow relationship between
      // you two, in either direction — matches what people expect
      // from blocking on other apps, and avoids the odd state of
      // still "following" someone you've just blocked.
      try {
        await supabase
          .from("follows")
          .delete()
          .eq("follower_id", currentUserData.id)
          .eq("following_id", userId);
        await supabase
          .from("follows")
          .delete()
          .eq("follower_id", userId)
          .eq("following_id", currentUserData.id);
      } catch (err) {
        console.warn("Follow cleanup on block failed:", err);
      }

      showToast(`${userName} is blocked.`);
    },
  });
};

window.unblockUser = function (userId, userName = "this student") {
  const key = idKey(userId);

  showConfirmDialog({
    title: `Unblock ${userName}?`,
    message:
      "They'll be able to message you again and their posts will show up in your feed.",
    confirmLabel: "Unblock",
    danger: false,
    onConfirm: async () => {
      blockedUserIds.delete(key);
      delete blockedUserNames[key];
      _persistBlockedLocally();

      try {
        renderFeedFromCache();
      } catch (_) {}
      if (
        document
          .getElementById("info-sheet-overlay")
          ?.classList.contains("sheet-open")
      ) {
        window.openInfoSheet("blocked");
      }

      try {
        await supabase
          .from("blocked_users")
          .delete()
          .eq("blocker_id", currentUserData.id)
          .eq("blocked_id", userId);
      } catch (err) {
        console.warn(
          "Unblock delete failed remotely, removed locally only:",
          err,
        );
      }

      showToast(`${userName} unblocked.`);
    },
  });
};

// ─── EDU VERIFICATION ───────────────────────────────────────────────────────
// Verifies a student by their institutional email domain. This is the
// lightweight, self-serve version of verification (no manual document
// review) — a user submits their .edu.gh (or equivalent) email, we send
// a Supabase OTP/magic-link to it, and on confirmation we flip
// profiles.is_verified. Requires the `verification_requests` table +
// `profiles.is_verified` column from the accompanying SQL migration —
// every call below fails soft (toast + console.warn) if that schema
// isn't present yet, so this can ship even before the migration runs.
//
// NOTE ON SCOPE: genuinely confirming someone owns a .edu inbox needs a
// server-side email step (Supabase Auth email OTP, or a custom Edge
// Function sending a verification link) — a purely client-side check of
// "does this string look like a university email" would be trivial to
// fake and isn't real verification. This function does the client-side
// half (submitting the request + reflecting status); the email-send/
// confirm step should go through supabase.auth.signInWithOtp() against
// the submitted address, or a dedicated Edge Function if you want the
// user to stay signed in as their existing account rather than switching
// auth identity. That wiring depends on how your Supabase Auth project
// is configured, so it's left as the one deliberately-unfinished edge —
// flagged here rather than guessed at.
window.submitVerificationRequest = async function (eduEmail) {
  if (!currentUserData) {
    showToast("Please sign in first.");
    return;
  }
  const email = (eduEmail || "").trim().toLowerCase();
  const looksLikeEduEmail =
    /^[^\s@]+@[^\s@]+\.(edu(\.[a-z]{2})?|ac\.[a-z]{2})$/i.test(email);
  if (!looksLikeEduEmail) {
    showToast("Please enter your university email (e.g. name@ug.edu.gh).");
    return;
  }

  try {
    const { error } = await supabase.from("verification_requests").insert({
      user_id: currentUserData.id,
      method: "edu_email",
      submitted_email: email,
      status: "pending",
      created_at: new Date().toISOString(),
    });
    if (error) throw error;

    showToast(
      "Verification request submitted — we'll email you a confirmation link.",
    );
    // See note above: triggering the actual confirmation email is a
    // server-side step. If you want it fired from here, this is
    // where a call like supabase.auth.signInWithOtp({ email }) or an
    // Edge Function invoke would go, once you've decided which path
    // fits your existing auth setup.
    if (
      document
        .getElementById("info-sheet-overlay")
        ?.classList.contains("sheet-open")
    ) {
      window.openInfoSheet("verification");
    }
  } catch (err) {
    console.warn("Verification request failed — table may not exist yet:", err);
    showToast(
      "Couldn't submit right now. This feature needs a database update — try again later.",
    );
  }
};

// Checks (and caches) whether a given user is verified. Call before
// rendering anything that shows a verified badge.
async function isUserVerified(userId) {
  if (!userId) return false;
  if (verifiedUserCache[userId] !== undefined) return verifiedUserCache[userId];
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("is_verified")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    const verified = !!data?.is_verified;
    verifiedUserCache[userId] = verified;
    return verified;
  } catch (err) {
    // Column/table likely doesn't exist yet — fail closed (unverified)
    // rather than crash the feed render.
    console.warn("Verification lookup failed:", err);
    verifiedUserCache[userId] = false;
    return false;
  }
}

// Small inline badge markup, reused in feed cards and public profile.
function verifiedBadgeHtml() {
  return `<i class="fas fa-circle-check text-amber-400 text-[11px] ml-1" title="Verified student" aria-label="Verified student"></i>`;
}

// After the feed/profile has already rendered with no badge (verification
// status wasn't known at render time), this retroactively injects the
// badge into the DOM once the check resolves — avoids blocking the whole
// card render on a network round trip for every single post.
async function applyVerifiedBadgeWhenReady(userId, targetSelector) {
  const verified = await isUserVerified(userId);
  if (!verified) return;
  document.querySelectorAll(targetSelector).forEach((el) => {
    if (!el.querySelector(".verified-badge-inline")) {
      el.insertAdjacentHTML(
        "beforeend",
        `<span class="verified-badge-inline">${verifiedBadgeHtml()}</span>`,
      );
    }
  });
}

// ─── SELLER RATINGS ──────────────────────────────────────────────────────────
// Double-blind-ish peer review: a rating (1-5) + optional comment, tied to
// a specific seller. "Double-blind" in the strict sense (neither party
// sees the other's rating until both submit) isn't practical here since
// there's no tracked "transaction" object linking a buyer and seller —
// this marketplace is DM-based with no order/checkout flow. What's built
// instead: any signed-in student who isn't the seller can rate them once
// per rater/seller pair (enforced by a unique constraint in the SQL
// migration), from that seller's public profile. Simpler than the full
// blueprint's transaction-scoped review, but honest about what the app can
// actually verify happened.
window.submitSellerRating = async function (sellerId, stars, comment = "") {
  if (!currentUserData) {
    showToast("Please sign in to leave a rating.");
    return;
  }
  if (sellerId === currentUserData.id) {
    showToast("You can't rate yourself.");
    return;
  }
  const rating = Math.max(1, Math.min(5, parseInt(stars, 10) || 0));
  if (!rating) {
    showToast("Pick a star rating first.");
    return;
  }

  try {
    const { error } = await supabase.from("seller_ratings").upsert(
      {
        seller_id: sellerId,
        rater_id: currentUserData.id,
        stars: rating,
        comment: (comment || "").trim().slice(0, 500),
        created_at: new Date().toISOString(),
      },
      { onConflict: "seller_id,rater_id" },
    );
    if (error) throw error;

    delete sellerRatingCache[sellerId]; // force a fresh average next fetch
    showToast("Rating submitted — thanks for keeping the campus honest.");
    if (
      document
        .getElementById("public-profile-overlay")
        ?.classList.contains("sheet-open")
    ) {
      window._refreshPublicProfileRatingBlock(sellerId);
    }
  } catch (err) {
    console.warn("Rating submit failed — table may not exist yet:", err);
    showToast(
      "Couldn't submit right now. This feature needs a database update — try again later.",
    );
  }
};

async function fetchSellerRatingSummary(sellerId) {
  if (sellerRatingCache[sellerId]) return sellerRatingCache[sellerId];
  try {
    const { data, error } = await supabase
      .from("seller_ratings")
      .select("stars")
      .eq("seller_id", sellerId);
    if (error) throw error;
    const count = data?.length || 0;
    const average =
      count > 0 ? data.reduce((sum, r) => sum + r.stars, 0) / count : 0;
    const summary = { average: Math.round(average * 10) / 10, count };
    sellerRatingCache[sellerId] = summary;
    return summary;
  } catch (err) {
    console.warn("Rating summary fetch failed — table may not exist yet:", err);
    return { average: 0, count: 0 };
  }
}

function ratingStarsHtml(average) {
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += `<i class="fa${i <= Math.round(average) ? "s" : "r"} fa-star text-amber-400 text-[11px]"></i>`;
  }
  return out;
}

// Re-fetches and re-renders just the rating block inside an already-open
// public profile sheet — used right after submitting a rating so the
// person sees their own rating reflected without a full profile reload.
window._refreshPublicProfileRatingBlock = async function (sellerId) {
  const summary = await fetchSellerRatingSummary(sellerId);
  const el = document.getElementById("public-profile-rating-block");
  if (!el) return;
  el.innerHTML = renderRatingBlockInner(sellerId, summary);
};

function renderRatingBlockInner(sellerId, summary) {
  const canRate = currentUserData && currentUserData.id !== sellerId;
  return `
        <div class="flex items-center gap-1.5">
            ${ratingStarsHtml(summary.average)}
            <span class="text-slate-400 text-[11px] ml-1">${summary.count > 0 ? `${summary.average} (${summary.count})` : "No ratings yet"}</span>
        </div>
        ${
          canRate
            ? `
            <button onclick="window.openRatingPrompt('${escAttr(sellerId)}')" class="text-amber-400 text-[10px] font-black uppercase tracking-wider mt-1.5">
                Rate this seller
            </button>`
            : ""
        }
    `;
}

// Lightweight inline prompt using the existing options-menu pattern
// (openOptionsMenu is already used for post/comment/report menus) rather
// than building a whole new modal component for a 1-5 star picker.
window.openRatingPrompt = function (sellerId) {
  openOptionsMenu([
    {
      label: "★☆☆☆☆ — 1 star",
      icon: "far fa-star",
      action: () => window.submitSellerRating(sellerId, 1),
    },
    {
      label: "★★☆☆☆ — 2 stars",
      icon: "far fa-star",
      action: () => window.submitSellerRating(sellerId, 2),
    },
    {
      label: "★★★☆☆ — 3 stars",
      icon: "far fa-star",
      action: () => window.submitSellerRating(sellerId, 3),
    },
    {
      label: "★★★★☆ — 4 stars",
      icon: "far fa-star",
      action: () => window.submitSellerRating(sellerId, 4),
    },
    {
      label: "★★★★★ — 5 stars",
      icon: "far fa-star",
      action: () => window.submitSellerRating(sellerId, 5),
    },
  ]);
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
// Same UX-safeguard-only cooldown as postComment's COMMENT_COOLDOWN_MS
// above — prevents someone from rapid-fire reporting many different
// posts in quick succession (e.g. to harass a seller), not a real
// security boundary. Real abuse prevention belongs at the database/RLS
// or Supabase project level.
let lastReportSubmittedAt = 0;
const REPORT_COOLDOWN_MS = 2500;

async function submitReport(targetType, targetId, reason = "unspecified") {
  if (!currentUserData) {
    showToast("Please sign in to report content.");
    return;
  }

  const now = Date.now();
  if (now - lastReportSubmittedAt < REPORT_COOLDOWN_MS) {
    showToast("You're reporting a bit fast — give it a second.");
    return;
  }
  lastReportSubmittedAt = now;

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
    // Fire-and-forget: don't make the reporter wait on a second
    // round-trip just to find out if this pushed something over the
    // auto-hide threshold.
    checkAutoModerationThreshold(targetType, targetId);
  } catch (err) {
    // Fix: once reports_one_per_reporter (a unique index on
    // target_type/target_id/reporter_id — see create_reports_table.sql)
    // exists, reporting the same thing twice throws a unique-violation
    // (Postgres code 23505) instead of silently inserting a second row.
    // That's a genuinely different situation from "the table doesn't
    // exist" or "RLS blocked it" below — the report already succeeded
    // the first time, so queuing another copy locally and telling the
    // person it's merely "saved on this device" would be misleading.
    if (err?.code === "23505") {
      showToast("You've already reported this — thanks, it's been recorded.");
      return;
    }

    // Table likely doesn't exist yet (or an RLS policy blocks it) —
    // queue locally so the report isn't just lost, and be upfront
    // that it hasn't reached a real moderation backend yet.
    console.warn("Report insert failed, queuing locally:", err);
    const queued = safeStorageJsonParse("campus_market_pending_reports", []);
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

// ─── AUTO-MODERATION (report-threshold auto-hide) ───────────────────────────
// The blueprint calls for listings that "breach predefined thresholds"
// to auto-hide pending moderator review. This is the honest, minimal
// version: once a post or comment collects AUTO_HIDE_REPORT_THRESHOLD
// distinct reports, it's automatically archived (posts, via the existing
// is_archived column) or removed from view (comments, via a `status`
// column) — reversible by a moderator later, not a hard delete.
//
// This deliberately does NOT try to build a moderator review dashboard —
// that's a real admin surface (who counts as a moderator? a role check?
// a separate admin app?) that depends on decisions about your project
// this file can't make for you. What's here is the trigger-side half:
// detecting the threshold and softly hiding the content. Reviewing/
// restoring what gets auto-hidden would need that admin surface built
// separately.
const AUTO_HIDE_REPORT_THRESHOLD = 3;

async function checkAutoModerationThreshold(targetType, targetId) {
  try {
    // The reports table's existing SELECT policy (reports_select_own)
    // only lets a user see/count THEIR OWN submitted reports — a
    // direct client-side count here would only ever return 0 or 1,
    // never the true total across every reporter. get_report_count
    // is a SECURITY DEFINER function that bypasses that restriction
    // to return the real aggregate, without opening up the table to
    // broader client reads.
    const { data: count, error } = await supabase.rpc("get_report_count", {
      p_target_type: targetType,
      p_target_id: targetId,
    });
    if (error) throw error;
    if ((count || 0) < AUTO_HIDE_REPORT_THRESHOLD) return;

    if (targetType === "post") {
      // Reuses the same soft-archive path as attemptSoftArchivePost,
      // just triggered by report volume instead of the owner
      // deleting it — keeps a single source of truth for "hidden
      // but recoverable" rather than a second hidden-flag concept.
      await supabase
        .from("posts")
        .update({
          is_archived: true,
          archived_at: new Date().toISOString(),
          status: "archived_auto_reported",
        })
        .eq("id", targetId);
      try {
        renderFeedFromCache();
      } catch (_) {}
    } else if (targetType === "comment") {
      await supabase
        .from("comments")
        .update({ status: "hidden_auto_reported" })
        .eq("id", targetId);
      document
        .querySelectorAll(`[id="comment-item-${CSS.escape(targetId)}"]`)
        .forEach((el) => el.remove());
    }
  } catch (err) {
    // Non-fatal by design — auto-moderation failing silently is far
    // better than it throwing and breaking the reporter's own report
    // flow, which already succeeded by the time this runs.
    console.warn(
      "Auto-moderation check failed (likely missing status column):",
      err,
    );
  }
}

// Post options: only the owner gets a real "Delete listing"; everyone
// else gets "Report" (persists — see submitReport above) and "Block
// user" (hides this person's posts and DMs — see blockUser above).
function openReportReasonMenu(
  targetType,
  targetId,
  authorId = null,
  authorName = "this student",
) {
  openOptionsMenu([
    {
      label: "Spam / scam",
      icon: "fas fa-shield-halved",
      action: () => submitReport(targetType, targetId, "spam_or_scam"),
    },
    {
      label: "Misleading description",
      icon: "fas fa-circle-exclamation",
      action: () =>
        submitReport(targetType, targetId, "misleading_description"),
    },
    {
      label: "Unsafe meetup request",
      icon: "fas fa-location-dot",
      action: () => submitReport(targetType, targetId, "unsafe_meetup_request"),
    },
    {
      label: "Harassment / abuse",
      icon: "fas fa-user-slash",
      action: () => submitReport(targetType, targetId, "harassment_or_abuse"),
    },
    { divider: true },
    {
      label: `Block ${authorName}`,
      icon: "fas fa-user-slash",
      danger: true,
      action: () => window.blockUser(authorId, authorName),
    },
  ]);
}

window.openPostOptionsMenu = function (
  postId,
  isOwn,
  authorId = null,
  authorName = "this student",
  isSuggested = false,
) {
  const sharedItems = [
    {
      label: "View Profile",
      icon: "fas fa-user",
      action: () => window.openPublicProfile(authorId),
    },
    {
      label: "Copy Link",
      icon: "fas fa-link",
      action: () => window.copyPostLink(postId),
    },
    {
      label: "Why you're seeing this post",
      icon: "fas fa-circle-info",
      action: () => window.openWhySeeingPost(authorId, isSuggested),
    },
  ];

  const items = isOwn
    ? [
        ...sharedItems,
        { divider: true },
        {
          label: "Manage listing",
          icon: "fas fa-sliders",
          action: () => window.openManageListingSheet(postId),
        },
        {
          label: "Archive or delete listing",
          icon: "fas fa-box-archive",
          danger: true,
          action: () => window.deletePost(postId),
        },
      ]
    : [
        ...sharedItems,
        { divider: true },
        {
          label: "Report listing",
          icon: "fas fa-flag",
          action: () =>
            openReportReasonMenu("post", postId, authorId, authorName),
        },
        { divider: true },
        {
          label: `Block ${authorName}`,
          icon: "fas fa-user-slash",
          danger: true,
          action: () => window.blockUser(authorId, authorName),
        },
      ];
  openOptionsMenu(items);
};

// Comment options: owner gets Delete; everyone else gets Report + Block.
window.openCommentOptionsMenu = function (
  commentId,
  postId,
  isOwn,
  authorId = null,
  authorName = "this student",
) {
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
          action: () =>
            openReportReasonMenu("comment", commentId, authorId, authorName),
        },
        { divider: true },
        {
          label: `Block ${authorName}`,
          icon: "fas fa-user-slash",
          danger: true,
          action: () => window.blockUser(authorId, authorName),
        },
      ];
  openOptionsMenu(items);
};

function renderFeedCard(id, d, options = {}) {
  const isSuggested = !!options.suggested;
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
          ? `<video class="feed-lazy-video w-full max-h-[600px] object-contain shrink-0 snap-start bg-black" muted loop playsinline preload="none" data-src="${esc(url)}" poster=""></video>`
          : `<img class="w-full max-h-[500px] object-contain bg-slate-950 shrink-0 snap-start" src="${esc(url)}" alt="${esc(d.title)} ${i + 1}" loading="lazy">`,
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
                <video class="feed-lazy-video w-full max-h-[600px] object-contain bg-black" muted loop playsinline preload="none" data-src="${esc(mediaUrls[0])}"></video>
               </div>`
        : `<div onclick="openDetail('${escAttr(id)}')" class="w-full cursor-pointer">
                <img class="w-full max-h-[500px] object-contain bg-slate-950" src="${esc(mediaUrls[0])}" alt="${esc(d.title)}" loading="lazy">
               </div>`;
  }

  const isFollowingPoster = followingUserIds.has(idKey(d.user_id));
  const followBlock = showFollow
    ? `
        <button
            class="follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 ${isFollowingPoster ? "bg-slate-700 text-slate-300 border border-slate-600" : "bg-slate-800 text-slate-300 border border-slate-700"} ml-2"
            data-follow-uid="${esc(d.user_id)}"
            data-active="${isFollowingPoster}"
            onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
            ${isFollowingPoster ? "✓ Following" : "+ Follow"}
        </button>`
    : "";

  const deleteBlock = `
        <button
            onclick="event.stopPropagation(); window.openPostOptionsMenu('${escAttr(id)}', ${isOwnPost ? "true" : "false"}, '${escAttr(d.user_id)}', '${escAttr(d.user_name)}', ${isSuggested ? "true" : "false"})"
            class="post-options-trigger"
            aria-label="More options">
            <i class="fas fa-ellipsis-vertical"></i>
        </button>`;

  const isLiked = likedPostIds.has(idKey(id));
  const heartClass = isLiked
    ? "fas fa-heart text-rose-500"
    : "far fa-heart text-slate-300";
  const likedData = isLiked ? "true" : "false";

  // likes_count now comes straight from the DB and is kept accurate via
  // the RPC counters, so this reflects the true persisted count on load.
  const displayLikes = parseInt(d.likes_count || 0);
  const displayComments =
    commentCountCache[id] ?? parseInt(d.comments_count || 0);

  const isAddedToCart = userCartList.some(
    (item) => idKey(item.id) === idKey(id),
  );
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-slate-300";

  registerPostContext(id, d, mediaUrls[0] || "");

  // Verification status isn't known synchronously (it's a DB lookup),
  // so the card renders without the badge first, then this fills it in
  // once resolved — same pattern as lazy avatar/video loading elsewhere
  // in this file. Cached after the first check, so scrolling past the
  // same seller's other posts doesn't re-query per card.
  if (d.user_id) {
    applyVerifiedBadgeWhenReady(d.user_id, `.feed-username-${CSS.escape(id)}`);
  }

  const _saleActiveForCard =
    d.sale_ends_at && new Date(d.sale_ends_at).getTime() > Date.now();
  const _isFlashPost =
    _saleActiveForCard &&
    d.original_price != null &&
    String(d.original_price) !== String(d.price || 0);
  const _originalPriceNum =
    d.original_price != null ? Number(d.original_price) : null;
  // Strikethrough applies for any original_price != price (lower OR higher).
  const _strikePrice = _isFlashPost;

  return `
    <div class="bg-slate-900 border-b border-slate-800/60 w-full" id="feed-card-${escAttr(id)}">

        <div class="flex items-center justify-between px-3 py-2.5">
            <div class="feed-profile-trigger flex items-center gap-2.5 min-w-0 cursor-pointer" data-user-id="${escAttr(d.user_id)}">
                <img src="${esc(d.user_avatar) || "https://ui-avatars.com/api/?name=User"}" data-avatar-for="${escAttr(d.user_id)}" class="w-8 h-8 rounded-full border border-slate-700 object-cover shrink-0" alt="">
                <div class="min-w-0">
                    <p class="text-[12px] font-bold text-white leading-tight truncate feed-username-${escAttr(id)}">${esc(d.user_name) || "Student"}</p>
                    <p class="text-[10px] text-slate-500 leading-tight truncate">${isSuggested ? '<span class="text-amber-400/80 font-semibold">Suggested</span>' : esc(d.institution) || ""}</p>
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
                    inputmode="text"
                    maxlength="500"
                    placeholder="Add a comment…"
                    class="comment-input-field flex-1 bg-slate-800/80 border border-slate-700/50 text-white text-xs rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-amber-400 transition"
                    oninput="window._syncCommentSendState('${escAttr(id)}', this)"
                    onkeydown="if(event.key==='Enter') window.submitCommentFromInput('${escAttr(id)}', this)"
                >
                <button id="cancel-reply-${escAttr(id)}" onclick="window.cancelCommentReply('${escAttr(id)}')" class="hidden text-[10px] text-slate-500 hover:text-white px-1">✕</button>
                <button
                    id="comment-send-${escAttr(id)}"
                    disabled
                    onclick="window._submitFromSendBtn('${escAttr(id)}')"
                    class="comment-send-btn shrink-0 w-8 h-8 rounded-xl bg-amber-400 text-black flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
                    aria-label="Send comment"
                >
                    <i class="fas fa-paper-plane text-[11px]"></i>
                </button>
            </div>
            <div id="comment-list-${escAttr(id)}" class="max-h-36 overflow-y-auto space-y-1.5 custom-scrollbar"></div>
        </div>
    </div>`;
}

// All-tab Pinterest-style masonry card. Distinct from renderFeedCard (the
// single-column feed, still used by Following) and from
// renderProductGridCard/renderServiceGridCard (plain image+price, no
// social context) — this keeps the poster's identity and engagement
// counts visible on the card itself, matching the decision that the All
// tab should read as a social feed rather than a second product grid.
// Image uses its natural aspect ratio (no forced height) so masonry
// columns genuinely vary, the way real Pinterest cards do.
function renderFeedMasonryCard(id, d, options = {}) {
  const isSuggested = !!options.suggested;

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
  const primaryUrl = mediaUrls[0] || "";
  const isVideo = d.media_type === "video";

  const isAddedToCart = userCartList.some(
    (item) => idKey(item.id) === idKey(id),
  );
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-white/80";

  const isSold = !!d.sold_at;
  const saleActive =
    d.sale_ends_at && new Date(d.sale_ends_at).getTime() > Date.now();
  // Fix: hasDiscount used to ignore saleActive, so the crossed-out
  // original price stuck around forever after a flash sale's countdown
  // ran out (only the badge itself ever disappeared). Gating on
  // saleActive here reverts the card to a plain price the moment the
  // sale ends, matching the badge.
  const hasDiscount =
    saleActive &&
    d.original_price != null &&
    Number(d.original_price) > 0 &&
    Number(d.original_price) !== Number(d.price || 0);

  registerPostContext(id, d, isVideo ? "" : primaryUrl);

  const mediaBlock = isVideo
    ? `<video class="w-full h-auto block" muted loop playsinline preload="metadata" src="${esc(primaryUrl)}#t=0.1"></video>
           <div class="absolute top-2.5 left-2.5 w-7 h-7 rounded-full bg-black/50 flex items-center justify-center text-white text-xs"><i class="fas fa-play"></i></div>`
    : `<img class="w-full h-auto block ${isSold ? "opacity-40 grayscale" : ""}" src="${esc(primaryUrl)}" alt="${esc(d.title)}" loading="lazy">`;

  return `
    <div class="masonry-card-feed bg-slate-900 border border-slate-800/60 rounded-2xl overflow-hidden mb-1" id="feed-card-${escAttr(id)}">
        <div class="relative w-full bg-slate-950 cursor-pointer" onclick="openDetail('${escAttr(id)}')">
            ${mediaBlock}
            ${isSold ? `<div class="absolute inset-0 flex items-center justify-center"><span class="bg-black/80 text-white text-[11px] font-black uppercase tracking-[0.2em] px-4 py-1.5 rounded-full border border-white/20">Sold</span></div>` : ""}
            ${!isSold && isSuggested ? `<div class="absolute top-2.5 left-2.5 bg-amber-400/90 text-black text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full">Suggested</div>` : ""}
            ${!isSold && saleActive ? `<div class="sale-countdown-badge absolute top-2.5 left-2.5 bg-rose-500/90 text-white text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full" data-sale-ends="${escAttr(d.sale_ends_at)}">${esc(countdownText(d.sale_ends_at))}</div>` : ""}
            ${
              !isSold
                ? `
            <button
                onclick="event.stopPropagation(); window.toggleCartItem('${escAttr(id)}')"
                class="absolute top-2.5 right-2.5 w-7 h-7 flex items-center justify-center bg-black/50 rounded-full active:scale-90 transition">
                <i class="${bookmarkClass} text-xs"></i>
            </button>`
                : ""
            }
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2.5 pt-6 pb-2 flex items-baseline gap-1.5">
                <span class="text-amber-400 font-black text-xs">GH₵${esc(String(d.price || 0))}</span>
                ${hasDiscount ? `<span class="sale-strike-price text-slate-400 text-[10px] line-through" data-sale-ends="${escAttr(d.sale_ends_at)}">GH₵${esc(String(d.original_price))}</span>` : ""}
            </div>
        </div>
        <div class="px-2.5 py-2">
            <p class="text-white text-[12px] font-semibold leading-snug line-clamp-2 cursor-pointer" onclick="openDetail('${escAttr(id)}')">${esc(d.title)}</p>
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
  const isAddedToCart = userCartList.some(
    (item) => idKey(item.id) === idKey(id),
  );
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-white/80";

  const isSolid = !!d.sold_at;
  const saleActive =
    d.sale_ends_at && new Date(d.sale_ends_at).getTime() > Date.now();
  // Fix: hasDiscount used to ignore saleActive, so the crossed-out
  // original price stuck around forever after a flash sale's countdown
  // ran out (only the badge itself ever disappeared). Gating on
  // saleActive here reverts the card to a plain price the moment the
  // sale ends, matching the badge.
  const hasDiscount =
    saleActive &&
    d.original_price != null &&
    Number(d.original_price) > 0 &&
    Number(d.original_price) !== Number(d.price || 0);

  const viewer = currentUserData;
  const showFollow = viewer && d.user_id !== viewer.id;
  const isFollowingPoster = followingUserIds.has(idKey(d.user_id));
  const followBlock = showFollow
    ? `
        <button
            onclick="event.stopPropagation(); toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')"
            class="w-full mt-1.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 ${isFollowingPoster ? "bg-slate-700 text-slate-300 border border-slate-600" : "bg-slate-800 text-slate-300 border border-slate-700"}"
            data-follow-uid="${esc(d.user_id)}"
            data-active="${isFollowingPoster}">
            ${isFollowingPoster ? "✓ Following" : "+ Follow"}
        </button>`
    : "";

  return `
    <div class="masonry-card bg-slate-900 border border-slate-800/60 rounded-2xl overflow-hidden mb-1" id="grid-card-${escAttr(id)}">
        <div class="relative w-full bg-slate-950 cursor-pointer" onclick="openDetail('${escAttr(id)}')">
            ${
              isVideo
                ? `<video class="w-full h-auto block" muted loop playsinline preload="metadata" src="${esc(mediaUrl)}#t=0.1"></video>
                   <div class="absolute top-2 left-2 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center text-white text-[10px]"><i class="fas fa-play"></i></div>`
                : `<img class="w-full h-auto block ${isSolid ? "opacity-40 grayscale" : ""}" src="${esc(mediaUrl)}" alt="${esc(d.title)}" loading="lazy">`
            }
            ${isSolid ? `<div class="absolute inset-0 flex items-center justify-center"><span class="bg-black/80 text-white text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-full border border-white/20">Sold</span></div>` : ""}
            ${!isSolid && saleActive ? `<div class="sale-countdown-badge absolute top-2 left-2 bg-rose-500/90 text-white text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full" data-sale-ends="${escAttr(d.sale_ends_at)}">${esc(countdownText(d.sale_ends_at))}</div>` : ""}
            <button
                onclick="event.stopPropagation(); window.toggleCartItem('${escAttr(id)}')"
                class="absolute top-2 right-2 w-7 h-7 flex items-center justify-center bg-black/50 rounded-full active:scale-90 transition">
                <i class="${bookmarkClass} text-xs"></i>
            </button>
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2 pt-5 pb-1.5 flex items-baseline gap-1.5">
                <span class="text-amber-400 font-black text-[11px]">GH₵${esc(String(d.price || 0))}</span>
                ${hasDiscount ? `<span class="sale-strike-price text-slate-400 text-[9px] line-through" data-sale-ends="${escAttr(d.sale_ends_at)}">GH₵${esc(String(d.original_price))}</span>` : ""}
            </div>
        </div>
        <div class="p-2">
            <p class="text-white text-[11px] font-semibold leading-snug line-clamp-1">${esc(d.title)}</p>
            <p class="text-slate-500 text-[9px] truncate mt-0.5">${esc(d.user_name) || "Student"}</p>
            ${followBlock}
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
      currentCampusScope !== "everywhere" && currentUserData?.institution;
    feed.innerHTML = isScopedEmpty
      ? `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">📦</p>
                <p class="font-bold text-white">No products found</p>
                ${buildScopeWidenPrompt({ contextLabel: "products" })}
            </div>`
      : `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📦</p>
                <p class="font-bold text-white">No products yet</p>
                <p class="text-slate-500 text-xs">Be the first to list one!</p>
            </div>`;
    return;
  }

  feed.innerHTML = `<div class="masonry-columns py-2">${products
    .map(({ id, data: d }) => renderProductGridCard(id, d))
    .join("")}</div>`;

  const canWidenProducts =
    currentCampusScope !== "everywhere" && currentUserData?.institution;
  feed.innerHTML += `
        <div id="feed-load-more-sentinel" class="py-6 text-center space-y-2 px-6">
            ${
              feedHasMore
                ? ""
                : canWidenProducts
                  ? buildScopeWidenPrompt({ contextLabel: "products" })
                  : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`
            }
        </div>`;
  setupFeedLoadMoreObserver();
}

function renderServiceGridCard(id, d) {
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

  const isSolid = !!d.sold_at;
  const saleActive =
    d.sale_ends_at && new Date(d.sale_ends_at).getTime() > Date.now();
  // Fix: hasDiscount used to ignore saleActive, so the crossed-out
  // original price stuck around forever after a flash sale's countdown
  // ran out (only the badge itself ever disappeared). Gating on
  // saleActive here reverts the card to a plain price the moment the
  // sale ends, matching the badge.
  const hasDiscount =
    saleActive &&
    d.original_price != null &&
    Number(d.original_price) > 0 &&
    Number(d.original_price) !== Number(d.price || 0);

  const viewer = currentUserData;
  const showFollow = viewer && d.user_id !== viewer.id;
  const isFollowingPoster = followingUserIds.has(idKey(d.user_id));
  const followBlock = showFollow
    ? `
        <button
            onclick="event.stopPropagation(); toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')"
            class="w-full mt-1.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 ${isFollowingPoster ? "bg-slate-700 text-slate-300 border border-slate-600" : "bg-slate-800 text-slate-300 border border-slate-700"}"
            data-follow-uid="${esc(d.user_id)}"
            data-active="${isFollowingPoster}">
            ${isFollowingPoster ? "✓ Following" : "+ Follow"}
        </button>`
    : "";

  return `
    <div class="masonry-card-service bg-slate-900 border border-slate-800/60 rounded-2xl overflow-hidden mb-1" id="grid-card-${escAttr(id)}">
        <div class="relative w-full bg-slate-950 cursor-pointer" onclick="window.openServiceReelViewer('${escAttr(id)}')">
            ${
              isVideo
                ? `<video class="w-full h-auto block" muted loop playsinline preload="metadata" src="${esc(mediaUrl)}#t=0.1"></video>
                   <div class="absolute top-2.5 left-2.5 w-7 h-7 rounded-full bg-black/50 flex items-center justify-center text-white text-xs"><i class="fas fa-play"></i></div>`
                : `<img class="w-full h-auto block ${isSolid ? "opacity-40 grayscale" : ""}" src="${esc(mediaUrl)}" alt="${esc(d.title)}" loading="lazy">`
            }
            ${isSolid ? `<div class="absolute inset-0 flex items-center justify-center"><span class="bg-black/80 text-white text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-full border border-white/20">Sold</span></div>` : ""}
            ${!isSolid && saleActive ? `<div class="sale-countdown-badge absolute top-9 right-2.5 bg-rose-500/90 text-white text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full" data-sale-ends="${escAttr(d.sale_ends_at)}">${esc(countdownText(d.sale_ends_at))}</div>` : ""}
            <div class="absolute top-2.5 right-2.5 ${saleActive ? "top-14" : ""} bg-amber-400 text-black text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full">
                <i class="fas fa-bolt text-[9px]"></i> Service
            </div>
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-3 pt-6 pb-2 flex items-baseline gap-1.5">
                <span class="text-amber-400 font-black text-sm">GH₵${esc(String(d.price || 0))}</span>
                ${hasDiscount ? `<span class="sale-strike-price text-slate-400 text-[10px] line-through" data-sale-ends="${escAttr(d.sale_ends_at)}">GH₵${esc(String(d.original_price))}</span>` : ""}
            </div>
        </div>
        <div class="p-3">
            <p class="text-white text-sm font-bold leading-snug line-clamp-2">${esc(d.title)}</p>
            <p class="text-slate-500 text-[11px] truncate mt-1">${esc(d.user_name) || "Student"}</p>
            ${followBlock}
        </div>
    </div>`;
}

function renderServiceGrid() {
  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.add("grid-mode");

  const services = allCachedPosts.filter(({ data: d }) => d.type === "skill");

  if (services.length === 0) {
    const isScopedEmpty =
      currentCampusScope !== "everywhere" && currentUserData?.institution;
    feed.innerHTML = isScopedEmpty
      ? `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">🛠️</p>
                <p class="font-bold text-white">No services found</p>
                ${buildScopeWidenPrompt({ contextLabel: "services" })}
            </div>`
      : `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">🛠️</p>
                <p class="font-bold text-white">No services yet</p>
                <p class="text-slate-500 text-xs">Be the first to offer one!</p>
            </div>`;
    return;
  }

  feed.innerHTML = `<div class="masonry-columns-services py-2">${services
    .map(({ id, data: d }) => renderServiceGridCard(id, d))
    .join("")}</div>`;

  const canWidenServices =
    currentCampusScope !== "everywhere" && currentUserData?.institution;
  feed.innerHTML += `
        <div id="feed-load-more-sentinel" class="py-6 text-center space-y-2 px-6">
            ${
              feedHasMore
                ? ""
                : canWidenServices
                  ? buildScopeWidenPrompt({ contextLabel: "services" })
                  : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`
            }
        </div>`;
  setupFeedLoadMoreObserver();
}

// Deals tab renderer: only shows posts with an active flash sale (a
// non-null original_price different from price AND sale_ends_at still in
// the future). When no qualifying posts exist, OR every active sale has
// expired, the tab is hidden entirely (handled by the setInterval below
// that toggles the button's .hidden class). Reuses renderProductGridCard
// for consistent visuals with the Products tab.
function renderDealsGrid() {
  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.add("grid-mode");

  const now = Date.now();
  const dealEntries = allCachedPosts.filter(({ data: d }) => {
    if (!d) return false;
    const op = d.original_price != null ? Number(d.original_price) : null;
    const price = Number(d.price || 0);
    if (op == null || op <= 0 || op === price) return false;
    if (!d.sale_ends_at) return false;
    return new Date(d.sale_ends_at).getTime() > now;
  });

  if (dealEntries.length === 0) {
    feed.innerHTML = `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">⚡</p>
                <p class="font-bold text-white">No live deals right now</p>
                <p class="text-slate-500 text-xs">Check back later — sellers can post flash sales anytime.</p>
            </div>`;
    return;
  }

  feed.innerHTML = `<div class="masonry-columns py-2">${dealEntries
    .map(({ id, data: d }) => renderProductGridCard(id, d))
    .join("")}</div>`;

  feed.innerHTML += `
        <div id="feed-load-more-sentinel" class="py-6 text-center space-y-2 px-6">
            ${
              feedHasMore
                ? ""
                : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`
            }
        </div>`;
  setupFeedLoadMoreObserver();
}

// Tick the Deals-tab button visibility: hide when no active sale is in
// the in-memory cache; show again when a new qualifying post arrives.
// Lightweight — runs every two seconds rather than every second since
// the visible state only needs to change when a deadline passes.
setInterval(() => {
  const btn = document.querySelector('.feed-tab-btn[data-tab="deals"]');
  if (!btn) return;
  const now = Date.now();
  const hasLiveDeal = allCachedPosts.some(({ data: d }) => {
    if (!d) return false;
    const op = d.original_price != null ? Number(d.original_price) : null;
    const price = Number(d.price || 0);
    if (op == null || op <= 0 || op === price) return false;
    if (!d.sale_ends_at) return false;
    return new Date(d.sale_ends_at).getTime() > now;
  });
  btn.classList.toggle("opacity-40", !hasLiveDeal);
  btn.title = hasLiveDeal
    ? "Live flash-sale listings"
    : "No live deals right now";
}, 5000);

// Tapping a service card opens a Reels-style continuous vertical scroller
// through every currently-loaded service post, landing on the tapped one
// first — reuses the same overlay/card renderer as the profile post
// viewer (openProfilePostViewer), just scoped to "all cached service
// posts" instead of "one user's posts".
window.openServiceReelViewer = async function (startPostId) {
  const overlay = document.getElementById("profile-post-viewer");
  const feed = document.getElementById("profile-post-viewer-feed");
  if (!overlay || !feed) return;

  const services = allCachedPosts
    .filter(({ data: d }) => d.type === "skill")
    .map(({ data: d }) => d);
  if (services.length === 0) return;

  overlay.classList.add("sheet-open", "is-service-viewer");
  pauseAllReelVideos();
  pushUiState("profile-post-viewer", () => window.closeProfilePostViewer(true));

  feed.innerHTML = services
    .map((d) => renderReelCard(idKey(d.id), d, true))
    .join("");

  requestAnimationFrame(() => {
    const targetCard = document.getElementById(
      `reel-card-${CSS.escape(idKey(startPostId))}`,
    );
    if (targetCard) {
      targetCard.scrollIntoView({ block: "start" });
      const targetMedia = targetCard.querySelector(".reel-video");
      if (targetMedia && targetMedia.dataset.src)
        targetMedia.src = targetMedia.dataset.src;
    }
  });

  setupReelsIntersectionObserver(feed);
};

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
      if (video.tagName !== "VIDEO") return;
      try {
        video.pause();
        video.muted = true;
        // Fully release the source rather than just pausing, so the
        // browser drops any active media session / background decode
        // buffer instead of keeping it warm for a quick resume.
        if (
          (video.classList.contains("feed-lazy-video") || video.dataset.src) &&
          video.src
        ) {
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
  openCommentIds.clear();
  if (currentCommentsChan) {
    supabase.removeChannel(currentCommentsChan);
    currentCommentsChan = null;
  }
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

  // Fix: root: null observes intersection against the whole BROWSER
  // viewport — but #posts-feed (in its normal, non-reels mode) scrolls
  // internally via its own overflow-y: scroll, not by moving the actual
  // window. A card scrolling within that inner container can stay
  // "intersecting the viewport" the entire time even as it visually
  // scrolls out of sight inside #posts-feed, since the container
  // element itself never moves relative to the window. That meant this
  // observer could silently never fire for normal-feed scrolling, and
  // an open comment panel would stay open (and visible, since it's
  // just an inline block in the card's own DOM) as the person scrolled
  // straight past it — reading exactly like a stuck dark panel
  // covering part of the screen. Using #posts-feed itself as the
  // intersection root fixes this at the source.
  const feed = document.getElementById("posts-feed");

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
    { root: feed, threshold: 0, rootMargin: "-20% 0px -20% 0px" },
  );

  document.querySelectorAll('[id^="feed-card-"]').forEach((card) => {
    feedCommentAutoCloseObserver.observe(card);
  });
}

function setupReelsIntersectionObserver(container = null) {
  if (reelsIntersectionObserver) {
    reelsIntersectionObserver.disconnect();
    reelsIntersectionObserver = null;
  }

  const feed = container || document.getElementById("posts-feed");
  if (!feed) return;

  reelsIntersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const mediaEl = entry.target.querySelector(".reel-video");
        const video = mediaEl && mediaEl.tagName === "VIDEO" ? mediaEl : null;
        const reelId = entry.target.id.replace("reel-card-", "");

        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          // Lazy-load: only assign the real src once this card is
          // actually the one in view. mediaEl.dataset.src is only
          // ever set when renderReelCard was called with lazy=true
          // (the profile post viewer) — the normal Reels tab's
          // cards have a real src from the start, so this is a
          // no-op there.
          if (mediaEl && mediaEl.dataset.src && !mediaEl.src) {
            mediaEl.src = mediaEl.dataset.src;
          }

          // This reel is the one in view: play it, unmuted only if the
          // user hasn't explicitly muted it before (default unmuted
          // like TikTok, matching tap-to-mute behavior already wired).
          if (video) {
            document.querySelectorAll(".reel-video").forEach((v) => {
              if (v !== video && v.tagName === "VIDEO") {
                v.pause();
                v.muted = true;
                v.currentTime = v.currentTime;
              }
            });
            video.muted = video.dataset.userMuted === "true";
            video.play().catch(() => {});
          }
        } else {
          if (video) {
            video.pause();
            video.muted = true;
          }

          // Fix: scrolling to the next/previous reel previously left
          // the last-opened reel's comment sheet (moved to
          // document.body, fixed to viewport — see toggleComments)
          // sitting open on screen, floating over whatever the person
          // scrolled to next. It looked exactly like a stuck dark
          // panel covering the bottom half of the screen, and the
          // only way out was tapping its close button or re-tapping
          // the comment icon to toggle it shut. Closing it here the
          // moment its reel leaves view means it can never outlive
          // the reel it belongs to.
          const commentSheet = document.getElementById(`comments-${reelId}`);
          if (commentSheet?.classList.contains("comments-open")) {
            window._closeCommentSheet(reelId);
          }
        }
      });
    },
    { root: feed, threshold: [0, 0.6, 1] },
  );

  document
    .querySelectorAll(".reel-card")
    .forEach((card) => reelsIntersectionObserver.observe(card));
}

function renderReelCard(id, d, lazy = false) {
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
  const isVideo = d.media_type === "video";
  const primaryUrl = mediaUrls[0] || "";

  const isLiked = likedPostIds.has(idKey(id));
  const heartClass = isLiked
    ? "fas fa-heart text-rose-500"
    : "far fa-heart text-white";
  const displayLikes = parseInt(d.likes_count || 0);
  const displayComments =
    commentCountCache[id] ?? parseInt(d.comments_count || 0);
  const isAddedToCart = userCartList.some(
    (item) => idKey(item.id) === idKey(id),
  );
  const bookmarkClass = isAddedToCart
    ? "fas fa-bookmark text-amber-400"
    : "far fa-bookmark text-white";
  const isOwnPost = currentUserData && d.user_id === currentUserData.id;

  const deleteBlock = `
        <button onclick="event.stopPropagation(); window.openPostOptionsMenu('${escAttr(id)}', ${isOwnPost ? "true" : "false"}, '${escAttr(d.user_id)}', '${escAttr(d.user_name)}')" class="reel-action-btn">
            <i class="fas fa-ellipsis-vertical text-white text-lg"></i>
        </button>`;

  registerPostContext(id, d, isVideo ? "" : primaryUrl);

  const srcAttr = lazy
    ? `data-src="${esc(primaryUrl)}"`
    : `src="${esc(primaryUrl)}"`;
  const mediaBlock = isVideo
    ? `<video class="reel-video" ${srcAttr} loop playsinline preload="none" data-user-muted="false"
            onclick="window._toggleReelMute(this)"></video>`
    : `<img class="reel-video reel-photo-fit" ${srcAttr} ${lazy ? 'loading="lazy"' : ""} alt="${esc(d.title)}">`;

  return `
    <div class="reel-card" id="reel-card-${escAttr(id)}">
        ${mediaBlock}
        <div class="reel-actions">
            <button onclick="likePost('${escAttr(id)}', this)" data-liked="${isLiked ? "true" : "false"}" class="reel-action-btn flex flex-col items-center">
                <i class="${heartClass} text-2xl"></i>
                <span class="like-count text-white text-[10px] font-bold mt-1">${displayLikes}</span>
            </button>
            <button onclick="toggleComments('${escAttr(id)}')" class="reel-action-btn flex flex-col items-center">
                <i class="far fa-comment text-2xl text-white"></i>
                <span class="comment-count-${escAttr(id)} text-white text-[10px] font-bold mt-1">${displayComments}</span>
            </button>
            <button id="reel-cart-icon-${escAttr(id)}" onclick="window.toggleCartItem('${escAttr(id)}')" class="reel-action-btn">
                <i class="${bookmarkClass} text-2xl"></i>
            </button>
            <button onclick="sharePost('${escAttr(id)}', '${escAttr(d.title)}')" class="reel-action-btn">
                <i class="far fa-paper-plane text-2xl text-white"></i>
            </button>
            ${deleteBlock}
        </div>

        <div class="reel-info">
            <div class="feed-profile-trigger flex items-center gap-2 mb-1.5 cursor-pointer" data-user-id="${escAttr(d.user_id)}">
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
                    inputmode="text"
                    maxlength="500"
                    placeholder="Add a comment…"
                    class="comment-input-field flex-1 bg-white/10 border border-white/20 text-white text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-amber-400 transition"
                    oninput="window._syncCommentSendState('${escAttr(id)}', this)"
                    onkeydown="if(event.key==='Enter') window.submitCommentFromInput('${escAttr(id)}', this)"
                >
                <button id="cancel-reply-${escAttr(id)}" onclick="window.cancelCommentReply('${escAttr(id)}')" class="hidden text-[10px] text-white/60 hover:text-white px-1">✕</button>
                <button
                    id="comment-send-${escAttr(id)}"
                    disabled
                    onclick="window._submitFromSendBtn('${escAttr(id)}')"
                    class="comment-send-btn shrink-0 w-8 h-8 rounded-xl bg-amber-400 text-black flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
                    aria-label="Send comment"
                >
                    <i class="fas fa-paper-plane text-[11px]"></i>
                </button>
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
  // behind with the same ID. Also tear down the realtime comments
  // channel here — this function runs on every tab switch back to
  // Reels, every refresh, and every pagination load, so leaving the
  // channel running against a node that's about to be deleted was the
  // most frequently-hit path behind comments looking frozen/stuck on
  // stale content: the subscription kept firing in the background,
  // updating a DOM node nobody could see or that no longer existed.
  document
    .querySelectorAll("body > .reel-comments")
    .forEach((el) => el.remove());
  openCommentIds.clear();
  if (currentCommentsChan) {
    supabase.removeChannel(currentCommentsChan);
    currentCommentsChan = null;
  }

  // Fix: caching the post-filter into this module-scope list (set on
  // each applyFeedRankingToCache() pass) is a measurable win — every
  // tab/render that falls through to renderReelsFeed() previously
  // re-walked allCachedPosts filtering video posts; with deep scrolled
  // feeds this is several hundred element ops per realtime refresh.
  // The cache is invalidated automatically whenever allCachedPosts is
  // replaced (subscribeFeed, followingFeed, refresh paths) so it's
  // always consistent.
  const reels =
    allReelsCache &&
    allReelsCache.length &&
    allReelsCache.every((p) => p?.data?.media_type === "video")
      ? allReelsCache
      : allCachedPosts.filter(({ data: d }) => d.media_type === "video");

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
    .map(({ id, data: d }) => renderReelCard(id, d, true))
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
  // Fix: this used to compare p.id === postId directly — p.id is the raw
  // bigint from the DB while postId is always a string (read out of an
  // HTML onclick attribute), so this comparison almost never matched and
  // the code fell through to a fragile DOM-scraping fallback below every
  // single time. That's exactly why "Add to Cart"/bookmarking looked
  // broken or inconsistent — it was silently guessing at the title/price
  // from whatever text happened to be in the card's DOM instead of using
  // the real post data.
  const found = allCachedPosts.find(
    (p) => idKey(p.id) === idKey(postId) || idKey(p.data?.id) === idKey(postId),
  );
  if (found) postRecord = found.data ? found.data : found;

  // Fix (Item 1): if the post isn't in the in-memory cache (realtime
  // INSERT just fired, or the bookmark card was built outside the feed),
  // look the row up directly from Supabase before falling back to DOM
  // scraping — saving into localStorage still works either way, but
  // without this path Add to Chart threw "Cannot link listing instance
  // data." on any card whose post wasn't yet in allCachedPosts.
  if (!postRecord && typeof supabase !== "undefined") {
    try {
      const { data: row } = await supabase
        .from("posts")
        .select(FEED_SELECT_COLUMNS)
        .eq("id", postId)
        .maybeSingle();
      if (row) {
        postRecord = row;
        allCachedPosts.push({ id: postId, data: row });
      }
    } catch (_) {
      /* fall through to DOM fallback */
    }
  }

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
        media_url: "",
        media_type: "image",
        institution: "",
        type: "product",
        user_id: "",
        user_name: nameEl?.textContent || "Student",
        user_avatar: "",
      };
    }
  }

  if (!postRecord) {
    // Final guard so any unexpected shape cannot throw past here and
    // leave the UI in the "Something went wrong" state the user saw.
    try {
      showToast("Couldn't save that — please try again.");
    } catch (_) {
      /* toast helper not ready */
    }
    return;
  }

  const index = userCartList.findIndex(
    (item) => idKey(item.id) === idKey(postId),
  );
  const isRemoving = index > -1;

  // 1. Optimistic UI: Handle local mutations instantly
  if (isRemoving) {
    userCartList.splice(index, 1);
    showToast("Removed from Cart");
  } else {
    userCartList.push({
      id: postId,
      title: postRecord.title,
      price: postRecord.price,
      media_url: postRecord.media_url || "",
      media_type: postRecord.media_type || "image",
      institution: postRecord.institution || "",
      type: postRecord.type || "product",
      user_id: postRecord.user_id || "",
      user_name: postRecord.user_name || "Anonymous",
      user_avatar: postRecord.user_avatar || "",
    });
    showToast("Added to Cart ✓");
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

  // Fix: the reel card's bookmark button had no id at all, so tapping
  // it on the Reels tab correctly saved the item (toast showed, data
  // persisted) but the icon on screen never visually flipped between
  // outline/filled — it silently "worked" with zero visible feedback,
  // which read as the feature not doing anything.
  const reelIcon = document
    .getElementById(`reel-cart-icon-${postId}`)
    ?.querySelector("i");
  if (reelIcon) {
    reelIcon.className = !isRemoving
      ? "fas fa-bookmark text-amber-400 text-2xl"
      : "far fa-bookmark text-white text-2xl";
  }

  const detailBtn = document.getElementById(`detail-cart-btn-${postId}`);
  if (detailBtn) {
    const labelText = detailBtn.querySelector(".cart-btn-label");
    if (labelText)
      labelText.textContent = !isRemoving ? "✓ In Cart" : "Add to Cart";
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
  //
  // Fix: a failure here used to only log a console warning — the bookmark
  // icon, the toast, and userCartList had already all been updated
  // optimistically above with no way to know the write never actually
  // reached the database. The item would then look "added" until the
  // next reload silently re-synced against the real `saves` table and
  // made it vanish again — exactly the "Add to Cart isn't working"
  // symptom. Now a real failure rolls back every part of the optimistic
  // update and tells the person plainly, instead of drifting silently.
  try {
    if (isRemoving) {
      const { error } = await supabase
        .from("saves")
        .delete()
        .eq("user_id", currentUserData.id)
        .eq("post_id", postId);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("saves")
        .insert({ user_id: currentUserData.id, post_id: postId });
      // A duplicate save (e.g. a fast double-tap) isn't a real
      // failure — the row already exists, which is what we wanted.
      const isDuplicate = error && error.code === "23505";
      if (error && !isDuplicate) throw error;
    }
  } catch (err) {
    console.error("Saves table sync failed — reverting bookmark UI:", err);

    if (isRemoving) {
      userCartList.splice(index, 0, {
        id: postId,
        title: postRecord.title,
        price: postRecord.price,
        media_url: postRecord.media_url || "",
        media_type: postRecord.media_type || "image",
        institution: postRecord.institution || "",
        type: postRecord.type || "product",
        user_id: postRecord.user_id || "",
        user_name: postRecord.user_name || "Anonymous",
        user_avatar: postRecord.user_avatar || "",
      });
    } else {
      const revertIndex = userCartList.findIndex(
        (item) => idKey(item.id) === idKey(postId),
      );
      if (revertIndex > -1) userCartList.splice(revertIndex, 1);
    }
    localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));

    const revertedIsSaved = isRemoving; // if we were removing, it's back to saved; if we were adding, it's back to unsaved
    if (feedIcon)
      feedIcon.className = revertedIsSaved
        ? "fas fa-bookmark text-amber-400"
        : "far fa-bookmark text-slate-300";
    if (gridBtn)
      gridBtn.className = revertedIsSaved
        ? "fas fa-bookmark text-amber-400 text-xs"
        : "far fa-bookmark text-white/80 text-xs";
    if (reelIcon)
      reelIcon.className = revertedIsSaved
        ? "fas fa-bookmark text-amber-400 text-2xl"
        : "far fa-bookmark text-white text-2xl";
    if (detailBtn) {
      const labelText = detailBtn.querySelector(".cart-btn-label");
      if (labelText)
        labelText.textContent = revertedIsSaved ? "✓ In Cart" : "Add to Cart";
    }
    if (
      !document.getElementById("cart-container")?.classList.contains("hidden")
    ) {
      renderCartListView();
    }

    showToast("Couldn't save that — please try again.");
  }
};

async function hydrateCartItemsFromSource() {
  if (!userCartList.length) return;

  const localSources = new Map();
  allCachedPosts.forEach((entry) => {
    const d = entry?.data || entry;
    const key = idKey(entry?.id || d?.id);
    if (key) localSources.set(key, d);
  });

  const missingIds = [];
  let changed = false;

  userCartList = userCartList.map((item) => {
    const key = idKey(item.id);
    const source = localSources.get(key);
    if (source) {
      const next = {
        ...item,
        title: item.title || source.title || "Campus Item",
        price: item.price || source.price || 0,
        media_url: item.media_url || source.media_url || "",
        media_type: item.media_type || source.media_type || "image",
        institution: item.institution || source.institution || "",
        type: item.type || source.type || "product",
        user_id: item.user_id || source.user_id || "",
        user_name: item.user_name || source.user_name || "Anonymous",
        user_avatar: item.user_avatar || source.user_avatar || "",
      };
      if (JSON.stringify(next) != JSON.stringify(item)) changed = true;
      return next;
    }

    if (!item.user_id || !item.user_name || !item.media_url) {
      missingIds.push(item.id);
    }
    return item;
  });

  if (missingIds.length) {
    try {
      const { data, error } = await supabase
        .from("posts")
        .select(
          "id, title, price, media_url, media_type, institution, type, user_id, user_name, user_avatar",
        )
        .in("id", missingIds);
      if (error) throw error;
      const dbById = new Map((data || []).map((row) => [idKey(row.id), row]));
      userCartList = userCartList.map((item) => {
        const source = dbById.get(idKey(item.id));
        if (!source) return item;
        changed = true;
        return {
          ...item,
          title: source.title || item.title || "Campus Item",
          price: source.price ?? item.price ?? 0,
          media_url: source.media_url || item.media_url || "",
          media_type: source.media_type || item.media_type || "image",
          institution: source.institution || item.institution || "",
          type: source.type || item.type || "product",
          user_id: source.user_id || item.user_id || "",
          user_name: source.user_name || item.user_name || "Anonymous",
          user_avatar: source.user_avatar || item.user_avatar || "",
        };
      });
    } catch (err) {
      console.warn("Cart hydration skipped:", err);
    }
  }

  if (changed) {
    localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
  }
}

function getValidCartItems() {
  const validItems = userCartList.filter((item) => item && item.id != null);
  if (validItems.length !== userCartList.length) {
    userCartList = validItems;
    try {
      localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
    } catch (_) {}
  }
  return validItems;
}

function buildCartListMarkup() {
  const validItems = getValidCartItems();
  if (validItems.length === 0) {
    return `
            <div class="p-6 text-center bg-slate-900 border border-slate-800/70 rounded-3xl space-y-2">
                <p class="text-white font-black text-sm uppercase tracking-wider">No saved items yet</p>
                <p class="text-slate-500 text-xs">Bookmark listings to keep them here for later.</p>
            </div>`;
  }

  const summary = `
        <div class="saved-items-summary">
            <div class="min-w-0">
                <p class="text-white font-black text-sm uppercase tracking-wider">${validItems.length} saved item${validItems.length === 1 ? "" : "s"}</p>
                <p class="text-slate-400 text-[11px]">Quick reopen, compare, or message the seller from one place.</p>
            </div>
            <span class="saved-item-meta-chip shrink-0"><i class="fas fa-bookmark text-amber-400"></i> Saved</span>
        </div>`;

  const cards = validItems
    .map((item) => {
      let firstUrl = item.media_url || "";
      if (firstUrl.startsWith("[")) {
        try {
          firstUrl = JSON.parse(firstUrl)[0] || "";
        } catch (_) {
          /* leave as-is */
        }
      }
      const isVideo = item.media_type === "video";
      const canContact =
        !!item.user_id &&
        (!currentUserData || idKey(item.user_id) !== idKey(currentUserData.id));
      const typeLabel = item.type === "skill" ? "Service" : "Product";
      const institution = item.institution
        ? esc(item.institution)
        : "Campus listing";
      const thumb = firstUrl
        ? `<div class="saved-item-thumb relative">
                   <img src="${esc(firstUrl)}" onerror="this.parentElement.innerHTML='<i class=\'fas fa-image text-slate-600\'></i>'; this.parentElement.classList.add('flex','items-center','justify-center');" class="w-full h-full object-cover" alt="">
                   ${isVideo ? `<div class="absolute inset-0 flex items-center justify-center bg-black/35"><i class="fas fa-play text-white text-xs"></i></div>` : ""}
               </div>`
        : `<div class="saved-item-thumb flex items-center justify-center text-slate-600"><i class="fas fa-image"></i></div>`;

      return `
        <div class="saved-item-card space-y-3">
            <div class="flex items-start gap-3">
                ${thumb}
                <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                            <div class="flex flex-wrap items-center gap-2 mb-2">
                                <span class="saved-item-meta-chip">${typeLabel}</span>
                                <span class="text-[10px] uppercase tracking-widest text-slate-500 font-bold truncate max-w-[170px]">${institution}</span>
                            </div>
                            <button onclick="openDetail('${escAttr(item.id)}')" class="text-left block w-full">
                                <p class="text-white font-black text-sm leading-tight line-clamp-2">${esc(item.title || "Campus Item")}</p>
                            </button>
                            <p class="text-amber-400 font-extrabold text-sm mt-1">GH₵${esc(String(item.price ?? 0))}</p>
                            ${item.user_name ? `<p class="text-slate-400 text-[11px] truncate mt-1">Seller: ${esc(item.user_name)}</p>` : ""}
                        </div>
                        <button onclick="window.toggleCartItem('${escAttr(item.id)}')" class="w-9 h-9 rounded-full bg-slate-950 border border-slate-800 text-red-400 shrink-0 active:scale-95 transition" aria-label="Remove saved item">
                            <i class="fas fa-trash-can text-xs"></i>
                        </button>
                    </div>
                </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button onclick="openDetail('${escAttr(item.id)}')" class="w-full bg-slate-800 border border-slate-700 text-white font-black py-2.5 rounded-xl text-[11px] uppercase tracking-wider active:scale-[0.98] transition">
                    View Details
                </button>
                ${
                  canContact
                    ? `<button onclick="contactSeller('${escAttr(item.user_id)}', '${escAttr(item.user_name || "Seller")}', '${escAttr(item.user_avatar || "")}', '${escAttr(item.title || "Listing")}', '${escAttr(item.id)}')" class="w-full bg-amber-400 text-black font-black py-2.5 rounded-xl text-[11px] uppercase tracking-wider active:scale-[0.98] transition">
                        Contact Seller
                    </button>`
                    : `<button disabled class="w-full bg-slate-900 border border-slate-800 text-slate-500 font-black py-2.5 rounded-xl text-[11px] uppercase tracking-wider cursor-not-allowed">
                        ${currentUserData && item.user_id && idKey(item.user_id) === idKey(currentUserData.id) ? "Your Listing" : "Contact Unavailable"}
                    </button>`
                }
            </div>
        </div>`;
    })
    .join("");

  return `${summary}<div class="space-y-3">${cards}</div>`;
}

async function renderCartListView() {
  await hydrateCartItemsFromSource();
  const markup = buildCartListMarkup();
  ["cart-items-wrapper", "profile-saved-items-wrapper"].forEach((id) => {
    const container = document.getElementById(id);
    if (container) container.innerHTML = markup;
  });

  const validCount = getValidCartItems().length;
  ["profile-saved-count", "profile-saved-count-pill"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(validCount);
  });
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

const followInFlight = new Set();

window.toggleFollow = async function (targetUserId, targetName, targetAvatar) {
  // Fix: native alert() replaced with showToast for consistency.
  if (!currentUserData) {
    showToast("Please sign in to follow.");
    return;
  }
  if (targetUserId === currentUserData.id) return;

  // Fix: rapid double-tapping Follow/Unfollow could fire two overlapping
  // requests before the first one's "am I already following?" check
  // resolved, causing a duplicate follow row (or a delete racing an
  // insert) — same in-flight guard pattern as likePost's likeInFlight.
  const key = idKey(targetUserId);
  if (followInFlight.has(key)) return;
  followInFlight.add(key);

  try {
    const { data: existing } = await supabase
      .from("follows")
      .select("id")
      .eq("follower_id", currentUserData.id)
      .eq("following_id", targetUserId)
      .maybeSingle();

    if (existing) {
      const { error: delError } = await supabase
        .from("follows")
        .delete()
        .eq("id", existing.id);
      if (delError) {
        console.error("Unfollow failed:", delError);
        showToast("Couldn't unfollow. Try again.");
        return;
      }
      updateFollowButtons(targetUserId, false);
    } else {
      const metadata = currentUserData.user_metadata || {};
      const { error: insertError } = await supabase.from("follows").insert({
        follower_id: currentUserData.id,
        follower_name: metadata.full_name || "Student",
        follower_avatar: metadata.avatar_url || "",
        following_id: targetUserId,
        following_name: targetName,
        following_avatar: targetAvatar,
        created_at: new Date().toISOString(),
      });
      if (insertError) {
        console.error("Follow failed:", insertError);
        showToast("Couldn't follow. Try again.");
        return;
      }
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
  } finally {
    followInFlight.delete(key);
  }
};

function updateFollowButtons(targetUserId, isFollowing) {
  const key = idKey(targetUserId);
  if (isFollowing) followingUserIds.add(key);
  else followingUserIds.delete(key);

  const cardClass = isFollowing
    ? "follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600 ml-2"
    : "follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700 ml-2";

  const detailClass = isFollowing
    ? "follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600"
    : "follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-amber-400 text-black";

  const gridClass = isFollowing
    ? "w-full mt-1.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600"
    : "w-full mt-1.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700";

  const label = isFollowing ? "✓ Following" : "+ Follow";

  document
    .querySelectorAll(`[data-follow-uid="${CSS.escape(targetUserId)}"]`)
    .forEach((btn) => {
      btn.textContent = label;
      btn.dataset.active = String(isFollowing);
      if (btn.id === "follow-btn-detail") {
        btn.className = detailClass;
      } else if (btn.closest(".masonry-card, .masonry-card-service")) {
        btn.className = gridClass;
      } else {
        btn.className = cardClass;
      }
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

// Shared delete implementation: removes the post's media from storage,
// deletes the DB row (scoped to the current user so someone can't delete
// another person's post even by guessing an id), and cleans up any local
// caches that reference it. Used by both the single-post delete (options
// menu) and the "My Gigs & Posts" bulk delete, so there's exactly one
// place that knows how to fully remove a post.
async function attemptSoftArchivePost(postId) {
  const archiveAttempts = [
    { is_archived: true, archived_at: new Date().toISOString() },
    { status: "archived", archived_at: new Date().toISOString() },
    { status: "archived" },
    { is_archived: true },
  ];

  for (const payload of archiveAttempts) {
    const { error } = await supabase
      .from("posts")
      .update(payload)
      .eq("id", postId)
      .eq("user_id", currentUserData.id);
    if (!error) return true;
  }

  return false;
}

// ─── ARCHIVED POSTS: view + restore ─────────────────────────────────────────
// The archive column has existed since the delete/auto-moderation flows
// were built, but until now there was no way to see or undo it — a
// deleted-by-mistake post, or one auto-hidden by a bad-faith report
// pile-on, was recoverable in the database but invisible in the app.
// This closes that loop: a dedicated view lists a person's own archived
// posts, with a one-tap restore.
window.restorePost = async function (postId) {
  if (!currentUserData) return;
  try {
    // Read the current status BEFORE overwriting it — this is the
    // only way to tell "this was auto-hidden by reports" apart from
    // "the owner deleted it themselves", since both end up as
    // is_archived = true and the distinguishing status value would
    // otherwise be gone the instant the restore update runs.
    const { data: current } = await supabase
      .from("posts")
      .select("status")
      .eq("id", postId)
      .maybeSingle();
    const wasReportTriggered = current?.status === "archived_auto_reported";

    const { error } = await supabase
      .from("posts")
      .update({ is_archived: false, archived_at: null, status: "active" })
      .eq("id", postId)
      .eq("user_id", currentUserData.id);
    if (error) throw error;

    // Quiet audit trail, logging only — never blocks the restore
    // itself. Only report-triggered restores are logged; a person
    // restoring their own plain delete needs no scrutiny. This
    // exists so a moderation process, if one gets built later, has
    // real history to look back on instead of starting from zero.
    // Fire-and-forget: a logging failure should never surface as if
    // the restore itself failed, since the restore already succeeded
    // by this point.
    if (wasReportTriggered) {
      supabase
        .from("restore_audit_log")
        .insert({
          post_id: String(postId),
          restored_by: currentUserData.id,
          was_report_triggered: true,
          restored_at: new Date().toISOString(),
        })
        .then(({ error: logErr }) => {
          if (logErr)
            console.warn("Restore audit log failed (non-fatal):", logErr);
        });
    }

    showToast("Post restored — back in your feed.");
    // Refresh whichever view is currently showing archived posts so
    // the restored item disappears from this list immediately,
    // and refresh the main profile grid so it reappears there too.
    if (
      document
        .getElementById("info-sheet-overlay")
        ?.classList.contains("sheet-open")
    ) {
      window.openInfoSheet("archived");
    }
    loadProfileStats();
  } catch (err) {
    console.warn("Restore failed:", err);
    showToast("Couldn't restore that post — try again.");
  }
};

async function fetchArchivedPosts() {
  if (!currentUserData) return [];
  try {
    const { data, error } = await supabase
      .from("posts")
      .select("id, title, media_url, media_type, price, archived_at")
      .eq("user_id", currentUserData.id)
      .eq("is_archived", true)
      .order("archived_at", { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn("Archived posts fetch failed:", err);
    return [];
  }
}

async function _deletePostById(postId) {
  const { data: currentPost, error: fetchErr } = await supabase
    .from("posts")
    .select("media_url")
    .eq("id", postId)
    .single();

  if (fetchErr) throw fetchErr;

  const archived = await attemptSoftArchivePost(postId);
  if (archived) {
    const cartIndex = userCartList.findIndex(
      (item) => idKey(item.id) === idKey(postId),
    );
    if (cartIndex > -1) {
      userCartList.splice(cartIndex, 1);
      localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
    }
    allCachedPosts = allCachedPosts.filter(
      (item) => idKey(item.id) !== idKey(postId),
    );
    return { mode: "archived" };
  }

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

  // Fix: deleting a post used to leave every like, comment, and save
  // pointing at it behind as an orphaned row — nothing here ever
  // cleaned those up. A like row surviving its post's deletion is
  // exactly what caused a confusing false "this is already liked"
  // duplicate-key conflict later, on an entirely unrelated test,
  // since the row was still sitting in the likes table with no post
  // left to belong to. Comments on the deleted post need their own
  // comment_likes cleared first (comment_likes references comments,
  // not posts, so it isn't reachable by post_id directly).
  const { data: doomedComments } = await supabase
    .from("comments")
    .select("id")
    .eq("post_id", idKey(postId));
  if (doomedComments?.length) {
    const commentIds = doomedComments.map((c) => c.id);
    await supabase.from("comment_likes").delete().in("comment_id", commentIds);
  }
  await supabase.from("comments").delete().eq("post_id", idKey(postId));
  await supabase.from("likes").delete().eq("post_id", postId);
  await supabase.from("saves").delete().eq("post_id", postId);

  const { error: dbDeleteErr } = await supabase
    .from("posts")
    .delete()
    .eq("id", postId)
    .eq("user_id", currentUserData.id);

  if (dbDeleteErr) throw dbDeleteErr;

  const cartIndex = userCartList.findIndex(
    (item) => idKey(item.id) === idKey(postId),
  );
  if (cartIndex > -1) {
    userCartList.splice(cartIndex, 1);
    localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
  }

  allCachedPosts = allCachedPosts.filter(
    (item) => idKey(item.id) !== idKey(postId),
  );
  return { mode: "deleted" };
}

window.deletePost = function (postId) {
  if (!currentUserData) return;

  showConfirmDialog({
    title: "Archive this listing?",
    message:
      "Uni-Sync now tries a safer archive-first workflow. If your database doesn't support archiving yet, it falls back to permanent deletion.",
    confirmLabel: "Archive",
    danger: true,
    onConfirm: async () => {
      try {
        const result = await _deletePostById(postId);
        showToast(
          result?.mode === "archived"
            ? "Listing archived successfully! ✓"
            : "Post deleted successfully! ✓",
        );
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
  const myGeneration = _feedLoadGeneration;

  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  feed.classList.remove("grid-mode", "reels-mode");
  pauseAllReelVideos();
  feed.innerHTML =
    '<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading following feed...</div>';

  feedLoadedCount = 0;
  feedHasMore = true;
  followingFeedCursor = null;

  try {
    const { data: followingData } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", currentUserData.id);

    if (myGeneration !== _feedLoadGeneration) return; // superseded by a newer tab switch

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
      .select(FEED_SELECT_COLUMNS)
      .eq("is_archived", false)
      .in("user_id", followingFeedIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(FEED_PAGE_SIZE);

    if (error) throw error;
    if (myGeneration !== _feedLoadGeneration) return; // superseded by a newer tab switch

    if (!posts || posts.length === 0) {
      feed.innerHTML =
        '<div class="text-center py-12 text-slate-500 text-sm">People you follow haven\'t posted yet.</div>';
      return;
    }

    allCachedPosts = posts.map((item) => ({ id: item.id, data: item }));
    feedLoadedCount = posts.length;
    feedHasMore = posts.length === FEED_PAGE_SIZE;
    updateFeedCursorFromPosts(posts, "following");
    applyFeedRankingToCache();

    feed.innerHTML =
      posts.map((d) => renderFeedCard(d.id, d)).join("") +
      `
            <div id="feed-load-more-sentinel" class="py-6">
                ${feedHasMore ? "" : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`}
            </div>`;
    posts.forEach((d) => {
      wireCarouselCounters(d.id);
      fetchAndCacheCommentCount(d.id);
    });

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
    let followingQuery = supabase
      .from("posts")
      .select(FEED_SELECT_COLUMNS)
      .eq("is_archived", false)
      .in("user_id", followingFeedIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    followingQuery = applyCursorToPostQuery(
      followingQuery,
      followingFeedCursor,
    ).limit(FEED_PAGE_SIZE);
    const { data: posts, error } = await followingQuery;

    if (error) throw error;

    const existingIds = new Set(allCachedPosts.map((p) => p.id));
    const newItems = (posts || [])
      .filter((item) => !existingIds.has(item.id))
      .map((item) => ({ id: item.id, data: item }));

    allCachedPosts = allCachedPosts.concat(newItems);
    feedLoadedCount += (posts || []).length;
    feedHasMore = (posts || []).length === FEED_PAGE_SIZE;
    updateFeedCursorFromPosts(posts || [], "following");
    applyFeedRankingToCache();

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

  // Blocking a user should hide their posts everywhere in the app —
  // rather than patching every fetch site that populates
  // allCachedPosts (subscribeFeed, loadNextFeedPage, loadFollowingFeed,
  // loadNextFollowingPage, search, etc.) individually and risking one
  // being missed later, this single filter runs right before anything
  // paints to the screen, so it's a guarantee regardless of which path
  // put a post in the cache.
  if (blockedUserIds.size > 0) {
    allCachedPosts = allCachedPosts.filter(
      ({ data: d }) => !blockedUserIds.has(idKey(d.user_id)),
    );
  }

  // Reels tab: full-bleed vertical video feed, TikTok-style
  if (currentFeedType === "reels") {
    renderReelsFeed();
    // Fix: same reels-cache reuse as renderReelsFeed() above; if a
    // fresh reels list was already built, iterate it directly instead
    // of re-filtering.
    const videos =
      allReelsCache && allReelsCache.length
        ? allReelsCache
        : allCachedPosts.filter(({ data: d }) => d.media_type === "video");
    videos.forEach(({ id }) => fetchAndCacheCommentCount(id));
    return;
  }

  // Any time we're NOT rendering reels, make sure no reel video is still
  // playing audio in the background (e.g. switching All -> Products).
  pauseAllReelVideos();

  // Products tab renders as a masonry grid instead of the snap-scroll feed
  if (currentFeedType === "product") {
    renderProductGrid();
    return;
  }

  // Services tab: same masonry idea as Products, but its own card style
  // (slightly bigger, per request) and its own continuous-scroll viewer
  // on tap instead of the single-post detail view.
  if (currentFeedType === "skill") {
    renderServiceGrid();
    return;
  }

  feed.classList.remove("grid-mode", "reels-mode");

  // Deals tab: shows every post with an active flash sale
  // (original_price != price and sale_ends_at still in the future),
  // hidden the moment no qualifying post exists OR the timer expires.
  // Renders in the same masonry style as Products/All/feed so desktop
  // and mobile get a consistent visual treatment.
  if (currentFeedType === "deals") {
    renderDealsGrid();
    return;
  }

  if (allCachedPosts.length === 0) {
    const isScopedEmpty =
      currentCampusScope !== "everywhere" &&
      currentUserData?.institution &&
      currentFeedType !== "following";
    feed.innerHTML = isScopedEmpty
      ? `
            <div class="text-center py-16 space-y-3 px-6">
                <p class="text-4xl">📭</p>
                <p class="font-bold text-white">No posts found</p>
                ${buildScopeWidenPrompt({ contextLabel: "posts" })}
            </div>`
      : `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📭</p>
                <p class="font-bold text-white">No posts yet</p>
                <p class="text-slate-500 text-xs">Be the first to post on campus!</p>
            </div>`;
    return;
  }

  const canWiden =
    currentCampusScope !== "everywhere" &&
    currentUserData?.institution &&
    currentFeedType !== "following";
  const sentinelHtml = `
        <div id="feed-load-more-sentinel" class="py-6 text-center space-y-2 px-6">
            ${
              feedHasMore
                ? ""
                : canWiden
                  ? buildScopeWidenPrompt({ contextLabel: "posts" })
                  : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`
            }
        </div>`;

  // Single assignment: build every card's HTML into one string first,
  // then set innerHTML exactly once. Wiring (carousel counters, comment
  // count fetches) happens afterward, over the now-rendered nodes —
  // splitting render from wiring means the browser only ever parses
  // and lays out the feed HTML one time per load, not once per card.
  const isAllTab = currentFeedType === "all";
  feed.classList.toggle("grid-mode", isAllTab);
  const cardRenderer = isAllTab ? renderFeedMasonryCard : renderFeedCard;
  const regularCardsHtml = allCachedPosts.map(({ id, data: d }) =>
    cardRenderer(id, d),
  );
  feed.innerHTML = isAllTab
    ? `<div class="masonry-columns-feed py-2">${regularCardsHtml.join("")}</div>${sentinelHtml}`
    : regularCardsHtml.join("") + sentinelHtml;

  // Instagram-style Suggested Reels: woven into the All tab specifically,
  // at semi-random spacing rather than a fixed slot (see
  // interleaveSuggestedReels). Fetched and spliced in after the regular
  // feed has already painted, so this never delays the primary content.
  if (currentFeedType === "all" && allCachedPosts.length > 0) {
    const myGeneration = _feedLoadGeneration;
    fetchSuggestedReelsPool().then((pool) => {
      if (myGeneration !== _feedLoadGeneration) return; // superseded by a newer tab switch
      const currentFeed = document.getElementById("posts-feed");
      if (!currentFeed || currentFeedType !== "all") return;

      const alreadyShownIds = new Set(
        allCachedPosts.map(({ id }) => idKey(id)),
      );
      const regularCards = allCachedPosts.map(({ id, data: d }) =>
        renderFeedMasonryCard(id, d),
      );
      const merged = interleaveSuggestedReels(
        regularCards,
        pool,
        alreadyShownIds,
      );
      currentFeed.innerHTML = `<div class="masonry-columns-feed py-2">${merged.join("")}</div>${sentinelHtml}`;

      allCachedPosts.forEach(({ id }) => {
        wireCarouselCounters(id);
        fetchAndCacheCommentCount(id);
      });
      setupFeedVideoObserver();
      setupFeedCommentAutoClose();
      setupFeedLoadMoreObserver();
    });
  }

  allCachedPosts.forEach(({ id }) => {
    wireCarouselCounters(id);
    fetchAndCacheCommentCount(id);
  });

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
              // Fix: this compared r.parent_comment_id === c.id
              // directly — r.parent_comment_id can come back from
              // the DB as a bigint, numeric string, normal string,
              // or null for top-level comments, while c.id is
              // usually a stringified bigint. === silently skipped
              // every reply whose id types didn't match exactly,
              // detaching reply chains on reload. Normalize both
              // sides through idKey() so the comparison is
              // type-independent (and also drop null entries here
              // since they're not replies).
              replies
                .filter(
                  (r) =>
                    r.parent_comment_id &&
                    idKey(r.parent_comment_id) === idKey(c.id),
                )
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

// Incremental counterpart to renderFeedFromCache, used by loadNextFeedPage
// once a new page of posts has been fetched and appended to
// allCachedPosts. Building and re-parsing the ENTIRE feed's HTML on every
// "load more" gets slower the longer a scroll session runs (500 existing
// cards re-rendered just to add 15 more) — this instead builds HTML for
// only the newly-fetched items and appends them to the existing DOM.
//
// Only handles the All / Products / Services tabs (the three that share
// loadNextFeedPage — Following has its own loadNextFollowingPage). Falls
// back to the full renderFeedFromCache() rebuild — same result as before
// this function existed, just slower for that one page — whenever
// something makes a safe incremental append not guaranteed correct:
// a blocked user's post in the new batch, a missing container, or (most
// importantly) applyFeedRankingToCache() having actually reordered
// previously-shown posts rather than just adding new ones at the end.
function appendFeedCards(newItems) {
  if (!newItems || newItems.length === 0) return;

  if (
    blockedUserIds.size > 0 &&
    newItems.some(({ data: d }) => blockedUserIds.has(idKey(d.user_id)))
  ) {
    renderFeedFromCache();
    return;
  }

  if (
    currentFeedType !== "all" &&
    currentFeedType !== "product" &&
    currentFeedType !== "skill"
  ) {
    renderFeedFromCache();
    return;
  }

  // Safety net: applyFeedRankingToCache() preserves prior order via
  // ordinal-tiebreaking whenever scores are equal, so new items land at
  // the end in the overwhelmingly common case — but a genuine score
  // change (e.g. an old post getting liked while a new page loads) can
  // still reorder existing entries. Detect that by checking whether the
  // already-displayed ids are still in the same relative order at the
  // front of allCachedPosts; if not, the DOM would silently drift out
  // of sync with the data, so fall back to a full rebuild instead.
  const displayedIds = Array.from(
    document.querySelectorAll(
      '#posts-feed [id^="feed-card-"], #posts-feed [id^="grid-card-"]',
    ),
  ).map((el) => el.id.replace(/^(feed|grid)-card-/, ""));

  if (displayedIds.length > 0) {
    const newIdSet = new Set(newItems.map(({ id }) => idKey(id)));
    const previousOrderIds = allCachedPosts
      .map(({ id }) => idKey(id))
      .filter((id) => !newIdSet.has(id));
    const stillInOrder =
      displayedIds.length <= previousOrderIds.length &&
      displayedIds.every((id, i) => id === previousOrderIds[i]);
    if (!stillInOrder) {
      renderFeedFromCache();
      return;
    }
  }

  const feed = document.getElementById("posts-feed");
  if (!feed) return;

  const isAllTab = currentFeedType === "all";
  let container,
    newCardsHtml = "";

  if (isAllTab) {
    container = feed.querySelector(".masonry-columns-feed");
    if (!container) {
      renderFeedFromCache();
      return;
    }
    const plainCardsHtml = newItems.map(({ id, data: d }) =>
      renderFeedMasonryCard(id, d),
    );
    // Cheap/cached after the initial load (see fetchSuggestedReelsPool's
    // 5-minute cache) — safe to call synchronously here without
    // triggering a second network round-trip or a follow-up reflow of
    // the whole feed the way the full-render path's async pool fetch does.
    const pool = suggestedReelsPool;
    const alreadyShownIds = new Set(allCachedPosts.map(({ id }) => idKey(id)));
    newCardsHtml = interleaveSuggestedReelsIncremental(
      plainCardsHtml,
      pool,
      alreadyShownIds,
    ).join("");
  } else if (currentFeedType === "product") {
    container = feed.querySelector(".masonry-columns");
    if (!container) {
      renderFeedFromCache();
      return;
    }
    const products = newItems.filter(
      ({ data: d }) => (d.type || "product") === "product",
    );
    if (products.length > 0)
      newCardsHtml = products
        .map(({ id, data: d }) => renderProductGridCard(id, d))
        .join("");
  } else {
    container = feed.querySelector(".masonry-columns-services");
    if (!container) {
      renderFeedFromCache();
      return;
    }
    const services = newItems.filter(({ data: d }) => d.type === "skill");
    if (services.length > 0)
      newCardsHtml = services
        .map(({ id, data: d }) => renderServiceGridCard(id, d))
        .join("");
  }

  // Fix: this used to early-return here when a batch had zero matching
  // items for the current tab (e.g. a page of mostly-Services posts
  // while on the Products tab), which skipped the sentinel refresh
  // below entirely and left it stuck on its "Loading more..." spinner
  // forever. Only skip the actual card insertion, not the state sync
  // that has to happen regardless of whether this batch had anything
  // to show.
  if (newCardsHtml) {
    container.insertAdjacentHTML("beforeend", newCardsHtml);
  }

  // The sentinel must stay the last element in #posts-feed for the
  // IntersectionObserver driving the next page load to keep triggering
  // correctly — re-append it after the newly-inserted cards rather than
  // leaving it wherever it ended up relative to the new container content.
  const sentinel = document.getElementById("feed-load-more-sentinel");
  if (sentinel) {
    feed.appendChild(sentinel);
    // Fix: the sentinel was left showing its "Loading more..." spinner
    // (set at the top of loadNextFeedPage) — refresh its content to
    // match the current feedHasMore state, same logic renderFeedFromCache
    // uses, so reaching the actual end of the feed on THIS load-more
    // shows "you're all caught up" instead of a stuck spinner.
    const canWiden =
      currentCampusScope !== "everywhere" &&
      currentUserData?.institution &&
      currentFeedType !== "following";
    sentinel.innerHTML = feedHasMore
      ? ""
      : canWiden
        ? buildScopeWidenPrompt({
            contextLabel:
              currentFeedType === "product"
                ? "products"
                : currentFeedType === "skill"
                  ? "services"
                  : "posts",
          })
        : `<p class="text-center text-slate-600 text-[10px] uppercase tracking-widest">You're all caught up ✓</p>`;
    // Re-attach the observer to the (repositioned) sentinel rather than
    // assuming an already-observed element keeps being watched after
    // appendChild moves it within the document — same call the
    // full-render path already makes after every render, so this stays
    // consistent instead of relying on an unverified DOM/Observer
    // interaction.
    setupFeedLoadMoreObserver();
  }

  if (newCardsHtml) {
    newItems.forEach(({ id }) => {
      wireCarouselCounters(id);
      fetchAndCacheCommentCount(id);
    });
    refreshFollowButtonStates();
  }
}

// Fix: this used to only ever apply for the All tab ('feed-tab-all'),
// even though Products and Services also render the same multi-column
// masonry grid (see .masonry-columns / .masonry-columns-services) and
// need identical desktop widening — without this, switching to
// Products or Services left the grid stuck at the narrow ~520px
// reading-column width with a large unused gap on wider screens,
// since the CSS widening rules were only ever keyed to this one class.
// Pulled out into its own function (see navigateTo()) because these
// classes also need to be cleared when leaving the feed entirely —
// otherwise they stuck around on <body> and widened/hid things on
// Profile, DMs, Explore, etc. that were never meant to be affected.
function syncFeedTabBodyClasses(type) {
  const isGridTab =
    type === "all" ||
    type === "product" ||
    type === "skill" ||
    type === "deals";
  document.body.classList.toggle("feed-tab-all", type === "all");
  document.body.classList.toggle("feed-tab-grid", isGridTab);
  document.body.classList.toggle("feed-tab-deals", type === "deals");
}

// ─── 15. FILTERING ────────────────────────────────────────────────────────────
window.filterFeed = function (type, clickedBtn = null) {
  if (!isAuthInitialized) return;

  const previousType = currentFeedType;
  currentFeedType = type;
  _feedLoadGeneration++;

  syncFeedTabBodyClasses(type);

  if (
    typeof window.closeHeaderSearch === "function" &&
    !window._searchNavInProgress
  ) {
    window.closeHeaderSearch();
  }

  // Remember the active tab so a refresh lands back where the person
  // actually was (Reels, Products, Services, Following...) instead of
  // always resetting to "All".
  localStorage.setItem("campus_market_feed_tab", type);

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

    // "deals" isn't a real `type` column value — it's a flash-sale
    // attribute that can sit on ANY post type (product or skill).
    // Adding a `.eq("type", "deals")` filter here made the Deals tab's
    // query match zero rows every single time, so it always rendered
    // "No live deals right now" even when active flash sales existed.
    // renderDealsGrid() already does the actual flash-sale filtering
    // client-side once the (unfiltered-by-type) posts are cached.
    if (type !== "all" && type !== "product" && type !== "deals") {
      q = q.eq("type", type);
    }

    // Three-tier scoping: institution first (tightest), then region
    // (wider), then no filter at all for 'everywhere'. Falls through
    // gracefully to a looser tier if the person's profile is somehow
    // missing the field a tighter tier needs (e.g. no region saved),
    // rather than silently returning nothing.
    if (currentCampusScope === "institution" && currentUserData?.institution) {
      q = q.eq("institution", currentUserData.institution);
    } else if (currentCampusScope === "region" && currentUserData?.region) {
      q = q.eq("region", currentUserData.region);
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
// Builds the right "want to see more?" prompt HTML for whichever scope
// tier is currently active, so the same institution -> region ->
// everywhere logic doesn't need to be duplicated across every place a
// feed can run dry (empty-from-zero states AND the scroll-exhaustion
// prompt at the bottom of a populated feed both call this).
function buildScopeWidenPrompt({ contextLabel = "posts" } = {}) {
  if (currentCampusScope === "institution") {
    const hasRegion = !!currentUserData?.region;
    return `
            <p class="text-slate-500 text-xs">
                No more ${contextLabel} from ${esc(currentUserData.institution)}${hasRegion ? ` — want to see ${esc(currentUserData.region)}?` : " — want to see everywhere?"}
            </p>
            <button
                onclick="window.setCampusScope('${hasRegion ? "region" : "everywhere"}')"
                class="mt-2 bg-amber-400 text-black font-black px-5 py-2 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition"
            >
                ${hasRegion ? `Show ${esc(currentUserData.region)}` : "Show Everywhere"}
            </button>`;
  }

  if (currentCampusScope === "region") {
    return `
            <p class="text-slate-500 text-xs">
                No more ${contextLabel} from ${esc(currentUserData.region)} — want to see everywhere?
            </p>
            <button
                onclick="window.setCampusScope('everywhere')"
                class="mt-2 bg-amber-400 text-black font-black px-5 py-2 rounded-xl text-xs uppercase tracking-wider active:scale-95 transition"
            >
                Show Everywhere
            </button>`;
  }

  // Already at 'everywhere' — there's nothing wider to offer.
  return `<p class="text-slate-500 text-xs">That's everything for now.</p>`;
}

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
  if (currentCampusScope === "institution") {
    label.textContent = currentUserData.institution;
  } else if (currentCampusScope === "region" && currentUserData?.region) {
    label.textContent = currentUserData.region;
  } else {
    label.textContent = "Everywhere";
  }
}

// Cycles institution -> region -> everywhere -> back to institution,
// persists the choice, and re-runs the current tab's query with the new
// scope applied. Skips the region step entirely for anyone without a
// saved region (goes straight institution -> everywhere for them, same
// as the old two-tier behavior), so this never traps someone in a tier
// their profile can't actually support.
window.toggleCampusScope = function () {
  if (!currentUserData?.institution) return;

  const hasRegion = !!currentUserData?.region;
  if (currentCampusScope === "institution") {
    currentCampusScope = hasRegion ? "region" : "everywhere";
  } else if (currentCampusScope === "region") {
    currentCampusScope = "everywhere";
  } else {
    currentCampusScope = "institution";
  }
  localStorage.setItem("campus_market_scope", currentCampusScope);

  const scopeLabel =
    currentCampusScope === "institution"
      ? currentUserData.institution
      : currentCampusScope === "region"
        ? currentUserData.region
        : "everywhere";
  showToast(`Showing posts from ${scopeLabel}`);

  // Re-apply the current tab with the new scope. Reels/Following
  // aren't affected by scope, so nothing to re-run there — but this
  // button is hidden on those tabs anyway.
  if (["all", "product", "skill"].includes(currentFeedType)) {
    const clickedBtn = document.querySelector(".feed-tab-btn.text-amber-400");
    window.filterFeed(currentFeedType, clickedBtn);
  }
};

// Jumps directly to a specific scope tier (used by the end-of-feed
// "want to see more?" prompt, which offers a specific next tier rather
// than cycling blindly) — same persistence/re-run behavior as the
// regular toggle, just targeting an explicit tier instead of advancing
// by one step.
window.setCampusScope = function (scope) {
  if (!_validCampusScopes.includes(scope)) return;
  if (!currentUserData?.institution) return;

  currentCampusScope = scope;
  localStorage.setItem("campus_market_scope", currentCampusScope);

  const scopeLabel =
    scope === "institution"
      ? currentUserData.institution
      : scope === "region"
        ? currentUserData.region || "your region"
        : "everywhere";
  showToast(`Showing posts from ${scopeLabel}`);

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
    window._searchNavInProgress = true;
    window.navigateTo("feed");
    window._searchNavInProgress = false;
    return;
  }

  window._searchNavInProgress = true;
  window.navigateTo("explore");
  window._searchNavInProgress = false;
  resultsEl.innerHTML = `<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Searching Campus...</div>`;
  const lower = trimmedTerm.toLowerCase();

  // Fix: this used to only search allCachedPosts — whatever happened to
  // already be loaded client-side (capped at SEARCH_LIMIT, populated
  // from the most recent posts). Once the app has more posts than that
  // cap, searching for anything older/outside that window silently
  // returned "no results" even though the post genuinely existed. Now
  // queries the database directly for this specific term instead, so
  // search coverage no longer depends on what's already been scrolled
  // past or cached.
  //
  // PostgREST's .or() filter string is itself a small parsed grammar —
  // comma separates conditions and parentheses group them — so a term
  // containing either would corrupt the filter (or, worse, let someone
  // craft an unintended additional condition) if passed through as-is.
  // Strip them before building the query; every other character is
  // safe inside an ilike %...% wildcard.
  const safeTerm = trimmedTerm.replace(/[,()]/g, "").trim();
  let searchResults = [];

  if (safeTerm) {
    try {
      const orFilter = [
        "title",
        "description",
        "user_name",
        "institution",
        "region",
        "type",
      ]
        .map((col) => `${col}.ilike.%${safeTerm}%`)
        .join(",");

      const { data, error } = await supabase
        .from("posts")
        .select(FEED_SELECT_COLUMNS)
        .eq("is_archived", false)
        .or(orFilter)
        .order("created_at", { ascending: false })
        .limit(SEARCH_LIMIT);

      if (error) throw error;
      searchResults = (data || []).map((item) => ({ id: item.id, data: item }));
    } catch (e) {
      console.error("Search query error:", e);
      // Fix: previously any DB error here was silently swallowed and
      // allCachedPosts (whatever was already loaded) was searched
      // instead, with no indication anything had gone wrong — a
      // failed search looked identical to a search with no matches.
      // Fall back to searching the local cache so a transient error
      // doesn't leave the person with a dead search box, but tell
      // them results may be incomplete rather than staying silent.
      searchResults = allCachedPosts || [];
      showToast(
        "Couldn't reach the server — showing recently loaded posts only.",
      );
    }
  }

  // Same blocked-user filter the main feed applies (see
  // renderFeedFromCache) — a blocked user's posts shouldn't surface via
  // search either. This was a pre-existing gap (search never filtered
  // for this even before this function's DB-query rewrite above), fixed
  // here alongside it.
  if (blockedUserIds.size > 0) {
    searchResults = searchResults.filter(
      ({ data: d }) => !blockedUserIds.has(idKey(d.user_id)),
    );
  }

  // Smarter-search pass: instead of just filtering (arbitrary order —
  // effectively whatever order allCachedPosts happened to be in), each
  // match gets a relevance score and results are sorted by it. This is
  // still substring matching under the hood (no fuzzy/typo-tolerant
  // matching or semantic search — that needs either a Postgres full-text
  // search index via to_tsvector/tsquery, or an external search service,
  // neither of which this file can safely assume exists), but a title
  // match now correctly outranks a match buried in a long description,
  // and recency acts as a tiebreaker so identical-relevance results
  // don't feel randomly ordered.
  const scored = [];
  for (const item of searchResults) {
    const d = item.data ? item.data : item;
    if (!d) continue;

    const title = (d.title || "").toLowerCase();
    const description = (d.description || "").toLowerCase();
    const userName = (d.user_name || "").toLowerCase();
    const institution = (d.institution || "").toLowerCase();
    const type = (d.type || "").toLowerCase();
    const region = (d.region || "").toLowerCase();

    let score = 0;
    if (title === lower)
      score += 100; // exact title match
    else if (title.startsWith(lower))
      score += 60; // title starts with query
    else if (title.includes(lower)) score += 40; // query appears in title
    if (description.includes(lower)) score += 15;
    if (userName.includes(lower)) score += 10;
    if (type.includes(lower)) score += 8;
    if (institution.includes(lower)) score += 5;
    if (region.includes(lower)) score += 5;

    if (score > 0) scored.push({ item, score, createdAt: d.created_at || "" });
  }

  // Ties broken by recency (newest first) so fresh listings surface
  // ahead of stale ones with identical text relevance — same intent as
  // the blueprint's "feed decay" idea, applied to search instead of the
  // main feed, which already has its own decay ranking.
  scored.sort(
    (a, b) => b.score - a.score || (b.createdAt > a.createdAt ? 1 : -1),
  );
  const matches = scored.map((s) => s.item);

  if (matches.length === 0) {
    resultsEl.innerHTML = `
            <div class="text-center py-14 space-y-3">
                <p class="text-4xl">🔍</p>
                <p class="text-slate-400 font-bold text-sm">No results for "${esc(trimmedTerm)}"</p>
                <p class="text-slate-600 text-xs">Try searching for alternative keys, items, or skills</p>
                <button onclick="window.saveSearchAlert('${escAttr(trimmedTerm)}')" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-400 text-black text-[11px] font-black uppercase tracking-wider active:scale-95 transition"><i class="fas fa-bell"></i> Notify me when posted</button>
                ${renderSavedAlertPills(trimmedTerm)}
            </div>`;
    return;
  }

  resultsEl.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-3">
            <p class="text-[10px] text-slate-500 uppercase font-bold tracking-widest">
                ${matches.length} campus result${matches.length !== 1 ? "s" : ""} found
            </p>
            <button onclick="window.saveSearchAlert('${escAttr(trimmedTerm)}')" class="px-3 py-1.5 rounded-xl bg-slate-900 border border-amber-400/40 text-amber-300 text-[10px] font-black uppercase tracking-wider active:scale-95 transition"><i class="fas fa-bell mr-1"></i>Save alert</button>
        </div>
        ${renderSavedAlertPills(trimmedTerm)}`;

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

  // Flash sale is an optional attribute on any listing (not a separate
  // post type) — reuses the same original_price/sale_ends_at columns
  // and countdown-badge rendering already built for Manage Listing, so
  // a listing created with a flash sale looks and behaves identically
  // to one that had a sale added afterwards.
  const flashSaleEnabled = !!document.getElementById("postFlashSaleToggle")
    ?.checked;
  const originalPriceRaw = flashSaleEnabled
    ? document.getElementById("postOriginalPrice")?.value.trim() || ""
    : "";
  const saleEndsRaw = flashSaleEnabled
    ? document.getElementById("postSaleEndsAt")?.value || ""
    : "";
  const parsedOriginalPrice = originalPriceRaw
    ? parseFloat(originalPriceRaw)
    : null;
  if (
    flashSaleEnabled &&
    originalPriceRaw &&
    (isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0)
  ) {
    showToast("Flash sale original price can't be negative.");
    return;
  }
  if (parsedOriginalPrice !== null && parsedOriginalPrice > 1000000) {
    showToast("That original price seems too high — please double-check it.");
    return;
  }
  if (flashSaleEnabled && !saleEndsRaw) {
    showToast("Please set an end time for your flash sale, or turn it off.");
    return;
  }
  const saleEndsIso = saleEndsRaw ? new Date(saleEndsRaw).toISOString() : null;
  if (saleEndsIso && new Date(saleEndsIso).getTime() <= Date.now()) {
    showToast("Flash sale end time must be in the future.");
    return;
  }

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
  if (title.length > 100) {
    showToast("Title must be 100 characters or fewer.");
    return;
  }
  if (description && description.length > 2000) {
    showToast("Description must be 2000 characters or fewer.");
    return;
  }

  const parsedPrice = parseFloat(price);
  if (price && (isNaN(parsedPrice) || parsedPrice < 0)) {
    showToast("Price can't be negative.");
    return;
  }
  if (parsedPrice > 1000000) {
    showToast("Price seems too high — please double-check it.");
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
      price: parsedPrice || 0,
      original_price: parsedOriginalPrice,
      sale_ends_at: saleEndsIso,
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
    const flashToggleEl = document.getElementById("postFlashSaleToggle");
    if (flashToggleEl) flashToggleEl.checked = false;
    document.getElementById("postFlashSaleFields")?.classList.add("hidden");
    const originalPriceEl = document.getElementById("postOriginalPrice");
    if (originalPriceEl) originalPriceEl.value = "";
    const saleEndsEl = document.getElementById("postSaleEndsAt");
    if (saleEndsEl) saleEndsEl.value = "";

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
    const [followersRes, followingRes, postsRes, bioRes] = await Promise.all([
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("following_id", currentUserData.id),
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("follower_id", currentUserData.id),
      // Archived posts now live in their own view (Settings →
      // Archived Posts) rather than being mixed into this grid —
      // this filter is what makes that separation real instead of
      // cosmetic.
      supabase
        .from("posts")
        .select("id, title, media_url, media_type, price")
        .eq("user_id", currentUserData.id)
        .eq("is_archived", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("bio")
        .eq("id", currentUserData.id)
        .maybeSingle(),
    ]);

    currentUserData.bio = bioRes.data?.bio || "";
    const bioEl = document.getElementById("profile-ui-bio");
    if (bioEl) {
      if (currentUserData.bio) {
        bioEl.textContent = currentUserData.bio;
        bioEl.classList.remove("hidden");
      } else {
        bioEl.classList.add("hidden");
      }
    }

    const postsCount = postsRes.data ? postsRes.data.length : 0;
    setEl("profile-followers-count", followersRes.count || 0);
    setEl("profile-following-count", followingRes.count || 0);
    setEl("profile-posts-count", postsCount);

    // The grid is about to be rebuilt from scratch, so any select-mode
    // state (checkmarks, the toolbar) referring to the old tiles would
    // otherwise be left dangling.
    if (typeof window.exitGridSelectMode === "function")
      window.exitGridSelectMode();

    // Cached so shareSelectedGridItems (multi-select Share) can build
    // a real summary of title/price for whatever's selected without
    // a redundant fetch — this data only otherwise existed inside
    // this function's own closure and was gone the moment it returned.
    _ownProfilePostsById.clear();
    postsRes.data?.forEach((d) => _ownProfilePostsById.set(idKey(d.id), d));

    const grid = document.getElementById("profile-grid");
    if (grid) {
      grid.innerHTML =
        postsRes.data?.map((d) => renderGridItem(d.id, d)).join("") || "";
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
// Theme switching: cycles through dark -> light -> system -> dark; saves
// the choice to localStorage and re-applies it to the html element so the
// CSS custom properties defined in main.css pick it up instantly. System
// mode follows the OS prefers-color-scheme live and is wired up to do so
// both on initial load (see the inline theme bootstrap in index.html)
// and here on every change.
window.setTheme = function (mode) {
  const valid = ["dark", "light", "system"];
  if (!valid.includes(mode)) mode = "dark";
  const apply = (m) => {
    const resolved =
      m === "system"
        ? window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : m;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-mode", m);
  };
  apply(mode);
  try {
    localStorage.setItem("campus_market_theme", mode);
  } catch (_) {}
  showToast("Theme: " + mode.charAt(0).toUpperCase() + mode.slice(1));
};

function populateAccountSettings() {
  if (!currentUserData) return;
  const nameInput = document.getElementById("settingsDisplayName");
  const emailInput = document.getElementById("settingsEmail");
  const bioInput = document.getElementById("settingsBio");
  const metadata = currentUserData.user_metadata || {};

  if (nameInput && !nameInput.dataset.userEdited) {
    nameInput.value = metadata.full_name || "";
  }
  if (emailInput) {
    emailInput.value = currentUserData.email || "";
  }
  if (bioInput && !bioInput.dataset.userEdited) {
    bioInput.value = currentUserData.bio || "";
    const counter = document.getElementById("settingsBioCount");
    if (counter) counter.textContent = bioInput.value.length;
  }

  const stripName = document.getElementById("settingsCampusStripName");
  const stripInst = document.getElementById("settingsCampusStripInst");
  if (stripName)
    stripName.textContent =
      metadata.full_name || currentUserData.email || "Campus Account";
  if (stripInst) {
    stripInst.textContent = currentUserData.institution
      ? `${currentUserData.institution}${currentUserData.region ? " · " + currentUserData.region : ""}`
      : "Set your institution below";
  }
}

document
  .getElementById("settingsDisplayName")
  ?.addEventListener("input", function () {
    this.dataset.userEdited = "true";
  });

document.getElementById("settingsBio")?.addEventListener("input", function () {
  this.dataset.userEdited = "true";
});

document
  .getElementById("saveAccountBtn")
  ?.addEventListener("click", async () => {
    if (!currentUserData) return;
    const nameInput = document.getElementById("settingsDisplayName");
    const bioInput = document.getElementById("settingsBio");
    const newName = nameInput?.value.trim();
    const newBio = bioInput?.value.trim() || "";

    if (!newName) {
      showToast("Please enter a display name.");
      return;
    }

    try {
      const { error: authError } = await supabase.auth.updateUser({
        data: { full_name: newName },
      });
      if (authError) throw authError;

      const { error } = await supabase
        .from("profiles")
        .update({ name: newName, bio: newBio })
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
      currentUserData.bio = newBio;

      allCachedPosts.forEach(({ data: d }) => {
        if (d.user_id === currentUserData.id) d.user_name = newName;
      });

      const nameEl = document.getElementById("profile-ui-name");
      if (nameEl) nameEl.textContent = newName;

      const bioEl = document.getElementById("profile-ui-bio");
      if (bioEl) {
        if (newBio) {
          bioEl.textContent = newBio;
          bioEl.classList.remove("hidden");
        } else {
          bioEl.classList.add("hidden");
        }
      }

      if (nameInput) delete nameInput.dataset.userEdited;
      if (bioInput) delete bioInput.dataset.userEdited;
      showToast("Profile updated everywhere! ✓");
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
    ...safeStorageJsonParse(APP_SETTINGS_KEY, {}),
  };
}

function saveAppSettings(partial) {
  const merged = { ...getAppSettings(), ...partial };
  try {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(merged));
  } catch (_) {}
  return merged;
}

// Exposed so other parts of the app (media pipeline, video observers) can
// check the current preference without re-reading localStorage directly.
window.getAppSettings = getAppSettings;

// ─── INFO SHEET: Privacy Policy / Help & Support / Blocked Users ────────────
// Replaces the old "Coming soon" toast placeholders with real, readable
// content. Blocked Users is honest about the fact that there's no
// block-a-person feature wired up yet (it would need its own table + RLS
// + feed filtering — a separate feature, not a settings-page fix) rather
// than faking a list or silently doing nothing.
const INFO_SHEET_CONTENT = {
  privacy: {
    title: "Privacy Policy",
    render: () => `
            <h4>What we collect</h4>
            <p>Your name, email, institution, and region come from sign-in and onboarding so listings and gigs can be matched to your campus. Anything you post — photos, videos, descriptions, prices, messages — is stored so it can be shown to other students.</p>
            <h4>How it's used</h4>
            <p>Your posts and profile are shown to other students on your campus (or nationwide, if you switch off campus scope). Direct messages are only visible to you and the other person in the conversation.</p>
            <h4>What we don't do</h4>
            <p>CampusMarket doesn't sell your data to advertisers, and doesn't share your contact details with anyone outside a conversation you've started yourself.</p>
            <h4>Your choices</h4>
            <p>You can edit your display name and campus at any time from this Settings tab. Deleting your account removes your posts, comments, and profile information.</p>
            <h4>Questions</h4>
            <p>Reach out through Help & Support above if you'd like more detail on anything here.</p>
        `,
  },
  help: {
    title: "Help & Support",
    render: () => `
            <h4>Buying or selling</h4>
            <p>Tap Contact Seller on any listing to open a direct message with the person who posted it. Prices and availability are set by the student posting, not by CampusMarket.</p>
            <h4>Reporting a problem</h4>
            <p>Open the listing or message you want to report and use the options menu (⋯) to send a report. A team member reviews every report.</p>
            <h4>Account issues</h4>
            <p>If you're locked out or something looks wrong with your profile, email the address below with your registered email and a short description.</p>
            <h4>Data usage</h4>
            <p>Turn on Data Saver Mode above to load lower-quality media and use less data on campus Wi-Fi or mobile data.</p>
            <h4>Contact</h4>
            <p><a href="mailto:support@campusmarket.app" class="text-amber-400 font-bold">support@campusmarket.app</a></p>
        `,
  },
  blocked: {
    title: "Blocked Users",
    render: () => {
      const ids = [...blockedUserIds];
      if (ids.length === 0) {
        return `
                    <div class="info-sheet-empty">
                        <i class="fas fa-user-shield text-3xl mb-3 text-slate-600"></i>
                        <p class="text-slate-300 font-bold text-sm mb-1">No blocked users</p>
                        <p class="text-xs max-w-[240px] leading-relaxed">When you block someone from a post, comment, or chat, they'll show up here so you can unblock them anytime.</p>
                    </div>
                `;
      }
      return ids
        .map((id) => {
          const name = blockedUserNames[id] || "Student";
          const fallbackAvatar = `https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(name)}`;
          return `
                    <div class="blocked-user-row">
                        <img src="${fallbackAvatar}" alt="">
                        <p class="text-white text-sm font-bold flex-1 truncate">${esc(name)}</p>
                        <button
                            onclick="window.unblockUser('${escAttr(id)}', '${escAttr(name)}')"
                            class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-[11px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg shrink-0 active:scale-95 transition"
                        >
                            Unblock
                        </button>
                    </div>
                `;
        })
        .join("");
    },
  },
  verification: {
    title: "Get Verified",
    // NOTE ON UI WIRING: this sheet renders correctly once opened, but
    // nothing in this JS file currently calls
    // window.openInfoSheet('verification') from a button — the other
    // entries here (privacy/help/blocked) are triggered by buttons
    // living in index.html, which wasn't part of what I could read
    // or edit. Add a settings row there calling
    // onclick="window.openInfoSheet('verification')" to surface this.
    render: () => {
      if (!currentUserData) {
        return `<div class="info-sheet-empty"><p class="text-xs">Please sign in first.</p></div>`;
      }
      return `
                <div class="px-1">
                    <p class="text-slate-300 text-sm leading-relaxed mb-4">
                        Verify your university email to get a
                        <span class="text-amber-400 font-bold">verified badge</span>
                        on your profile and posts — it helps buyers and sellers trust who they're dealing with.
                    </p>
                    <input
                        id="verification-email-input"
                        type="email"
                        placeholder="you@university.edu.gh"
                        class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 mb-3 focus:outline-none focus:border-amber-400"
                    >
                    <button
                        onclick="window.submitVerificationRequest(document.getElementById('verification-email-input').value)"
                        class="w-full bg-amber-400 text-black font-black py-3 rounded-xl uppercase tracking-wider text-xs active:scale-95 transition"
                    >
                        Submit for verification
                    </button>
                    <p class="text-slate-500 text-[11px] mt-3 leading-relaxed">
                        We'll email a confirmation link to that address. Only university-affiliated addresses (ending in .edu, .edu.xx, or .ac.xx) are accepted.
                    </p>
                </div>
            `;
    },
  },
  archived: {
    title: "Archived Posts",
    // Unlike the other sheets here, this one needs an async fetch —
    // render() itself must stay synchronous (openInfoSheet assigns
    // its return value straight to innerHTML), so this renders a
    // loading state immediately and loadArchivedPostsIntoSheet()
    // fills in the real content right after, same pattern
    // openPublicProfile uses for its own async data.
    render: () => {
      if (!currentUserData) {
        return `<div class="info-sheet-empty"><p class="text-xs">Please sign in first.</p></div>`;
      }
      setTimeout(loadArchivedPostsIntoSheet, 0);
      return `
                <div class="flex items-center justify-center py-12">
                    <i class="fas fa-circle-notch fa-spin text-slate-600 text-xl"></i>
                </div>`;
    },
  },
};

async function loadArchivedPostsIntoSheet() {
  const bodyEl = document.getElementById("info-sheet-body");
  // Sheet may have been closed before the fetch resolved (fast tap
  // away) — don't paint content into a body no one's looking at.
  if (
    !bodyEl ||
    !document
      .getElementById("info-sheet-overlay")
      ?.classList.contains("sheet-open")
  )
    return;

  const posts = await fetchArchivedPosts();

  if (!posts.length) {
    bodyEl.innerHTML = `
            <div class="info-sheet-empty">
                <i class="fas fa-box-archive text-3xl mb-3 text-slate-600"></i>
                <p class="text-slate-300 font-bold text-sm mb-1">No archived posts</p>
                <p class="text-xs max-w-[240px] leading-relaxed">Posts you delete, or that get auto-hidden after multiple reports, show up here — nothing is ever silently gone for good.</p>
            </div>`;
    return;
  }

  bodyEl.innerHTML = posts
    .map((d) => {
      let thumb = "";
      if (d.media_url) {
        try {
          const urls = d.media_url.startsWith("[")
            ? JSON.parse(d.media_url)
            : [d.media_url];
          thumb = urls[0] || "";
        } catch (_) {
          thumb = d.media_url;
        }
      }
      const archivedDate = d.archived_at
        ? new Date(d.archived_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })
        : "";
      return `
            <div class="flex items-center gap-3 py-2.5 border-b border-slate-800 last:border-0">
                <div class="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 overflow-hidden shrink-0">
                    ${thumb ? `<img src="${esc(thumb)}" class="w-full h-full object-cover" alt="" loading="lazy">` : `<div class="w-full h-full flex items-center justify-center text-slate-700"><i class="fas fa-image"></i></div>`}
                </div>
                <div class="min-w-0 flex-1">
                    <p class="text-white text-sm font-bold truncate">${esc(d.title) || "Untitled"}</p>
                    <p class="text-slate-500 text-[10px]">${archivedDate ? `Archived ${archivedDate}` : ""}</p>
                </div>
                <button
                    onclick="window.restorePost('${escAttr(d.id)}')"
                    class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-[11px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg shrink-0 active:scale-95 transition"
                >
                    Restore
                </button>
            </div>`;
    })
    .join("");
}

window.openWhySeeingPost = function (posterId, isSuggested) {
  const overlay = document.getElementById("info-sheet-overlay");
  const titleEl = document.getElementById("info-sheet-title");
  const bodyEl = document.getElementById("info-sheet-body");
  if (!overlay || !titleEl || !bodyEl) return;

  const isFollowed = followingUserIds.has(idKey(posterId));
  let reasonHtml;
  if (isSuggested) {
    reasonHtml = `<p>This is a <strong class="text-white">suggested</strong> post — a recent or popular listing from someone you don't follow yet, mixed into your feed the way suggested content works on most apps.</p>`;
  } else if (isFollowed) {
    reasonHtml = `<p>You're seeing this because you <strong class="text-white">follow</strong> this seller.</p>`;
  } else {
    reasonHtml = `<p>You're seeing this because it's a <strong class="text-white">recent listing</strong> on CampusMarket. Posts you're more likely to be interested in — based on recency and engagement — are shown higher in your feed.</p>`;
  }

  titleEl.textContent = "Why you're seeing this post";
  bodyEl.innerHTML = `
        <div class="p-6 space-y-4 text-sm text-slate-300 leading-relaxed">
            ${reasonHtml}
            <p class="text-slate-500 text-xs">Following or unfollowing sellers changes what shows up here going forward.</p>
        </div>`;
  bodyEl.scrollTop = 0;
  overlay.classList.add("sheet-open");
  pushUiState("info-sheet", () => window.closeInfoSheet(true));
};

window.openInfoSheet = function (key) {
  const entry = INFO_SHEET_CONTENT[key];
  const overlay = document.getElementById("info-sheet-overlay");
  const titleEl = document.getElementById("info-sheet-title");
  const bodyEl = document.getElementById("info-sheet-body");
  if (!entry || !overlay || !titleEl || !bodyEl) return;

  titleEl.textContent = entry.title;
  bodyEl.innerHTML = entry.render();
  bodyEl.scrollTop = 0;
  overlay.classList.add("sheet-open");
  pushUiState("info-sheet", () => window.closeInfoSheet(true));
};

window.closeInfoSheet = function (fromPop = false) {
  document.getElementById("info-sheet-overlay")?.classList.remove("sheet-open");
  if (!fromPop) popUiState("info-sheet");
};

// ─── PUBLIC PROFILE (someone else's page, opened from a post) ──────────────
// A read-only view of another student: avatar, name, institution, follower/
// following/post counts, their public posts grid, and Follow + Message
// actions. Deliberately separate from #profile-container (the signed-in
// person's OWN profile, with editable settings/account deletion/etc.) —
// this only ever fetches and displays someone else's public data.
window.openPublicProfile = async function (userId) {
  if (!userId) return;
  const overlay = document.getElementById("public-profile-overlay");
  const titleEl = document.getElementById("public-profile-title");
  const bodyEl = document.getElementById("public-profile-body");
  if (!overlay || !bodyEl) return;

  titleEl.textContent = "Profile";
  bodyEl.innerHTML = `
        <div class="flex items-center justify-center py-20">
            <i class="fas fa-circle-notch fa-spin text-slate-600 text-xl"></i>
        </div>`;
  overlay.classList.add("sheet-open");
  pushUiState("public-profile", () => window.closePublicProfile(true));

  try {
    const [
      followersRes,
      followingRes,
      postsRes,
      isFollowingRes,
      profileRowRes,
    ] = await Promise.all([
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("following_id", userId),
      supabase
        .from("follows")
        .select("", { count: "exact", head: true })
        .eq("follower_id", userId),
      supabase
        .from("posts")
        .select("id, title, media_url, media_type, price")
        .eq("user_id", userId)
        .eq("is_archived", false)
        .order("created_at", { ascending: false }),
      currentUserData
        ? supabase
            .from("follows")
            .select("id")
            .eq("follower_id", currentUserData.id)
            .eq("following_id", userId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("profiles").select("bio").eq("id", userId).maybeSingle(),
    ]);

    // The name/institution/avatar aren't stored anywhere queryable by
    // user id alone (profiles are keyed by auth, not duplicated per
    // post) — the most recent post from this person is a reliable,
    // already-available source for display info without needing a
    // separate profiles-table fetch.
    const latestPost = postsRes.data?.[0];
    const displayName =
      latestPost?.user_name || blockedUserNames[idKey(userId)] || "Student";
    const avatarUrl =
      latestPost?.user_avatar ||
      `https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(displayName)}`;
    const institution = latestPost?.institution || "";
    const isFollowing = !!isFollowingRes?.data;
    const isBlocked = blockedUserIds.has(idKey(userId));
    const ratingSummary = await fetchSellerRatingSummary(userId);
    const isVerified = await isUserVerified(userId);

    titleEl.textContent = displayName;

    bodyEl.innerHTML = `
            <div class="public-profile-header">
                <img src="${esc(avatarUrl)}" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(displayName)}'" alt="">
                <h3 class="text-white font-black text-lg mt-3">${esc(displayName)}${isVerified ? verifiedBadgeHtml() : ""}</h3>
                ${institution ? `<p class="text-slate-500 text-xs mt-1">${esc(institution)}</p>` : ""}
                ${profileRowRes.data?.bio ? `<p class="text-slate-300 text-xs mt-2 leading-snug px-4">${esc(profileRowRes.data.bio)}</p>` : ""}
                <div id="public-profile-rating-block" class="flex flex-col items-center mt-2">
                    ${renderRatingBlockInner(userId, ratingSummary)}
                </div>
            </div>

            <div class="public-profile-stats">
                <div><span class="stat-value">${postsRes.data?.length || 0}</span><span class="stat-label">Posts</span></div>
                <div onclick="window.openFollowListModal('${escAttr(userId)}', 'followers')" class="cursor-pointer active:opacity-70 transition"><span class="stat-value">${followersRes.count || 0}</span><span class="stat-label">Followers</span></div>
                <div onclick="window.openFollowListModal('${escAttr(userId)}', 'following')" class="cursor-pointer active:opacity-70 transition"><span class="stat-value">${followingRes.count || 0}</span><span class="stat-label">Following</span></div>
            </div>

            <div class="flex gap-2 mb-5">
                <button
                    onclick="toggleFollow('${escAttr(userId)}', '${escAttr(displayName)}', '${escAttr(avatarUrl)}'); window._refreshPublicProfileFollowState('${escAttr(userId)}', '${escAttr(displayName)}', '${escAttr(avatarUrl)}')"
                    class="flex-1 font-black py-3 rounded-xl uppercase tracking-wider text-xs transition active:scale-95 ${isFollowing ? "bg-slate-800 border border-slate-700 text-white" : "bg-amber-400 text-black"}"
                >
                    ${isFollowing ? "Following" : "+ Follow"}
                </button>
                <button
                    onclick="window.openDM('${escAttr(userId)}', '${escAttr(displayName)}', '${escAttr(avatarUrl)}')"
                    class="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-black py-3 rounded-xl uppercase tracking-wider text-xs transition active:scale-95"
                >
                    Message
                </button>
            </div>

            <div class="grid grid-cols-3 gap-2 mb-6">
                ${
                  postsRes.data && postsRes.data.length > 0
                    ? postsRes.data
                        .map((d) => renderPublicGridItem(d.id, d))
                        .join("")
                    : `<div class="col-span-3 info-sheet-empty !py-10">
                             <i class="fas fa-box-open text-2xl mb-2 text-slate-600"></i>
                             <p class="text-xs">No posts yet</p>
                           </div>`
                }
            </div>

            ${
              !isBlocked
                ? `
                <button
                    onclick="window.blockUser('${escAttr(userId)}', '${escAttr(displayName)}')"
                    class="w-full text-red-400 text-xs font-bold uppercase tracking-wider py-3"
                >
                    <i class="fas fa-user-slash mr-1.5"></i> Block ${esc(displayName)}
                </button>
            `
                : ""
            }
        `;
  } catch (err) {
    console.error("Public profile load error:", err);
    bodyEl.innerHTML = `
            <div class="info-sheet-empty">
                <i class="fas fa-triangle-exclamation text-2xl mb-2 text-slate-600"></i>
                <p class="text-xs">Couldn't load this profile. Please try again.</p>
            </div>`;
  }
};

// Re-renders just the Follow button's label/style after toggling, without
// re-fetching the whole profile — toggleFollow already updated the DB by
// the time this runs immediately after it in the onclick above.
window._refreshPublicProfileFollowState = async function (
  userId,
  displayName,
  avatarUrl,
) {
  if (!currentUserData) return;
  const { data } = await supabase
    .from("follows")
    .select("id")
    .eq("follower_id", currentUserData.id)
    .eq("following_id", userId)
    .maybeSingle();
  const isFollowing = !!data;
  const btn = document.querySelector(
    '#public-profile-body button[onclick*="toggleFollow"]',
  );
  if (btn) {
    btn.textContent = isFollowing ? "Following" : "+ Follow";
    btn.className = `flex-1 font-black py-3 rounded-xl uppercase tracking-wider text-xs transition active:scale-95 ${isFollowing ? "bg-slate-800 border border-slate-700 text-white" : "bg-amber-400 text-black"}`;
  }
};

window.closePublicProfile = function (fromPop = false) {
  document
    .getElementById("public-profile-overlay")
    ?.classList.remove("sheet-open");
  if (!fromPop) popUiState("public-profile");
};

// Shows either the Followers or Following list for any user (your own
// profile or someone else's public profile — both call this with their
// own userId). The `follows` table already stores follower/following
// name+avatar denormalized on each row (see toggleFollow's insert), so
// this needs a single query with no extra profile lookups.
// Thin wrapper for the logged-in person's own Followers/Following stat
// boxes: those live in plain HTML with an inline onclick, which runs in
// global scope — but currentUserData is a module-scoped variable (this
// script loads as type="module"), not something on window. Resolving it
// here, inside the module, avoids a ReferenceError that a direct
// `currentUserData?.id` reference in the HTML onclick would otherwise hit.
window.openMyFollowList = function (mode) {
  if (!currentUserData) {
    showToast("Please sign in first.");
    return;
  }
  window.openFollowListModal(currentUserData.id, mode);
};

window.openFollowListModal = async function (userId, mode) {
  if (!userId || (mode !== "followers" && mode !== "following")) return;

  const overlay = document.getElementById("follow-list-overlay");
  const titleEl = document.getElementById("follow-list-title");
  const bodyEl = document.getElementById("follow-list-body");
  if (!overlay || !bodyEl) return;

  titleEl.textContent = mode === "followers" ? "Followers" : "Following";
  bodyEl.innerHTML = `
        <div class="flex items-center justify-center py-20">
            <i class="fas fa-circle-notch fa-spin text-slate-600 text-xl"></i>
        </div>`;
  overlay.classList.add("sheet-open");
  pushUiState("follow-list", () => window.closeFollowListModal(true));

  try {
    const query =
      mode === "followers"
        ? supabase
            .from("follows")
            .select("follower_id, follower_name, follower_avatar")
            .eq("following_id", userId)
        : supabase
            .from("follows")
            .select("following_id, following_name, following_avatar")
            .eq("follower_id", userId);

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });
    if (error) throw error;

    if (!data || data.length === 0) {
      bodyEl.innerHTML = `
                <div class="text-center py-16 space-y-2">
                    <p class="text-4xl">${mode === "followers" ? "👋" : "👥"}</p>
                    <p class="font-bold text-white">${mode === "followers" ? "No followers yet" : "Not following anyone yet"}</p>
                </div>`;
      return;
    }

    const isOwnList = currentUserData && userId === currentUserData.id;

    const rows = await Promise.all(
      data.map(async (row) => {
        const personId =
          mode === "followers" ? row.follower_id : row.following_id;
        const name =
          (mode === "followers" ? row.follower_name : row.following_name) ||
          "Student";
        const avatar =
          (mode === "followers" ? row.follower_avatar : row.following_avatar) ||
          `https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(name)}`;

        // Only "following" is unfollow-able from here — a followers
        // list has no equivalent action for the person viewing it.
        const unfollowBtn =
          mode === "following" && isOwnList
            ? `
                <button
                    onclick="event.stopPropagation(); window.unfollowFromList('${escAttr(personId)}')"
                    class="shrink-0 bg-slate-800 border border-slate-700 text-white font-black px-4 py-2 rounded-xl uppercase tracking-wider text-[10px] active:scale-95 transition"
                >Unfollow</button>`
            : "";

        return `
                <div
                    onclick="window.openPublicProfile('${escAttr(personId)}')"
                    class="flex items-center gap-3 py-3 px-1 border-b border-slate-900 cursor-pointer active:bg-slate-900/40 transition"
                >
                    <img src="${esc(avatar)}" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(name)}'" class="w-11 h-11 rounded-full object-cover shrink-0" alt="">
                    <span class="flex-1 text-white font-bold text-sm truncate">${esc(name)}</span>
                    ${unfollowBtn}
                </div>`;
      }),
    );

    bodyEl.innerHTML = rows.join("");
  } catch (err) {
    console.error("Follow list fetch error:", err);
    bodyEl.innerHTML = `<p class="text-center text-slate-500 text-sm py-16">Couldn't load this list. Try again.</p>`;
  }
};

// Unfollow button inside the Following list — removes the row, then
// re-renders the list in place so it disappears immediately instead of
// requiring the person to close and reopen the modal to see it gone.
window.unfollowFromList = async function (targetUserId) {
  if (!currentUserData || !targetUserId) return;
  try {
    await supabase
      .from("follows")
      .delete()
      .eq("follower_id", currentUserData.id)
      .eq("following_id", targetUserId);
    updateFollowButtons(targetUserId, false);
    if (
      !document
        .getElementById("profile-container")
        ?.classList.contains("hidden")
    ) {
      loadProfileStats();
    }
    window.openFollowListModal(currentUserData.id, "following");
  } catch (err) {
    console.error("Unfollow error:", err);
    showToast("Couldn't unfollow — try again.");
  }
};

window.closeFollowListModal = function (fromPop = false) {
  document
    .getElementById("follow-list-overlay")
    ?.classList.remove("sheet-open");
  if (!fromPop) popUiState("follow-list");
};

// Tapping any post tile on a profile grid (own or someone else's) opens
// this instead of the single-post detail view — a full-bleed, Reels-style
// vertical scroller through that user's whole post history, landing
// exactly on the tapped post first (Instagram-style "view and scroll
// continuously"). Own-profile posts reuse the already-cached
// _ownProfilePostsById (populated by loadProfileStats) to skip a
// redundant fetch; other users' posts are queried fresh since no
// equivalent cache exists for them.
window.openProfilePostViewer = async function (userId, startPostId) {
  if (!userId) return;

  const overlay = document.getElementById("profile-post-viewer");
  const feed = document.getElementById("profile-post-viewer-feed");
  if (!overlay || !feed) return;

  feed.innerHTML = `
        <div class="h-full flex items-center justify-center">
            <i class="fas fa-circle-notch fa-spin text-slate-600 text-2xl"></i>
        </div>`;
  overlay.classList.remove("is-service-viewer");
  overlay.classList.add("sheet-open");
  pauseAllReelVideos();
  pushUiState("profile-post-viewer", () => window.closeProfilePostViewer(true));

  try {
    let posts;
    const isOwnProfile = currentUserData && userId === currentUserData.id;

    if (isOwnProfile && _ownProfilePostsById.size > 0) {
      posts = Array.from(_ownProfilePostsById.values());
    } else {
      const { data, error } = await supabase
        .from("posts")
        .select(FEED_SELECT_COLUMNS)
        .eq("user_id", userId)
        .eq("is_archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      posts = data || [];
    }

    if (posts.length === 0) {
      feed.innerHTML = `<div class="h-full flex items-center justify-center text-slate-500 text-sm">No posts to show.</div>`;
      return;
    }

    feed.innerHTML = posts
      .map((d) => renderReelCard(idKey(d.id), d, true))
      .join("");

    // Jump straight to the tapped post — and retry once more after
    // layout settles. On some mobile browsers a single immediate
    // scrollIntoView can be ignored or snapped back to the first card
    // while the newly inserted full-screen cards are still resolving
    // their final heights.
    const jumpToRequestedCard = () => {
      const targetCard = feed.querySelector(
        `#reel-card-${CSS.escape(idKey(startPostId))}`,
      );
      if (!targetCard) return;
      feed.scrollTo({ top: targetCard.offsetTop, behavior: "auto" });
      const targetMedia = targetCard.querySelector(".reel-video");
      if (
        targetMedia &&
        targetMedia.dataset.src &&
        !targetMedia.getAttribute("src")
      ) {
        targetMedia.src = targetMedia.dataset.src;
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(jumpToRequestedCard);
      setTimeout(jumpToRequestedCard, 120);
    });

    setupReelsIntersectionObserver(feed);
  } catch (err) {
    console.error("Profile post viewer error:", err);
    feed.innerHTML = `<div class="h-full flex items-center justify-center text-slate-500 text-sm">Couldn't load posts. Try again.</div>`;
  }
};

window.closeProfilePostViewer = function (fromPop = false) {
  document
    .getElementById("profile-post-viewer")
    ?.classList.remove("sheet-open", "is-service-viewer");
  pauseAllReelVideos();
  if (!fromPop) popUiState("profile-post-viewer");
};

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

  // Theme picker (dark / light / system). Reading, not a toggle, so
  // wired to 'change' on a <select> — value is reflected into the
  // data-theme attributes via window.applyTheme() and persisted.
  const themeSel = document.getElementById("settingsThemeSelect");
  if (themeSel && !themeSel.dataset.wired) {
    themeSel.value = currentThemeMode;
    themeSel.dataset.wired = "true";
    themeSel.addEventListener("change", () => {
      window.applyTheme(themeSel.value);
      showToast(
        "Theme: " +
          (themeSel.value.charAt(0).toUpperCase() + themeSel.value.slice(1)),
      );
    });
  }
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
      const stripInst = document.getElementById("settingsCampusStripInst");
      if (stripInst) stripInst.textContent = `${institution} · ${region}`;
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
    content.innerHTML = `
            <div class="text-center py-12 space-y-3 bg-slate-900 border border-slate-800/60 rounded-3xl p-6">
                <p class="text-white font-black text-sm uppercase tracking-wider">Couldn't load chats</p>
                <p class="text-slate-500 text-xs">Check your connection and try again.</p>
                <div class="flex justify-center">
                    <button onclick="window.navigateTo('dms')" class="inline-flex items-center gap-2 bg-amber-400 text-black font-black px-4 py-2.5 rounded-xl text-[11px] uppercase tracking-wider active:scale-[0.98] transition">
                        <i class="fas fa-rotate-right text-[10px]"></i> Retry
                    </button>
                </div>
            </div>`;
  }
}

function renderInboxList() {
  const content = document.getElementById("dms-content");
  if (!content) return;

  const visibleConversations = conversationsCache.filter(
    (conv) => !blockedUserIds.has(idKey(dmPeerInfo(conv).id)),
  );

  const inboxHeader = `
        <div class="flex items-center justify-between gap-3 bg-slate-900 border border-slate-800/60 rounded-3xl px-4 py-3">
            <div>
                <p class="text-white font-black text-sm uppercase tracking-wider">Messages</p>
                <p class="text-slate-500 text-[11px]">Search users and start a chat anytime.</p>
            </div>
            <button onclick="window.openDMUserSearch()" class="inline-flex items-center gap-2 rounded-2xl bg-slate-800 border border-slate-700 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-200 active:scale-95 transition" aria-label="Find people">
                <i class="fas fa-magnifying-glass text-[10px]"></i> Find People
            </button>
        </div>`;

  const composeFab = `
        <button onclick="window.openDMUserSearch()" class="dm-compose-fab" aria-label="Start new chat">
            <i class="fas fa-pen-to-square text-sm"></i> New Chat
        </button>`;

  if (visibleConversations.length === 0) {
    content.innerHTML = `
            ${inboxHeader}
            <div class="text-center py-16 space-y-3 bg-slate-900 border border-slate-800/60 rounded-3xl p-6">
                <p class="text-3xl">💬</p>
                <p class="font-black text-white uppercase tracking-tight text-sm">No chats yet</p>
                <p class="text-slate-500 text-xs max-w-xs mx-auto">Tap Contact on a listing, or use New Chat to search for a student and message them directly.</p>
                <button onclick="window.openDMUserSearch()" class="inline-flex items-center gap-2 bg-amber-400 text-black font-black px-4 py-2.5 rounded-xl text-[11px] uppercase tracking-wider active:scale-95 transition">
                    <i class="fas fa-user-plus text-[10px]"></i> Start Chat
                </button>
            </div>
            ${composeFab}`;
    return;
  }

  content.innerHTML = `${inboxHeader}<div class="divide-y divide-slate-800/60 bg-slate-900 border border-slate-800/60 rounded-3xl overflow-hidden">${visibleConversations
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
                <img src="${esc(peer.avatar)}" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(peer.name)}'" class="w-12 h-12 rounded-full object-cover border border-slate-700 shrink-0" alt="">
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
    .join("")}</div>${composeFab}`;
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

window.openDMUserSearch = function () {
  if (!currentUserData) {
    window.openLoginModal();
    return;
  }

  let overlay = document.getElementById("dm-user-search-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "dm-user-search-overlay";
    overlay.className =
      "hidden fixed inset-0 z-[92] bg-black/80 backdrop-blur-sm p-4";
    overlay.innerHTML = `
            <div class="max-w-md mx-auto mt-10 bg-[#0f172a] border border-slate-800/80 rounded-3xl shadow-2xl overflow-hidden">
                <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                    <div>
                        <p class="text-white font-black text-sm uppercase tracking-wider">Start a chat</p>
                        <p class="text-slate-500 text-[11px]">Search by student name or institution.</p>
                    </div>
                    <button onclick="window.closeDMUserSearch()" class="w-9 h-9 rounded-full bg-slate-800 text-slate-300 hover:text-white transition"><i class="fas fa-times"></i></button>
                </div>
                <div class="p-4 space-y-3">
                    <div class="relative">
                        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input id="dm-user-search-input" type="text" inputmode="search" placeholder="Search users" class="w-full bg-slate-900 border border-slate-700 text-white rounded-2xl pl-9 pr-3 py-3 text-sm focus:outline-none focus:border-amber-400" oninput="window.searchDMUsers(this.value)">
                    </div>
                    <div id="dm-user-search-results" class="max-h-[55vh] overflow-y-auto space-y-2 pr-1">
                        <div class="text-center text-slate-500 text-xs py-10">Type at least 2 letters to search.</div>
                    </div>
                </div>
            </div>`;
    document.body.appendChild(overlay);
  }

  overlay.classList.remove("hidden");
  pushUiState("dm-user-search", () => window.closeDMUserSearch(true));
  setTimeout(
    () => document.getElementById("dm-user-search-input")?.focus(),
    20,
  );
};

window.closeDMUserSearch = function (fromPop = false) {
  document.getElementById("dm-user-search-overlay")?.classList.add("hidden");
  if (!fromPop) popUiState("dm-user-search");
};

let dmUserSearchTimer = null;
window.searchDMUsers = function (term) {
  clearTimeout(dmUserSearchTimer);
  dmUserSearchTimer = setTimeout(() => window._runDMUserSearch(term), 180);
};

window._runDMUserSearch = async function (term) {
  const resultsEl = document.getElementById("dm-user-search-results");
  if (!resultsEl || !currentUserData) return;

  const cleanTerm = (term || "").trim().replace(/[,%()]/g, " ");
  if (cleanTerm.length < 2) {
    resultsEl.innerHTML = `<div class="text-center text-slate-500 text-xs py-10">Type at least 2 letters to search.</div>`;
    return;
  }

  resultsEl.innerHTML = `<div class="text-center text-slate-500 text-xs py-10 uppercase tracking-widest">Searching...</div>`;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, name, avatar, institution, region")
      .neq("id", currentUserData.id)
      .or(
        `name.ilike.%${cleanTerm}%,institution.ilike.%${cleanTerm}%,region.ilike.%${cleanTerm}%`,
      )
      .limit(20);
    if (error) throw error;

    const rows = (data || []).filter((row) => row?.id);
    if (!rows.length) {
      resultsEl.innerHTML = `<div class="text-center text-slate-500 text-xs py-10">No users found.</div>`;
      return;
    }

    resultsEl.innerHTML = rows
      .map((row) => {
        const displayName = row.name || "Student";
        const avatar =
          row.avatar ||
          `https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(displayName)}`;
        const location = [row.institution, row.region]
          .filter(Boolean)
          .join(" · ");
        return `
                <div class="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-2xl p-3">
                    <img src="${esc(avatar)}" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(displayName)}'" class="w-11 h-11 rounded-full object-cover border border-slate-700 shrink-0" alt="">
                    <div class="min-w-0 flex-1">
                        <p class="text-white font-bold text-sm truncate">${esc(displayName)}</p>
                        <p class="text-slate-500 text-[11px] truncate">${esc(location || "Campus student")}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button onclick="window.openUserDashboard('${escAttr(row.id)}')" class="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-[10px] font-black uppercase tracking-wider">View</button>
                        <button onclick="window.closeDMUserSearch(); window.openDM('${escAttr(row.id)}', '${escAttr(displayName)}', '${escAttr(avatar)}')" class="px-3 py-2 rounded-xl bg-amber-400 text-black text-[10px] font-black uppercase tracking-wider">Chat</button>
                    </div>
                </div>`;
      })
      .join("");
  } catch (err) {
    console.error("DM user search failed:", err);
    resultsEl.innerHTML = `<div class="text-center text-red-400 text-xs py-10">Couldn't search users right now.</div>`;
  }
};

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

  if (blockedUserIds.has(idKey(otherUserId))) {
    showToast(
      "You've blocked this person. Unblock them in Campus Settings to message again.",
    );
    return;
  }

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
    // If the SQL patch from blocked_users_rls.sql is applied,
    // get_or_create_conversation raises when either person has
    // blocked the other — this surfaces that clearly instead of a
    // generic failure, covering the case where THEY blocked YOU
    // (which the local blockedUserIds check earlier in this function
    // has no way to know about).
    const isBlockRejection =
      /block/i.test(err?.message || "") || err?.code === "42501";
    content.innerHTML = `<div class="p-12 text-center text-red-400 text-xs">${
      isBlockRejection
        ? "This chat isn't available."
        : "Couldn't open this chat. Try again."
    }</div>`;
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

    const newLabel = formatDateSeparator(optimisticMsg.created_at);
    if (newLabel !== container.dataset.lastDateLabel) {
      container.innerHTML += renderDateSeparator(newLabel);
    }
    container.dataset.lastDateLabel = newLabel;

    container.innerHTML += renderChatBubble(optimisticMsg);
    container.scrollTop = container.scrollHeight;
  }

  try {
    // Same duplication-bug fix as sendChatMessage: capture the real
    // inserted row id so the realtime echo of this exact message can
    // be recognized and skipped instead of rendered a second time.
    const { data: inserted, error: msgErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: activeConversationId,
        sender_id: currentUserData.id,
        text,
      })
      .select("id")
      .single();
    if (msgErr) throw msgErr;

    if (container && inserted?.id) {
      container.dataset.lastOptimisticId = String(inserted.id);
    }

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
                <img src="${esc(activeConversationPeer.avatar)}" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?background=1e293b&color=fbbf24&bold=true&name=${encodeURIComponent(activeConversationPeer.name)}'" class="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0" alt="">
                <div class="min-w-0">
                    <p class="text-white font-bold text-sm truncate">${esc(activeConversationPeer.name)}</p>
                    <p id="chat-typing-status" class="text-amber-400 text-[10px] font-semibold h-3.5"></p>
                </div>
            </div>
            <div id="chat-messages" class="flex-1 overflow-y-auto space-y-2 px-1 pb-2"></div>
            <div class="flex items-end gap-2 pt-2 border-t border-slate-800/60">
                <textarea
                    id="chat-input"
                    rows="1"
                    maxlength="1000"
                    placeholder="Message..."
                    class="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-2xl px-4 py-2.5 focus:outline-none focus:border-amber-400 transition resize-none max-h-32 leading-normal"
                    style="field-sizing: content;"
                    onkeydown="window._handleChatInputKeydown(event)"
                    oninput="window._handleTypingInput(); window._autoGrowChatInput(this); window._syncChatSendState(this)"
                ></textarea>
                <button
                    id="chat-send-btn"
                    disabled
                    onclick="window.sendChatMessage()"
                    class="w-10 h-10 flex items-center justify-center bg-amber-400 text-black rounded-full active:scale-90 transition shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <i class="fas fa-paper-plane text-xs"></i>
                </button>
            </div>
        </div>`;
}

// Enter sends the message (matching every mainstream chat app); Shift+Enter
// inserts a normal newline instead, so a longer message can actually be
// composed across multiple lines without accidentally sending mid-thought.
window._handleChatInputKeydown = function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    window.sendChatMessage();
  }
};

// Grows the textarea with its content up to the max-h-32 CSS cap (beyond
// that it scrolls internally instead of pushing the rest of the layout
// around) — the `field-sizing: content` inline style above handles this
// automatically in browsers that support it, but this is the fallback for
// ones that don't.
window._autoGrowChatInput = function (el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
};

window._syncChatSendState = function (el) {
  const sendBtn = document.getElementById("chat-send-btn");
  if (sendBtn) sendBtn.disabled = el.value.trim().length === 0;
};

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

  // Read receipts: a single check for sent-but-not-yet-read, a double
  // check for read — only shown on your OWN messages (seeing whether
  // the other person read your own message), matching WhatsApp/iMessage
  // conventions. `read` already existed as a column being written to
  // (see loadAndRenderMessages' mark-as-read call) but was never
  // actually displayed anywhere.
  const receiptHtml = isMe
    ? `<i class="fas ${msg.read ? "fa-check-double text-blue-400" : "fa-check text-black/40"} text-[10px] ml-1"></i>`
    : "";

  return `
        <div class="flex ${isMe ? "justify-end" : "justify-start"}" data-message-id="${escAttr(idKey(msg.id))}">
            <div class="max-w-[75%] ${isMe ? "bg-amber-400 text-black" : "bg-slate-800 text-white"} rounded-2xl ${isMe ? "rounded-br-sm" : "rounded-bl-sm"} px-3.5 py-2">
                <p class="text-sm break-words">${esc(msg.text)}</p>
                <p class="text-[9px] ${isMe ? "text-black/50" : "text-slate-400"} mt-1 text-right flex items-center justify-end gap-0.5">
                    ${esc(formatClockTime(msg.created_at))}${receiptHtml}
                </p>
            </div>
        </div>`;
}

// A short date separator ("Today", "Yesterday", or e.g. "Jul 3") shown
// once between groups of messages from different calendar days —
// standard in every mainstream chat app, and without it a long
// conversation just reads as one undifferentiated wall of bubbles with
// no sense of when anything happened.
function formatDateSeparator(dateStr) {
  const msgDate = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const isSameDay = (a, b) => a.toDateString() === b.toDateString();
  if (isSameDay(msgDate, today)) return "Today";
  if (isSameDay(msgDate, yesterday)) return "Yesterday";
  return msgDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function renderDateSeparator(label) {
  return `
        <div class="flex items-center gap-3 my-3">
            <span class="flex-1 h-px bg-slate-800"></span>
            <span class="text-[9px] text-slate-500 font-bold uppercase tracking-widest shrink-0">${esc(label)}</span>
            <span class="flex-1 h-px bg-slate-800"></span>
        </div>`;
}

// Renders a full message list with date separators inserted between
// days — shared by the initial load and anywhere else a full list needs
// re-rendering, so date-grouping logic lives in exactly one place.
function renderMessageListWithDateSeparators(messages) {
  let html = "";
  let lastDateLabel = null;
  messages.forEach((msg) => {
    const label = formatDateSeparator(msg.created_at);
    if (label !== lastDateLabel) {
      html += renderDateSeparator(label);
      lastDateLabel = label;
    }
    html += renderChatBubble(msg);
  });
  return html;
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
      container.innerHTML = renderMessageListWithDateSeparators(messages);
      container.dataset.lastDateLabel = formatDateSeparator(
        messages[messages.length - 1].created_at,
      );
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

  // Tracks message ids already rendered in this thread session, as a
  // second safety net alongside container.dataset.lastOptimisticId — in
  // the rare case where the realtime INSERT event arrives before
  // sendChatMessage's own insert().select() round-trip has finished
  // (both are separate network round-trips racing each other), relying
  // on dataset.lastOptimisticId alone could still momentarily miss and
  // double-render. This set makes the render idempotent regardless of
  // which one wins the race.
  const renderedMessageIds = new Set();

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

        const incomingId = String(payload.new.id);
        if (
          container.dataset.lastOptimisticId === incomingId ||
          renderedMessageIds.has(incomingId)
        )
          return;
        renderedMessageIds.add(incomingId);

        const emptyState = container.querySelector("p");
        if (emptyState && container.children.length === 1)
          container.innerHTML = "";

        // If this message falls on a different day than the last one
        // currently rendered, insert a date separator first — keeps a
        // long-running open thread correctly grouped by day even
        // without a full reload.
        const newLabel = formatDateSeparator(payload.new.created_at);
        const lastBubble = container.lastElementChild;
        const lastLabel = container.dataset.lastDateLabel;
        if (newLabel !== lastLabel) {
          container.innerHTML += renderDateSeparator(newLabel);
        }
        container.dataset.lastDateLabel = newLabel;

        container.innerHTML += renderChatBubble(payload.new);
        container.scrollTop = container.scrollHeight;

        // Any incoming message implicitly means the peer stopped
        // typing — clear the indicator right away instead of waiting
        // for their typing-stopped broadcast.
        setTypingStatusVisible(false);
      },
    )
    // Fix/addition: `read` was already being written to (see the
    // mark-as-read call in loadAndRenderMessages) but nothing ever
    // reflected that back into the UI in real time — your own sent
    // message would keep showing a single check forever unless you
    // fully reloaded the thread. Listening for UPDATE events lets the
    // check flip to double the instant the other person actually
    // opens the conversation and their mark-as-read query runs.
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${activeConversationId}`,
      },
      (payload) => {
        if (!payload.new.read) return;
        const bubble = document.querySelector(
          `[data-message-id="${CSS.escape(String(payload.new.id))}"] i.fa-check`,
        );
        if (bubble) {
          bubble.classList.remove("fa-check", "text-black/40");
          bubble.classList.add("fa-check-double", "text-blue-400");
        }
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

  // Backstop: normally openDM() already refuses to open a blocked
  // person's thread at all, but this covers the edge case of blocking
  // someone while already inside a conversation with them.
  if (
    activeConversationPeer &&
    blockedUserIds.has(idKey(activeConversationPeer.id))
  ) {
    showToast("You've blocked this person and can't send messages to them.");
    return;
  }

  input.value = "";
  input.style.height = "auto";
  window._syncChatSendState(input);
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

    const newLabel = formatDateSeparator(optimisticMsg.created_at);
    if (newLabel !== container.dataset.lastDateLabel) {
      container.innerHTML += renderDateSeparator(newLabel);
    }
    container.dataset.lastDateLabel = newLabel;

    container.innerHTML += renderChatBubble(optimisticMsg);
    container.scrollTop = container.scrollHeight;
  }

  try {
    // Fix: this insert's returned row id was never captured anywhere,
    // so the realtime handler's dedup check (comparing
    // container.dataset.lastOptimisticId against the incoming row's
    // id) could never actually match — every message you sent would
    // render once optimistically here, then render AGAIN a moment
    // later when Supabase's realtime INSERT event echoed it back,
    // showing every outgoing message duplicated. Selecting the
    // inserted row back and recording its real id closes that gap.
    const { data: inserted, error: msgErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: activeConversationId,
        sender_id: currentUserData.id,
        text,
      })
      .select("id")
      .single();
    if (msgErr) throw msgErr;

    if (container && inserted?.id) {
      container.dataset.lastOptimisticId = String(inserted.id);
    }

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
    // Same block-detection reasoning as postComment above — this is
    // how we find out the OTHER person blocked you (your local
    // blockedUserIds only knows about blocks you made yourself).
    const isBlockRejection =
      err?.code === "42501" || /row-level security/i.test(err?.message || "");
    showToast(
      isBlockRejection
        ? "This message couldn't be delivered."
        : "Message failed to send.",
    );
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
    // Bug fix: previously ANY auth event while offline was skipped
    // entirely, including a real, locally-cached session being
    // restored (which needs no network — Supabase reads it straight
    // from localStorage). That meant if you happened to be offline
    // the moment the app's first auth check fired, currentUserData
    // never got set at all, and Profile/DMs/Create kept showing the
    // sign-in gate forever afterwards, even once you were clearly
    // still signed in elsewhere. Now we only skip the update for an
    // actual sign-OUT event (user === null) while offline — that's
    // the case a network drop can spuriously fake — and let a real
    // user object through regardless of connectivity.
    if (!navigator.onLine && !user) {
      console.warn(
        "[Auth Observer] Network is offline and no cached session — ignoring sign-out evaluation.",
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
      const authProfileNavDesktop = document.getElementById(
        "auth-profile-nav-desktop",
      );
      if (authProfileNavDesktop) {
        authProfileNavDesktop.innerHTML = `<i class="fas fa-user"></i><span>Profile</span>`;
        authProfileNavDesktop.onclick = function (e) {
          e.stopPropagation();
          window.navigateTo("profile", authProfileNavDesktop);
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

      // Fix: the very first feed load after sign-in/refresh always
      // rebuilt an "all" style filter and ignored whichever tab
      // (Reels, Products, Services, Following) the person had open
      // before — so a refresh silently bounced everyone back to
      // "All". currentFeedType is now rehydrated from
      // localStorage before this runs (see the top of the file),
      // so this restores the same tab, re-applies campus scoping
      // consistently via the shared filterFeed() path, and syncs
      // the active-tab button styling and Reels header mode to
      // match.
      // filterFeed() guards on isAuthInitialized being true, so it
      // must be set before we call it here (it's normally set at
      // the end of this handler) — otherwise this restore call
      // would silently no-op on first load.
      isAuthInitialized = true;

      // Everything below this point is expensive and/or has
      // side effects that don't belong happening more than once
      // per page load (subscribing to realtime channels, syncing
      // the likes table, fetching profile stats) — see
      // hasBootedFeedForSession's declaration for why this guard
      // exists. The lightweight UI sync above (avatar/name text,
      // onboarding check) stays unguarded since re-running it
      // harmlessly on a repeat auth event is fine.
      if (!hasBootedFeedForSession) {
        hasBootedFeedForSession = true;

        // Load the block list before the first render so a blocked
        // person's posts never flash on screen for a moment before
        // being filtered out.
        await syncBlockedUsers();
        await syncFollowingIds();

        updateCampusScopeBanner();
        const savedTabBtn = document.querySelector(
          `.feed-tab-btn[onclick*="'${currentFeedType}'"]`,
        );
        window.filterFeed(currentFeedType, savedTabBtn);
        try {
          loadProfileStats();
        } catch (_) {}
        _initAvatarLongPress();

        // If this page was opened via a shared post link
        // (?post=ID, see the Copy Link menu item), open that
        // post's detail view once the feed has finished its
        // initial load -- otherwise a copied/shared link would
        // just open the app fresh with no way to reach the
        // specific post it pointed to.
        try {
          const sharedPostId = new URLSearchParams(window.location.search).get(
            "post",
          );
          if (sharedPostId) window.openDetail(sharedPostId);
        } catch (_) {}

        // Populate the DMs unread badge immediately on sign-in,
        // rather than only after the person happens to open the DMs
        // tab for the first time.
        try {
          const { data: convData } = await supabase
            .from("conversations")
            .select("*")
            .or(
              `user_a.eq.${currentUserData.id},user_b.eq.${currentUserData.id}`,
            )
            .order("last_message_at", { ascending: false });
          conversationsCache = convData || [];
          updateDmUnreadBadge();
        } catch (_) {}
      }
    } else {
      unsubscribeFeed();
      unsubscribeConversations();
      unsubscribeActiveThread();
      if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);

      // Reset so a genuine sign-out followed by signing back in
      // (within the same page load, not just a refresh) correctly
      // re-runs the one-time boot sequence for the new session,
      // instead of being permanently skipped because it already
      // ran once for the previous person.
      hasBootedFeedForSession = false;

      if (authProfileNav) {
        authProfileNav.innerHTML = `<i class="fas fa-sign-in-alt text-lg"></i><span class="text-[10px] uppercase font-bold tracking-wider">Sign In</span>`;
        authProfileNav.onclick = function (e) {
          e.stopPropagation();
          window.openLoginModal();
        };
      }
      const authProfileNavDesktopOut = document.getElementById(
        "auth-profile-nav-desktop",
      );
      if (authProfileNavDesktopOut) {
        authProfileNavDesktopOut.innerHTML = `<i class="fas fa-sign-in-alt"></i><span>Sign In</span>`;
        authProfileNavDesktopOut.onclick = function (e) {
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
    const header = document.getElementById("site-header");
    const currentScrollY = window.scrollY;

    if (currentScrollY < 20) {
      bottomNav?.classList.remove("bottom-nav-hidden");
      header?.classList.remove("header-hidden");
      lastScrollY = currentScrollY;
      return;
    }
    if (currentScrollY > lastScrollY) {
      bottomNav?.classList.add("bottom-nav-hidden");
      header?.classList.add("header-hidden");
    } else {
      bottomNav?.classList.remove("bottom-nav-hidden");
      header?.classList.remove("header-hidden");
    }
    lastScrollY = currentScrollY;
  },
  { passive: true },
);

// ─── 23. DELEGATED CLICK FOR FEED PROFILE LINKS ──────────────────────────────
// Fix: this previously called navigateTo('profile') unconditionally,
// which always opens the SIGNED-IN person's own profile tab — tapping
// someone else's name/avatar on a post had nowhere real to go and just
// silently reopened your own profile every time. Now it reads which
// person was actually tapped (data-user-id, added to every profile
// trigger element) and opens a real, separate public-profile view for
// them — own profile stays reachable only via the bottom nav, as before.
document.body.addEventListener("click", (event) => {
  const profileClickTarget = event.target.closest(".feed-profile-trigger");
  if (profileClickTarget) {
    event.preventDefault();
    event.stopPropagation();
    const userId = profileClickTarget.dataset.userId;
    if (!userId) return;

    // Tapping your OWN name/avatar on your own post should go to your
    // real profile tab (with editable settings etc.), not the
    // read-only public view meant for other people.
    if (currentUserData && idKey(userId) === idKey(currentUserData.id)) {
      window.navigateTo("profile");
    } else if (typeof window.openPublicProfile === "function") {
      window.openPublicProfile(userId);
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
        if (
          currentCampusScope === "institution" &&
          currentUserData?.institution
        ) {
          q = q.eq("institution", currentUserData.institution);
        } else if (currentCampusScope === "region" && currentUserData?.region) {
          q = q.eq("region", currentUserData.region);
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
// Simple, view-only grid tile — used for the public profile view (someone
// ELSE's posts). Deliberately has none of renderGridItem's press-and-hold
// multi-select wiring, since selecting-to-delete only ever makes sense on
// your own profile; a tap just opens the post like anywhere else in the
// app.
function renderPublicGridItem(id, post) {
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
    <div class="relative aspect-square w-full bg-slate-950 border border-slate-800 rounded-xl overflow-hidden cursor-pointer group hover:border-amber-400/50 transition" onclick="window.openProfilePostViewer('${escAttr(d.user_id)}', '${escAttr(idKey(id))}')">
        ${
          isVideo
            ? `<video class="w-full h-full object-cover" src="${mediaUrl}#t=0.1" preload="metadata" muted playsinline></video>
               <div class="absolute top-1.5 right-1.5 text-white drop-shadow text-[10px]"><i class="fas fa-video"></i></div>`
            : `<img class="w-full h-full object-cover group-hover:scale-105 transition duration-300" src="${mediaUrl || fallbackImage}" alt="" loading="lazy">`
        }
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
            <p class="text-[10px] text-white font-black truncate w-full">GH₵${d.price || 0}</p>
        </div>
    </div>`;
}

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
  const key = idKey(id);

  // Press-and-hold enters multi-select mode and selects this tile; a
  // normal tap either opens the post (outside select mode) or toggles
  // selection (while in select mode). onmousedown/touchstart start a
  // timer; onmouseup/touchend/mouseleave/touchmove-far all cancel it so
  // a normal tap or a scroll gesture never gets mistaken for a hold.
  return `
    <div
        class="grid-tile relative aspect-square w-full bg-slate-950 border border-slate-800 rounded-xl overflow-hidden cursor-pointer group hover:border-amber-400/50 transition"
        data-post-id="${escAttr(key)}"
        onclick="window._handleGridTileTap('${escAttr(key)}')"
        onmousedown="window._startGridTileHold('${escAttr(key)}')"
        onmouseup="window._cancelGridTileHold()"
        onmouseleave="window._cancelGridTileHold()"
        ontouchstart="window._startGridTileHold('${escAttr(key)}')"
        ontouchend="window._cancelGridTileHold()"
        ontouchmove="window._cancelGridTileHold()"
    >
        <span class="grid-tile-check"><i class="fas fa-check"></i></span>
        ${
          isVideo
            ? `<video class="w-full h-full object-cover" src="${mediaUrl}#t=0.1" preload="metadata" muted playsinline></video>
               <div class="absolute top-1.5 right-1.5 text-white drop-shadow text-[10px]"><i class="fas fa-video"></i></div>`
            : `<img class="w-full h-full object-cover group-hover:scale-105 transition duration-300" src="${mediaUrl || fallbackImage}" alt="" loading="lazy">`
        }
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
            <p class="text-[10px] text-white font-black truncate w-full">GH₵${d.price || 0}</p>
        </div>
    </div>`;
}

// ─── GRID MULTI-SELECT (press-and-hold to select, then bulk delete) ────────
let _gridHoldTimer = null;
let _gridSelectMode = false;
let _gridJustLongPressed = false;
const _gridSelectedIds = new Set();
// id -> {title, price, ...} for the signed-in person's OWN posts, refreshed
// every time loadProfileStats() rebuilds the grid. Lets shareSelectedGridItems
// build a real summary of what's selected without a redundant fetch.
const _ownProfilePostsById = new Map();

window._startGridTileHold = function (id) {
  clearTimeout(_gridHoldTimer);
  _gridHoldTimer = setTimeout(() => {
    _gridHoldTimer = null;
    _gridJustLongPressed = true;
    if (!_gridSelectMode) window._enterGridSelectMode();
    window._toggleGridTileSelection(id);
  }, 500);
};

window._cancelGridTileHold = function () {
  clearTimeout(_gridHoldTimer);
  _gridHoldTimer = null;
};

// The click handler fires after mouseup/touchend regardless of whether a
// hold just happened. If the hold timer already fired (long press), skip
// the tap behavior entirely — the hold handler already selected the tile,
// and the browser-generated click right after a long-press shouldn't
// toggle selection a second time or open the post.
window._handleGridTileTap = function (id) {
  if (_gridJustLongPressed) {
    _gridJustLongPressed = false;
    return;
  }
  if (_gridSelectMode) {
    window._toggleGridTileSelection(id);
  } else {
    window.openProfilePostViewer(currentUserData?.id, id);
  }
};

window._enterGridSelectMode = function () {
  _gridSelectMode = true;
  // Fix: the toolbar markup starts with class="hidden", and this app's
  // .hidden rule is `display: none !important` — adding
  // select-mode-active alone was never enough to show it, since a
  // non-!important display:flex rule can't override an !important
  // display:none. The toolbar itself was invisible the whole time even
  // though tiles correctly flipped into select mode (checkmarks use a
  // separate, non-!important CSS rule, so those worked fine and made it
  // look like only "half" of select mode was broken).
  const toolbar = document.getElementById("grid-select-toolbar");
  toolbar?.classList.remove("hidden");
  toolbar?.classList.add("select-mode-active");
  document
    .querySelectorAll(".grid-tile")
    .forEach((t) => t.classList.add("select-mode"));
};

window.exitGridSelectMode = function () {
  _gridSelectMode = false;
  _gridSelectedIds.clear();
  const toolbar = document.getElementById("grid-select-toolbar");
  toolbar?.classList.add("hidden");
  toolbar?.classList.remove("select-mode-active");
  document.querySelectorAll(".grid-tile").forEach((t) => {
    t.classList.remove("select-mode", "tile-selected");
  });
  _updateGridSelectCount();
};

window._toggleGridTileSelection = function (id) {
  const key = idKey(id);
  const tile = document.querySelector(
    `.grid-tile[data-post-id="${CSS.escape(key)}"]`,
  );
  if (_gridSelectedIds.has(key)) {
    _gridSelectedIds.delete(key);
    tile?.classList.remove("tile-selected");
  } else {
    _gridSelectedIds.add(key);
    tile?.classList.add("tile-selected");
  }
  _updateGridSelectCount();

  // Selecting the last remaining tile back down to zero doesn't force
  // an exit — the toolbar (with Cancel) stays up so the person can
  // keep selecting more without re-triggering a long-press.
};

function _updateGridSelectCount() {
  const countEl = document.getElementById("grid-select-count");
  if (countEl) countEl.textContent = `${_gridSelectedIds.size} selected`;
  const flashBtn = document.getElementById("grid-select-flashsale-btn");
  if (flashBtn) {
    flashBtn.classList.toggle("hidden", _gridSelectedIds.size !== 1);
    flashBtn.classList.toggle("flex", _gridSelectedIds.size === 1);
  }
}

// Press-and-hold → select a single post → "Flash Sale" opens the same
// Manage Listing sheet already used from the ⋮ menu, which has the
// discount-price + sale-end-time fields — no separate UI to maintain.
window.openFlashSaleForSelected = function () {
  if (_gridSelectedIds.size !== 1) {
    showToast("Select exactly one post to set a flash sale.");
    return;
  }
  const [postId] = [..._gridSelectedIds];
  window.exitGridSelectMode();
  window.openManageListingSheet(postId);
};

// Shares a combined summary of whatever's currently selected in the "My
// Gigs & Posts" multi-select grid. There's no per-post deep link anywhere
// in this single-page app to share individually (sharePost, the existing
// single-post share, already just links back to the app's root URL with
// a text description) — so for multiple selected posts, this builds one
// combined text listing (title + price per item) and shares/copies that,
// which is the honest equivalent given what the app actually has to share.
window.shareSelectedGridItems = function () {
  if (_gridSelectedIds.size === 0) {
    showToast("Select at least one post first.");
    return;
  }

  const ids = [..._gridSelectedIds];
  const items = ids.map((id) => _ownProfilePostsById.get(id)).filter(Boolean);

  if (items.length === 0) {
    showToast("Couldn't find details for the selected posts.");
    return;
  }

  const lines = items.map((d) => `• ${d.title} — GH₵${d.price ?? 0}`);
  const intro =
    items.length === 1
      ? `Check out "${items[0].title}" on CampusMarket!`
      : `Check out these ${items.length} listings on CampusMarket!`;
  const shareText = `${intro}\n${lines.join("\n")}\n${window.location.href}`;

  if (navigator.share) {
    // Fix: same hardening as window.sharePost above — distinguish
    // user-cancel (AbortError, silent) from real failure (log +
    // clipboard fallback toast) so multi-select share never appears
    // to do nothing on tap.
    navigator.share({ title: "CampusMarket", text: shareText }).then(
      () => showToast("Shared! ✓"),
      (err) => {
        if (err?.name === "AbortError") return;
        console.warn("navigator.share failed:", err);
        if (navigator.clipboard?.writeText) {
          navigator.clipboard
            .writeText(shareText)
            .then(() => showToast("Share failed — link copied instead."))
            .catch(() => showToast("Couldn't share or copy the link."));
        } else {
          showToast("Couldn't share the link.");
        }
      },
    );
  } else {
    navigator.clipboard?.writeText(shareText);
    showToast("Link copied to clipboard!");
  }
};

window.deleteSelectedGridItems = function () {
  if (_gridSelectedIds.size === 0) {
    showToast("Select at least one post first.");
    return;
  }

  const ids = [..._gridSelectedIds];
  showConfirmDialog({
    title: `Delete ${ids.length} post${ids.length > 1 ? "s" : ""}?`,
    message:
      "This can't be undone. The selected posts, their media, and any likes or comments on them will be permanently removed.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      showToast(`Deleting ${ids.length} post${ids.length > 1 ? "s" : ""}…`);
      let failCount = 0;

      for (const id of ids) {
        try {
          await _deletePostById(id);
        } catch (err) {
          console.error("Bulk delete error for post", id, err);
          failCount++;
        }
      }

      window.exitGridSelectMode();
      try {
        loadProfileStats();
      } catch (_) {}

      if (failCount === 0) {
        showToast(`${ids.length} post${ids.length > 1 ? "s" : ""} deleted`);
      } else {
        showToast(
          `Deleted ${ids.length - failCount} of ${ids.length} — some failed, please try again`,
        );
      }
    },
  });
};

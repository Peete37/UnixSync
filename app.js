// ─── 1. IMPORTS ───────────────────────────────────────────────────────────────
import { supabase } from "./supabase-config.js";
import { onAuthChange, signInWithGoogle, signOutUser as authSignOut } from "./auth.service.js";

// ─── 2. CONSTANTS ─────────────────────────────────────────────────────────────
const FEED_LIMIT         = 30;
const SEARCH_LIMIT       = 100;
const SEARCH_RESULTS_CAP = 20;

const GHANA_DATA = {
    'Greater Accra': ['University of Ghana (UG)', 'University of Professional Studies Accra (UPSA)', 'Ghana Institute of Management and Public Administration (GIMPA)', 'Accra Technical University (ATU)', 'Methodist University Ghana', 'Central University', 'Academic City University College', 'Lancaster University Ghana', 'University of Media Arts and Communication (UMAC)', 'Radford University College'],
    'Ashanti': ['Kwame Nkrumah University of Science and Technology (KNUST)', 'Kumasi Technical University (KsTU)', 'Kumasi College of Health Sciences', 'Pentecost University', 'Christian Service University College', 'Valley View University (Kumasi Campus)', 'Sunyani Technical University'],
    'Eastern': ['Koforidua Technical University (KTU)', 'University of Energy and Natural Resources (UENR)', 'Akenten Appiah-Menka University of Skills Training and Entrepreneurial Development (AAMUSTED)', 'Presbyterian University Ghana (Abetifi Campus)'],
    'Central': ['University of Cape Coast (UCC)', 'Cape Coast Technical University (CCTU)', 'University of Education Winneba (UEW)', 'Winneba Technical University', 'Takoradi Technical University'],
    'Western': ['University of Mines and Technology (UMaT)', 'Takoradi Technical University (TTU)', 'Western Technical University'],
    'Northern': ['University for Development Studies (UDS)', 'Tamale Technical University', 'SD Dombo University of Business and Integrated Development Studies (SDD-UBIDS)'],
    'Upper East': ['University for Development Studies (UDS — Bolgatanga Campus)', 'Bolgatanga Technical University'],
    'Upper West': ['University for Development Studies (UDS — Wa Campus)', 'Wa Technical University'],
    'Volta': ['Ho Technical University (HTU)', 'University of Health and Allied Sciences (UHAS)'],
    'Oti': ['Oti Nursing and Midwifery Training College'],
    'Bono': ['Sunyani Technical University', 'University of Energy and Natural Resources (UENR — Sunyani Campus)'],
    'Bono East': ['Techiman Nursing and Midwifery Training College'],
    'Ahafo': ['Goaso College of Education'],
    'Savannah': ['Damongo College of Education'],
    'North East': ['Nalerigu College of Health Sciences'],
    'Western North': ['Sefwi Wiawso College of Education'],
};

const ALL_REGIONS      = Object.keys(GHANA_DATA).sort();
const ALL_INSTITUTIONS = [...new Set(Object.values(GHANA_DATA).flat())].sort();

// ─── 3. MODULE STATE ──────────────────────────────────────────────────────────
let currentUserData     = null;
let currentFeedChan     = null;
let currentCommentsChan = null;
let allCachedPosts      = [];
let isAuthInitialized   = false;
let isOnline            = navigator.onLine;
let currentFeedType     = 'all'; // tracks active tab: all | following | product | skill

// DM state
let currentConversationsChan = null;
let currentMessagesChan      = null;
let activeConversationId     = null;
let activeConversationPeer   = null; // { id, name, avatar }
let conversationsCache       = [];

// Persistent state maps that survive feed re-renders
const likedPostIds      = new Set(JSON.parse(localStorage.getItem('campus_market_likes') || '[]'));
const openCommentIds    = new Set(); // tracks which comment sections are open

let userCartList = JSON.parse(localStorage.getItem("campus_market_cart") || "[]");

Object.defineProperty(window, '_currentUser',   { get: () => currentUserData });
Object.defineProperty(window, '_userCartList',  { get: () => userCartList });

// ─── 3b. MEDIA EDIT MODAL STATE (WhatsApp-style edit before upload) ──────────
// Files staged for review in the "Edit Media" modal before they're actually
// attached/uploaded. Each entry: { file, url (object URL), rotation, type }
let stagedMediaFiles  = [];
let activeStagedIndex = 0;
let finalMediaFiles   = []; // the files the user actually confirmed via "Use These Files"

// ─── 3c. HISTORY / BACK-BUTTON STATE ──────────────────────────────────────────
// Tracks which overlays (modals, comment sheets, DM threads) are open so the
// phone's hardware/gesture back button closes them one layer at a time
// instead of exiting/backgrounding the app.
const _uiStack = [];

function pushUiState(id, closeFn) {
    _uiStack.push({ id, close: closeFn });
    try { history.pushState({ uiLayer: id }, ''); } catch (_) {}
}

function popUiState(id) {
    const idx = _uiStack.findIndex(l => l.id === id);
    if (idx !== -1) _uiStack.splice(idx, 1);
}

window.addEventListener('popstate', () => {
    if (_uiStack.length > 0) {
        const top = _uiStack.pop();
        try { top.close(true); } catch (_) {}
        // Re-arm a history entry so the next back-press is caught again
        // if there's still something else open underneath.
        if (_uiStack.length > 0) {
            try { history.pushState({ uiLayer: _uiStack[_uiStack.length - 1].id }, ''); } catch (_) {}
        }
    }
});

// Seed one base history entry so the first back-press when nothing is open
// behaves like a normal app (doesn't feel broken), while genuinely letting
// the browser/app handle exit navigation once the stack is empty.
try { history.replaceState({ uiLayer: 'base' }, ''); } catch (_) {}

// ─── 4. UTILITIES ─────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function escAttr(str) {
    return esc(str).replace(/`/g, '&#x60;');
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function buildOptions(arr, selectedVal = '') {
    return arr.map(v =>
        `<option value="${esc(v)}" ${v === selectedVal ? 'selected' : ''}>${esc(v)}</option>`
    ).join('');
}

function buildInstitutionOptions(region, selectedVal = '') {
    const list = region && GHANA_DATA[region] ? GHANA_DATA[region] : ALL_INSTITUTIONS;
    return buildOptions(list, selectedVal);
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] bg-slate-800 border border-slate-700 text-white text-xs font-bold px-4 py-2.5 rounded-2xl shadow-xl whitespace-nowrap';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatClockTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const activeAuthChange = typeof onAuthChange === 'function'
    ? onAuthChange
    : (typeof window.onAuthChange === 'function' ? window.onAuthChange : null);

if (!activeAuthChange) {
    console.error('[app.js] onAuthChange is not available. Auth will not function.');
}

// ─── 5. ONBOARDING MODAL ──────────────────────────────────────────────────────
function injectOnboardingModal() {
    if (document.getElementById('onboarding-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'onboarding-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4';
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
    const instSelect = document.getElementById('onboard-institution');
    if (!instSelect) return;
    instSelect.innerHTML =
        `<option value="">— Select your institution —</option>` +
        buildInstitutionOptions(region);
};

window.saveOnboarding = async function () {
    const region      = document.getElementById('onboard-region')?.value;
    const institution = document.getElementById('onboard-institution')?.value;

    if (!region)      { alert('Please select your region.'); return; }
    if (!institution) { alert('Please select your institution.'); return; }
    if (!currentUserData) return;

    try {
        const metadata = currentUserData.user_metadata || {};

        const { error } = await supabase
            .from("profiles")
            .upsert({
                id: currentUserData.id,
                name: metadata.full_name || 'Student',
                avatar: metadata.avatar_url || '',
                email: currentUserData.email || '',
                institution,
                region,
                created_at: new Date().toISOString()
            });

        if (error) throw error;

        currentUserData.institution = institution;
        currentUserData.region = region;

        applyLocationToUI(institution, region);
        document.getElementById('onboarding-modal')?.remove();
    } catch (err) {
        console.error("Onboarding save error:", err);
        alert('Could not save your details. Please try again.');
    }
};

function applyLocationToUI(institution, region) {
    const instEl     = document.getElementById('profileInstitution');
    const regEl      = document.getElementById('profileRegion');
    const locationEl = document.getElementById('profile-ui-location');

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
        document.getElementById('login-modal')?.classList.add('hidden');
        document.getElementById('signup-modal')?.classList.add('hidden');
        await signInWithGoogle();
    } catch (err) {
        console.error("Login failure:", err);
        showToast('Sign-in failed. Please try again.');
    }
};

window.logout = async function () {
    try {
        unsubscribeFeed();
        unsubscribeConversations();
        unsubscribeActiveThread();
        if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);
        await authSignOut();
        window.navigateTo('feed');
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
        .limit(FEED_LIMIT);
}

async function fetchFeedSnapshot(queryFactory = null) {
    const req = queryFactory ? queryFactory() : defaultFeedQuery();
    const { data, error } = await req;
    if (error) throw error;
    return data || [];
}

async function subscribeFeed(queryFactory = null) {
    unsubscribeFeed();

    try {
        const data = await fetchFeedSnapshot(queryFactory);
        allCachedPosts = data.map(item => ({ id: item.id, data: item }));

        // Sync local bookmark view mapping if authenticated
        if (currentUserData) {
            const { data: remoteSaves } = await supabase
                .from("saves")
                .select("post_id")
                .eq("user_id", currentUserData.id);

            if (remoteSaves) {
                const savedIds = remoteSaves.map(s => s.post_id);
                userCartList = userCartList.filter(item => savedIds.includes(item.id));
                allCachedPosts.forEach(({ id, data: d }) => {
                    if (savedIds.includes(id) && !userCartList.some(c => c.id === id)) {
                        userCartList.push({
                            id,
                            title: d.title,
                            price: d.price,
                            media_url: d.media_url || '',
                            media_type: d.media_type || 'image',
                            institution: d.institution || '',
                            type: d.type || 'product',
                            user_name: d.user_name || 'Anonymous'
                        });
                    }
                });
                localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
            }
        }

        renderFeedFromCache();
    } catch (err) {
        console.error("Feed poll error:", err);
    }

    currentFeedChan = supabase
        .channel(`posts-live-feed-${Date.now()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, async () => {
            try {
                const data = await fetchFeedSnapshot(queryFactory);
                allCachedPosts = data.map(item => ({ id: item.id, data: item }));
                renderFeedFromCache();

                if (!document.getElementById('profile-container')?.classList.contains('hidden')) {
                    loadProfileStats();
                }
            } catch (err) {
                console.error("Feed live refresh error:", err);
            }
        })
        .subscribe();
}

// ─── 8. NAVIGATION CONTROL ────────────────────────────────────────────────────
function clearNavHighlights() {
    document.querySelectorAll('nav button, .bottom-nav button, nav a').forEach(b => {
        b.classList.remove('nav-active');
        b.classList.replace('text-white', 'text-slate-400');
        b.querySelector('span:last-child')?.classList.replace('text-white', 'text-slate-400');
    });
}

function setNavHighlight(btn, viewId) {
    if (btn) {
        btn.classList.add('nav-active');
        btn.classList.replace('text-slate-400', 'text-white');
        btn.querySelector('span:last-child')?.classList.replace('text-slate-400', 'text-white');
        return;
    }

    const navMap = {
        feed: 'nav-btn-feed',
        explore: 'nav-btn-explore',
        dms: 'nav-btn-dms',
        profile: 'auth-profile-nav',
        cart: 'nav-btn-cart'
    };

    const fallback = document.getElementById(navMap[viewId]);
    if (fallback) {
        fallback.classList.add('nav-active');
        fallback.classList.replace('text-slate-400', 'text-white');
        fallback.querySelector('span:last-child')?.classList.replace('text-slate-400', 'text-white');
    }
}

window.navigateTo = function (viewId, btn = null) {
    // Stop all reel video audio whenever we leave the feed entirely, so
    // switching to Profile/DMs/etc never leaves background audio playing.
    if (viewId !== 'feed') {
        pauseAllReelVideos();
    }

    ['feed-container', 'profile-container', 'explore-container', 'dms-container', 'cart-container']
        .forEach(id => document.getElementById(id)?.classList.add('hidden'));

    const targetId = viewId === 'feed' ? 'feed-container' : `${viewId}-container`;
    const targetElement = document.getElementById(targetId);
    if (targetElement) targetElement.classList.remove('hidden');

    // feed-tabs now lives in the merged header row (always visible), but
    // it only applies to the feed itself — hide it on other views the
    // same way the old two-row header did.
    const tabs = document.getElementById('feed-tabs');
    if (tabs) tabs.style.display = viewId === 'feed' ? 'flex' : 'none';

    // Leaving the feed always exits Reels overlay mode so the header goes
    // back to its normal solid bar on Profile/DMs/Explore/Cart.
    if (viewId !== 'feed') {
        document.getElementById('site-header')?.classList.remove('header-reels-mode');
    }

    clearNavHighlights();
    setNavHighlight(btn, viewId);

    if (viewId === 'profile') {
        const gate    = document.getElementById('profile-auth-gate');
        const content = document.getElementById('profile-content');
        if (!currentUserData) {
            gate?.classList.remove('hidden');
            content?.classList.add('hidden');
        } else {
            gate?.classList.add('hidden');
            content?.classList.remove('hidden');
            loadProfileStats();
        }
    }

    if (viewId === 'dms') {
        const gate    = document.getElementById('dms-auth-gate');
        const content = document.getElementById('dms-content');
        if (!currentUserData) {
            gate?.classList.remove('hidden');
            content?.classList.add('hidden');
        } else {
            gate?.classList.add('hidden');
            content?.classList.remove('hidden');
            openInboxView();
        }
    } else {
        // leaving DMs view entirely (not opening a thread) — tear down thread listener
        if (viewId !== 'dms-thread') unsubscribeActiveThread();
    }

    if (viewId === 'cart') {
        renderCartListView();
    }
};

window.switchProfileTab = function (tabType, selectedBtn) {
    document.querySelectorAll('.profile-subview').forEach(view => view.classList.add('hidden'));

    document.querySelectorAll('.profile-subtab-btn').forEach(btn => {
        btn.classList.replace('text-amber-400', 'text-slate-400');
        btn.classList.replace('border-amber-400', 'border-transparent');
    });

    document.getElementById(`profile-subview-${tabType}`)?.classList.remove('hidden');
    selectedBtn.classList.replace('text-slate-400', 'text-amber-400');
    selectedBtn.classList.replace('border-transparent', 'border-amber-400');
};

window.togglePostModal = function () {
    if (!currentUserData) {
        window.openLoginModal();
        return;
    }
    const modal = document.getElementById('post-modal');
    if (!modal) return;
    const willOpen = modal.classList.contains('hidden');
    modal.classList.toggle('hidden');

    if (willOpen) {
        pushUiState('post-modal', () => {
            document.getElementById('post-modal')?.classList.add('hidden');
        });
    } else {
        popUiState('post-modal');
    }
};

// ─── 9. DETAIL MODAL ──────────────────────────────────────────────────────────
window.openDetail = async function (postId) {
    const modal   = document.getElementById('detail-modal');
    const content = document.getElementById('detail-content');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    pushUiState('detail-modal', () => window.closeDetailModal(true));
    content.innerHTML = `<div class="p-20 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Syncing Details...</div>`;

    try {
        const { data: d, error } = await supabase.from("posts").select("*").eq("id", postId).single();

        if (error || !d) {
            content.innerHTML = `<p class="p-10 text-center text-red-500 text-xs">Post not found.</p>`;
            return;
        }

        const viewer      = currentUserData;
        const isOwn       = viewer && d.user_id === viewer.id;
        const isFollowing = (!isOwn && viewer) ? await checkFollowing(d.user_id) : false;

        let mediaUrls = [];
        if (d.media_url) {
            if (d.media_url.startsWith('[')) {
                try { mediaUrls = JSON.parse(d.media_url); } catch(_) { mediaUrls = [d.media_url]; }
            } else {
                mediaUrls = [d.media_url];
            }
        }

        let mediaBlock = '';
        if (mediaUrls.length > 1) {
            const slides = mediaUrls.map((url, i) =>
                d.media_type === 'video'
                    ? `<video class="carousel-slide w-full aspect-video object-cover shrink-0 snap-start" ${i === 0 ? 'autoplay' : ''} controls src="${esc(url)}"></video>`
                    : `<img class="carousel-slide w-full object-cover shrink-0 snap-start" src="${esc(url)}" alt="Image ${i+1}">`
            ).join('');
            mediaBlock = `
                <div class="relative w-full">
                    <div id="detail-carousel" class="flex overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar" style="scroll-snap-type:x mandatory;">
                        ${slides}
                    </div>
                    <div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                        ${mediaUrls.map((_, i) => `<div class="carousel-dot w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-amber-400' : 'bg-white/40'}"></div>`).join('')}
                    </div>
                </div>`;
        } else if (mediaUrls.length === 1) {
            mediaBlock = d.media_type === 'video'
                ? `<video class="w-full aspect-video object-cover" controls autoplay src="${esc(mediaUrls[0])}"></video>`
                : `<img class="w-full object-cover" src="${esc(mediaUrls[0])}" alt="Post Media">`;
        }

        const followBlock = (!isOwn && viewer) ? `
            <button
                id="follow-btn-detail"
                class="follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 ${isFollowing ? 'bg-slate-700 text-slate-300 border border-slate-600' : 'bg-amber-400 text-black'}"
                data-follow-uid="${esc(d.user_id)}"
                data-active="${isFollowing}"
                onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
                ${isFollowing ? '✓ Following' : '+ Follow'}
            </button>` : '';

        const isAddedToCart  = userCartList.some(item => item.id === d.id);
        const cartText       = isAddedToCart ? "✓ Added to Chart" : "Add to Chart List";
        const cartColorClass = isAddedToCart
            ? "bg-slate-800 border border-slate-700 text-slate-400"
            : "bg-slate-900 border border-slate-700 text-white hover:border-amber-400";

        const ctaLabel = d.type === 'skill' ? 'Book Technical Service' : 'Contact Seller';

        content.innerHTML = `
            <div class="w-full bg-slate-950 relative">${mediaBlock}</div>
            <div class="p-6 space-y-4">
                <div class="flex justify-between items-center gap-4">
                    <h1 class="text-2xl font-bold text-white uppercase tracking-tighter">${esc(d.title) || 'Campus Item'}</h1>
                    <span class="text-amber-400 font-black text-xl shrink-0">GH₵${esc(String(d.price || 0))}</span>
                </div>
                <div class="flex flex-wrap gap-2 text-[10px] uppercase font-bold tracking-wider">
                    <span class="bg-slate-800 text-amber-400 px-2 py-1 rounded border border-slate-700">${esc(d.institution) || 'All Campuses'}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700">${esc(d.region) || 'All Regions'}</span>
                    <span class="bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700 capitalize">${esc(d.type) || 'product'}</span>
                </div>
                <div class="flex items-center justify-between gap-3 p-3 bg-slate-900 rounded-xl border border-slate-800">
                    <div class="flex items-center gap-3 min-w-0">
                        <img src="${esc(d.user_avatar) || 'https://ui-avatars.com/api/?name=User'}" class="w-10 h-10 rounded-full border border-amber-400 object-cover" alt="Avatar">
                        <div class="min-w-0">
                            <p class="text-xs text-slate-500 uppercase">Provider</p>
                            <p class="text-sm font-bold truncate">${esc(d.user_name) || 'Anonymous Student'}</p>
                        </div>
                    </div>
                    ${followBlock}
                </div>
                <p class="text-slate-400 leading-relaxed font-light">${esc(d.description) || 'No description provided.'}</p>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
                    <button
                        id="detail-cart-btn-${escAttr(d.id)}"
                        onclick="window.toggleCartItem('${escAttr(d.id)}')"
                        class="w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs ${cartColorClass}">
                        <i class="fas fa-shopping-basket mr-1.5 text-[11px]"></i><span class="cart-btn-label">${cartText}</span>
                    </button>
                    <button onclick="contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}')" class="w-full bg-amber-400 text-black font-black py-4 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                        ${esc(ctaLabel)}
                    </button>
                </div>
            </div>`;

        if (mediaUrls.length > 1) {
            const carousel = document.getElementById('detail-carousel');
            const dots     = content.querySelectorAll('.carousel-dot');
            carousel?.addEventListener('scroll', () => {
                const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
                dots.forEach((d, i) => {
                    d.classList.toggle('bg-amber-400', i === idx);
                    d.classList.toggle('bg-white/40',  i !== idx);
                });
            }, { passive: true });
        }

    } catch (e) {
        console.error("Detail load error:", e);
        content.innerHTML = `<p class="p-10 text-center text-red-500 text-xs">Error loading post.</p>`;
    }
};

window.closeDetailModal = function (fromPop = false) {
    document.getElementById('detail-modal')?.classList.add('hidden');
    if (!fromPop) popUiState('detail-modal');
};

// ─── 10. LOGIN MODAL ──────────────────────────────────────────────────────────
window.openLoginModal = function () {
    // Never show credential entry while offline — keeps the app feeling
    // professional instead of dumping a broken form on a dead connection.
    if (!isOnline) {
        showToast("You're offline. Reconnect to sign in.");
        return;
    }
    document.getElementById('signup-modal')?.classList.add('hidden');
    document.getElementById('login-modal')?.classList.remove('hidden');
    pushUiState('login-modal', () => window.closeLoginModal(true));
};

window.closeLoginModal = function (fromPop = false) {
    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('signup-modal')?.classList.add('hidden');
    if (!fromPop) popUiState('login-modal');
};

// ─── 10b. EMAIL AUTH ──────────────────────────────────────────────────────────
window.loginWithEmail = async function () {
    const email = document.getElementById('login-email')?.value.trim();
    const password = document.getElementById('login-password')?.value;
    if (!email || !password) { showToast('Fill in credentials'); return; }
    await window.signInWithEmailPassword(email, password);
};

window.signUpWithEmail = async function () {
    const name = document.getElementById('signup-name')?.value.trim();
    const email = document.getElementById('signup-email')?.value.trim();
    const password = document.getElementById('signup-password')?.value;
    if (!name || !email || !password) { showToast('Complete all fields'); return; }
    await window.registerWithEmail(name, email, password);
};

window.signInWithEmailPassword = async function (email, password) {
    if (!isOnline) { showToast("You're offline. Reconnect to sign in."); return; }
    const btn = document.querySelector('#login-modal button[onclick="window.loginWithEmail()"]');
    try {
        if (btn) { btn.textContent = 'Signing in…'; btn.disabled = true; }
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        document.getElementById('login-modal')?.classList.add('hidden');
        showToast('Welcome back! ✓');
    } catch (err) {
        console.error("Email sign-in error:", err);
        showToast(err.message || 'Sign-in failed. Check your credentials.');
    } finally {
        if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
    }
};

window.registerWithEmail = async function (name, email, password) {
    if (!isOnline) { showToast("You're offline. Reconnect to sign up."); return; }
    const btn = document.querySelector('#signup-modal button[onclick="window.signUpWithEmail()"]');
    try {
        if (btn) { btn.textContent = 'Creating account…'; btn.disabled = true; }
        const { error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: name } }
        });
        if (error) throw error;
        document.getElementById('signup-modal')?.classList.add('hidden');
        showToast('Account created! Check your email to confirm. ✓');
    } catch (err) {
        console.error("Email sign-up error:", err);
        showToast(err.message || 'Sign-up failed. Please try again.');
    } finally {
        if (btn) { btn.textContent = 'Create Account'; btn.disabled = false; }
    }
};

// ─── 11. AVATAR UPLOAD ────────────────────────────────────────────────────────
window.handleAvatarUpload = async function (inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;

    if (!currentUserData) { showToast('Please sign in first.'); return; }
    if (!file.type.startsWith('image/')) { showToast('Please choose an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB.'); return; }

    const previewEl = document.getElementById('profile-ui-avatar');
    const localURL  = URL.createObjectURL(file);
    if (previewEl) previewEl.src = localURL;

    showToast('Uploading avatar…');

    try {
        const ext         = file.name.split('.').pop();
        const storagePath = `${currentUserData.id}/avatar.${ext}`;

        const { error: uploadErr } = await supabase.storage
            .from('avatars')
            .upload(storagePath, file, { contentType: file.type, upsert: true });

        if (uploadErr) throw uploadErr;

        const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(storagePath);
        const dynamicUrl = `${publicUrl}?t=${Date.now()}`;

        const { error: dbErr } = await supabase
            .from('profiles')
            .update({ avatar: dynamicUrl })
            .eq('id', currentUserData.id);

        if (dbErr) throw dbErr;

        await supabase.auth.updateUser({ data: { avatar_url: dynamicUrl } });

        if (!currentUserData.user_metadata) currentUserData.user_metadata = {};
        currentUserData.user_metadata.avatar_url = dynamicUrl;

        if (previewEl) previewEl.src = publicUrl;
        showToast('Avatar updated! ✓');
    } catch (err) {
        console.error('Avatar upload error:', err);
        if (previewEl) {
            previewEl.src = currentUserData.user_metadata?.avatar_url || 'https://ui-avatars.com/api/?name=User';
        }
        showToast('Upload failed. Please try again.');
    } finally {
        inputEl.value = '';
    }
};

// ─── 11b. AVATAR LONG-PRESS MODAL ────────────────────────────────────────────
let _avatarPressTimer = null;
function _initAvatarLongPress() {
    const profileAvatar    = document.getElementById('profile-ui-avatar');
    const avatarModal      = document.getElementById('avatarModal');
    const modalAvatarImg   = document.getElementById('modalAvatarImg');
    const closeAvatarBtn   = document.getElementById('closeAvatarBtn');
    const copyImageBtn     = document.getElementById('copyImageBtn');
    const downloadImageBtn = document.getElementById('downloadImageBtn');

    if (!profileAvatar || !avatarModal || !modalAvatarImg) return;

    function openAvatarModal(src) {
        modalAvatarImg.src = src;
        avatarModal.classList.remove('hidden');
        pushUiState('avatar-modal', () => { avatarModal.classList.add('hidden'); });
    }
    function closeAvatarModalFn() {
        avatarModal.classList.add('hidden');
        popUiState('avatar-modal');
    }

    function startPress() {
        clearTimeout(_avatarPressTimer);
        _avatarPressTimer = setTimeout(() => { openAvatarModal(profileAvatar.src); }, 600);
    }

    function cancelPress() { clearTimeout(_avatarPressTimer); }

    profileAvatar.addEventListener('touchstart',  startPress,  { passive: true });
    profileAvatar.addEventListener('touchend',    cancelPress);
    profileAvatar.addEventListener('touchmove',   cancelPress);
    profileAvatar.addEventListener('mousedown',   startPress);
    profileAvatar.addEventListener('mouseup',     cancelPress);
    profileAvatar.addEventListener('mouseleave',  cancelPress);

    closeAvatarBtn?.addEventListener('click', closeAvatarModalFn);
    avatarModal.addEventListener('click', (e) => { if (e.target === avatarModal) closeAvatarModalFn(); });

    copyImageBtn?.addEventListener('click', async () => {
        try {
            const response = await fetch(modalAvatarImg.src);
            const blob = await response.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            showToast('✓ Image copied to clipboard!');
        } catch (err) {
            console.error('Copy failed:', err);
            showToast('Failed to copy image.');
        }
    });

    downloadImageBtn?.addEventListener('click', async () => {
        try {
            const response = await fetch(modalAvatarImg.src);
            const blob     = await response.blob();
            const blobUrl  = window.URL.createObjectURL(blob);
            const link     = document.createElement('a');
            link.href      = blobUrl;
            link.download  = `avatar-${Date.now()}.jpg`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
            showToast('✓ Download started!');
        } catch (err) {
            console.error('Download failed:', err);
            showToast('Failed to download image.');
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initAvatarLongPress);
} else {
    _initAvatarLongPress();
}

// ─── 11c. MEDIA EDIT MODAL (WhatsApp-style edit before upload) ──────────────
// Opened automatically whenever files are chosen via the mediaInput file
// picker. Lets the user preview, rotate, and remove files before they are
// actually attached to the listing (finalMediaFiles is what gets uploaded).
window.openEditMediaModal = function (fileList) {
    // Revoke any previously staged object URLs to avoid leaking memory
    stagedMediaFiles.forEach(f => { try { URL.revokeObjectURL(f.url); } catch(_) {} });

    stagedMediaFiles = Array.from(fileList).map(file => ({
        file,
        url: URL.createObjectURL(file),
        rotation: 0,
        type: file.type.startsWith('video') ? 'video' : 'image'
    }));
    activeStagedIndex = 0;

    renderEditMediaModal();

    const modal = document.getElementById('editMediaModal');
    modal?.classList.remove('hidden');
    pushUiState('edit-media-modal', () => window.closeEditMediaModal(true));
};

function renderEditMediaModal() {
    const mainPreview = document.getElementById('editMainPreview');
    const thumbStrip  = document.getElementById('editThumbStrip');
    if (!mainPreview || !thumbStrip) return;

    if (stagedMediaFiles.length === 0) {
        mainPreview.innerHTML = `<p class="text-slate-500 text-xs p-8">No files attached.</p>`;
        thumbStrip.innerHTML = '';
        return;
    }

    if (activeStagedIndex >= stagedMediaFiles.length) activeStagedIndex = stagedMediaFiles.length - 1;
    const active = stagedMediaFiles[activeStagedIndex];

    const rotationStyle = `transform: rotate(${active.rotation}deg);`;
    mainPreview.innerHTML = active.type === 'video'
        ? `<video src="${active.url}" style="${rotationStyle}" controls muted></video>
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>`
        : `<img src="${active.url}" style="${rotationStyle}" alt="Preview">
           <button class="rotate-btn" onclick="window._rotateStagedMedia()"><i class="fas fa-rotate-right text-sm"></i></button>`;

    thumbStrip.innerHTML = stagedMediaFiles.map((f, i) => `
        <div class="edit-thumb ${i === activeStagedIndex ? 'active-thumb' : ''}" onclick="window._selectStagedMedia(${i})">
            ${f.type === 'video'
                ? `<video src="${f.url}" muted></video>`
                : `<img src="${f.url}" alt="thumb ${i+1}">`}
            <button class="remove-thumb-btn" onclick="event.stopPropagation(); window._removeStagedMedia(${i})">✕</button>
        </div>
    `).join('');
}

window._selectStagedMedia = function (i) {
    activeStagedIndex = i;
    renderEditMediaModal();
};

window._rotateStagedMedia = function () {
    if (!stagedMediaFiles[activeStagedIndex]) return;
    stagedMediaFiles[activeStagedIndex].rotation = (stagedMediaFiles[activeStagedIndex].rotation + 90) % 360;
    renderEditMediaModal();
};

window._removeStagedMedia = function (i) {
    const removed = stagedMediaFiles.splice(i, 1)[0];
    if (removed) { try { URL.revokeObjectURL(removed.url); } catch(_) {} }
    if (activeStagedIndex >= stagedMediaFiles.length) activeStagedIndex = Math.max(0, stagedMediaFiles.length - 1);
    renderEditMediaModal();
    if (stagedMediaFiles.length === 0) {
        const countEl = document.getElementById('mediaFileCount');
        if (countEl) countEl.textContent = '';
    }
};

window.closeEditMediaModal = function (fromPop = false) {
    document.getElementById('editMediaModal')?.classList.add('hidden');
    if (!fromPop) popUiState('edit-media-modal');
};

// Applies rotation (if any) by redrawing rotated images to canvas so the
// final uploaded file actually reflects the edit, then stores the
// confirmed set as finalMediaFiles for handlePostSubmission to use.
window.confirmEditedMedia = async function () {
    if (stagedMediaFiles.length === 0) {
        showToast('Please attach at least one file.');
        window.closeEditMediaModal();
        return;
    }

    const processed = [];
    for (const item of stagedMediaFiles) {
        if (item.type === 'image' && item.rotation !== 0) {
            try {
                const rotatedFile = await rotateImageFile(item.file, item.rotation);
                processed.push(rotatedFile);
            } catch (e) {
                console.warn('Rotate failed, using original file:', e);
                processed.push(item.file);
            }
        } else {
            processed.push(item.file);
        }
    }

    finalMediaFiles = processed;

    const countEl = document.getElementById('mediaFileCount');
    if (countEl) {
        countEl.textContent = `${processed.length} file${processed.length > 1 ? 's' : ''} ready — tap Publish to upload`;
    }

    window.closeEditMediaModal();
    showToast('Media ready ✓');
};

function rotateImageFile(file, degrees) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const swap = degrees === 90 || degrees === 270;
            canvas.width  = swap ? img.height : img.width;
            canvas.height = swap ? img.width  : img.height;
            const ctx = canvas.getContext('2d');
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate((degrees * Math.PI) / 180);
            ctx.drawImage(img, -img.width / 2, -img.height / 2);
            canvas.toBlob((blob) => {
                URL.revokeObjectURL(objUrl);
                if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
                resolve(new File([blob], file.name, { type: file.type || 'image/jpeg' }));
            }, file.type || 'image/jpeg', 0.92);
        };
        img.onerror = reject;
        img.src = objUrl;
    });
}

// ─── 12. CARD RENDERERS ───────────────────────────────────────────────────────
window.likePost = async function (postId, btn) {
    if (!currentUserData) {
        showToast("Please sign in to like posts.");
        return;
    }
    if (!postId || postId === 'undefined') {
        showToast("Error: Missing Post Identifier");
        return;
    }

    const liked   = likedPostIds.has(postId);
    const countEl = btn.querySelector('.like-count');
    const icon    = btn.querySelector('i');
    let currentCount = parseInt(countEl?.textContent || 0);

    // 1. Optimistic UI update
    if (liked) {
        likedPostIds.delete(postId);
        icon.className = 'far fa-heart text-slate-300';
        btn.classList.remove('text-rose-500');
        currentCount = Math.max(0, currentCount - 1);
    } else {
        likedPostIds.add(postId);
        icon.className = 'fas fa-heart text-rose-500';
        btn.classList.add('text-rose-500');
        currentCount = currentCount + 1;
    }

    if (countEl) countEl.textContent = currentCount;
    localStorage.setItem('campus_market_likes', JSON.stringify([...likedPostIds]));

    // Keep the in-memory cache in sync so a re-render (tab switch, search,
    // etc.) before the next DB refresh doesn't show a stale count.
    const cachedEntry = allCachedPosts.find(p => p.id === postId);
    if (cachedEntry?.data) cachedEntry.data.likes_count = currentCount;

    // 2. Execute Backend sync — this is what makes likes survive reload.
    // Uses atomic RPC counters (increment_post_likes / decrement_post_likes)
    // defined in migration.sql so concurrent likes never clobber each other.
    try {
        if (liked) {
            await supabase
                .from("likes")
                .delete()
                .eq("post_id", postId)
                .eq("user_id", currentUserData.id);
            await supabase.rpc('decrement_post_likes', { post_id_input: postId });
        } else {
            const { error: insertErr } = await supabase
                .from("likes")
                .insert({
                    post_id: postId,
                    user_id: currentUserData.id
                });
            // Unique constraint means a duplicate like just fails silently —
            // don't double-increment the counter in that case.
            if (!insertErr) {
                await supabase.rpc('increment_post_likes', { post_id_input: postId });
            }
        }
    } catch(e) {
        console.warn("Like sync delayed or rejected:", e);
    }
};

window.sharePost = function (postId, title) {
    const text = `Check out "${title}" on CampusMarket!`;
    if (navigator.share) {
        navigator.share({ title, text, url: window.location.href }).catch(() => {});
    } else {
        navigator.clipboard?.writeText(`${text} ${window.location.href}`);
        showToast('Link copied to clipboard!');
    }
};

window.downloadMedia = function (mediaUrl, title) {
    if (!mediaUrl) return;
    const a    = document.createElement('a');
    a.href     = mediaUrl;
    a.download = title || 'campus-market';
    a.target   = '_blank';
    a.click();
};

// Now opens a real DM thread with the seller instead of just landing on
// an empty inbox. Falls back gracefully if seller info is incomplete.
window.contactSeller = function (sellerId, userName, sellerAvatar, postTitle) {
    if (!currentUserData) {
        showToast('Please sign in to contact the seller.');
        return;
    }
    if (!sellerId || sellerId === currentUserData.id) {
        window.navigateTo('dms');
        return;
    }
    window.openDM(sellerId, userName, sellerAvatar);
};

// ─── Comment count tracking (keeps counters accurate without a full re-fetch) ──
const commentCountCache = {}; // postId -> count

function updateCommentCountUI(postId, count) {
    commentCountCache[postId] = count;
    document.querySelectorAll(`.comment-count-${CSS.escape(postId)}`).forEach(el => {
        el.textContent = count;
    });
}

async function fetchAndCacheCommentCount(postId) {
    try {
        const { count, error } = await supabase
            .from('comments')
            .select('id', { count: 'exact', head: true })
            .eq('post_id', postId);
        if (!error) updateCommentCountUI(postId, count || 0);
    } catch (_) {}
}

window.postComment = async function(postId, inputEl, parentCommentId = null) {
    const text = inputEl.value.trim();
    if (!text || !currentUserData) return;
    inputEl.value = '';

    try {
        const metadata = currentUserData.user_metadata || {};
        const insertPayload = {
            post_id: postId,
            user_id: currentUserData.id,
            user_name: metadata.full_name || 'Anonymous Student',
            user_avatar: metadata.avatar_url || '',
            text,
            created_at: new Date().toISOString()
        };
        if (parentCommentId) insertPayload.parent_comment_id = parentCommentId;
        await supabase.from('comments').insert(insertPayload);
    } catch(err) {
        console.error("Comment submission error:", err);
    }
};

// Tracks which comment (if any) is currently being replied to, per post,
// so the reply target is visible and Enter posts as a reply not a new
// top-level comment.
const activeReplyTarget = {};

window.startCommentReply = function (postId, commentId, commentAuthor) {
    activeReplyTarget[postId] = commentId;
    const input = document.querySelector(`#comments-${CSS.escape(postId)} input[type="text"]`);
    if (input) {
        input.placeholder = `Replying to ${commentAuthor}…`;
        input.dataset.replyTo = commentId;
        input.focus();
    }
    const cancelBtn = document.getElementById(`cancel-reply-${postId}`);
    if (cancelBtn) cancelBtn.classList.remove('hidden');
};

window.cancelCommentReply = function (postId) {
    delete activeReplyTarget[postId];
    const input = document.querySelector(`#comments-${CSS.escape(postId)} input[type="text"]`);
    if (input) {
        input.placeholder = 'Add a comment…';
        delete input.dataset.replyTo;
    }
    const cancelBtn = document.getElementById(`cancel-reply-${postId}`);
    if (cancelBtn) cancelBtn.classList.add('hidden');
};

// Wraps postComment so the comment input's Enter key correctly posts as a
// reply when a reply target is active, then clears the reply state.
window.submitCommentFromInput = function (postId, inputEl) {
    const parentId = inputEl.dataset.replyTo || null;
    window.postComment(postId, inputEl, parentId);
    if (parentId) window.cancelCommentReply(postId);
};

const likedCommentIds = new Set(JSON.parse(localStorage.getItem('campus_market_comment_likes') || '[]'));

window.likeComment = async function (commentId, btn) {
    if (!currentUserData) { showToast("Please sign in to like comments."); return; }

    const liked = likedCommentIds.has(commentId);
    const countEl = btn.querySelector('.comment-like-count');
    const icon = btn.querySelector('i');
    let count = parseInt(countEl?.textContent || 0);

    if (liked) {
        likedCommentIds.delete(commentId);
        icon.className = 'far fa-thumbs-up text-slate-400';
        count = Math.max(0, count - 1);
    } else {
        likedCommentIds.add(commentId);
        icon.className = 'fas fa-thumbs-up text-amber-400';
        count = count + 1;
    }
    if (countEl) countEl.textContent = count;
    localStorage.setItem('campus_market_comment_likes', JSON.stringify([...likedCommentIds]));

    try {
        if (liked) {
            await supabase.from('comment_likes').delete().eq('comment_id', commentId).eq('user_id', currentUserData.id);
            await supabase.rpc('decrement_comment_likes', { comment_id_input: commentId });
        } else {
            const { error } = await supabase.from('comment_likes').insert({ comment_id: commentId, user_id: currentUserData.id });
            if (!error) await supabase.rpc('increment_comment_likes', { comment_id_input: commentId });
        }
    } catch (e) {
        console.warn("Comment like sync delayed:", e);
    }
};

// Fixed: previously scoped to .eq('user_id', ...) which silently failed
// whenever RLS/user id mismatched in any way and gave no feedback. Now we
// check ownership up front, surface real errors, and always refresh the
// count after a successful delete.
window.deleteComment = async function (commentId, postId) {
    if (!currentUserData) { showToast('Please sign in.'); return; }
    const confirmed = window.confirm("Delete this comment?");
    if (!confirmed) return;

    try {
        const { data, error } = await supabase
            .from('comments')
            .delete()
            .eq('id', commentId)
            .eq('user_id', currentUserData.id)
            .select();

        if (error) throw error;

        if (!data || data.length === 0) {
            showToast("You can only delete your own comments.");
            return;
        }

        document.querySelectorAll(`[id="comment-item-${commentId}"]`).forEach(el => el.remove());
        // also remove any replies that were nested under it (best-effort local cleanup)
        showToast("Comment deleted");

        const newCount = Math.max(0, (commentCountCache[postId] ?? 1) - 1);
        updateCommentCountUI(postId, newCount);
    } catch (err) {
        console.error("Error deleting comment:", err);
        showToast("Failed to delete comment.");
    }
};

function renderCommentItem(c, postId) {
    const isLiked = likedCommentIds.has(c.id);
    const heartClass = isLiked ? 'fas fa-thumbs-up text-amber-400' : 'far fa-thumbs-up text-slate-400';
    const isOwn = currentUserData && c.user_id === currentUserData.id;
    const indentClass = c.parent_comment_id ? 'ml-7' : '';

    return `
        <div class="flex gap-2 items-start text-left mt-2 ${indentClass}" id="comment-item-${escAttr(c.id)}">
            <img src="${esc(c.user_avatar) || 'https://ui-avatars.com/api/?name=U'}" class="w-6 h-6 rounded-full border border-slate-800 object-cover shrink-0 mt-0.5">
            <div class="bg-slate-800 rounded-2xl px-3 py-2 flex-1 border border-slate-700/20">
                <p class="text-[9px] font-black text-amber-400 uppercase tracking-wide">${esc(c.user_name)}</p>
                <p class="text-xs text-slate-200 mt-0.5">${esc(c.text)}</p>
                <div class="flex items-center gap-3 mt-1.5">
                    <button onclick="window.likeComment('${escAttr(c.id)}', this)" class="flex items-center gap-1">
                        <i class="${heartClass} text-[11px]"></i>
                        <span class="comment-like-count text-[10px] text-slate-400 font-semibold">${parseInt(c.likes_count || 0)}</span>
                    </button>
                    <button onclick="window.startCommentReply('${escAttr(postId)}', '${escAttr(c.id)}', '${escAttr(c.user_name)}')" class="text-[10px] text-slate-400 font-semibold hover:text-amber-400 transition">
                        Reply
                    </button>
                    ${isOwn ? `<button onclick="window.deleteComment('${escAttr(c.id)}', '${escAttr(postId)}')" class="text-[10px] text-red-400 font-semibold hover:text-red-300 transition">Delete</button>` : ''}
                </div>
            </div>
        </div>`;
}

// TikTok-style comment sheet: works for both the inline feed card comment
// panel and the fixed bottom-sheet used on Reels (markup differs slightly
// but both use #comments-{id}, #comment-list-{id}).
window.toggleComments = async function (postId) {
    const commentSection = document.getElementById(`comments-${postId}`);
    const list           = document.getElementById(`comment-list-${postId}`);
    if (!commentSection || !list) return;

    const isReelSheet = commentSection.classList.contains('reel-comments');
    const backdrop    = document.getElementById('comments-global-backdrop');

    const isOpen = isReelSheet
        ? commentSection.classList.contains('comments-open')
        : !commentSection.classList.contains('hidden');

    if (isOpen) {
        window._closeCommentSheet(postId, true);
        return;
    }

    // Close any other open reel comment sheet first
    document.querySelectorAll('.reel-comments.comments-open').forEach(el => {
        if (el.id !== `comments-${postId}`) el.classList.remove('comments-open');
    });

    if (isReelSheet) {
        commentSection.classList.remove('hidden');
        requestAnimationFrame(() => commentSection.classList.add('comments-open'));
        backdrop?.classList.add('backdrop-open');
        pushUiState(`comments-${postId}`, () => window._closeCommentSheet(postId, true));
    } else {
        commentSection.classList.remove('hidden');
        pushUiState(`comments-${postId}`, () => window._closeCommentSheet(postId, true));
    }

    openCommentIds.add(postId);

    list.innerHTML = `<p class="text-[10px] text-slate-500 animate-pulse py-2 pl-1">Loading comments...</p>`;

    const fetchAndRender = async () => {
        const { data: comments, error, count } = await supabase
            .from('comments')
            .select('*', { count: 'exact' })
            .eq('post_id', postId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        list.innerHTML = '';

        updateCommentCountUI(postId, count ?? (comments ? comments.length : 0));

        if (!comments || comments.length === 0) {
            list.innerHTML = `<p class="text-[10px] text-slate-600 italic py-2 pl-1">No comments yet. Start the chat!</p>`;
            return;
        }

        // Top-level comments first, replies immediately after their parent
        const topLevel = comments.filter(c => !c.parent_comment_id);
        const replies  = comments.filter(c => c.parent_comment_id);

        topLevel.forEach(c => {
            list.innerHTML += renderCommentItem(c, postId);
            replies.filter(r => r.parent_comment_id === c.id).forEach(r => {
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
        .on("postgres_changes", { event: "*", schema: "public", table: "comments", filter: `post_id=eq.${postId}` }, () => {
            fetchAndRender().catch(console.error);
        })
        .subscribe();
};

// Shared close routine for both inline and bottom-sheet comment views.
window._closeCommentSheet = function (postId, fromPop = false) {
    const commentSection = document.getElementById(`comments-${postId}`);
    const backdrop = document.getElementById('comments-global-backdrop');
    if (!commentSection) return;

    if (commentSection.classList.contains('reel-comments')) {
        commentSection.classList.remove('comments-open');
        backdrop?.classList.remove('backdrop-open');
        setTimeout(() => commentSection.classList.add('hidden'), 280);
    } else {
        commentSection.classList.add('hidden');
    }
    openCommentIds.delete(postId);
    if (!fromPop) popUiState(`comments-${postId}`);
};

// Global backdrop click dismisses whichever reel comment sheet is open.
document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('comments-global-backdrop')) {
        const backdrop = document.createElement('div');
        backdrop.id = 'comments-global-backdrop';
        backdrop.className = 'comments-backdrop';
        backdrop.addEventListener('click', () => {
            const openSheet = document.querySelector('.reel-comments.comments-open');
            if (openSheet) {
                const postId = openSheet.id.replace('comments-', '');
                window._closeCommentSheet(postId);
            }
        });
        document.body.appendChild(backdrop);
    }
});

function renderFeedCard(id, d) {
    const viewer     = currentUserData;
    const showFollow = viewer && d.user_id !== viewer.id;
    const isOwnPost  = viewer && d.user_id === viewer.id;

    let mediaUrls = [];
    if (d.media_url) {
        if (d.media_url.startsWith('[')) {
            try { mediaUrls = JSON.parse(d.media_url); } catch(_) { mediaUrls = [d.media_url]; }
        } else {
            mediaUrls = [d.media_url];
        }
    }

    let mediaBlock = '';
    if (mediaUrls.length > 1) {
        const slides = mediaUrls.map((url, i) =>
            d.media_type === 'video'
                ? `<video class="w-full aspect-square object-cover shrink-0 snap-start" ${i === 0 ? 'autoplay muted loop playsinline' : 'muted loop playsinline'} src="${esc(url)}"></video>`
                : `<img class="w-full aspect-square object-cover shrink-0 snap-start" src="${esc(url)}" alt="${esc(d.title)} ${i+1}">`
        ).join('');
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
        mediaBlock = d.media_type === 'video'
            ? `<div onclick="openDetail('${escAttr(id)}')" class="w-full bg-black cursor-pointer">
                <video class="w-full aspect-square object-cover" autoplay muted loop playsinline src="${esc(mediaUrls[0])}"></video>
               </div>`
            : `<div onclick="openDetail('${escAttr(id)}')" class="w-full cursor-pointer">
                <img class="w-full aspect-square object-cover" src="${esc(mediaUrls[0])}" alt="${esc(d.title)}">
               </div>`;
    }

    const followBlock = showFollow ? `
        <button
            class="follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700 ml-2"
            data-follow-uid="${esc(d.user_id)}"
            data-active="false"
            onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
            + Follow
        </button>` : '';

    const deleteBlock = isOwnPost ? `
        <button
            onclick="event.stopPropagation(); window.deletePost('${escAttr(id)}')"
            class="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-red-950/40 text-red-400 border border-red-900/50">
            <i class="fas fa-trash-can"></i>
        </button>` : '';

    const isLiked       = likedPostIds.has(id);
    const heartClass    = isLiked ? 'fas fa-heart text-rose-500' : 'far fa-heart text-slate-300';
    const likedData     = isLiked ? 'true' : 'false';

    // likes_count now comes straight from the DB and is kept accurate via
    // the RPC counters, so this reflects the true persisted count on load.
    const displayLikes  = parseInt(d.likes_count || 0);
    const displayComments = commentCountCache[id] ?? parseInt(d.comments_count || 0);

    const isAddedToCart  = userCartList.some(item => item.id === id);
    const bookmarkClass  = isAddedToCart ? "fas fa-bookmark text-amber-400" : "far fa-bookmark text-slate-300";

    return `
    <div class="bg-slate-900 border-b border-slate-800/60 max-w-md mx-auto" id="feed-card-${escAttr(id)}">

        <div class="flex items-center justify-between px-3 py-2.5">
            <div class="feed-profile-trigger flex items-center gap-2.5 min-w-0 cursor-pointer">
                <img src="${esc(d.user_avatar) || 'https://ui-avatars.com/api/?name=User'}" class="w-8 h-8 rounded-full border border-slate-700 object-cover shrink-0" alt="">
                <div class="min-w-0">
                    <p class="text-[12px] font-bold text-white leading-tight truncate">${esc(d.user_name) || 'Student'}</p>
                    <p class="text-[10px] text-slate-500 leading-tight truncate">${esc(d.institution) || ''}</p>
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
                <button onclick="likePost('${escAttr(id)}', this)" data-liked="${likedData}" class="flex items-center gap-1 active:scale-90 transition ${isLiked ? 'text-rose-500' : ''}">
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
                <button onclick="downloadMedia('${escAttr(mediaUrls[0] || '')}', '${escAttr(d.title)}')" class="text-slate-400 hover:text-purple-400 transition">
                    <i class="fas fa-arrow-down text-base"></i>
                </button>
            </div>
        </div>

        <div class="px-3 pb-1">
            <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-amber-400 font-black text-sm">GH₵${esc(String(d.price || 0))}</span>
                <span class="text-[10px] text-slate-500 uppercase font-semibold">${esc(d.type) || 'product'}</span>
            </div>
            <p class="text-white text-[13px] font-semibold mt-0.5 leading-snug line-clamp-2">${esc(d.title)}</p>
        </div>

        <div class="px-3 pb-3">
            <button
                onclick="contactSeller('${escAttr(d.user_id)}', '${escAttr(d.user_name)}', '${escAttr(d.user_avatar)}', '${escAttr(d.title)}')"
                class="w-full flex items-center justify-center gap-1.5 bg-amber-400 text-black font-extrabold py-2.5 rounded-xl text-[11px] uppercase tracking-wider transition active:scale-[0.98]">
                <i class="fas fa-bolt text-[10px]"></i> Contact Seller
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
    let mediaUrl = '';
    if (d.media_url) {
        if (d.media_url.startsWith('[')) {
            try { mediaUrl = JSON.parse(d.media_url)[0]; } catch(_) { mediaUrl = d.media_url; }
        } else {
            mediaUrl = d.media_url;
        }
    }

    const isVideo = d.media_type === 'video';
    const isAddedToCart = userCartList.some(item => item.id === id);
    const bookmarkClass = isAddedToCart ? "fas fa-bookmark text-amber-400" : "far fa-bookmark text-white/80";

    return `
    <div class="bg-slate-900 border border-slate-800/60 rounded-2xl overflow-hidden" id="grid-card-${escAttr(id)}">
        <div class="relative aspect-square w-full bg-slate-950 cursor-pointer" onclick="openDetail('${escAttr(id)}')">
            ${isVideo
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
            <p class="text-slate-500 text-[9px] truncate mt-0.5">${esc(d.user_name) || 'Student'}</p>
        </div>
    </div>`;
}

function renderProductGrid() {
    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    feed.classList.add('grid-mode');

    const products = allCachedPosts.filter(({ data: d }) => (d.type || 'product') === 'product');

    if (products.length === 0) {
        feed.innerHTML = `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📦</p>
                <p class="font-bold text-white">No products yet</p>
                <p class="text-slate-500 text-xs">Be the first to list one!</p>
            </div>`;
        return;
    }

    feed.innerHTML = `<div class="grid grid-cols-2 gap-2.5 py-2">${
        products.map(({ id, data: d }) => renderProductGridCard(id, d)).join('')
    }</div>`;
}

// ─── 12d. REELS FEED (TikTok-style full-bleed vertical video) ────────────────
// Only the reel currently in view should play with sound / play at all;
// every other reel is paused and muted so scrolling past a video never
// leaves its audio running in the background.
let reelsIntersectionObserver = null;

function pauseAllReelVideos() {
    document.querySelectorAll('.reel-video').forEach(video => {
        try {
            video.pause();
            video.muted = true;
        } catch (_) {}
    });
    if (reelsIntersectionObserver) {
        reelsIntersectionObserver.disconnect();
        reelsIntersectionObserver = null;
    }
}

function setupReelsIntersectionObserver() {
    if (reelsIntersectionObserver) {
        reelsIntersectionObserver.disconnect();
        reelsIntersectionObserver = null;
    }

    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    reelsIntersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target.querySelector('.reel-video');
            if (!video) return;
            if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
                // This reel is the one in view: play it, unmuted only if the
                // user hasn't explicitly muted it before (default unmuted
                // like TikTok, matching tap-to-mute behavior already wired).
                document.querySelectorAll('.reel-video').forEach(v => {
                    if (v !== video) { v.pause(); v.muted = true; v.currentTime = v.currentTime; }
                });
                video.muted = video.dataset.userMuted === 'true';
                video.play().catch(() => {});
            } else {
                video.pause();
                video.muted = true;
            }
        });
    }, { root: feed, threshold: [0, 0.6, 1] });

    document.querySelectorAll('.reel-card').forEach(card => reelsIntersectionObserver.observe(card));
}

function renderReelCard(id, d) {
    let mediaUrls = [];
    if (d.media_url) {
        if (d.media_url.startsWith('[')) {
            try { mediaUrls = JSON.parse(d.media_url); } catch(_) { mediaUrls = [d.media_url]; }
        } else {
            mediaUrls = [d.media_url];
        }
    }
    const videoUrl = mediaUrls[0] || '';

    const isLiked = likedPostIds.has(id);
    const heartClass = isLiked ? 'fas fa-heart text-rose-500' : 'far fa-heart text-white';
    const displayLikes = parseInt(d.likes_count || 0);
    const displayComments = commentCountCache[id] ?? parseInt(d.comments_count || 0);
    const isAddedToCart = userCartList.some(item => item.id === id);
    const bookmarkClass = isAddedToCart ? 'fas fa-bookmark text-amber-400' : 'far fa-bookmark text-white';
    const isOwnPost = currentUserData && d.user_id === currentUserData.id;

    const deleteBlock = isOwnPost ? `
        <button onclick="event.stopPropagation(); window.deletePost('${escAttr(id)}')" class="reel-action-btn">
            <i class="fas fa-trash-can text-red-400 text-lg"></i>
        </button>` : '';

    return `
    <div class="reel-card" id="reel-card-${escAttr(id)}">
        <video class="reel-video" src="${esc(videoUrl)}" loop playsinline data-user-muted="false"
            onclick="window._toggleReelMute(this)"></video>

        <div class="reel-actions">
            <button onclick="likePost('${escAttr(id)}', this)" data-liked="${isLiked ? 'true' : 'false'}" class="reel-action-btn flex flex-col items-center">
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
                <img src="${esc(d.user_avatar) || 'https://ui-avatars.com/api/?name=User'}" class="w-8 h-8 rounded-full border border-white/40 object-cover shrink-0" alt="">
                <p class="text-white font-bold text-sm leading-tight truncate">${esc(d.user_name) || 'Student'}</p>
            </div>
            <p class="text-white text-sm font-semibold leading-snug line-clamp-2">${esc(d.title)}</p>
            <p class="text-amber-400 font-black text-sm mt-1">GH₵${esc(String(d.price || 0))}</p>
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
    video.dataset.userMuted = video.muted ? 'true' : 'false';
};

function renderReelsFeed() {
    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    feed.classList.remove('grid-mode');
    feed.classList.add('reels-mode');

    const reels = allCachedPosts.filter(({ data: d }) => d.media_type === 'video');

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

    feed.innerHTML = reels.map(({ id, data: d }) => renderReelCard(id, d)).join('');
    setupReelsIntersectionObserver();
}

// ─── 12b. CHART / CART LIST LOGIC (NOW BACKEND POWERED!) ──────────────────────
window.toggleCartItem = async function (postId) {
    if (!currentUserData) {
        showToast("Please sign in to save items.");
        return;
    }

    let postRecord = null;
    const found = allCachedPosts.find(p => p.id === postId || p.data?.id === postId);
    if (found) postRecord = found.data ? found.data : found;

    if (!postRecord) {
        const cardEl = document.getElementById(`feed-card-${postId}`);
        if (cardEl) {
            const nameEl = Array.from(cardEl.querySelectorAll('p')).find(el => el.classList.contains('text-[12px]'));
            postRecord = {
                title: cardEl.querySelector('p.text-white')?.textContent || 'Campus Item',
                price: cardEl.querySelector('.text-amber-400')?.textContent?.replace('GH₵', '') || '0',
                user_name: nameEl?.textContent || 'Student'
            };
        }
    }

    if (!postRecord) {
        showToast("Cannot link listing instance data.");
        return;
    }

    const index = userCartList.findIndex(item => item.id === postId);
    const isRemoving = index > -1;

    // 1. Optimistic UI: Handle local mutations instantly
    if (isRemoving) {
        userCartList.splice(index, 1);
        showToast("Removed from Chart List");
    } else {
        userCartList.push({
            id:          postId,
            title:       postRecord.title,
            price:       postRecord.price,
            media_url:   postRecord.media_url || '',
            media_type:  postRecord.media_type || 'image',
            institution: postRecord.institution || '',
            type:        postRecord.type || 'product',
            user_name:   postRecord.user_name || 'Anonymous'
        });
        showToast("Added to Chart List! ✓");
    }

    localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));

    // Instantly update icons/buttons on current cards
    const feedIcon = document.getElementById(`feed-cart-icon-${postId}`)?.querySelector('i');
    if (feedIcon) {
        feedIcon.className = !isRemoving ? "fas fa-bookmark text-amber-400" : "far fa-bookmark text-slate-300";
    }

    const gridBtn = document.getElementById(`grid-card-${postId}`)?.querySelector('button i');
    if (gridBtn) {
        gridBtn.className = !isRemoving ? "fas fa-bookmark text-amber-400 text-xs" : "far fa-bookmark text-white/80 text-xs";
    }

    const detailBtn = document.getElementById(`detail-cart-btn-${postId}`);
    if (detailBtn) {
        const labelText = detailBtn.querySelector('.cart-btn-label');
        if (labelText) labelText.textContent = !isRemoving ? "✓ Added to Chart" : "Add to Chart List";
        detailBtn.className = !isRemoving
            ? "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-800 border border-slate-700 text-slate-400"
            : "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-900 border border-slate-700 text-white hover:border-amber-400";
    }

    if (!document.getElementById('cart-container')?.classList.contains('hidden')) {
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
    } catch(err) {
        console.warn("Saves table background sync failed/delayed:", err);
    }
};

function renderCartListView() {
    const container = document.getElementById('cart-items-wrapper');
    if (!container) return;
    if (userCartList.length === 0) {
        container.innerHTML = `<p class="p-10 text-center text-slate-500 text-xs uppercase">Your list is empty</p>`;
        return;
    }
    container.innerHTML = userCartList.map(item => `
        <div class="flex items-center justify-between p-3 bg-slate-900 rounded-xl border border-slate-800">
            <div class="min-w-0 flex-1 cursor-pointer" onclick="openDetail('${escAttr(item.id)}')">
                <p class="text-white font-bold text-sm truncate">${esc(item.title)}</p>
                <p class="text-amber-400 font-extrabold text-xs">GH₵${esc(String(item.price))}</p>
            </div>
            <button onclick="window.toggleCartItem('${escAttr(item.id)}')" class="text-red-400 p-2"><i class="fas fa-trash-can"></i></button>
        </div>
    `).join('');
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
    } catch { return false; }
}

window.toggleFollow = async function (targetUserId, targetName, targetAvatar) {
    if (!currentUserData) { alert("Please login first."); return; }
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
                follower_id:      currentUserData.id,
                follower_name:    metadata.full_name || 'Student',
                follower_avatar:  metadata.avatar_url || '',
                following_id:     targetUserId,
                following_name:   targetName,
                following_avatar: targetAvatar,
                created_at:       new Date().toISOString()
            });
            updateFollowButtons(targetUserId, true);
        }

        if (!document.getElementById('profile-container')?.classList.contains('hidden')) {
            loadProfileStats();
        }
    } catch (err) {
        console.error("Follow toggle error:", err);
    }
};

function updateFollowButtons(targetUserId, isFollowing) {
    const cardClass = isFollowing
        ? 'follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600 ml-2'
        : 'follow-btn px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700 ml-2';

    const detailClass = isFollowing
        ? 'follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600'
        : 'follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 bg-amber-400 text-black';

    const label = isFollowing ? '✓ Following' : '+ Follow';

    document.querySelectorAll(`[data-follow-uid="${CSS.escape(targetUserId)}"]`).forEach(btn => {
        btn.textContent = label;
        btn.dataset.active = String(isFollowing);
        btn.className = btn.id === 'follow-btn-detail' ? detailClass : cardClass;
    });
}

async function refreshFollowButtonStates() {
    if (!currentUserData) return;
    try {
        const { data } = await supabase
            .from("follows")
            .select("following_id")
            .eq("follower_id", currentUserData.id);
        data?.forEach(row => updateFollowButtons(row.following_id, true));
    } catch (err) {
        console.warn("refreshFollowButtonStates failed silently:", err);
    }
}

window.deletePost = async function (postId) {
    if (!currentUserData) return;
    const confirmDelete = window.confirm("Are you sure you want to delete this listing permanently?");
    if (!confirmDelete) return;

    try {
        const { data: currentPost, error: fetchErr } = await supabase
            .from("posts")
            .select("media_url")
            .eq("id", postId)
            .single();

        if (fetchErr) throw fetchErr;

        if (currentPost?.media_url) {
            const targets = currentPost.media_url.startsWith('[') ? JSON.parse(currentPost.media_url) : [currentPost.media_url];
            for (const url of targets) {
                const pathParts   = url.split('/storage/v1/object/public/posts/');
                const storagePath = pathParts[1];
                if (storagePath) await supabase.storage.from("posts").remove([storagePath]);
            }
        }

        const { error: dbDeleteErr } = await supabase
            .from("posts")
            .delete()
            .eq("id", postId)
            .eq("user_id", currentUserData.id);

        if (dbDeleteErr) throw dbDeleteErr;

        const cartIndex = userCartList.findIndex(item => item.id === postId);
        if (cartIndex > -1) {
            userCartList.splice(cartIndex, 1);
            localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));
        }

        showToast("Post deleted successfully! ✓");
        allCachedPosts = allCachedPosts.filter(item => item.id !== postId);
        renderFeedFromCache();
    } catch (err) {
        console.error("Error deleting post from database:", err);
        showToast("Failed to delete post.");
    }
};

// ─── 14. FEED VIEWS ──────────────────────────────────────────────────────────
async function loadFollowingFeed() {
    if (!currentUserData) return;

    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    feed.classList.remove('grid-mode', 'reels-mode');
    pauseAllReelVideos();
    feed.innerHTML = '<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading following feed...</div>';

    try {
        const { data: followingData } = await supabase
            .from("follows")
            .select("following_id")
            .eq("follower_id", currentUserData.id);

        const followingIds = followingData?.map(s => s.following_id) || [];

        if (followingIds.length === 0) {
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
            .in("user_id", followingIds)
            .order("created_at", { ascending: false })
            .limit(FEED_LIMIT);

        if (error) throw error;

        if (!posts || posts.length === 0) {
            feed.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">People you follow haven\'t posted yet.</div>';
            return;
        }

        feed.innerHTML = '';
        posts.forEach(d => { feed.innerHTML += renderFeedCard(d.id, d); wireCarouselCounters(d.id); fetchAndCacheCommentCount(d.id); });
        refreshFollowButtonStates();
    } catch (err) {
        console.error("Following feed error:", err);
    }
}

function renderFeedFromCache() {
    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    // Reels tab: full-bleed vertical video feed, TikTok-style
    if (currentFeedType === 'reels') {
        renderReelsFeed();
        allCachedPosts.filter(({ data: d }) => d.media_type === 'video').forEach(({ id }) => fetchAndCacheCommentCount(id));
        return;
    }

    // Any time we're NOT rendering reels, make sure no reel video is still
    // playing audio in the background (e.g. switching All -> Products).
    pauseAllReelVideos();

    // Products tab renders as a 4-square grid instead of the snap-scroll feed
    if (currentFeedType === 'product') {
        renderProductGrid();
        return;
    }

    feed.classList.remove('grid-mode', 'reels-mode');

    if (allCachedPosts.length === 0) {
        feed.innerHTML = `
            <div class="text-center py-16 space-y-3">
                <p class="text-4xl">📭</p>
                <p class="font-bold text-white">No posts yet</p>
                <p class="text-slate-500 text-xs">Be the first to post on campus!</p>
            </div>`;
        return;
    }

    feed.innerHTML = '';
    allCachedPosts.forEach(({ id, data: d }) => {
        feed.innerHTML += renderFeedCard(id, d);
        wireCarouselCounters(id);
        fetchAndCacheCommentCount(id);
    });

    openCommentIds.forEach(postId => {
        const section = document.getElementById(`comments-${postId}`);
        if (section) {
            section.classList.remove('hidden');
            const list = document.getElementById(`comment-list-${postId}`);
            if (list) {
                supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true })
                    .then(({ data: comments }) => {
                        if (!comments || comments.length === 0) return;
                        list.innerHTML = '';
                        const topLevel = comments.filter(c => !c.parent_comment_id);
                        const replies  = comments.filter(c => c.parent_comment_id);
                        topLevel.forEach(c => {
                            list.innerHTML += renderCommentItem(c, postId);
                            replies.filter(r => r.parent_comment_id === c.id).forEach(r => {
                                list.innerHTML += renderCommentItem(r, postId);
                            });
                        });
                    }).catch(() => {});
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
    if (previousType === 'reels' && type !== 'reels') {
        pauseAllReelVideos();
    }

    if (clickedBtn) {
        document.querySelectorAll('.feed-tab-btn').forEach(btn => {
            btn.classList.replace('text-amber-400', 'text-slate-500');
            btn.classList.replace('border-amber-400', 'border-transparent');
        });
        clickedBtn.classList.replace('text-slate-500', 'text-amber-400');
        clickedBtn.classList.replace('border-transparent', 'border-amber-400');
    }

    // Reels tab: TikTok-style overlay header, and the feed shows video
    // posts only (media_type = 'video'), not a "type" column filter —
    // reels are a view of existing video posts, not a new post type.
    const header = document.getElementById('site-header');
    if (type === 'reels') {
        header?.classList.add('header-reels-mode');
    } else {
        header?.classList.remove('header-reels-mode');
    }

    if (type === 'following') {
        unsubscribeFeed();
        loadFollowingFeed();
        return;
    }

    const feed = document.getElementById('posts-feed');
    if (feed) {
        feed.innerHTML = '<div class="p-12 text-center animate-pulse text-slate-500 text-xs uppercase tracking-widest">Loading...</div>';
    }

    // Product tab still fetches ALL posts (so grid + other tabs share cache)
    // but renderFeedFromCache() switches to grid layout based on currentFeedType.
    const queryFactory = () => {
        let q = supabase.from("posts").select("*");
        if (type === 'reels') {
            q = q.eq("media_type", "video");
        } else if (type !== 'all' && type !== 'product') {
            q = q.eq("type", type);
        }
        return q.order("created_at", { ascending: false }).limit(FEED_LIMIT);
    };

    subscribeFeed(queryFactory);
};

// ─── 16. SEARCH ──────────────────────────────────────────────────────────────
window.runSearch = async function (term) {
    const resultsEl = document.getElementById('search-results');
    if (!resultsEl) return;

    const trimmedTerm = term.trim();
    if (!trimmedTerm) {
        window.navigateTo('feed');
        return;
    }

    window.navigateTo('explore');
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
                allCachedPosts = data.map(item => ({ id: item.id, data: item }));
            }
        } catch (e) {
            console.warn("Search initialization fallback mismatch:", e);
        }
    }

    const matches = allCachedPosts.filter(item => {
        const d = item.data ? item.data : item;
        if (!d) return false;
        return (
            (d.title       || '').toLowerCase().includes(lower) ||
            (d.description || '').toLowerCase().includes(lower) ||
            (d.user_name   || '').toLowerCase().includes(lower) ||
            (d.institution || '').toLowerCase().includes(lower) ||
            (d.type        || '').toLowerCase().includes(lower) ||
            (d.region      || '').toLowerCase().includes(lower)
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
            ${matches.length} campus result${matches.length !== 1 ? 's' : ''} found
        </p>`;

    matches.slice(0, SEARCH_RESULTS_CAP).forEach(item => {
        const id = item.id;
        const d  = item.data ? item.data : item;
        resultsEl.innerHTML += renderFeedCard(id, d);
        wireCarouselCounters(id);
        fetchAndCacheCommentCount(id);
    });

    refreshFollowButtonStates();
};

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

    const title       = document.getElementById('postTitle')?.value.trim();
    const description = document.getElementById('postDescription')?.value.trim();
    const type        = document.getElementById('postType')?.value;
    const price       = document.getElementById('postPrice')?.value;

    // Prefer the reviewed/edited files from the WhatsApp-style edit modal;
    // fall back to the raw file input if the user somehow skipped it.
    const rawInputFiles = document.getElementById('mediaInput')?.files;
    const mediaFiles = (finalMediaFiles && finalMediaFiles.length > 0)
        ? finalMediaFiles
        : (rawInputFiles ? Array.from(rawInputFiles) : []);

    const submitBtn      = document.getElementById('publishPostBtn');
    const submitBtnLabel = document.getElementById('publishPostBtnLabel');
    const attachBtn       = document.getElementById('attachMediaBtn');

    if (!title) { showToast('Please enter a title.'); return; }
    if (!mediaFiles || mediaFiles.length === 0) { showToast('Please attach at least one image or video.'); return; }

    // Lock the UI immediately: disable Publish AND the attach button, add a
    // spinner, so there is a clear, visible sign the upload is in progress
    // and it's impossible to trigger a second submission of the same files.
    isSubmittingPost = true;
    if (submitBtn) submitBtn.disabled = true;
    if (attachBtn) attachBtn.disabled = true;
    if (submitBtn) submitBtn.classList.add('opacity-70', 'cursor-not-allowed');
    if (submitBtnLabel) submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Uploading 0/${mediaFiles.length}...`;

    try {
        const publicUrls      = [];
        let primaryMediaType  = 'image';

        // Multi-file upload: every file the user attached is uploaded and
        // stored as a JSON array in media_url, which both the feed carousel
        // and detail-view carousel already render as a swipeable gallery.
        for (let i = 0; i < mediaFiles.length; i++) {
            const file        = mediaFiles[i];
            const ext         = (file.name || 'file').split('.').pop();
            const storagePath = `${currentUserData.id}/${Date.now()}-${i}.${ext}`;

            if (submitBtnLabel) submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Uploading ${i + 1}/${mediaFiles.length}...`;

            const { error: uploadError } = await supabase.storage
                .from("posts")
                .upload(storagePath, file, { contentType: file.type });

            if (uploadError) throw uploadError;

            const { data: { publicUrl } } = supabase.storage.from("posts").getPublicUrl(storagePath);
            publicUrls.push(publicUrl);

            if (i === 0 && file.type.startsWith('video')) {
                primaryMediaType = 'video';
            }
        }

        if (submitBtnLabel) submitBtnLabel.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i> Publishing...`;

        const institution = currentUserData.institution || document.getElementById('profileIns
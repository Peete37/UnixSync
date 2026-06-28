// ─── 1. IMPORTS ───────────────────────────────────────────────────────────────
import { supabase } from "./supabase-config.js";
import { onAuthChange, signInWithGoogle, signOutUser } from "./auth.service.js";

// ─── 2. CONSTANTS ─────────────────────────────────────────────────────────────

const FEED_LIMIT         = 30;
const SEARCH_LIMIT       = 100;
const SEARCH_RESULTS_CAP = 20;

const GHANA_DATA = {
    'Greater Accra': [
        'University of Ghana (UG)',
        'University of Professional Studies Accra (UPSA)',
        'Ghana Institute of Management and Public Administration (GIMPA)',
        'Accra Technical University (ATU)',
        'Methodist University Ghana',
        'Central University',
        'Academic City University College',
        'Lancaster University Ghana',
        'University of Media Arts and Communication (UMAC)',
        'Radford University College',
    ],
    'Ashanti': [
        'Kwame Nkrumah University of Science and Technology (KNUST)',
        'Kumasi Technical University (KsTU)',
        'Kumasi College of Health Sciences',
        'Pentecost University',
        'Christian Service University College',
        'Valley View University (Kumasi Campus)',
        'Sunyani Technical University',
    ],
    'Eastern': [
        'Koforidua Technical University (KTU)',
        'University of Energy and Natural Resources (UENR)',
        'Akenten Appiah-Menka University of Skills Training and Entrepreneurial Development (AAMUSTED)',
        'Presbyterian University Ghana (Abetifi Campus)',
    ],
    'Central': [
        'University of Cape Coast (UCC)',
        'Cape Coast Technical University (CCTU)',
        'University of Education Winneba (UEW)',
        'Winneba Technical University',
        'Takoradi Technical University',
    ],
    'Western': [
        'University of Mines and Technology (UMaT)',
        'Takoradi Technical University (TTU)',
        'Western Technical University',
    ],
    'Northern': [
        'University for Development Studies (UDS)',
        'Tamale Technical University',
        'SD Dombo University of Business and Integrated Development Studies (SDD-UBIDS)',
    ],
    'Upper East': [
        'University for Development Studies (UDS — Bolgatanga Campus)',
        'Bolgatanga Technical University',
    ],
    'Upper West': [
        'University for Development Studies (UDS — Wa Campus)',
        'Wa Technical University',
    ],
    'Volta': [
        'Ho Technical University (HTU)',
        'University of Health and Allied Sciences (UHAS)',
    ],
    'Oti': [
        'Oti Nursing and Midwifery Training College',
    ],
    'Bono': [
        'Sunyani Technical University',
        'University of Energy and Natural Resources (UENR — Sunyani Campus)',
    ],
    'Bono East': [
        'Techiman Nursing and Midwifery Training College',
    ],
    'Ahafo': [
        'Goaso College of Education',
    ],
    'Savannah': [
        'Damongo College of Education',
    ],
    'North East': [
        'Nalerigu College of Health Sciences',
    ],
    'Western North': [
        'Sefwi Wiawso College of Education',
    ],
};

const ALL_REGIONS      = Object.keys(GHANA_DATA).sort();
const ALL_INSTITUTIONS = [...new Set(Object.values(GHANA_DATA).flat())].sort();

// ─── 3. MODULE STATE ──────────────────────────────────────────────────────────

let currentUserData   = null;
let currentFeedChan   = null;
let currentCommentsChan = null; // Track single reactive detail streams
let allCachedPosts    = [];
let isAuthInitialized = false;

// Cart Management Array Local State
let userCartList      = JSON.parse(localStorage.getItem("campus_market_cart") || "[]");

Object.defineProperty(window, '_currentUser', { get: () => currentUserData });
Object.defineProperty(window, '_userCartList', { get: () => userCartList });

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
        if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);
        await signOutUser();
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
    ['feed-container', 'profile-container', 'explore-container', 'dms-container', 'cart-container']
        .forEach(id => document.getElementById(id)?.classList.add('hidden'));

    const targetId = viewId === 'feed' ? 'feed-container' : `${viewId}-container`;
    const targetElement = document.getElementById(targetId);
    if (targetElement) targetElement.classList.remove('hidden');

    const tabs = document.getElementById('feed-tabs');
    if (tabs) tabs.style.display = viewId === 'feed' ? 'flex' : 'none';

    clearNavHighlights();
    setNavHighlight(btn, viewId);

    // ── Module View Integrations ──
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
        }
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
    document.getElementById('post-modal')?.classList.toggle('hidden');
};

// ─── 9. DETAIL MODAL ──────────────────────────────────────────────────────────

window.openDetail = async function (postId) {
    const modal = document.getElementById('detail-modal');
    const content = document.getElementById('detail-content');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
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

        const mediaBlock = d.media_type === 'video'
            ? `<video class="w-full aspect-video object-cover" controls autoplay src="${esc(d.media_url)}"></video>`
            : `<img class="w-full object-cover" src="${esc(d.media_url)}" alt="Post Media">`;

        const followBlock = (!isOwn && viewer) ? `
            <button
                id="follow-btn-detail"
                class="follow-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition active:scale-95 ${isFollowing ? 'bg-slate-700 text-slate-300 border border-slate-600' : 'bg-amber-400 text-black'}"
                data-follow-uid="${esc(d.user_id)}"
                data-active="${isFollowing}"
                onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
                ${isFollowing ? '✓ Following' : '+ Follow'}
            </button>` : '';

        const isAddedToCart = userCartList.some(item => item.id === d.id);
        const cartText = isAddedToCart ? "✓ Added to Chart" : "Add to Chart List";
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
                    <button onclick="contactSeller('${escAttr(d.user_name)}', '${escAttr(d.title)}')" class="w-full bg-amber-400 text-black font-black py-4 rounded-2xl active:scale-95 transition-transform uppercase tracking-wider text-xs">
                        ${esc(ctaLabel)}
                    </button>
                </div>
            </div>`;
    } catch (e) {
        console.error("Detail load error:", e);
        content.innerHTML = `<p class="p-10 text-center text-red-500 text-xs">Error loading post.</p>`;
    }
};

window.closeDetailModal = function () {
    document.getElementById('detail-modal')?.classList.add('hidden');
};

// ─── 10. LOGIN MODAL ──────────────────────────────────────────────────────────

window.openLoginModal = function () {
    document.getElementById('signup-modal')?.classList.add('hidden');
    document.getElementById('login-modal')?.classList.remove('hidden');
};

window.closeLoginModal = function () {
    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('signup-modal')?.classList.add('hidden');
};

// ─── 10b. EMAIL AUTH ──────────────────────────────────────────────────────────

window.signInWithEmailPassword = async function (email, password) {
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

    if (!currentUserData) {
        showToast('Please sign in first.');
        return;
    }

    if (!file.type.startsWith('image/')) {
        showToast('Please choose an image file.');
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        showToast('Image must be under 5 MB.');
        return;
    }

    const previewEl = document.getElementById('profile-ui-avatar');
    const localURL = URL.createObjectURL(file);
    if (previewEl) previewEl.src = localURL;

    showToast('Uploading avatar…');

    try {
        const ext = file.name.split('.').pop();
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
        currentUserData.user_metadata.avatar_url = publicUrl;

        if (previewEl) previewEl.src = publicUrl;

        showToast('Avatar updated! ✓');
    } catch (err) {
        console.error('Avatar upload error:', err);
        if (previewEl) {
            previewEl.src =
                currentUserData.user_metadata?.avatar_url ||
                'https://ui-avatars.com/api/?name=User';
        }
        showToast('Upload failed. Please try again.');
    } finally {
        inputEl.value = '';
    }
};

// ─── 11b. AVATAR LONG-PRESS MODAL ────────────────────────────────────────────

let _avatarPressTimer = null;

function _initAvatarLongPress() {
    const profileAvatar  = document.getElementById('profile-ui-avatar');
    const avatarModal    = document.getElementById('avatarModal');
    const modalAvatarImg = document.getElementById('modalAvatarImg');
    const closeAvatarBtn = document.getElementById('closeAvatarBtn');
    const copyImageBtn   = document.getElementById('copyImageBtn');
    const downloadImageBtn = document.getElementById('downloadImageBtn');

    if (!profileAvatar || !avatarModal || !modalAvatarImg) {
        return;
    }

    function openAvatarModal(src) {
        modalAvatarImg.src = src;
        avatarModal.classList.remove('hidden');
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

    profileAvatar.addEventListener('touchstart',  startPress,  { passive: true });
    profileAvatar.addEventListener('touchend',    cancelPress);
    profileAvatar.addEventListener('touchmove',   cancelPress);

    profileAvatar.addEventListener('mousedown',   startPress);
    profileAvatar.addEventListener('mouseup',     cancelPress);
    profileAvatar.addEventListener('mouseleave',  cancelPress);

    closeAvatarBtn?.addEventListener('click', () => {
        avatarModal.classList.add('hidden');
    });

    avatarModal.addEventListener('click', (e) => {
        if (e.target === avatarModal) avatarModal.classList.add('hidden');
    });

    copyImageBtn?.addEventListener('click', async () => {
        try {
            const response = await fetch(modalAvatarImg.src);
            const blob = await response.blob();
            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ]);
            showToast('✓ Image copied to clipboard!');
        } catch (err) {
            console.error('Copy failed:', err);
            showToast('Failed to copy image.');
        }
    });

    downloadImageBtn?.addEventListener('click', async () => {
        try {
            const response = await fetch(modalAvatarImg.src);
            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `avatar-${Date.now()}.jpg`;
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

// ─── 12. CARD RENDERERS ───────────────────────────────────────────────────────

window.likePost = function (postId, btn) {
    const liked = btn.dataset.liked === 'true';
    const countEl = btn.querySelector('.like-count');
    const icon = btn.querySelector('i');

    if (liked) {
        btn.dataset.liked = 'false';
        icon.className = 'far fa-heart';
        btn.classList.remove('text-rose-500');
        btn.classList.add('text-slate-400');
        if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent) - 1);
    } else {
        btn.dataset.liked = 'true';
        icon.className = 'fas fa-heart';
        btn.classList.remove('text-slate-400');
        btn.classList.add('text-rose-500');
        if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
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
    const a = document.createElement('a');
    a.href = mediaUrl;
    a.download = title || 'campus-market';
    a.target = '_blank';
    a.click();
};

window.contactSeller = function (userName, postTitle) {
    if (!currentUserData) {
        showToast('Please sign in to contact the seller.');
        return;
    }

    window.navigateTo('dms');
    showToast(`Starting chat with ${userName}…`);
    if (typeof window.openDM === 'function') window.openDM(null, userName);
};

// ─── OPTIMIZED COMMENT RETRIEVAL & REALTIME STREAM FROM DATABASE ───
window.toggleComments = async function (postId) {
    const commentSection = document.getElementById(`comments-${postId}`);
    const list = document.getElementById(`comment-list-${postId}`);
    if (!commentSection || !list) return;

    commentSection.classList.toggle('hidden');

    if (currentCommentsChan) {
        supabase.removeChannel(currentCommentsChan);
        currentCommentsChan = null;
    }

    if (!commentSection.classList.contains('hidden')) {
        list.innerHTML = `<p class="text-[10px] text-slate-500 animate-pulse py-2 pl-1">Loading comments...</p>`;
        
        const fetchAndRender = async () => {
            const { data: comments, error } = await supabase
                .from('comments')
                .select('*')
                .eq('post_id', postId)
                .order('created_at', { ascending: true });

            if (error) throw error;
            list.innerHTML = '';

            if (!comments || comments.length === 0) {
                list.innerHTML = `<p class="text-[10px] text-slate-600 italic py-2 pl-1">No comments yet. Start the chat!</p>`;
                return;
            }

            comments.forEach(c => {
                const item = document.createElement('div');
                item.className = 'flex gap-2 items-start text-left mt-2';
                item.innerHTML = `
                    <img src="${esc(c.user_avatar) || 'https://ui-avatars.com/api/?name=U'}" class="w-6 h-6 rounded-full border border-slate-800 object-cover shrink-0 mt-0.5">
                    <div class="bg-slate-800 rounded-2xl px-3 py-2 flex-1 border border-slate-700/20">
                        <p class="text-[9px] font-black text-amber-400 uppercase tracking-wide">${esc(c.user_name)}</p>
                        <p class="text-xs text-slate-200 mt-0.5">${esc(c.text)}</p>
                    </div>`;
                list.appendChild(item);
            });
        };

        try {
            await fetchAndRender();
        } catch (err) {
            console.error("Error loading comments:", err);
            list.innerHTML = `<p class="text-[10px] text-red-400 py-1 pl-1">Failed to sync comments.</p>`;
        }

        // Setup real-time postgres stream dependency for comments panel
        currentCommentsChan = supabase
            .channel(`comments-live-${postId}`)
            .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter: `post_id=eq.${postId}` }, () => {
                fetchAndRender().catch(console.error);
            })
            .subscribe();
    }
};

function renderFeedCard(id, d) {
    const viewer     = currentUserData;
    const showFollow = viewer && d.user_id !== viewer.id;
    const isOwnPost  = viewer && d.user_id === viewer.id;

    const mediaBlock = d.media_type === 'video'
        ? `<div class="w-full max-h-[75vh] bg-black flex items-center justify-center overflow-hidden">
            <video class="w-full h-auto max-h-[75vh] object-contain" autoplay muted loop playsinline src="${esc(d.media_url)}"></video>
           </div>`
        : `<div class="w-full max-h-[75vh] bg-slate-950 flex items-center justify-center overflow-hidden">
            <img class="w-full h-auto max-h-[75vh] object-contain" src="${esc(d.media_url)}" alt="${esc(d.title)}">
           </div>`;

    const followBlock = showFollow ? `
        <button
            class="follow-btn px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700"
            data-follow-uid="${esc(d.user_id)}"
            data-active="false"
            onclick="toggleFollow('${escAttr(d.user_id)}','${escAttr(d.user_name)}','${escAttr(d.user_avatar)}')">
            + Follow
        </button>` : '';

    const deleteBlock = isOwnPost ? `
        <button
            onclick="event.stopPropagation(); window.deletePost('${escAttr(id)}')"
            class="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-red-950/40 text-red-400 border border-red-900/50 hover:bg-red-900 hover:text-white">
            <i class="fas fa-trash-can mr-1"></i> Delete
        </button>` : '';

    const isAddedToCart = userCartList.some(item => item.id === id);
    const feedCartIconClass = isAddedToCart ? "fas fa-bookmark text-amber-400" : "far fa-bookmark text-slate-300";

    return `
    <div class="bg-slate-900 rounded-2xl overflow-hidden border border-slate-800/60 shadow-xl max-w-md mx-auto my-2">
        <div onclick="openDetail('${escAttr(id)}')" class="cursor-pointer relative">
            ${mediaBlock}
        </div>
        <div class="p-3 space-y-2.5">
            <div class="flex justify-between items-start gap-2">
                <div class="flex-1 min-w-0 text-left">
                    <p class="font-bold text-white text-sm tracking-tight line-clamp-2">${esc(d.title)}</p>
                    <p class="text-slate-400 text-[10px] font-medium mt-0.5">${esc(d.institution) || ''} · ${esc(d.type) || 'product'}</p>
                </div>
                <span class="text-amber-400 font-black text-sm shrink-0 bg-amber-400/10 px-2 py-0.5 rounded-lg border border-amber-400/20">GH₵${esc(String(d.price || 0))}</span>
            </div>

            <div class="feed-profile-trigger flex items-center justify-between gap-3 pt-0.5 cursor-pointer hover:opacity-90 transition">
                <div class="flex items-center gap-2 min-w-0">
                    <img src="${esc(d.user_avatar) || 'https://ui-avatars.com/api/?name=User'}" class="w-6 h-6 rounded-full border border-slate-700 object-cover" alt="">
                    <span class="text-[11px] text-slate-300 font-semibold truncate">${esc(d.user_name) || 'Student'}</span>
                </div>
                <div class="flex gap-1">
                    ${followBlock}
                    ${deleteBlock}
                </div>
            </div>

            <div class="border-t border-slate-800/80 pt-2 flex items-center justify-between px-1">
                <div class="flex items-center gap-4">
                    <button onclick="likePost('${escAttr(id)}', this)" class="text-slate-300 hover:text-rose-500 transition active:scale-90 flex items-center gap-1">
                        <i class="far fa-heart text-lg"></i>
                        <span class="like-count text-xs font-medium">0</span>
                    </button>
                    <button onclick="toggleComments('${escAttr(id)}')" class="text-slate-300 hover:text-amber-400 transition active:scale-90 flex items-center gap-1">
                        <i class="far fa-comment text-lg"></i>
                    </button>
                    <button onclick="sharePost('${escAttr(id)}', '${escAttr(d.title)}')" class="text-slate-300 hover:text-green-400 transition active:scale-90">
                        <i class="far fa-paper-plane text-lg"></i>
                    </button>
                </div>
                <div class="flex items-center gap-3">
                    <button id="feed-cart-icon-${escAttr(id)}" onclick="window.toggleCartItem('${escAttr(id)}')" class="hover:text-amber-400 transition active:scale-90">
                        <i class="${feedCartIconClass} text-base"></i>
                    </button>
                    <button onclick="downloadMedia('${escAttr(d.media_url)}', '${escAttr(d.title)}')" class="text-slate-400 hover:text-purple-400 transition">
                        <i class="fas fa-arrow-down text-sm"></i>
                    </button>
                </div>
            </div>

            <button
                onclick="contactSeller('${escAttr(d.user_name)}', '${escAttr(d.title)}')"
                class="w-full flex items-center justify-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-black font-extrabold py-2 rounded-xl text-[11px] uppercase tracking-wider transition active:scale-[0.98] shadow-md shadow-amber-400/5">
                <i class="fas fa-bolt text-[10px]"></i>
                Contact Seller
            </button>

            <div id="comments-${escAttr(id)}" class="hidden space-y-2 pt-1.5 border-t border-slate-800/60">
                <div class="flex gap-2">
                    <div class="flex-1 flex gap-1.5">
                        <input
                            type="text"
                            placeholder="Add a comment…"
                            class="flex-1 bg-slate-800/80 border border-slate-700/50 text-white text-xs rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-amber-400 transition"
                            onkeydown="if(event.key==='Enter') postComment('${escAttr(id)}', this)"
                        >
                    </div>
                </div>
                <div id="comment-list-${escAttr(id)}" class="max-h-36 overflow-y-auto space-y-1.5 custom-scrollbar"></div>
            </div>
        </div>
    </div>`;
}

window.postComment = async function (postId, inputEl) {
    const text = inputEl?.value?.trim();
    if (!text) return;
    if (!currentUserData) {
        showToast('Sign in to comment.');
        return;
    }

    const list = document.getElementById(`comment-list-${postId}`);
    if (!list) return;

    const metadata = currentUserData.user_metadata || {};
    const avatar   = metadata.avatar_url || `https://ui-avatars.com/api/?name=U`;
    const name     = metadata.full_name  || 'Student';

    try {
        const { error } = await supabase
            .from("comments")
            .insert({
                post_id: postId,
                user_id: currentUserData.id,
                user_name: name,
                user_avatar: avatar,
                text: text,
                created_at: new Date().toISOString()
            });

        if (error) throw error;

        if(list.innerText.includes("No comments yet")) list.innerHTML = '';

        const item = document.createElement('div');
        item.className = 'flex gap-2 items-start text-left mt-1.5';
        item.innerHTML = `
            <img src="${esc(avatar)}" class="w-6 h-6 rounded-full border border-slate-800 object-cover shrink-0 mt-0.5" alt="">
            <div class="bg-slate-800/80 rounded-2xl px-3 py-2 flex-1 border border-slate-700/30">
                <p class="text-[9px] font-black text-amber-400 uppercase tracking-wide">${esc(name)}</p>
                <p class="text-xs text-slate-200 mt-0.5">${esc(text)}</p>
            </div>`;

        list.appendChild(item);
        inputEl.value = '';
        showToast('Comment added! ✓');
    } catch (err) {
        console.error("Database comment error:", err);
        showToast("Failed to save comment.");
    }
};

function renderGridItem(id, d) {
    return `
    <div onclick="openDetail('${escAttr(id)}')" class="aspect-square bg-slate-900 rounded-lg overflow-hidden relative border border-slate-800 cursor-pointer active:scale-95 transition">
        ${d.media_type === 'video' ? '<div class="absolute top-2 right-2 text-[10px]">📹</div>' : ''}
        <img class="w-full h-full object-cover opacity-60" src="${esc(d.media_url)}" alt="">
        <span class="absolute bottom-1 left-1 text-[8px] font-bold text-white uppercase truncate pr-1">${esc(d.title)}</span>
    </div>`;
}

// ─── 12b. CHART / CART LIST LOGIC ──────────────────────────────────────────

window.toggleCartItem = function (postId) {
    const postRecord = allCachedPosts.find(p => p.id === postId)?.data;
    if (!postRecord) {
        showToast("Cannot link listing instance data.");
        return;
    }

    const index = userCartList.findIndex(item => item.id === postId);
    let isAdded = false;

    if (index > -1) {
        userCartList.splice(index, 1);
        showToast("Removed from Chart List");
    } else {
        userCartList.push({
            id: postId,
            title: postRecord.title,
            price: postRecord.price,
            media_url: postRecord.media_url,
            media_type: postRecord.media_type,
            institution: postRecord.institution,
            type: postRecord.type,
            user_name: postRecord.user_name
        });
        showToast("Added to Chart List! ✓");
        isAdded = true;
    }

    localStorage.setItem("campus_market_cart", JSON.stringify(userCartList));

    // Update global visual nodes inline across view boundaries
    const feedIcon = document.getElementById(`feed-cart-icon-${postId}`)?.querySelector('i');
    if (feedIcon) {
        feedIcon.className = isAdded ? "fas fa-bookmark text-amber-400" : "far fa-bookmark text-slate-300";
    }

    const detailBtn = document.getElementById(`detail-cart-btn-${postId}`);
    if (detailBtn) {
        const labelText = detailBtn.querySelector('.cart-btn-label');
        if (labelText) labelText.textContent = isAdded ? "✓ Added to Chart" : "Add to Chart List";
        if (isAdded) {
            detailBtn.className = "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-800 border border-slate-700 text-slate-400";
        } else {
            detailBtn.className = "w-full font-black py-4 rounded-2xl active:scale-95 transition-all uppercase tracking-wider text-xs bg-slate-900 border border-slate-700 text-white hover:border-amber-400";
        }
    }

    // Refresh display view states instantly if open
    if (!document.getElementById('cart-container')?.classList.contains('hidden')) {
        renderCartListView();
    }
};

function renderCartListView() {
    const container = document.getElementById('cart-container');
    if (!container) return;

    // Reset base structural layout template bounds
    container.innerHTML = `
        <div class="max-w-md mx-auto px-4 py-6 space-y-4 pb-28">
            <div class="text-left border-b border-slate-800 pb-3">
                <h1 class="text-xl font-black text-white uppercase tracking-tight">Your Saved Chart</h1>
                <p class="text-xs text-slate-500">Tracked campus items & services list</p>
            </div>
            <div id="cart-items-wrapper" class="space-y-2.5"></div>
        </div>`;

    const wrapper = document.getElementById('cart-items-wrapper');
    if (userCartList.length === 0) {
        wrapper.innerHTML = `
            <div class="text-center py-16 space-y-2">
                <p class="text-4xl">🛒</p>
                <p class="text-sm font-bold text-slate-400">Your chart list is empty</p>
                <p class="text-xs text-slate-600 max-w-xs mx-auto">Bookmark listings inside the main feed or details modal to plan your purchases.</p>
            </div>`;
        return;
    }

    userCartList.forEach(item => {
        const card = document.createElement('div');
        card.className = "bg-slate-900 border border-slate-800/80 rounded-2xl p-3 flex gap-3 items-center relative text-left";
        card.innerHTML = `
            <div onclick="openDetail('${escAttr(item.id)}')" class="w-16 h-16 rounded-xl bg-slate-950 overflow-hidden shrink-0 cursor-pointer border border-slate-800">
                <img class="w-full h-full object-cover" src="${esc(item.media_url)}" alt="">
            </div>
            <div class="flex-1 min-w-0 cursor-pointer" onclick="openDetail('${escAttr(item.id)}')">
                <h3 class="text-xs font-bold text-white truncate uppercase">${esc(item.title)}</h3>
                <p class="text-[10px] text-slate-500 truncate mt-0.5">${esc(item.institution || 'All Campuses')} · ${esc(item.user_name || 'Seller')}</p>
                <p class="text-xs font-black text-amber-400 mt-1">GH₵${esc(String(item.price || 0))}</p>
            </div>
            <div class="flex flex-col gap-2">
                <button onclick="window.toggleCartItem('${escAttr(item.id)}')" class="p-2 text-slate-500 hover:text-red-400 transition text-sm">
                    <i class="fas fa-trash-can"></i>
                </button>
            </div>`;
        wrapper.appendChild(card);
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
                follower_name: metadata.full_name || 'Student',
                follower_avatar: metadata.avatar_url || '',
                following_id: targetUserId,
                following_name: targetName,
                following_avatar: targetAvatar,
                created_at: new Date().toISOString()
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
        ? 'follow-btn px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-700 text-slate-300 border border-slate-600'
        : 'follow-btn px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition active:scale-95 bg-slate-800 text-slate-300 border border-slate-700';

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
        // Fetch target row snapshot payload to access active image storage URLs before unlinking row entries
        const { data: currentPost, error: fetchErr } = await supabase
            .from("posts")
            .select("media_url")
            .eq("id", postId)
            .single();

        if (fetchErr) throw fetchErr;

        // Perform primary bucket unlinking procedures via public storage parser
        if (currentPost?.media_url) {
            const pathParts = currentPost.media_url.split('/storage/v1/object/public/posts/');
            const storagePath = pathParts[1];
            if (storagePath) {
                await supabase.storage.from("posts").remove([storagePath]);
            }
        }

        const { error: dbDeleteErr } = await supabase
            .from("posts")
            .delete()
            .eq("id", postId)
            .eq("user_id", currentUserData.id);

        if (dbDeleteErr) throw dbDeleteErr;

        // Evict item from Chart List structural arrays if present
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
        posts.forEach(d => { feed.innerHTML += renderFeedCard(d.id, d); });
        refreshFollowButtonStates();
    } catch (err) {
        console.error("Following feed error:", err);
    }
}

function renderFeedFromCache() {
    const feed = document.getElementById('posts-feed');
    if (!feed) return;

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
    });

    refreshFollowButtonStates();
}

// ─── 15. FILTERING ────────────────────────────────────────────────────────────

window.filterFeed = function (type, clickedBtn = null) {
    if (!isAuthInitialized) return;

    if (clickedBtn) {
        document.querySelectorAll('.feed-tab-btn').forEach(btn => {
            btn.classList.replace('text-amber-400', 'text-slate-500');
            btn.classList.replace('border-amber-400', 'border-transparent');
        });
        clickedBtn.classList.replace('text-slate-500', 'text-amber-400');
        clickedBtn.classList.replace('border-transparent', 'border-amber-400');
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

    const queryFactory = () => {
        let q = supabase
            .from("posts")
            .select("*");

        if (type !== 'all') {
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
        const d = item.data ? item.data : item;
        resultsEl.innerHTML += renderFeedCard(id, d);
    });

    refreshFollowButtonStates();
};

// ─── 17. POST SUBMISSION ──────────────────────────────────────────────────────

window.handlePostSubmission = async function () {
    if (!currentUserData) {
        window.openLoginModal();
        return;
    }

    const title       = document.getElementById('postTitle')?.value.trim();
    const description = document.getElementById('postDescription')?.value.trim();
    const type        = document.getElementById('postType')?.value;
    const price       = document.getElementById('postPrice')?.value;
    const mediaFile   = document.getElementById('mediaInput')?.files[0];
    const submitBtn   = document.querySelector('#post-modal button[onclick="handlePostSubmission()"]');

    if (!title) {
        showToast('Please enter a title.');
        return;
    }

    if (!mediaFile) {
        showToast('Please attach an image or video.');
        return;
    }

    if (submitBtn) {
        submitBtn.textContent = 'Uploading...';
        submitBtn.disabled = true;
    }

    try {
        const ext = mediaFile.name.split('.').pop();
        const storagePath = `${currentUserData.id}/${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from("posts")
            .upload(storagePath, mediaFile, { contentType: mediaFile.type });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage.from("posts").getPublicUrl(storagePath);
        const mediaType = mediaFile.type.startsWith('video') ? 'video' : 'image';

        const institution = currentUserData.institution || document.getElementById('profileInstitution')?.value || 'Global';
        const region      = currentUserData.region || document.getElementById('profileRegion')?.value || 'Global';
        const metadata    = currentUserData.user_metadata || {};

        const { error: insertError = null } = await supabase.from("posts").insert({
            title,
            description,
            type,
            price: parseFloat(price) || 0,
            media_url: publicUrl,
            media_type: mediaType,
            institution,
            region,
            user_name: metadata.full_name || 'Anonymous Student',
            user_avatar: metadata.avatar_url || '',
            user_id: currentUserData.id,
            created_at: new Date().toISOString()
        });

        if (insertError) throw insertError;

        document.getElementById('postTitle').value = '';
        document.getElementById('postDescription').value = '';
        document.getElementById('postPrice').value = '';
        document.getElementById('mediaInput').value = '';

        window.togglePostModal();
        showToast('Post published! 🎉');
    } catch (err) {
        console.error("Post submission error:", err);
        showToast('Failed to publish. Please try again.');
    } finally {
        if (submitBtn) {
            submitBtn.textContent = 'Publish Instantly';
            submitBtn.disabled = false;
        }
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
                .select("id, title, media_url, media_type")
                .eq("user_id", currentUserData.id)
                .order("created_at", { ascending: false })
        ]);

        const postsCount = postsRes.data ? postsRes.data.length : 0;

        setEl('profile-followers-count', followersRes.count || 0);
        setEl('profile-following-count', followingRes.count || 0);
        setEl('profile-posts-count', postsCount);

        const grid = document.getElementById('profile-grid');
        if (grid) {
            grid.innerHTML = '';
            postsRes.data?.forEach(d => {
                grid.innerHTML += renderGridItem(d.id, d);
            });
        }
    } catch (err) {
        console.warn("Profile stats error:", err);
    }
}

// ─── 19. SETTINGS PERSISTENCE ────────────────────────────────────────────────

window.initProfileSelects = function () {
    const regEl  = document.getElementById('profileRegion');
    const instEl = document.getElementById('profileInstitution');

    if (regEl && !regEl.dataset.populated) {
        regEl.innerHTML = buildOptions(ALL_REGIONS);
        regEl.dataset.populated = 'true';

        regEl.addEventListener('change', () => {
            if (instEl) {
                instEl.innerHTML = buildInstitutionOptions(regEl.value, instEl.value);
            }
        });
    }

    if (instEl && !instEl.dataset.populated) {
        instEl.innerHTML = buildOptions(ALL_INSTITUTIONS);
        instEl.dataset.populated = 'true';
    }
};

document.getElementById('saveLocationBtn')?.addEventListener('click', async () => {
    if (!currentUserData) return;

    const institution = document.getElementById('profileInstitution')?.value;
    const region      = document.getElementById('profileRegion')?.value;

    if (!institution || !region) {
        showToast('Please select both a region and institution.');
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

        const locationEl = document.getElementById('profile-ui-location');
        if (locationEl) locationEl.textContent = `${institution} · ${region}`;

        showToast('Settings updated ✓');
    } catch (err) {
        console.error("Save settings error:", err);
        showToast('Failed to save. Please try again.');
    }
});

// ─── 20. DM STUB ─────────────────────────────────────────────────────────────

window.openDM = function (targetUserId, targetName) {
    console.warn(`[DMs] openDM called for ${targetUserId} (${targetName}) — not yet implemented.`);
};

// ─── 21. AUTH OBSERVER ───────────────────────────────────────────────────────

if (activeAuthChange) {
    activeAuthChange(async (user) => {
        if (!navigator.onLine) {
            console.warn("[Auth Observer] Network is offline. Ignoring auth state evaluation.");
            return;
        }

        currentUserData = user;
        const authProfileNav = document.getElementById('auth-profile-nav');

        if (typeof window.updateAuthButton === 'function') {
            window.updateAuthButton(user);
        }

        if (user) {
            const metadata = user.user_metadata || {};

            document.getElementById('login-modal')?.classList.add('hidden');
            document.getElementById('signup-modal')?.classList.add('hidden');
            document.getElementById('onboarding-modal')?.remove();

            if (authProfileNav) {
                authProfileNav.innerHTML = `
                    <i class="fas fa-user text-lg"></i>
                    <span class="text-[10px] uppercase font-bold tracking-wider">Profile</span>
                `;
                authProfileNav.onclick = function (e) {
                    e.stopPropagation();
                    window.navigateTo('profile', authProfileNav);
                };
            }

            const avatarEl = document.getElementById('profile-ui-avatar');
            const nameEl   = document.getElementById('profile-ui-name');

            try {
                const { data: savedUserRow } = await supabase
                    .from("profiles")
                    .select("avatar, institution, region")
                    .eq("id", user.id)
                    .maybeSingle();

                const savedAvatar =
                    savedUserRow?.avatar ||
                    metadata.avatar_url ||
                    `https://ui-avatars.com/api/?name=${encodeURIComponent(metadata.full_name || 'User')}`;

                if (!currentUserData.user_metadata) currentUserData.user_metadata = {};
                currentUserData.user_metadata.avatar_url = savedAvatar;

                if (avatarEl) avatarEl.src = savedAvatar;
                if (nameEl) nameEl.textContent = metadata.full_name || 'Campus Student';

                window.initProfileSelects();

                if (!savedUserRow || !savedUserRow.institution || !savedUserRow.region) {
                    injectOnboardingModal();
                } else {
                    currentUserData.institution = savedUserRow.institution || '';
                    currentUserData.region = savedUserRow.region || '';
                    applyLocationToUI(savedUserRow.institution || '', savedUserRow.region || '');
                }
            } catch (err) {
                console.warn("User doc sync bypassed (using local auth state):", err);

                if (avatarEl) {
                    avatarEl.src =
                        metadata.avatar_url ||
                        `https://ui-avatars.com/api/?name=${encodeURIComponent(metadata.full_name || 'User')}`;
                }
                if (nameEl) nameEl.textContent = metadata.full_name || 'Campus Student';

                window.initProfileSelects();
            }

            document.getElementById('profile-auth-gate')?.classList.add('hidden');
            document.getElementById('profile-content')?.classList.remove('hidden');
            document.getElementById('dms-auth-gate')?.classList.add('hidden');
            document.getElementById('dms-content')?.classList.remove('hidden');

            subscribeFeed();
            try { loadProfileStats(); } catch (_) {}

            _initAvatarLongPress();

        } else {
            unsubscribeFeed();
            if (currentCommentsChan) supabase.removeChannel(currentCommentsChan);

            if (authProfileNav) {
                authProfileNav.innerHTML = `
                    <i class="fas fa-sign-in-alt text-lg"></i>
                    <span class="text-[10px] uppercase font-bold tracking-wider">Sign In</span>
                `;
                authProfileNav.onclick = function (e) {
                    e.stopPropagation();
                    window.openLoginModal();
                };
            }

            setEl('profile-ui-name', 'Campus Student');
            setEl('profile-ui-location', 'Global Network');
            setEl('profile-followers-count', '0');
            setEl('profile-following-count', '0');
            setEl('profile-posts-count', '0');

            const grid = document.getElementById('profile-grid');
            if (grid) grid.innerHTML = '';

            document.getElementById('profile-auth-gate')?.classList.remove('hidden');
            document.getElementById('profile-content')?.classList.add('hidden');
            document.getElementById('dms-auth-gate')?.classList.remove('hidden');
            document.getElementById('dms-content')?.classList.add('hidden');

            subscribeFeed();

            if (typeof window.openLoginModal === 'function' && navigator.onLine) {
                window.openLoginModal();
            }
        }

        isAuthInitialized = true;

        if (!document.querySelector('.bottom-nav button.nav-active, nav button.nav-active, nav a.nav-active')) {
            document.getElementById('nav-btn-feed')?.classList.add('nav-active');
        }
    });
}

// ─── 22. SCROLL DIRECTION DETECTOR FOR NAVBAR ────────────────────────────────

let lastScrollY = window.scrollY;

window.addEventListener('scroll', () => {
    const bottomNav = document.querySelector('.bottom-nav-container');
    if (!bottomNav) return;

    const currentScrollY = window.scrollY;

    if (currentScrollY < 20) {
        bottomNav.classList.remove('bottom-nav-hidden');
        return;
    }

    if (currentScrollY > lastScrollY) {
        bottomNav.classList.add('bottom-nav-hidden');
    } else {
        bottomNav.classList.remove('bottom-nav-hidden');
    }

    lastScrollY = currentScrollY;
}, { passive: true });

// ─── 23. DELEGATED CLICK FOR FEED PROFILE LINKS ──────────────────────────────

document.getElementById('posts-feed')?.addEventListener('click', (event) => {
    const profileClickTarget = event.target.closest('.feed-profile-trigger');

    if (profileClickTarget) {
        event.stopPropagation();

        if (typeof window.navigateTo === 'function') {
            window.navigateTo('profile');
        }
    }
});

// ─── 24. NATIVE INTERNET CONNECTIVITY DETECTOR ────────────────────────────────

window.addEventListener('offline', () => {
    showToast("⚠️ Connection lost. No Internet.");
    
    const submitBtn = document.querySelector('#post-modal button[onclick="handlePostSubmission()"]');
    if (submitBtn) {
        submitBtn.dataset.originalText = submitBtn.textContent;
        submitBtn.textContent = 'Offline (Waiting for Connection)';
        submitBtn.disabled = true;
    }
});

window.addEventListener('online', () => {
    showToast("⚡ Back online! Syncing data...");
    
    const submitBtn = document.querySelector('#post-modal button[onclick="handlePostSubmission()"]');
    if (submitBtn && submitBtn.dataset.originalText) {
        submitBtn.textContent = submitBtn.dataset.originalText;
        submitBtn.disabled = false;
    }
    
    if (typeof subscribeFeed === 'function') {
        subscribeFeed();
    }
});
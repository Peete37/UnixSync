import { escapeHtml, formatRelativeTime } from "./helpers.ui.js";

function renderMedia(post) {
  const media = post.mediaURL || [];

  if (post.mediaType === "video") {
    return `
      <div class="relative rounded-2xl overflow-hidden bg-slate-900 mt-3">
        <video
          class="w-full max-h-[520px] object-cover"
          playsinline
          preload="metadata"
          controls
          src="${media[0] || ""}"
        ></video>
        <div class="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div class="bg-black/50 rounded-full px-4 py-2 text-sm font-semibold">▶ Play</div>
        </div>
      </div>
    `;
  }

  if (media.length > 1) {
    return `
      <div class="mt-3 overflow-x-auto hide-scrollbar snap-x snap-mandatory flex gap-2">
        ${media
          .map(
            (src) => `
              <img
                src="${src}"
                alt="Post media"
                class="snap-start w-[85%] h-80 object-cover rounded-2xl flex-shrink-0 bg-slate-900"
              />
            `,
          )
          .join("")}
      </div>
    `;
  }

  if (media.length === 1) {
    return `
      <div class="rounded-2xl overflow-hidden bg-slate-900 mt-3">
        <img
          src="${media[0]}"
          alt="Post media"
          class="w-full max-h-[520px] object-cover"
          loading="lazy"
        />
      </div>
    `;
  }

  return "";
}

function renderLocation(post) {
  if (!post.location || (!post.location.lat && !post.location.landmark))
    return "";

  return `
    <div class="mt-3 flex items-center justify-between gap-3">
      <p class="text-sm text-slate-400 truncate">
        📍 ${escapeHtml(post.location.landmark || "Location attached")}
      </p>
      <button
        class="view-map-btn text-xs px-3 py-1.5 rounded-full bg-slate-800 text-white"
        data-lat="${post.location.lat || ""}"
        data-lng="${post.location.lng || ""}"
      >
        View on Map
      </button>
    </div>
  `;
}

export function renderPostCard(post) {
  const influencerClass = post.isInfluencer
    ? "border border-amber-400/50 shadow-influencer"
    : "border border-slate-800";

  return `
    <article class="p-4 border-b border-slate-900">
      <div class="rounded-3xl bg-slate-950 ${influencerClass} p-4">
        <div class="flex items-start gap-3">
          <img
            src="${post.creatorPhotoURL || "./assets/placeholder-avatar.png"}"
            alt="${escapeHtml(post.creatorName || "User")}"
            class="w-11 h-11 rounded-full object-cover border border-slate-700"
          />

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold truncate">${escapeHtml(post.creatorName || "Unknown User")}</h3>
              ${
                post.isInfluencer
                  ? `<span class="text-[10px] uppercase tracking-wide bg-amber-400 text-black px-2 py-0.5 rounded-full font-bold">Gold</span>`
                  : ""
              }
            </div>

            <p class="text-xs text-slate-500">${formatRelativeTime(post.timestamp)}</p>

            <p class="mt-3 text-sm leading-6 text-slate-100 whitespace-pre-wrap">
              ${escapeHtml(post.description || "")}
            </p>

            ${renderMedia(post)}
            ${renderLocation(post)}

            <div class="mt-4 flex items-center gap-5 text-sm text-slate-400">
              <button class="hover:text-white">❤️ ${post.likesCount || 0}</button>
              <button class="hover:text-white">💬 Comment</button>
              <button class="hover:text-white">🔁 Share</button>
              <button class="hover:text-white">📩 Chat</button>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

export function renderFeed(posts = []) {
  if (!posts.length) {
    return `
      <div class="p-8 text-center text-slate-400">
        No posts yet. Be the first to post on unix sync.
      </div>
    `;
  }

  return posts.map(renderPostCard).join("");
}

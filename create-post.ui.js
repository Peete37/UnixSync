import { compressImage } from "./image-compressor.js";
import { getCurrentUser } from "./auth.service.js";
import { createPost } from "./post.service.js";
import { createLocalPreview, uploadMedia } from "./storage.service.js"; // 👈 Imported our new uploadMedia function
import { getCurrentCoordinates } from "./location.service.js";

// ─── State ────────────────────────────────────────────────────────────────────
let selectedFiles = [];
let attachedLocation = null;
let isSubmitting = false;

// ─── Mount ────────────────────────────────────────────────────────────────────
export function mountCreatePostModal() {
  if (document.getElementById("createPostModal")) return;

  const modal = document.createElement("div");
  modal.id = "createPostModal";
  modal.innerHTML = modalHTML();
  document.body.appendChild(modal);

  bindModalEvents();
}

// ─── Open / Close ─────────────────────────────────────────────────────────────
// Updated to handle asynchronous Supabase authentication safely
export async function openCreatePostModal() {
  const user = await getCurrentUser();

  if (!user) {
    alert("Please sign in to post.");
    return;
  }

  resetModal();
  const modal = document.getElementById("createPostModal");
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  modal.querySelector("#postDescription")?.focus();
}

export function closeCreatePostModal() {
  const modal = document.getElementById("createPostModal");
  modal?.classList.add("hidden");
  document.body.style.overflow = "";
  resetModal();
}

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetModal() {
  selectedFiles = [];
  attachedLocation = null;
  isSubmitting = false;

  const desc = document.getElementById("postDescription");
  if (desc) desc.value = "";

  renderPreviews();
  updateLocationButton();
  setSubmitState(false);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────
function modalHTML() {
  return `
    <div
      class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm"
      id="createPostModal"
    >
      <div
        class="w-full max-w-md bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl
               flex flex-col max-h-[92vh] overflow-hidden"
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <button
            id="closeCreatePostBtn"
            class="text-slate-400 hover:text-white text-2xl leading-none"
            aria-label="Close"
          >&times;</button>
          <h2 class="font-bold text-base">New Post</h2>
          <button
            id="submitPostBtn"
            class="text-sm font-semibold px-4 py-1.5 rounded-full bg-amber-400 text-black
                   disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Share
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          <div class="flex items-center gap-3" id="postModalUserRow">
            <img
              id="postModalAvatar"
              src="./assets/placeholder-avatar.png"
              alt="You"
              class="w-10 h-10 rounded-full object-cover border border-slate-700"
            />
            <span id="postModalName" class="font-semibold text-sm">You</span>
          </div>

          <textarea
            id="postDescription"
            placeholder="What's happening on campus?"
            rows="4"
            class="w-full bg-transparent text-sm text-white placeholder-slate-500 resize-none
                   outline-none leading-6"
            maxlength="500"
          ></textarea>

          <div id="mediaPreviews" class="flex gap-2 flex-wrap"></div>

          <div id="uploadProgressWrap" class="hidden">
            <div class="h-1 bg-slate-800 rounded-full overflow-hidden">
              <div id="uploadProgressBar" class="h-full bg-amber-400 transition-all duration-300" style="width:0%"></div>
            </div>
            <p class="text-xs text-slate-400 mt-1" id="uploadProgressLabel">Uploading…</p>
          </div>

          <div id="locationDisplay" class="hidden text-sm text-slate-400 flex items-center gap-2">
            <span>📍</span>
            <span id="locationText">Location attached</span>
            <button id="removeLocationBtn" class="text-red-400 text-xs ml-auto">Remove</button>
          </div>

        </div>

        <div class="flex items-center gap-4 px-5 py-3 border-t border-slate-800 flex-shrink-0">
          <label for="mediaFileInput" class="cursor-pointer text-slate-400 hover:text-amber-400 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14
                   M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
            <input
              id="mediaFileInput"
              type="file"
              accept="image/*,video/*"
              multiple
              class="hidden"
            />
          </label>

          <button
            id="attachLocationBtn"
            class="text-slate-400 hover:text-amber-400 transition-colors"
            aria-label="Attach location"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
          </button>

          <span class="ml-auto text-xs text-slate-600" id="charCount">0 / 500</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Bind events ──────────────────────────────────────────────────────────────
function bindModalEvents() {
  document.getElementById("closeCreatePostBtn")?.addEventListener("click", closeCreatePostModal);
  document.getElementById("submitPostBtn")?.addEventListener("click", handleSubmit);
  document.getElementById("mediaFileInput")?.addEventListener("change", handleFileSelect);
  document.getElementById("attachLocationBtn")?.addEventListener("click", handleAttachLocation);
  document.getElementById("removeLocationBtn")?.addEventListener("click", handleRemoveLocation);

  document.getElementById("postDescription")?.addEventListener("input", (e) => {
    const len = e.target.value.length;
    const counter = document.getElementById("charCount");
    if (counter) counter.textContent = `${len} / 500`;
  });

  document.getElementById("createPostModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCreatePostModal();
  });

  hydratUserRow();
}

async function hydratUserRow() {
  const user = await getCurrentUser();
  if (!user) return;

  const avatar = document.getElementById("postModalAvatar");
  const name = document.getElementById("postModalName");
  if (avatar) avatar.src = user.user_metadata?.avatar_url || "./assets/placeholder-avatar.png";
  if (name) name.textContent = user.user_metadata?.full_name || "You";
}

// ─── File handling ────────────────────────────────────────────────────────────
function handleFileSelect(e) {
  const files = Array.from(e.target.files || []);
  selectedFiles = [...selectedFiles, ...files].slice(0, 5);
  renderPreviews();
  e.target.value = "";
}

function renderPreviews() {
  const container = document.getElementById("mediaPreviews");
  if (!container) return;

  if (!selectedFiles.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = selectedFiles
    .map((file, i) => {
      const previewURL = createLocalPreview(file);
      const isVideo = file.type.startsWith("video/");

      return `
        <div class="relative w-20 h-20 rounded-xl overflow-hidden bg-slate-800 flex-shrink-0">
          ${
            isVideo
              ? `<video src="${previewURL}" class="w-full h-full object-cover"></video>
                 <div class="absolute inset-0 flex items-center justify-center bg-black/30">
                   <span class="text-white text-xl">▶</span>
                 </div>`
              : `<img src="${previewURL}" class="w-full h-full object-cover" alt="Preview" />`
          }
          <button
            data-index="${i}"
            class="remove-preview-btn absolute top-1 right-1 bg-black/60 rounded-full w-5 h-5
                   flex items-center justify-center text-white text-xs leading-none"
          >&times;</button>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".remove-preview-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index, 10);
      selectedFiles.splice(idx, 1);
      renderPreviews();
    });
  });
}

// ─── Location ─────────────────────────────────────────────────────────────────
async function handleAttachLocation() {
  const btn = document.getElementById("attachLocationBtn");
  if (btn) btn.classList.add("animate-pulse");

  try {
    const coords = await getCurrentCoordinates();
    attachedLocation = {
      lat: coords.lat,
      lng: coords.lng,
      landmark: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
    };
    updateLocationButton();
  } catch (error) {
    console.error("Could not fetch location. Please allow location access:", error);
  } finally {
    if (btn) btn.classList.remove("animate-pulse");
  }
}

function handleRemoveLocation() {
  attachedLocation = null;
  updateLocationButton();
}

function updateLocationButton() {
  const display = document.getElementById("locationDisplay");
  const text = document.getElementById("locationText");

  if (attachedLocation) {
    display?.classList.remove("hidden");
    if (text) text.textContent = attachedLocation.landmark;
  } else {
    display?.classList.add("hidden");
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────
async function handleSubmit() {
  if (isSubmitting) return;

  const user = await getCurrentUser();
  if (!user) return alert("Please sign in.");

  const description = document.getElementById("postDescription")?.value.trim();
  if (!description && !selectedFiles.length) {
    return alert("Add a description or media to post.");
  }

  isSubmitting = true;
  setSubmitState(true);

  try {
    let mediaURLs = [];
    let mediaType = "image";

    if (selectedFiles.length) {
      showProgress(0);

      const total = selectedFiles.length;
      const perFileProgress = new Array(total).fill(0);

      // Rewritten to loop through your compressed images and pass them to our Supabase storage hook
      const results = await Promise.all(
        selectedFiles.map(async (file, i) => {
          const isVideo = file.type.startsWith("video/");
          const blobToUpload = isVideo ? file : await compressImage(file, 1024, 0.75);

          const uploadResult = await uploadMedia(blobToUpload, user.id, (pct) => {
            perFileProgress[i] = pct;
            const overall = Math.round(
              perFileProgress.reduce((a, b) => a + b, 0) / total
            );
            showProgress(overall);
          });

          return uploadResult; // returns { url: publicUrl, mediaType, path }
        })
      );

      mediaURLs = results.map((r) => r.url);
      mediaType = results[0]?.mediaType || "image";
      hideProgress();
    }

    // Matches your clean Supabase query parameter expectations (takes individual properties or flat variables)
    await createPost(
      description,
      mediaURLs.length > 1 ? mediaURLs : (mediaURLs[0] || ""), // Pass array or single string based on your schema preference
      mediaType,
      attachedLocation ? attachedLocation.landmark : ""
    );

    closeCreatePostModal();

    // Trigger feed refresh
    document.getElementById("refreshFeedBtn")?.click();
  } catch (err) {
    console.error(err);
    alert(`Failed to post: ${err.message}`);
    isSubmitting = false;
    setSubmitState(false);
    hideProgress();
  }
}

function setSubmitState(loading) {
  const btn = document.getElementById("submitPostBtn");
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? "Posting…" : "Share";
}

function showProgress(percent) {
  const wrap = document.getElementById("uploadProgressWrap");
  const bar = document.getElementById("uploadProgressBar");
  const label = document.getElementById("uploadProgressLabel");

  wrap?.classList.remove("hidden");
  if (bar) bar.style.width = `${percent}%`;
  if (label) label.textContent = `Uploading… ${percent}%`;
}

function hideProgress() {
  document.getElementById("uploadProgressWrap")?.classList.add("hidden");
}

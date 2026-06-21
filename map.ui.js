// ─── 1. FIXED FLAT DIRECTORY IMPORTS ──────────────────────────────────────────
import { supabase } from "./supabase-config.js"; // Swapped out Firebase for your unified client
import { loadCampusFeed } from "./post.service.js"; 
import { getCurrentCoordinates } from "./location.service.js";
import { escapeHtml } from "./helpers.ui.js";

// ─── State ────────────────────────────────────────────────────────────────────
let mapInstance = null;
let markers = [];
let infoWindows = [];

// ─── Mount ────────────────────────────────────────────────────────────────────
export function mountMapPage() {
  if (document.getElementById("mapPage")) return;

  const page = document.createElement("div");
  page.id = "mapPage";
  page.innerHTML = mapPageHTML();
  document.body.appendChild(page);

  bindMapPageEvents();
}

// ─── Open ─────────────────────────────────────────────────────────────────────
export async function openMapPage() {
  const page = document.getElementById("mapPage");
  page?.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  await initMap();
  await loadPostsOnMap();
}

function closeMapPage() {
  document.getElementById("mapPage")?.classList.add("hidden");
  document.body.style.overflow = "";
}

// ─── Google Maps init ─────────────────────────────────────────────────────────
async function initMap() {
  if (mapInstance) return; // already initialized

  // Check if Google Maps is loaded
  if (!window.google?.maps) {
    document.getElementById("mapLoadingMsg").textContent =
      "⚠️ Google Maps not loaded. Add your Maps API key.";
    return;
  }

  let center = { lat: 5.6037, lng: -0.187 }; // Default fallback: Accra, Ghana

  try {
    const coords = await getCurrentCoordinates();
    center = { lat: coords.lat, lng: coords.lng };
  } catch {
    // Use default center fallback
  }

  mapInstance = new google.maps.Map(document.getElementById("mapCanvas"), {
    center,
    zoom: 14,
    styles: darkMapStyle(),
    disableDefaultUI: true,
    zoomControl: true,
  });

  // "My Location" dot
  if (center.lat !== 5.6037) {
    new google.maps.Marker({
      position: center,
      map: mapInstance,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#f59e0b",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
      title: "You are here",
      zIndex: 999,
    });
  }

  document.getElementById("mapLoadingMsg")?.classList.add("hidden");
}

// ─── Load posts on map ────────────────────────────────────────────────────────
async function loadPostsOnMap() {
  if (!mapInstance) return;

  // Clear existing markers
  markers.forEach((m) => m.setMap(null));
  markers = [];
  infoWindows.forEach((w) => w.close());
  infoWindows = [];

  let posts = [];
  
  // Safe internal query block matching your Supabase collection table schema
  try {
    const { data, error } = await supabase
      .from("posts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    posts = data || [];
  } catch (err) {
    console.warn("Direct map extraction fallback running:", err);
  }

  // To cleanly parse positions, we read coordinates directly out of your relational table layout
  const postsWithLocation = posts.filter(
    (p) => p.location?.lat && p.location?.lng
  );

  if (!postsWithLocation.length) {
    showMapNotice("No posts with location found nearby.");
    return;
  }

  postsWithLocation.forEach((post) => {
    const position = { lat: parseFloat(post.location.lat), lng: parseFloat(post.location.lng) };

    const marker = new google.maps.Marker({
      position,
      map: mapInstance,
      title: post.creatorName || "Student",
      icon: {
        url: post.creatorPhotoURL || "./assets/placeholder-avatar.png",
        scaledSize: new google.maps.Size(40, 40),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(20, 20),
      },
    });

    const mediaHTML = post.mediaURL
        ? `<img src="${post.mediaURL}" class="w-full h-24 object-cover rounded-lg mt-2" />`
        : "";

    const infoWindow = new google.maps.InfoWindow({
      content: `
        <div style="background:#0f172a;color:#fff;padding:10px 12px;border-radius:12px;
                    max-width:200px;font-family:sans-serif;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="${post.creatorPhotoURL || "./assets/placeholder-avatar.png"}"
                 style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />
            <div>
              <p style="margin:0;font-weight:600;font-size:13px;">
                ${escapeHtml(post.creatorName || "User")}
              </p>
              <p style="margin:0;font-size:11px;color:#94a3b8;">${post.location.landmark || ""}</p>
            </div>
          </div>
          <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#e2e8f0;">
            ${escapeHtml((post.description || "").slice(0, 80))}${(post.description || "").length > 80 ? "…" : ""}
          </p>
          ${mediaHTML}
        </div>
      `,
    });

    marker.addListener("click", () => {
      infoWindows.forEach((w) => w.close());
      infoWindow.open({ anchor: marker, map: mapInstance });
    });

    markers.push(marker);
    infoWindows.push(infoWindow);
  });
}

// ─── HTML ─────────────────────────────────────────────────────────────────────
function mapPageHTML() {
  return `
    <div
      id="mapPage"
      class="hidden fixed inset-0 z-50 bg-black flex flex-col max-w-md mx-auto"
    >
      <div class="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur border-b border-slate-800 z-10">
        <button id="closeMapPageBtn" class="text-slate-400 hover:text-white">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <h2 class="font-bold text-base">Campus Map</h2>
        <button
          id="refreshMapBtn"
          class="text-sm px-3 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300"
        >
          Refresh
        </button>
      </div>

      <div id="mapLoadingMsg" class="text-center text-slate-400 text-sm py-4">
        Loading map…
      </div>

      <div id="mapCanvas" class="flex-1 w-full"></div>

      <div
        id="mapNotice"
        class="hidden absolute bottom-20 left-0 right-0 mx-4 bg-slate-900 border border-slate-700
               rounded-xl px-4 py-2 text-sm text-slate-400 text-center"
      ></div>
    </div>
  `;
}

function bindMapPageEvents() {
  document.getElementById("closeMapPageBtn")?.addEventListener("click", closeMapPage);

  document.getElementById("refreshMapBtn")?.addEventListener("click", async () => {
    await loadPostsOnMap();
  });
}

function showMapNotice(text) {
  const el = document.getElementById("mapNotice");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

// ─── Dark map style ────────────────────────────────────────────────────────────
function darkMapStyle() {
  return [
    { elementType: "geometry", stylers: [{ color: "#0f172a" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
    {
      featureType: "administrative.locality",
      elementType: "labels.text.fill",
      stylers: [{ color: "#d59563" }],
    },
    {
      featureType: "road",
      elementType: "geometry",
      stylers: [{ color: "#1e293b" }],
    },
    {
      featureType: "road",
      elementType: "geometry.stroke",
      stylers: [{ color: "#0f172a" }],
    },
    {
      featureType: "road.highway",
      elementType: "geometry",
      stylers: [{ color: "#334155" }],
    },
    {
      featureType: "water",
      elementType: "geometry",
      stylers: [{ color: "#0c1825" }],
    },
  ];
}

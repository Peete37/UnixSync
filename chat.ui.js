import {
  getOrCreateChat,
  sendMessage,
  subscribeToMessages,
  fetchUserChats,
  markAsRead
} from './chat.service.js';

import { getUserProfile, getCurrentUser } from './auth.service.js';
import { escapeHtml, formatRelativeTime } from './helpers.ui.js';
// ─── State ────────────────────────────────────────────────────────────────────
let activeChatId = null;
let unsubscribeMessages = null;

// ─── Mount ────────────────────────────────────────────────────────────────────
export function mountChatUI() {
  if (document.getElementById("chatPanel")) return;

  const panel = document.createElement("div");
  panel.id = "chatPanel";
  panel.innerHTML = chatPanelHTML();
  document.body.appendChild(panel);

  bindChatPanelEvents();
}

// ─── Open chat list (Inbox) ───────────────────────────────────────────────────
export async function openChatInbox() {
  const user = getCurrentUser();
  if (!user) return alert("Please sign in to use DMs.");

  showChatPanel("inbox");

  const listEl = document.getElementById("chatInboxList");
  if (listEl) listEl.innerHTML = `<p class="text-slate-500 text-sm p-4">Loading…</p>`;

  try {
    const chats = await fetchUserChats(user.uid);

    if (!chats.length) {
      if (listEl) listEl.innerHTML = `<p class="text-slate-500 text-sm p-4">No conversations yet.</p>`;
      return;
    }

    // Fetch other participant profiles
    const chatItems = await Promise.all(
      chats.map(async (chat) => {
        const otherUid = chat.participants.find((uid) => uid !== user.uid);
        const profile = await getUserProfile(otherUid);
        return { chat, profile };
      })
    );

    if (listEl) {
      listEl.innerHTML = chatItems.map(({ chat, profile }) => inboxItemHTML(chat, profile, user.uid)).join("");

      listEl.querySelectorAll(".inbox-item").forEach((item) => {
        item.addEventListener("click", () => {
          const otherUid = item.dataset.otherUid;
          openChatWithUser(otherUid);
        });
      });
    }
  } catch (err) {
    console.error(err);
    if (listEl) listEl.innerHTML = `<p class="text-red-400 text-sm p-4">Failed to load chats.</p>`;
  }
}

/**
 * Open a DM with a specific user UID.
 * Called from the feed post cards ("Chat" button).
 */
export async function openChatWithUser(otherUid) {
  const user = getCurrentUser();
  if (!user) return alert("Please sign in.");

  showChatPanel("chat");

  const chatBody = document.getElementById("chatMessages");
  const chatHeader = document.getElementById("chatWindowHeader");

  if (chatBody) chatBody.innerHTML = `<p class="text-slate-500 text-sm p-4 text-center">Loading…</p>`;

  // Load other user's profile
  const profile = await getUserProfile(otherUid);
  if (chatHeader) {
    chatHeader.innerHTML = `
      <button id="backToInboxBtn" class="text-slate-400 hover:text-white mr-3">←</button>
      <img src="${profile?.photoURL || "./assets/placeholder-avatar.png"}"
           class="w-8 h-8 rounded-full object-cover border border-slate-700 mr-2" />
      <span class="font-semibold text-sm truncate">${escapeHtml(profile?.name || "User")}</span>
    `;
    document.getElementById("backToInboxBtn")?.addEventListener("click", openChatInbox);
  }

  // Get or create chat
  activeChatId = await getOrCreateChat(user.uid, otherUid);
  await markAsRead(activeChatId, user.uid);

  // Unsubscribe previous listener
  unsubscribeMessages?.();
  unsubscribeMessages = subscribeToMessages(activeChatId, (messages) => {
    renderMessages(messages, user.uid);
  });
}

// ─── Render messages ──────────────────────────────────────────────────────────
function renderMessages(messages, myUid) {
  const container = document.getElementById("chatMessages");
  if (!container) return;

  if (!messages.length) {
    container.innerHTML = `<p class="text-slate-500 text-sm text-center mt-8">Say hello 👋</p>`;
    return;
  }

  container.innerHTML = messages
    .map((msg) => {
      const isMine = msg.senderId === myUid;
      const time = msg.createdAt?.toMillis
        ? formatRelativeTime(msg.createdAt.toMillis())
        : "";

      return `
        <div class="flex ${isMine ? "justify-end" : "justify-start"} mb-2 px-3">
          <div class="max-w-[75%]">
            <div class="px-4 py-2 rounded-2xl text-sm leading-relaxed
              ${isMine
                ? "bg-amber-400 text-black rounded-br-sm"
                : "bg-slate-800 text-white rounded-bl-sm"}
            ">
              ${escapeHtml(msg.text)}
            </div>
            <p class="text-[10px] text-slate-600 mt-0.5 ${isMine ? "text-right" : "text-left"}">${time}</p>
          </div>
        </div>
      `;
    })
    .join("");

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ─── Send message ─────────────────────────────────────────────────────────────
async function handleSendMessage() {
  if (!activeChatId) return;

  const user = getCurrentUser();
  if (!user) return;

  const input = document.getElementById("chatInput");
  const text = input?.value.trim();
  if (!text) return;

  if (input) input.value = "";

  try {
    await sendMessage(activeChatId, user.uid, text);
  } catch (err) {
    console.error(err);
    alert("Failed to send message.");
  }
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────
function chatPanelHTML() {
  return `
    <div
      id="chatPanel"
      class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm"
    >
      <div class="w-full max-w-md bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl
                  flex flex-col h-[88vh] overflow-hidden">

        <!-- Inbox view -->
        <div id="inboxView">
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
            <h2 class="font-bold text-base">Messages</h2>
            <button id="closeChatPanelBtn" class="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
          </div>
          <div id="chatInboxList" class="overflow-y-auto flex-1"></div>
        </div>

        <!-- Chat window view -->
        <div id="chatWindowView" class="hidden flex flex-col h-full">
          <!-- Header -->
          <div
            id="chatWindowHeader"
            class="flex items-center px-4 py-3 border-b border-slate-800 flex-shrink-0"
          ></div>

          <!-- Messages -->
          <div
            id="chatMessages"
            class="flex-1 overflow-y-auto py-3"
          ></div>

          <!-- Input bar -->
          <div class="flex items-center gap-3 px-4 py-3 border-t border-slate-800 flex-shrink-0">
            <input
              id="chatInput"
              type="text"
              placeholder="Message…"
              class="flex-1 bg-slate-800 text-sm text-white placeholder-slate-500 rounded-full px-4 py-2.5 outline-none"
            />
            <button
              id="chatSendBtn"
              class="bg-amber-400 text-black font-bold text-sm px-4 py-2.5 rounded-full"
            >
              Send
            </button>
          </div>
        </div>

      </div>
    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function inboxItemHTML(chat, profile, myUid) {
  const unread = chat.unread?.[myUid] || 0;

  return `
    <div
      class="inbox-item flex items-center gap-3 px-4 py-3 border-b border-slate-900
             hover:bg-slate-900 cursor-pointer transition-colors"
      data-other-uid="${chat.participants.find((uid) => uid !== myUid)}"
    >
      <img
        src="${profile?.photoURL || "./assets/placeholder-avatar.png"}"
        class="w-11 h-11 rounded-full object-cover border border-slate-700 flex-shrink-0"
      />
      <div class="min-w-0 flex-1">
        <p class="font-semibold text-sm truncate">${escapeHtml(profile?.name || "User")}</p>
        <p class="text-xs text-slate-500 truncate">${escapeHtml(chat.lastMessage || "Start a conversation")}</p>
      </div>
      ${
        unread > 0
          ? `<span class="bg-amber-400 text-black text-xs font-bold rounded-full w-5 h-5
                          flex items-center justify-center flex-shrink-0">${unread}</span>`
          : ""
      }
    </div>
  `;
}

function showChatPanel(view) {
  const panel = document.getElementById("chatPanel");
  const inboxView = document.getElementById("inboxView");
  const chatWindowView = document.getElementById("chatWindowView");

  panel?.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  if (view === "inbox") {
    inboxView?.classList.remove("hidden");
    chatWindowView?.classList.add("hidden");
  } else {
    inboxView?.classList.add("hidden");
    chatWindowView?.classList.remove("hidden");
  }
}

function closeChatPanel() {
  document.getElementById("chatPanel")?.classList.add("hidden");
  document.body.style.overflow = "";
  unsubscribeMessages?.();
  unsubscribeMessages = null;
  activeChatId = null;
}

function bindChatPanelEvents() {
  document.getElementById("closeChatPanelBtn")?.addEventListener("click", closeChatPanel);

  document.getElementById("chatSendBtn")?.addEventListener("click", handleSendMessage);

  document.getElementById("chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // Close on backdrop click
  document.getElementById("chatPanel")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeChatPanel();
  });
}
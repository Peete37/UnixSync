// ─── 1. CENTRALIZED CONFIG IMPORT ───────────────────────────────────────────
import { supabase } from "./supabase-config.js";

/**
 * Build a deterministic chatId from two UIDs (alphabetical sort).
 * This remains fully identical to keep your existing structural logic!
 */
export function buildChatId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

/**
 * Get or create a chat row between two users.
 */
export async function getOrCreateChat(currentUid, otherUid) {
  const chatId = buildChatId(currentUid, otherUid);

  // 1. Check if the chat room row already exists
  const { data: chat, error } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .maybeSingle();

  // 2. If it doesn't exist, insert a new record
  if (!chat) {
    const { error: insertError } = await supabase
      .from("chats")
      .insert([
        {
          id: chatId,
          participants: [currentUid, otherUid],
          last_message: "",
          last_at: new Date().toISOString(),
          unread_count_user1: 0, // Flattened unread structure for PostgreSQL
          unread_count_user2: 0,
        },
      ]);

    if (insertError) throw insertError;
  }

  return chatId;
}

/**
 * Send a message in a chat and update the parent chat info.
 */
export async function sendMessage(chatId, senderId, text) {
  const trimmedText = text.trim();
  const now = new Date().toISOString();

  // 1. Insert the message into the messages table
  const { error: msgError } = await supabase
    .from("messages")
    .insert([
      {
        chat_id: chatId,
        sender_id: senderId,
        text: trimmedText,
        created_at: now,
        seen: false,
      },
    ]);

  if (msgError) throw msgError;

  // 2. Fetch the chat to figure out whose unread count to increment
  const { data: chat } = await supabase
    .from("chats")
    .select("participants, unread_count_user1, unread_count_user2")
    .eq("id", chatId)
    .single();

  if (chat) {
    // Determine if the recipient is user1 or user2 based on position in your alphabetical array
    const isUser1 = chat.participants[0] !== senderId;
    const updateData = {
      last_message: trimmedText.slice(0, 80),
      last_at: now,
    };

    if (isUser1) {
      updateData.unread_count_user1 = (chat.unread_count_user1 || 0) + 1;
    } else {
      updateData.unread_count_user2 = (chat.unread_count_user2 || 0) + 1;
    }

    // 3. Update parent chat record details
    await supabase.from("chats").update(updateData).eq("id", chatId);
  }
}

/**
 * Subscribe to messages in real-time.
 * Returns an unsubscribe cleanup function matching your original API layout.
 */
export function subscribeToMessages(chatId, callback) {
  // First, pull down the initial message history (limit 100)
  supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(100)
    .then(({ data }) => {
      if (data) callback(data);
    });

  // Set up real-time filter subscription for incoming new entries
  const channel = supabase
    .channel(`chat:${chatId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `chat_id=eq.${chatId}`,
      },
      async () => {
        // Fetch full fresh history array for the container render callback
        const { data } = await supabase
          .from("messages")
          .select("*")
          .eq("chat_id", chatId)
          .order("created_at", { ascending: true })
          .limit(100);
        if (data) callback(data);
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Fetch all chats for a user (inbox list overview).
 */
export async function fetchUserChats(uid) {
  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .cs("participants", [uid]); // .cs() stands for "contains array" in Supabase!

  if (error) throw error;
  return data || [];
}

/**
 * Mark messages in a chat as read for a user.
 */
export async function markAsRead(chatId, uid) {
  // 1. Reset unread counters inside the parent tracking row
  const { data: chat } = await supabase
    .from("chats")
    .select("participants")
    .eq("id", chatId)
    .single();

  if (chat) {
    const isUser1 = chat.participants[0] === uid;
    const updateField = isUser1 ? { unread_count_user1: 0 } : { unread_count_user2: 0 };
    
    await supabase.from("chats").update(updateField).eq("id", chatId);
  }

  // 2. Flip all incoming messages targeting this user inside this thread to seen
  await supabase
    .from("messages")
    .update({ seen: true })
    .eq("chat_id", chatId)
    .not("sender_id", "eq", uid);
}
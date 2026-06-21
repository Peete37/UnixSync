// ─── 1. CONFIG & UI IMPORTS ──────────────────────────────────────────────────
import { supabase } from "./supabase-config.js";
import { renderPostCard } from "./feed.ui.js";

/**
 * Helper to get the current logged-in user's session data
 */
export const getCurrentUser = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

/**
 * Creates a new post with influencer status check
 */
export const createPost = async (description, mediaURL = "", mediaType = "image", location = "") => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be logged in to post.");

  // Fetch user profile from custom users table to check influencer status
  const { data: userData } = await supabase
    .from("users")
    .select("isInfluencer, expiryDate")
    .eq("id", user.id)
    .single();

  const now = Date.now();
  const influencerStillActive = Boolean(userData?.isInfluencer) && 
                                Boolean(userData?.expiryDate) && 
                                new Date(userData.expiryDate).getTime() > now;

  const postData = {
    creatorId: user.id,
    creatorName: user.user_metadata?.full_name || "Student",
    creatorPhotoURL: user.user_metadata?.avatar_url || "",
    mediaType,
    mediaURL,
    description,
    location,
    timestamp: now,
    likesCount: 0,
    isInfluencer: influencerStillActive,
    created_at: new Date().toISOString()
  };

  // Insert the post row into the 'posts' table
  const { data: newPost, error } = await supabase
    .from("posts")
    .insert([postData])
    .select()
    .single();

  if (error) throw error;
  return newPost;
};

/**
 * Toggle like on a post using a secure Supabase Remote Procedure Call (RPC) or safe increment
 * Note: To keep things atomic like your old transaction, it's highly recommended to use an RPC 
 * function in your Supabase SQL editor. Here is a secure JavaScript fallback pattern.
 */
export async function toggleLike(postId, uid) {
  // 1. Check if the user already liked the post
  const { data: likeExists, error: fetchError } = await supabase
    .from("likes")
    .select("*")
    .eq("post_id", postId)
    .eq("user_id", uid)
    .maybeSingle();

  if (fetchError) throw fetchError;

  if (likeExists) {
    // 2a. Unlike: Delete row from likes table
    await supabase.from("likes").delete().eq("post_id", postId).eq("user_id", uid);
    
    // Decrement likesCount on the post
    const { data: post } = await supabase.from("posts").select("likesCount").eq("id", postId).single();
    await supabase.from("posts").update({ likesCount: Math.max(0, (post?.likesCount || 1) - 1) }).eq("id", postId);
  } else {
    // 2b. Like: Add row to likes table
    await supabase.from("likes").insert([{ post_id: postId, user_id: uid }]);
    
    // Increment likesCount on the post
    const { data: post } = await supabase.from("posts").select("likesCount").eq("id", postId).single();
    await supabase.from("posts").update({ likesCount: (post?.likesCount || 0) + 1).eq("id", postId);
  }
}

/**
 * Fetch feed ordered by influencer status and newest timestamp
 */
export async function fetchFeed(feedLimit = 20) {
  const { data, error } = await supabase
    .from("posts")
    .select("*")
    .order("isInfluencer", { ascending: false })
    .order("timestamp", { ascending: false })
    .limit(feedLimit);

  if (error) throw error;
  return data || [];
}

/**
 * Real-time listener for the feed using Supabase Realtime Broadcast/Channels
 */
export const getLivePosts = (callback) => {
  const channel = supabase
    .channel("public:posts")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "posts" },
      async () => {
        // Fetch fresh list when any post changes, updates, or is deleted
        const { data } = await supabase
          .from("posts")
          .select("*")
          .order("created_at", { ascending: false });
        if (data) callback(data);
      }
    )
    .subscribe();

  // Return unsubscribe cleanup function to match old Firebase return setup
  return () => {
    supabase.removeChannel(channel);
  };
};

/**
 * One-time feed fetcher that cleans up the DOM spinner overlay
 */
export const loadCampusFeed = async () => {
  const feedContainer = document.getElementById("feed-container");
  try {
    // Fetch posts ordered by newest first
    const { data: posts, error } = await supabase
      .from("posts")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // CLEAR THE LOADING SPINNER IMMEDIATELY
    if (feedContainer) {
      feedContainer.innerHTML = "";
    }

    // Handle Empty State
    if (!posts || posts.length === 0) {
      if (feedContainer) {
        feedContainer.innerHTML = `<p class="p-12 text-center text-slate-400">No campus updates posted yet!</p>`;
      }
      return;
    }

    // Render all posts perfectly formatted through feed.ui.js setup
    if (feedContainer) {
      feedContainer.innerHTML = posts.map(renderPostCard).join("");
    }
  } catch (error) {
    console.error("Error loading feed:", error);
    if (feedContainer) {
      feedContainer.innerHTML = `<p class="p-12 text-center text-red-400">Failed to load campus feed. Try refreshing.</p>`;
    }
  }
};

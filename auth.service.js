// ─── 1. CENTRALIZED CONFIG IMPORT ───────────────────────────────────────────
import { supabase } from "./supabase-config.js";

/**
 * Get the current authenticated user session.
 */
export const getCurrentUser = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
};

/**
 * Core Google Authentication Logic using OAuth Popups
 * Automatically provisions user profiles in the Supabase 'users' table on completion
 */
async function executeGoogleLogin() {
  try {
    // 1. Trigger Supabase OAuth sign-in with Google
    // Note: In production/mobile, Supabase handles this via redirects or popup configurations
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin, // Redirect back to your app homepage after login
      },
    });

    if (error) throw error;

    // 2. Note on Profiling: Supabase automatically handles creating a secure user record
    // inside the `auth.users` table. If you want to sync this to a custom public 'users'
    // table, the absolute best practice in Supabase is using a PostgreSQL Trigger.
    // However, if you're doing it on the client side, it would look like the commented block below:
    /*
    const user = await getCurrentUser();
    if (user) {
      const { data: profile } = await supabase.from('users').select('*').eq('id', user.id).single();
      if (!profile) {
        await supabase.from('users').insert([{
          id: user.id,
          name: user.user_metadata.full_name || "Kofid User",
          email: user.email || "",
          photo_url: user.user_metadata.avatar_url || "",
          is_influencer: false,
          expiry_date: null,
          created_at: new Date().toISOString(),
        }]);
      }
    }
    */
  } catch (error) {
    console.error("Google Login Error:", error.message || error);
    throw error;
  }
}

// Export both naming styles so app.js and index scripts don't throw import errors
export const loginWithGoogle = () => executeGoogleLogin();
export const signInWithGoogle = () => executeGoogleLogin();

/**
 * Global Authentication Observers
 * Listens for Sign In, Sign Out, and Token Refresh events
 */
export const onAuthChange = (callback) => {
  // Fix: previously this ONLY fired the callback in response to Supabase's
  // onAuthStateChange event. That event's first firing (INITIAL_SESSION) can
  // be delayed while the SDK tries to validate/refresh the token over the
  // network -- so if the page loads (or re-checks auth) while offline, the
  // callback simply never runs until connectivity returns and that refresh
  // resolves. That's exactly what left Profile/DMs/Create stuck showing the
  // Sign In screen for someone who was genuinely still logged in, until the
  // network came back. supabase.auth.getSession() reads the session straight
  // out of localStorage first and resolves immediately (no network needed)
  // -- calling the callback with that up front means the UI can hydrate from
  // the cached session right away, regardless of connectivity, while the real
  // onAuthStateChange listener still keeps it correctly in sync afterwards.
  supabase.auth
    .getSession()
    .then(({ data }) => {
      callback(data?.session ? data.session.user : null);
    })
    .catch(() => {});

  supabase.auth.onAuthStateChange((event, session) => {
    // Converts Supabase session user object back to match your original callback structure
    callback(session ? session.user : null);
  });
};

export const watchAuthState = (callback) => onAuthChange(callback);

/**
 * Sign Out System Controllers
 */
export const logout = () => supabase.auth.signOut();
export const logoutUser = () => supabase.auth.signOut();
export const signOutUser = async () => {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } catch (error) {
    console.error("Logout Execution Error:", error.message || error);
  }
};

/**
 * Fetch an isolated user profile by their UUID key from the custom 'users' table
 */
export async function getUserProfile(uid) {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", uid)
      .single(); // Gets a clean single object back instead of an array

    if (error) return null;
    return data;
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return null;
  }
}

// Supabase Edge Function: delete-account
//
// A browser client can never safely hold a service-role key (it would be
// visible to anyone who opens devtools), so full auth-user deletion has
// to happen server-side. This function verifies the caller's own JWT,
// confirms they're deleting THEIR OWN account (never someone else's),
// then uses the service role key (kept as a server-side secret, never
// shipped to the browser) to actually remove the auth user.
//
// ─── DEPLOY ───────────────────────────────────────────────────────────────
// 1. Install the Supabase CLI if you haven't: https://supabase.com/docs/guides/cli
// 2. From your project root:
//      supabase functions new delete-account
//      (then replace the generated index.ts with this file's contents)
// 3. Deploy:
//      supabase functions deploy delete-account
// 4. The service role key is already available to Edge Functions as the
//    SUPABASE_SERVICE_ROLE_KEY env var automatically — you do NOT need to
//    set it yourself or put it in your client code.
//
// ─── CLIENT USAGE ─────────────────────────────────────────────────────────
// The app already calls this via supabase.functions.invoke('delete-account')
// in app.js's confirmDeleteAccount — see the fallback behavior there if
// this function isn't deployed yet.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Client used ONLY to verify who's calling (with the anon key + their
    // JWT) — this never touches the service role.
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client, using the service role key — only ever runs
    // server-side inside this function, never exposed to any browser.
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Deletes exactly the calling user's own account — there is no path
    // here for deleting anyone else's, since the id comes from their own
    // verified JWT, not from anything the client could pass in.
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("delete-account error:", err);
    return new Response(JSON.stringify({ error: err.message || "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

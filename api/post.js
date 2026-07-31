// Example: response caching at the API layer, for ONE specific,
// genuinely safe case — fetching a single public listing by id.
//
// This is deliberately NOT wired into app.js automatically. Your feed,
// "Following" tab, saved items, DMs, etc. are all personalized per viewer
// (campus scope, who they follow, what they've saved) — caching those at
// a shared CDN layer would risk showing one person's personalized data to
// someone else. A single listing's own content, by contrast, is identical
// no matter who's looking at it, which is what makes it safe to cache here.
//
// Deploy: put this file at /api/post.js in your project root (Vercel
// auto-detects anything under /api as a Serverless Function, no extra
// config needed). Then a request like:
//   https://yourapp.vercel.app/api/post?id=<post-uuid>
// returns the listing's public fields, cached at Vercel's edge for 30
// seconds with a 5-minute stale-while-revalidate window — so repeat
// views of a popular listing hit the CDN instead of your database, while
// an edit/price-change still shows up within half a minute.
//
// Uses the PUBLIC anon key only (same one already embedded in your
// client-side supabase-config.js) — never put a service-role key in a
// file like this, since anything under /api is reachable by anyone.

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit } from "../lib/rateLimit.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

export default async function handler(req, res) {
  // Input validation, done BEFORE anything touches the database:
  //   - only GET is meaningful for a read-only cached endpoint
  //   - posts.id is a bigint in your schema, so anything that isn't a
  //     plain run of digits (optionally very large, but never negative,
  //     decimal, or containing SQL/other characters) is rejected
  //     immediately with 400, rather than being handed to Supabase as-is.
  //     supabase-js parameterizes this internally so it isn't literally
  //     SQL-injectable either way, but rejecting malformed input early
  //     means garbage requests never reach your database at all, and
  //     the error message stays meaningful instead of a generic 404.
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Rate limit checked before doing any real work — this is a public,
  // unauthenticated, cached endpoint, exactly the kind that's cheap for
  // someone to hammer. See lib/rateLimit.js for setup; this fails open
  // (lets requests through) until Upstash is actually configured.
  const { limited, retryAfter } = await checkRateLimit(req);
  if (limited) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests, slow down." });
    return;
  }

  const { id } = req.query;
  if (!id || typeof id !== "string" || !/^\d{1,19}$/.test(id)) {
    res
      .status(400)
      .json({ error: "Invalid or missing ?id= (expected a positive integer)" });
    return;
  }

  const { data, error } = await supabase
    .from("posts")
    .select(
      "id, title, description, price, media_urls, category, institution, region, created_at, user_id",
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // s-maxage is what Vercel's CDN honors; stale-while-revalidate lets it
  // keep serving the (slightly old) cached copy instantly while it
  // quietly re-fetches a fresh one in the background, rather than making
  // one unlucky visitor wait on a slow re-fetch.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=300",
  );
  res.status(200).json(data);
}

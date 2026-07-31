/**
 * Shared rate limiter for Vercel Serverless Functions, backed by Upstash
 * Redis. Reusable across any /api endpoint you add later — api/post.js
 * uses it below as the first example.
 *
 * Setup:
 *   1. Create a free database at upstash.com (Redis -> Create Database).
 *   2. Copy the REST URL and REST Token from that database's page.
 *   3. Add them in Vercel -> Settings -> Environment Variables:
 *        UPSTASH_REDIS_REST_URL
 *        UPSTASH_REDIS_REST_TOKEN
 *   4. npm install @upstash/ratelimit @upstash/redis
 *
 * Fails OPEN, not closed, if Upstash isn't configured yet: if the two env
 * vars above are missing, checkRateLimit() logs a warning once and lets
 * every request through, rather than throwing and taking your whole
 * endpoint down before you've had a chance to set Upstash up. Once both
 * env vars exist, rate limiting turns on automatically — no code change
 * needed at that point.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let ratelimit = null;
let warnedMissingConfig = false;

function getRatelimiter() {
  if (ratelimit) return ratelimit;
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    if (!warnedMissingConfig) {
      console.warn(
        "[RateLimit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting is OFF until configured.",
      );
      warnedMissingConfig = true;
    }
    return null;
  }
  ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    // 20 requests per 10 seconds per identifier (IP by default — see
    // checkRateLimit below). Sliding window rather than fixed, so it
    // can't be gamed by timing requests right at a window boundary.
    limiter: Ratelimit.slidingWindow(20, "10 s"),
    analytics: true,
  });
  return ratelimit;
}

/**
 * Call at the top of a handler, before any real work happens. Returns
 * { limited: false } to proceed normally, or { limited: true, retryAfter }
 * when the caller should get a 429.
 *
 * identifier defaults to the caller's IP (from Vercel's forwarded-for
 * header) — pass a different identifier (e.g. a user id) if you want
 * per-account limits instead of per-IP for a specific authenticated
 * endpoint.
 */
export async function checkRateLimit(req, identifier = null) {
  const limiter = getRatelimiter();
  if (!limiter) return { limited: false };

  const id =
    identifier ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";
  const { success, reset } = await limiter.limit(id);

  if (!success) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
    };
  }
  return { limited: false };
}

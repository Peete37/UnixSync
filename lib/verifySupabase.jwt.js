/**
 * verifySupabaseJwt — for any FUTURE custom endpoint (Vercel serverless
 * function or Supabase Edge Function) that needs to independently check
 * who's calling it, by reading the Authorization header directly, instead
 * of going through supabase-js (which already does this safely on its
 * own — you do NOT need this file for anything that just uses
 * `supabase.auth.getUser()` or the regular client SDK).
 *
 * Not currently used anywhere in this project. It exists so that IF you
 * add a custom authenticated endpoint later, the three classic JWT bugs
 * below are closed from the start rather than something to remember:
 *
 *   1. "alg: none" — a forged token with header {"alg":"none"} and no
 *      signature at all. A naive verifier that trusts whatever the token
 *      itself claims its algorithm is will happily accept this as valid.
 *      Fixed here by NEVER reading the algorithm from the token — the
 *      allowed algorithm is hardcoded below, and jsonwebtoken.verify()
 *      rejects anything that doesn't match.
 *
 *   2. Algorithm confusion (RS256/HS256 mix-up) — if a server is
 *      configured to accept EITHER RS256 or HS256 and normally verifies
 *      with a public key (for RS256), an attacker can take that same
 *      public key and use it as if it were an HMAC secret to forge an
 *      HS256 token that a loose verifier will accept. Fixed the same
 *      way: only one algorithm is ever accepted, decided by this code,
 *      never by the token.
 *
 *   3. Expiration — jsonwebtoken checks `exp` automatically UNLESS you
 *      explicitly disable it. This helper never disables it, and also
 *      rejects tokens with no `exp` claim at all (a token that can never
 *      expire is its own bug).
 *
 * Setup:
 *   npm install jsonwebtoken
 *
 * Get SUPABASE_JWT_SECRET from: Supabase Dashboard -> Project Settings ->
 * API -> "JWT Settings" -> JWT Secret. Put it in Vercel's environment
 * variables (Settings -> Environment Variables) — never in a committed
 * file. Note: if your project uses Supabase's newer asymmetric signing
 * keys (ES256) instead of the legacy shared secret, check that same
 * dashboard page — it will say which one you're on — and swap ALGORITHM
 * below to 'ES256' with the public key instead. Don't just add both
 * algorithms to be safe; that reopens the exact confusion attack this
 * file exists to prevent.
 *
 * Usage in a Vercel serverless function:
 *
 *   import { verifySupabaseJwt } from '../lib/verifySupabaseJwt.js';
 *
 *   export default async function handler(req, res) {
 *     const authHeader = req.headers.authorization || '';
 *     const token = authHeader.replace(/^Bearer\s+/i, '');
 *
 *     let claims;
 *     try {
 *       claims = verifySupabaseJwt(token);
 *     } catch (err) {
 *       res.status(401).json({ error: 'Invalid or expired token' });
 *       return;
 *     }
 *
 *     // claims.sub is the authenticated user's id — safe to trust now.
 *   }
 */

import jwt from "jsonwebtoken";

const ALGORITHM = "HS256"; // change only after confirming your project's actual signing algorithm — see note above

export function verifySupabaseJwt(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Missing token");
  }

  // The `algorithms` option is the entire defense against both alg:none
  // and algorithm confusion — it is what stops jsonwebtoken from ever
  // trusting the token's own header. Never remove this option, never
  // widen it to more than the one algorithm your project actually uses.
  const claims = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
    algorithms: [ALGORITHM],
  });

  // jwt.verify already enforces `exp` if present — but a token missing
  // the claim entirely wouldn't be rejected by that check alone, since
  // there'd be nothing to compare against. Requiring it explicitly
  // closes that gap: no expiry claim is treated the same as expired.
  if (!claims.exp) {
    throw new Error("Token has no expiration claim");
  }

  return claims;
}

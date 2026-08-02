// supabase/functions/login-guard/index.ts
//
// Deploy with: supabase functions deploy login-guard
//
// Fronts the three login_attempts RPC functions (check_login_lockout,
// record_failed_login, reset_login_attempts) using the service role key,
// which is the ONLY thing allowed to call them (see the grants in
// 20260731000002_login_attempts.sql). This function is the sole path a
// client has to that lockout logic — called from app.js's sign-in flow
// via supabase.functions.invoke('login-guard', { body: { action, email } }).
//
// Actions:
//   { action: 'check',   email }              -> { locked, retryAfterSeconds }
//   { action: 'failure', email }              -> { failedCount, lockedUntil }
//   { action: 'success', email }              -> { ok: true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
    // CORS — needed since this is called directly from the browser.
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
            }
        });
    }

    try {
        const { action, email } = await req.json();

        if (!email || typeof email !== 'string') {
            return json({ error: 'Missing email' }, 400);
        }
        // Basic shape validation — not a full RFC 5322 email regex (not
        // worth the complexity here), just enough to reject obvious
        // garbage before it reaches the database.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return json({ error: 'Invalid email' }, 400);
        }
        const normalizedEmail = email.trim().toLowerCase();

        if (action === 'check') {
            const { data, error } = await supabaseAdmin.rpc('check_login_lockout', { p_email: normalizedEmail });
            if (error) throw error;
            const row = data?.[0];
            return json({ locked: !!row?.locked, retryAfterSeconds: row?.retry_after_seconds || 0 });
        }

        if (action === 'failure') {
            const { data, error } = await supabaseAdmin.rpc('record_failed_login', { p_email: normalizedEmail });
            if (error) throw error;
            const row = data?.[0];
            return json({ failedCount: row?.failed_count, lockedUntil: row?.locked_until });
        }

        if (action === 'success') {
            const { error } = await supabaseAdmin.rpc('reset_login_attempts', { p_email: normalizedEmail });
            if (error) throw error;
            return json({ ok: true });
        }

        return json({ error: 'Unknown action' }, 400);
    } catch (err) {
        console.error('[login-guard] error:', err);
        // Fails CLOSED on the check action would lock everyone out on an
        // outage — but this endpoint's own errors are rare infra issues,
        // not something to design elaborate fallback behavior around.
        // Returning a plain 500 here (rather than "locked: false") is the
        // right call: the CLIENT decides what "check failed" means (see
        // app.js — it lets the sign-in attempt proceed rather than
        // blocking someone from logging in just because this function had
        // a hiccup).
        return json({ error: 'Internal error' }, 500);
    }
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

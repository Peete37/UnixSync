// supabase/functions/send-push/index.ts
//
// Deploy with: supabase functions deploy send-push
//
// Called from app.js as: supabase.functions.invoke('send-push', { body: {
// user_id, title, body, url } }) — the DM-message call site is the one
// concrete example currently wired up (see sendChatMessage in app.js).
// Deliberately fire-and-forget from the caller's side: a failure here
// (no subscription, expired subscription, function not deployed) must
// never block or error out the actual action (sending a message, etc.)
// that triggered it — see the .catch(() => {}) at that call site.
//
// Requires two secrets set on the project before this actually delivers
// anything:
//   supabase secrets set VAPID_PUBLIC_KEY=<the same one hardcoded in app.js>
//   supabase secrets set VAPID_PRIVATE_KEY=<generated together as a pair,
//     e.g. via `npx web-push generate-vapid-keys` — never reuse only half
//     a pair, public/private must come from the same generation>
//
// Uses the service role key to read push_subscriptions directly,
// bypassing RLS — safe here since this function runs server-side only
// and is never exposed to look up arbitrary users' subscriptions from
// the client (same reasoning as login-guard's own admin client above).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7?target=deno';

const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:peetepeete37@gmail.com',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

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

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        // Matches the same "not configured yet" spirit as app.js's own
        // VAPID_PUBLIC_KEY check on the client — a clear, quiet failure
        // rather than a confusing crash, since this is an expected state
        // until the two secrets above are set.
        return json({ error: 'VAPID keys not configured on the server' });
    }

    try {
        const { user_id, title, body, url } = await req.json();

        if (!user_id || typeof user_id !== 'string') {
            return json({ error: 'Missing user_id' }, 400);
        }

        const { data: subs, error } = await supabaseAdmin
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth')
            .eq('user_id', user_id);
        if (error) throw error;

        if (!subs || subs.length === 0) {
            // Not an error — this person just doesn't have push enabled
            // on any device. Same "quiet, expected" outcome as app.js's
            // own catch on the invoke() call.
            return json({ delivered: 0 });
        }

        const notificationPayload = JSON.stringify({
            title: title || 'CampusMarket',
            body: body || '',
            url: url || '/'
        });

        let delivered = 0;
        await Promise.all(
            subs.map(async (sub) => {
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        notificationPayload
                    );
                    delivered++;
                } catch (err: unknown) {
                    // 404/410 means the browser subscription itself is
                    // dead (uninstalled, cleared site data, etc.) — clean
                    // it up so future calls stop retrying a subscription
                    // that will never work again. Any other error
                    // (network blip, etc.) is left alone rather than
                    // deleting a subscription that might still be good.
                    const status = (err as { statusCode?: number })?.statusCode;
                    if (status === 404 || status === 410) {
                        await supabaseAdmin
                            .from('push_subscriptions')
                            .delete()
                            .eq('endpoint', sub.endpoint);
                    }
                }
            })
        );

        return json({ delivered });
    } catch (err) {
        console.error('[send-push] error:', err);
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

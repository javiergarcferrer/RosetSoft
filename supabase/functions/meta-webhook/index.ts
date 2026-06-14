// meta-webhook — Instagram real-time events (comments + mentions).
//
// Meta calls this the instant someone comments on or @-mentions our IG account
// (after the page is subscribed via meta-social `subscribeWebhooks`). We verify
// the handshake, persist each event to `ig_events` with the service role, and
// answer 200 fast — the Studio reads the table for a live activity feed instead
// of polling the Graph API.
//
// Setup (Meta App Dashboard → Webhooks): callback URL = this function's URL,
// verify token = META_WEBHOOK_VERIFY_TOKEN (defaults to 'rosetsoft-ig').

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const VERIFY_TOKEN = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || 'rosetsoft-ig';
const TEAM = 'team';

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verification handshake — echo hub.challenge when the token matches.
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return new Response('ok', { status: 200 });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }> } = {};
  try { body = await req.json(); } catch { /* tolerate empty */ }

  const rows: Array<Record<string, unknown>> = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const field = change.field;
      const v = (change.value || {}) as Record<string, any>;
      if (field === 'comments') {
        rows.push({
          id: crypto.randomUUID(), profile_id: TEAM, kind: 'comment',
          object_id: v.id ? String(v.id) : null,
          media_id: v.media?.id ? String(v.media.id) : null,
          username: v.from?.username ? String(v.from.username) : null,
          text: v.text ? String(v.text).slice(0, 500) : null,
          payload: v, created_at: new Date().toISOString(),
        });
      } else if (field === 'mentions') {
        rows.push({
          id: crypto.randomUUID(), profile_id: TEAM, kind: 'mention',
          object_id: v.comment_id ? String(v.comment_id) : null,
          media_id: v.media_id ? String(v.media_id) : null,
          payload: v, created_at: new Date().toISOString(),
        });
      }
    }
  }
  if (rows.length) {
    try { await admin.from('ig_events').insert(rows); } catch { /* never fail the webhook */ }
  }

  // Always 200 — Meta retries on non-2xx and will disable a flaky endpoint.
  return new Response('ok', { status: 200 });
});

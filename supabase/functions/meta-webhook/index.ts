// meta-webhook — Instagram real-time events (comments + mentions).
//
// Meta calls this the instant someone comments on or @-mentions our IG account
// (after the page is subscribed via meta-social `subscribeWebhooks`). We verify
// the handshake, persist each event to `ig_events` with the service role, and
// answer 200 fast — the Studio reads the table for a live activity feed instead
// of polling the Graph API.
//
// POST payloads are authenticated by the X-Hub-Signature-256 header — an
// HMAC-SHA256 of the raw body with the Meta App Secret, exactly as wa-webhook
// does. With Instagram Login the IG account belongs to its OWN Instagram app
// (meta_social_config.ig_app_secret), which may differ from the WhatsApp app
// (whatsapp_config.app_secret). We accept a signature from EITHER so the feed
// works whether the two share one Meta app or not. No valid signature → 401, so
// nobody who merely knows the URL can inject forged comments/mentions into the
// JARVIS live feed. Without a secret saved we can't authenticate Meta, so
// inbound processing stays off until one is pasted in Configuración.
//
// Setup (Meta App Dashboard → Instagram → Webhooks): callback URL = this
// function's URL, verify token = META_WEBHOOK_VERIFY_TOKEN (default 'rosetsoft-ig').

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const VERIFY_TOKEN = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || 'rosetsoft-ig';
const TEAM = 'team';

/** HMAC-SHA256 verify of the raw body against the App Secret (the twin of
 *  wa-webhook's check — the Deno functions don't share modules, so the rule is
 *  copied verbatim and kept equivalent on purpose). */
async function validSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !header.startsWith('sha256=') || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice('sha256='.length).toLowerCase();
  // Constant-time-ish compare (same length, XOR accumulate).
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

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

  // Authenticate the payload BEFORE trusting (or persisting) any of it. Read the
  // raw bytes (not req.json()) so the HMAC is over exactly what Meta signed.
  // Accept a signature from the Instagram app secret OR the WhatsApp app secret
  // (they may be the same Meta app, or two — see header note).
  const raw = await req.text();
  const sig = req.headers.get('x-hub-signature-256');
  const [{ data: igCfg }, { data: waCfg }] = await Promise.all([
    admin.from('meta_social_config').select('ig_app_secret').eq('profile_id', TEAM).maybeSingle(),
    admin.from('whatsapp_config').select('app_secret').eq('profile_id', TEAM).maybeSingle(),
  ]);
  const igSecret = (igCfg as { ig_app_secret?: string } | null)?.ig_app_secret || '';
  const waSecret = (waCfg as { app_secret?: string } | null)?.app_secret || '';
  const ok = (igSecret && await validSignature(raw, sig, igSecret))
    || (waSecret && await validSignature(raw, sig, waSecret));
  if (!ok) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }> } = {};
  try { body = JSON.parse(raw); } catch { /* tolerate empty */ }

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

// meta-webhook — Instagram real-time events (Direct messages + comments + mentions).
//
// Meta calls this the instant someone DMs, comments on, or @-mentions our IG
// account (after the account is subscribed via meta-social `subscribeWebhooks`).
// We verify the handshake, persist each event with the service role, and answer
// 200 fast:
//   • DIRECT messages (entry[].messaging[]) → `ig_messages` (the CRM Instagram
//     inbox reads the table — webhook-fed, like wa_messages).
//   • comments / mentions (entry[].changes[]) → `ig_events` (the Studio live feed).
//
// POST payloads are authenticated by the X-Hub-Signature-256 header — an
// HMAC-SHA256 of the raw body with the Meta App Secret, exactly as wa-webhook
// does. With Instagram Login the IG account belongs to its OWN Instagram app
// (meta_social_config.ig_app_secret), which may differ from the WhatsApp app
// (whatsapp_config.app_secret). We accept a signature from EITHER so the feed
// works whether the two share one Meta app or not. No valid signature → 401, so
// nobody who merely knows the URL can inject forged events into the JARVIS feed.
// Without a secret saved we can't authenticate Meta, so inbound processing stays
// off until one is pasted in Configuración.
//
// Setup (Meta App Dashboard → Instagram → Webhooks): callback URL = this
// function's URL, verify token = META_WEBHOOK_VERIFY_TOKEN (default 'rosetsoft-ig').

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// The webhook verify token is a shared secret between the Meta App Dashboard and
// this function. It MUST come from the environment — never a hardcoded default,
// which would be publicly guessable and let anyone complete the subscribe
// handshake. Unset ⇒ the handshake fails closed (403) below.
const VERIFY_TOKEN = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || '';
const TEAM = 'team';
const IG_API = 'https://graph.instagram.com/v23.0';

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

/** The renderable text + kind of an inbound Direct message. */
function dmContent(message: Record<string, any>): { kind: string; body: string } {
  if (message?.text) return { kind: 'text', body: String(message.text).slice(0, 1000) };
  const att = (message?.attachments || [])[0];
  const type = String(att?.type || '').toLowerCase();
  if (type === 'image') return { kind: 'image', body: '📷 Imagen' };
  if (type === 'video') return { kind: 'video', body: '🎬 Video' };
  if (type === 'audio') return { kind: 'audio', body: '🎤 Audio' };
  if (type === 'share') return { kind: 'share', body: '↗️ Publicación compartida' };
  if (type === 'story_mention') return { kind: 'story_mention', body: 'Te mencionó en su historia' };
  if (message?.is_deleted) return { kind: 'deleted', body: 'Mensaje eliminado' };
  return { kind: 'unknown', body: '' };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verification handshake — echo hub.challenge when the token matches.
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';
    // Fail closed when no token is configured — never accept a guessable default.
    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
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
  // (they may be the same Meta app, or two — see header note). The same
  // meta_social_config read also gives us our IG id + token for DM enrichment.
  const raw = await req.text();
  const sig = req.headers.get('x-hub-signature-256');
  const [{ data: igCfg }, { data: waCfg }] = await Promise.all([
    admin.from('meta_social_config').select('ig_app_secret, ig_user_id').eq('profile_id', TEAM).maybeSingle(),
    admin.from('whatsapp_config').select('app_secret').eq('profile_id', TEAM).maybeSingle(),
  ]);
  const igSecret = (igCfg as { ig_app_secret?: string } | null)?.ig_app_secret || '';
  const waSecret = (waCfg as { app_secret?: string } | null)?.app_secret || '';
  const ok = (igSecret && await validSignature(raw, sig, igSecret))
    || (waSecret && await validSignature(raw, sig, waSecret));
  if (!ok) {
    return new Response('invalid signature', { status: 401 });
  }

  const igUserId = (igCfg as { ig_user_id?: string } | null)?.ig_user_id || '';

  let body: {
    object?: string;
    entry?: Array<{
      id?: string;
      changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
      messaging?: Array<Record<string, any>>;
    }>;
  } = {};
  try { body = JSON.parse(raw); } catch { /* tolerate empty */ }

  // Inbound DM @-handles are resolved by igBackfill (me/conversations carries the
  // participant usernames), NOT here: a per-message Graph call inside the webhook
  // would serialize N live round-trips into the response and risk Meta disabling
  // the endpoint for slowness. We store the IGSID now; the inbox enriches later.

  const eventRows: Array<Record<string, unknown>> = [];  // ig_events (comments/mentions)
  const dmRows: Array<Record<string, unknown>> = [];     // ig_messages (Direct)

  for (const entry of body.entry || []) {
    // ── Direct messages (Messenger-style messaging array) → ig_messages ──
    for (const ev of entry.messaging || []) {
      const message = (ev?.message || {}) as Record<string, any>;
      const mid = message?.mid ? String(message.mid) : null;
      const senderId = String(ev?.sender?.id || '');
      const recipientId = String(ev?.recipient?.id || '');
      if (!senderId && !recipientId) continue;
      // An echo (is_echo) is a message WE sent (app or IG app) — log it outbound
      // so the inbox shows both sides. The COUNTERPART (thread identity) is
      // whoever isn't our own IG account.
      const isEcho = message?.is_echo === true || senderId === igUserId;
      const counterpart = isEcho ? recipientId : senderId;
      if (!counterpart) continue;
      const { kind, body: text } = dmContent(message);
      const tsMs = Number(ev?.timestamp) || Date.now();
      dmRows.push({
        id: crypto.randomUUID(),
        profile_id: TEAM,
        direction: isEcho ? 'out' : 'in',
        ig_message_id: mid,
        thread_key: counterpart,
        sender_id: senderId || null,
        recipient_id: recipientId || null,
        username: null,
        name: null,
        kind,
        body: text,
        status: isEcho ? 'sent' : 'received',
        payload: ev,
        created_at: new Date(tsMs).toISOString(),
      });
    }

    // ── comments / mentions → ig_events (the Studio live feed) ──
    for (const change of entry.changes || []) {
      const field = change.field;
      const v = (change.value || {}) as Record<string, any>;
      if (field === 'comments') {
        eventRows.push({
          // Deterministic id when Meta gives us the comment id — webhook
          // delivery is at-least-once, so a redelivery collides on the PK and
          // is dropped instead of duplicating the Studio feed.
          id: v.id ? `igev-comment-${String(v.id)}` : crypto.randomUUID(),
          profile_id: TEAM, kind: 'comment',
          object_id: v.id ? String(v.id) : null,
          media_id: v.media?.id ? String(v.media.id) : null,
          username: v.from?.username ? String(v.from.username) : null,
          text: v.text ? String(v.text).slice(0, 500) : null,
          payload: v, created_at: new Date().toISOString(),
        });
      } else if (field === 'mentions') {
        eventRows.push({
          id: v.comment_id ? `igev-mention-${String(v.comment_id)}` : crypto.randomUUID(),
          profile_id: TEAM, kind: 'mention',
          object_id: v.comment_id ? String(v.comment_id) : null,
          media_id: v.media_id ? String(v.media_id) : null,
          payload: v, created_at: new Date().toISOString(),
        });
      }
    }
  }

  // Dedupe DMs on the message id (Meta retries) — the partial unique index backs this.
  if (dmRows.length) {
    try { await admin.from('ig_messages').upsert(dmRows, { onConflict: 'ig_message_id', ignoreDuplicates: true }); }
    catch (e) { console.error('[meta-webhook] dm insert failed:', (e as Error).message); }
  }
  if (eventRows.length) {
    // ignoreDuplicates on the (deterministic) PK — a Meta redelivery no-ops.
    try { await admin.from('ig_events').upsert(eventRows, { onConflict: 'id', ignoreDuplicates: true }); }
    catch { /* never fail the webhook */ }
  }

  // Always 200 — Meta retries on non-2xx and will disable a flaky endpoint.
  return new Response('ok', { status: 200 });
});

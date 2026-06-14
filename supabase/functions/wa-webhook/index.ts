// wa-webhook — Meta's webhook for the WhatsApp Business Cloud API.
//
// Two jobs, both public (Meta calls this, not the browser — verify_jwt must
// be off):
//   GET  — the one-time registration handshake: echo hub.challenge when
//          hub.verify_token matches settings.whatsapp_verify_token.
//   POST — inbound traffic: client messages land in wa_messages (linked to a
//          customer/professional by phone match), and delivery-status updates
//          (sent/delivered/read/failed) update the matching outbound row.
//
// POST payloads are authenticated by the X-Hub-Signature-256 header — an
// HMAC-SHA256 of the raw body with the app's App Secret (whatsapp_config,
// service-role read). No valid signature → 401; without the secret saved we
// can't authenticate Meta, so inbound processing stays off until it's pasted
// in Configuración.
//
// Always answer 2xx once authenticated, even on partial failures — Meta
// retries non-2xx with backoff and eventually disables the webhook.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const TEAM = 'team';
const GRAPH = 'https://graph.facebook.com/v23.0';
const IMAGES_BUCKET = 'images';
// Inbound media above this size is left as a text-only log row (the bucket is
// for chat-sized payloads, not 100MB documents).
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/amr': 'amr', 'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

/** Async delivery-failure codes → dealer-readable Spanish (the sync twin
 *  lives in wa-send's friendlyMetaError — the Deno functions don't share
 *  modules, and the status payload shape differs anyway). */
const STATUS_ERRORS: Record<number, string> = {
  131047: 'No entregado: fuera de la ventana de 24 horas. WhatsApp solo entrega texto libre si el cliente escribió en las últimas 24 h — envía una plantilla aprobada.',
  131026: 'No entregado: el destinatario no puede recibir el mensaje (ventana cerrada, número sin WhatsApp o versión antigua).',
  131048: 'No entregado: Meta limitó el envío a este número por ahora (límites de spam).',
  131049: 'No entregado: Meta limitó la entrega de marketing a este número por ahora.',
  131030: 'No entregado: el número no está en la lista de destinatarios permitidos del número de PRUEBA (Meta → WhatsApp → API Setup → "To").',
};

/** The media reference of an inbound message ({ id, mime }) or null. */
function inboundMedia(msg: Record<string, any>): { id: string; mime: string } | null {
  const m = msg[msg.type as string];
  if (!m || typeof m !== 'object' || !m.id) return null;
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(msg.type)) return null;
  return { id: String(m.id), mime: String(m.mime_type || 'application/octet-stream').split(';')[0] };
}

/** Matching key: the LAST 10 digits (mirrors src/lib/phone.js phoneKey — the
 *  Deno↔Vite wall means we can't import it; the rule is trivial and kept
 *  equivalent on purpose). */
function phoneKey(phone: string | null | undefined): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

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

/** The renderable text of an inbound message, per Meta message type. */
function inboundBody(msg: Record<string, any>): string {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    case 'reaction': return msg.reaction?.emoji || '';
    case 'image': return msg.image?.caption || '';
    case 'video': return msg.video?.caption || '';
    case 'document': return msg.document?.caption || msg.document?.filename || '';
    case 'location': {
      const l = msg.location || {};
      return l.name || (l.latitude != null ? `${l.latitude}, ${l.longitude}` : '');
    }
    case 'contacts': {
      const c = (msg.contacts || [])[0];
      return c?.name?.formatted_name || c?.name?.first_name || 'Contacto';
    }
    case 'order': {
      // A cart the client built from product cards we sent. The renderable
      // detail (items, prices) lives in payload.order — this is just the
      // inbox-list label; the chat bubble reads the full order off payload.
      const n = (msg.order?.product_items || []).length;
      return n ? `🛒 Pedido · ${n} producto(s)` : '🛒 Pedido';
    }
    case 'system': return msg.system?.body || 'Aviso del sistema';
    default: return '';
  }
}

Deno.serve(async (req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return new Response('server not configured', { status: 500 });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── Registration handshake ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';
    const { data } = await admin.from('settings').select('whatsapp_verify_token').eq('profile_id', TEAM).maybeSingle();
    const expected = (data as { whatsapp_verify_token?: string } | null)?.whatsapp_verify_token || '';
    if (mode === 'subscribe' && expected && token === expected) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('verification failed', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  const { data: cfg } = await admin.from('whatsapp_config').select('app_secret, access_token, phone_number_id').eq('profile_id', TEAM).maybeSingle();
  const secret = (cfg as { app_secret?: string } | null)?.app_secret || '';
  const accessToken = (cfg as { access_token?: string } | null)?.access_token || '';
  const phoneNumberId = (cfg as { phone_number_id?: string } | null)?.phone_number_id || '';
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256'), secret))) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: Record<string, any> = {};
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 200 }); }

  // Contact links resolved once per delivery (both tables are small).
  let customers: { id: string; phone: string | null }[] | null = null;
  let professionals: { id: string; phone: string | null }[] | null = null;
  async function linkFor(phone: string): Promise<{ customer_id: string | null; professional_id: string | null }> {
    if (!customers) {
      customers = ((await admin.from('customers').select('id, phone').eq('profile_id', TEAM)).data as typeof customers) || [];
      professionals = ((await admin.from('professionals').select('id, phone').eq('profile_id', TEAM)).data as typeof professionals) || [];
    }
    const key = phoneKey(phone);
    const c = customers!.find((r) => phoneKey(r.phone) === key);
    if (c) return { customer_id: c.id, professional_id: null };
    const p = professionals!.find((r) => phoneKey(r.phone) === key);
    return { customer_id: null, professional_id: p ? p.id : null };
  }

  // Persist a message's media into Storage and stamp the row. Meta's media
  // URL expires minutes after issue, so this runs inside the webhook delivery,
  // not lazily from the UI. Guarded by media_path IS NULL so a Meta retry of
  // an already-processed message doesn't store the bytes twice.
  async function persistMedia(waId: string, media: { id: string; mime: string }): Promise<void> {
    if (!accessToken) return;
    try {
      const metaRes = await fetch(`${GRAPH}/${media.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const meta = await metaRes.json().catch(() => ({}));
      const url = (meta as { url?: string }).url;
      const size = Number((meta as { file_size?: number }).file_size) || 0;
      if (!metaRes.ok || !url || size > MAX_MEDIA_BYTES) return;
      const binRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!binRes.ok) return;
      const bytes = new Uint8Array(await binRes.arrayBuffer());
      const ext = EXT_BY_MIME[media.mime] || 'bin';
      const path = `wa/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await admin.storage.from(IMAGES_BUCKET)
        .upload(path, bytes, { contentType: media.mime, upsert: false });
      if (upErr) { console.error('[wa-webhook] media upload failed:', upErr.message); return; }
      await admin.from('wa_messages')
        .update({ media_path: path, media_mime: media.mime })
        .eq('wa_id', waId).is('media_path', null);
    } catch (e) {
      console.error('[wa-webhook] media persist failed:', (e as Error).message);
    }
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Template status / quality updates → record the latest per template on
        // settings, so Configuración warns the dealer BEFORE a paused/disabled
        // template silently fails their quote sends. These changes carry no
        // messages/statuses, so we record and move on.
        if (change.field === 'message_template_status_update' || change.field === 'message_template_quality_update') {
          const v = value as Record<string, any>;
          const name = v.message_template_name || v.template_name || '';
          if (name) {
            const { data: st } = await admin.from('settings').select('whatsapp_template_status').eq('profile_id', TEAM).maybeSingle();
            const map = ((st as { whatsapp_template_status?: Record<string, any> } | null)?.whatsapp_template_status) || {};
            const next: Record<string, unknown> = { ...(map[name] || {}), at: Date.now() };
            if (change.field === 'message_template_status_update') {
              next.status = String(v.event || v.new_status || '').toUpperCase();
              next.reason = v.reason ? String(v.reason) : null;
            } else {
              next.quality = String(v.new_quality_score || '').toUpperCase();
            }
            map[name] = next;
            const { error } = await admin.from('settings').update({ whatsapp_template_status: map }).eq('profile_id', TEAM);
            if (error) console.error('[wa-webhook] template status update failed:', error.message);

            // On a REJECTION, also persist the durable rejection record so the
            // Difusión panel can show the dealer the exact reason Meta gave (the
            // settings map above is overwritten on the next status event; this
            // upsert keeps the last rejection per template+language). Best-effort:
            // a failure here must never throw out of the webhook (Meta would
            // retry / disable it).
            if (change.field === 'message_template_status_update') {
              const status = String(next.status || '');
              if (status === 'REJECTED') {
                const language = String(v.language || v.message_template_language || '');
                const reason = v.reason ? String(v.reason) : '';
                try {
                  const { error: rejErr } = await admin.from('wa_template_rejections').upsert({
                    id: `${TEAM}:${name}:${language}`,
                    profile_id: TEAM,
                    template_name: name,
                    language,
                    rejected_reason: reason || null,
                    status,
                    updated_at: new Date().toISOString(),
                  }, { onConflict: 'profile_id,template_name,language' });
                  if (rejErr) console.error('[wa-webhook] template rejection upsert failed:', rejErr.message);
                } catch (e) {
                  console.error('[wa-webhook] template rejection persist error:', (e as Error).message);
                }
              }
            }
          }
          continue;
        }

        // Number quality changed → re-fetch the authoritative rating + tier and
        // persist, so the connection card flags a degraded number (which Meta
        // throttles or blocks) promptly instead of only on the next manual test.
        if (change.field === 'phone_number_quality_update') {
          if (accessToken && phoneNumberId) {
            try {
              const r = await fetch(`${GRAPH}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier`, { headers: { Authorization: `Bearer ${accessToken}` } });
              const d = await r.json().catch(() => ({})) as { quality_rating?: string; messaging_limit_tier?: string };
              if (r.ok) {
                await admin.from('settings').update({
                  whatsapp_quality_rating: d.quality_rating || null,
                  whatsapp_messaging_limit: d.messaging_limit_tier || null,
                }).eq('profile_id', TEAM);
              }
            } catch (e) {
              console.error('[wa-webhook] quality refresh failed:', (e as Error).message);
            }
          }
          continue;
        }

        const contacts: Record<string, any>[] = value.contacts || [];

        // Inbound messages → wa_messages (dedupe on wa_id: Meta retries).
        for (const msg of value.messages || []) {
          const phone = String(msg.from || '').replace(/\D/g, '');
          if (!phone) continue;
          const contact = contacts.find((c) => phoneKey(c.wa_id) === phoneKey(phone));
          const link = await linkFor(phone);
          const tsMs = Number(msg.timestamp) ? Number(msg.timestamp) * 1000 : Date.now();
          const { error } = await admin.from('wa_messages').upsert({
            id: crypto.randomUUID(),
            profile_id: TEAM,
            direction: 'in',
            wa_id: msg.id || null,
            phone,
            profile_name: contact?.profile?.name || null,
            ...link,
            kind: msg.type || 'unknown',
            body: inboundBody(msg),
            status: 'received',
            payload: msg,
            created_at: new Date(tsMs).toISOString(),
          }, { onConflict: 'wa_id', ignoreDuplicates: true });
          if (error) console.error('[wa-webhook] inbound insert failed:', error.message);
          const media = inboundMedia(msg);
          if (!error && media && msg.id) await persistMedia(msg.id, media);
        }

        // COEXISTENCE: echoes of messages the team sends from the phone's
        // WhatsApp Business app on the same number — logged as outbound rows
        // so the CRM inbox shows BOTH cockpits' sides of the conversation.
        // Dedupe on wa_id (Meta retries; and our own API sends never echo).
        for (const echo of (value as Record<string, any>).message_echoes || []) {
          const phone = String(echo.to || '').replace(/\D/g, '');
          if (!phone || !echo.id) continue;
          const link = await linkFor(phone);
          const tsMs = Number(echo.timestamp) ? Number(echo.timestamp) * 1000 : Date.now();
          const { error } = await admin.from('wa_messages').upsert({
            id: crypto.randomUUID(),
            profile_id: TEAM,
            direction: 'out',
            wa_id: echo.id,
            phone,
            ...link,
            kind: echo.type || 'text',
            body: inboundBody(echo),
            status: 'sent',
            payload: { ...echo, smbEcho: true },
            created_at: new Date(tsMs).toISOString(),
          }, { onConflict: 'wa_id', ignoreDuplicates: true });
          if (error) console.error('[wa-webhook] echo insert failed:', error.message);
          const echoMedia = inboundMedia(echo);
          if (!error && echoMedia && echo.id) await persistMedia(echo.id, echoMedia);
        }

        // COEXISTENCE: chat-history sync — at onboarding Meta streams up to
        // ~6 months of the phone app's conversations in chunks. Bulk-upsert
        // per thread (dedupe on wa_id) and mark inbound history as READ so
        // months of old chats don't explode the unread badges.
        for (const h of (value as Record<string, any>).history || []) {
          for (const th of h.threads || []) {
            const phone = String(th.id || '').replace(/\D/g, '');
            if (!phone) continue;
            const link = await linkFor(phone);
            const bizKey = phoneKey(value.metadata?.display_phone_number || '');
            const rows = (th.messages || []).filter((m: Record<string, any>) => m?.id).map((m: Record<string, any>) => {
              const fromMe = m.history_context?.from_me === true
                || (bizKey && phoneKey(m.from) === bizKey);
              const tsMs = Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now();
              return {
                id: crypto.randomUUID(),
                profile_id: TEAM,
                direction: fromMe ? 'out' : 'in',
                wa_id: m.id,
                phone,
                ...link,
                kind: m.type || 'text',
                body: inboundBody(m),
                status: fromMe ? 'sent' : 'received',
                read_at: fromMe ? null : new Date().toISOString(),
                payload: { ...m, historySync: true },
                created_at: new Date(tsMs).toISOString(),
              };
            });
            if (!rows.length) continue;
            const { error } = await admin.from('wa_messages')
              .upsert(rows, { onConflict: 'wa_id', ignoreDuplicates: true });
            if (error) console.error('[wa-webhook] history sync insert failed:', error.message);
          }
        }

        // Delivery-status updates → the matching outbound row. The Cloud API
        // ACCEPTS many bad sends (returns a wamid) and only fails them here,
        // asynchronously — most commonly 131047: free-form text outside the
        // 24h window is silently dropped. Translate those codes so the chat
        // bubble tells the dealer WHY the message never arrived.
        for (const st of value.statuses || []) {
          if (!st.id || !st.status) continue;
          const patch: Record<string, unknown> = {
            status: st.status,
            status_at: new Date((Number(st.timestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          };
          const e0 = st.errors?.[0];
          const errMsg = e0
            ? (STATUS_ERRORS[Number(e0.code)] || e0.error_data?.details || e0.message || e0.title)
            : null;
          if (errMsg) patch.error = errMsg;
          // Per-message pricing (2025+ model) rides the status webhook: the
          // billing category + whether Meta charged. Record it for cost reports.
          const pricing = st.pricing as { category?: string; billable?: boolean } | undefined;
          if (pricing) {
            if (pricing.category) patch.pricing_category = String(pricing.category);
            if (typeof pricing.billable === 'boolean') patch.pricing_billable = pricing.billable;
          }
          const { error } = await admin.from('wa_messages').update(patch).eq('wa_id', st.id);
          if (error) console.error('[wa-webhook] status update failed:', error.message);
        }
      }
    }
  } catch (e) {
    // Answer 200 anyway — a parse hiccup must not make Meta disable the webhook.
    console.error('[wa-webhook] processing error:', (e as Error).message);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

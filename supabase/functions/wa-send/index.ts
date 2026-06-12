// wa-send — outbound WhatsApp via the Meta Cloud API.
//
// Called by a signed-in team member (Settings connection test, the quote
// editor's "Enviar por WhatsApp", the CRM inbox composer, the Difusión
// campaign sender). It reads the Meta credentials from the write-only
// whatsapp_config table via the service role (the access token never reaches
// the browser), calls the Graph API, and logs every outbound message into
// wa_messages so the inbox thread shows it.
//
// Body shapes (one per request):
//   { test: true }                                  → verify token + number id
//   { listTemplates: true }                         → WABA's message templates
//   { createTemplate: {...} }                       → submit a template for review
//   { deleteTemplate: { name } }                    → delete a template by name
//   { markRead: { messageId, typing? } }            → read receipt (+ typing)
//   { to, text, customerId?, professionalId?, quoteId? }            → free text
//   { to, template, params?, lang?, customerId?, … }                → template
//   { to, media: { base64, mime, filename?, caption? }, … }         → media
//   { broadcast: { name, template, lang, recipients, audience? } }  → campaign
//
// Free-form text/media only delivers inside Meta's 24h customer-service
// window; outside it the API answers re-engagement error 131047 — translated
// below to a message the dealer can act on (send a template instead).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const GRAPH = 'https://graph.facebook.com/v23.0';
const TEAM = 'team';
const IMAGES_BUCKET = 'images';
// One broadcast call caps its audience; the client chunks larger sends. Keeps
// a campaign comfortably inside the function's wall-clock budget.
const MAX_BROADCAST = 300;

type Recipient = { to?: string; params?: string[]; customerId?: string | null; professionalId?: string | null };
type SendBody = {
  test?: boolean;
  listTemplates?: boolean;
  createTemplate?: {
    name?: string; category?: string; language?: string;
    headerText?: string; bodyText?: string; footerText?: string;
    exampleParams?: string[];
    // Optional URL button: Meta appends the button's {{1}} variable to
    // buttonUrlBase — how a quote template carries a tappable "Ver cotización"
    // instead of a bare link in the body.
    buttonText?: string; buttonUrlBase?: string;
  };
  deleteTemplate?: { name?: string };
  markRead?: { messageId?: string; typing?: boolean };
  getBusinessProfile?: boolean;
  setBusinessProfile?: {
    about?: string; address?: string; description?: string; email?: string;
    vertical?: string; websites?: string[];
  };
  /** Browse the WABA's connected Commerce catalog (paged; optional name search). */
  listCatalog?: { q?: string; after?: string };
  /** Send product(s) from the connected catalog — 1 item ⇒ single-product
   *  message, 2+ ⇒ product_list. `names` ride along only for our chat log. */
  products?: { items?: string[]; names?: string[]; text?: string };
  broadcast?: { name?: string; template?: string; lang?: string; audience?: string; recipients?: Recipient[] };
  to?: string;
  text?: string;
  template?: string;
  params?: string[];
  /** Fills a template URL button's {{1}} (the path suffix Meta appends). */
  buttonParams?: string[];
  lang?: string;
  media?: { base64?: string; mime?: string; filename?: string; caption?: string };
  /** wamid of the message being replied to (WhatsApp's quoted-reply context). */
  replyTo?: string;
  /** React to a message: empty emoji removes the reaction. */
  reaction?: { messageId?: string; emoji?: string };
  /** Free-form interactive message (24h window rules apply): quick-reply
   *  buttons, a list menu (≤10 rows behind one button), or a CTA-URL button. */
  interactive?: {
    text?: string;
    buttons?: string[];
    list?: { button?: string; rows?: { title?: string; description?: string }[] };
    cta?: { displayText?: string; url?: string };
  };
  /** Location pin the client can open in Maps (free-form — 24h window). */
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  /** Contact card (vCard) the client can save (free-form — 24h window). */
  contact?: { name?: string; phone?: string; org?: string };
  customerId?: string | null;
  professionalId?: string | null;
  quoteId?: string | null;
  campaignId?: string | null;
};

/** Meta error code → dealer-readable Spanish. Falls back to Meta's message. */
function friendlyMetaError(code: number | undefined, message: string): string {
  switch (code) {
    case 190:
      return 'El token de acceso expiró o fue revocado. Genera un token PERMANENTE (System User en Business Manager) y pégalo de nuevo en Configuración.';
    case 131030:
      return 'Este número no está en la lista de destinatarios permitidos del número de PRUEBA. Agrégalo en Meta → WhatsApp → API Setup → "To" → Manage phone number list (máx. 5).';
    case 131047:
    case 131026:
      return 'Fuera de la ventana de 24 horas: WhatsApp solo permite iniciar conversación con una PLANTILLA aprobada. Envía la plantilla o espera a que el cliente escriba.';
    case 132001:
      return 'La plantilla no existe (o no en ese idioma) en tu cuenta de WhatsApp. Revisa el nombre exacto en Plantillas (Difusión) o en Meta → WhatsApp Manager.';
    case 131048:
    case 131049:
      return 'Meta limitó el envío de marketing a este número por ahora (límites de spam / experiencia del usuario). Intenta más tarde.';
    case 100:
      return `Meta rechazó la petición: ${message}. Revisa que el Phone Number ID sea el ID (no el número) y que el token tenga permiso whatsapp_business_messaging.`;
    default:
      return message;
  }
}

function metaError(data: unknown, status: number): string {
  const err = (data as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error;
  return friendlyMetaError(err?.code, err?.error_data?.details || err?.message || `HTTP ${status}`);
}

/** image/* | video/* | audio/* → that type; everything else ships as document. */
function waMediaKind(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (/^image\/(jpeg|png|webp)/.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'document';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);

  // The anon key passes the gateway's verify_jwt (it's a valid JWT) — require
  // a real signed-in team member before touching the Meta token.
  const authClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: auth } = await authClient.auth.getUser();
  if (!auth?.user) return json({ error: 'No autorizado.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: cfg } = await admin
    .from('whatsapp_config').select('access_token, phone_number_id, waba_id, app_secret').eq('profile_id', TEAM).maybeSingle();
  const token = (cfg as { access_token?: string } | null)?.access_token;
  const phoneNumberId = (cfg as { phone_number_id?: string } | null)?.phone_number_id;
  const appSecret = (cfg as { app_secret?: string } | null)?.app_secret || '';
  // A WABA id is a long numeric Meta id — but the field has been hand-pasted
  // with emails/phone numbers before. Treat a non-numeric value as ABSENT so
  // every wabaId consumer gives its clear "missing WABA" guidance instead of
  // a cryptic Graph error, and the connection check below can heal it.
  const wabaRaw = (cfg as { waba_id?: string } | null)?.waba_id || '';
  let wabaId = /^\d{10,20}$/.test(wabaRaw) ? wabaRaw : '';
  if (!token || !phoneNumberId) return json({ configured: false, message: 'WhatsApp no conectado' });

  let body: SendBody = {};
  try { body = await req.json(); } catch { /* empty body falls through to validation */ }

  const graphHeaders = { Authorization: `Bearer ${token}` };
  const graphJson = { ...graphHeaders, 'Content-Type': 'application/json' };

  // ── Connection check ───────────────────────────────────────────────────────
  if (body.test === true) {
    const r = await fetch(`${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { headers: graphHeaders });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ configured: true, ok: false, error: metaError(data, r.status) }, 502);
    const d = data as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
    // Resolve the app (and, if needed, the WABA) from the token itself —
    // debug_token carries the app that minted it plus the WABAs a System
    // User token manages. The healed WABA id persists so templates /
    // Difusión work on the next request too.
    const dbg = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: graphHeaders });
    const dd = await dbg.json().catch(() => ({})) as
      { data?: { app_id?: string; granular_scopes?: { scope?: string; target_ids?: string[] }[] } };
    const appId = String(dd.data?.app_id || '');
    if (!wabaId) {
      const ids = (dd.data?.granular_scopes || [])
        .find((s) => s.scope === 'whatsapp_business_management')?.target_ids || [];
      if (ids.length) {
        wabaId = String(ids[0]);
        await admin.from('whatsapp_config').update({ waba_id: wabaId }).eq('profile_id', TEAM);
      }
    }

    // Webhooks only flow when BOTH halves are wired, so the connection check
    // ensures both (idempotent) instead of trusting portal clicks:
    //   1. APP level — the callback URL registered AND the `messages` field
    //      subscribed. Verifying the URL in the portal alone subscribes NO
    //      fields, and a missed toggle means Meta delivers nothing (the
    //      observed failure: handshake 200 logged, zero POSTs ever after).
    //      POST /{app-id}/subscriptions does both in one call, using the app
    //      token (app_id|app_secret); Meta re-verifies our GET handshake
    //      inline against settings.whatsapp_verify_token.
    //   2. WABA level — the app subscribed to this account's events.
    let webhookSubscribed = false;
    let webhookError: string | null = null;
    if (!wabaId) {
      webhookError = wabaRaw
        ? `El WhatsApp Business Account ID guardado ("${wabaRaw}") no es válido — es el código numérico largo que aparece en Meta → WhatsApp → API Setup. Pégalo de nuevo en Configuración → WhatsApp.`
        : 'Falta el WhatsApp Business Account ID (WABA): sin él no se puede activar la recepción de mensajes. Pégalo en Configuración → WhatsApp.';
    } else if (!appSecret) {
      webhookError = 'Falta el App Secret (Meta → tu app → App settings → Basic): sin él no se puede activar ni autenticar la recepción de mensajes.';
    } else if (!appId) {
      webhookError = 'No se pudo identificar la app de Meta desde el token. Genera el token desde el System User de la app correcta y vuelve a guardarlo.';
    } else {
      const { data: st } = await admin.from('settings').select('whatsapp_verify_token').eq('profile_id', TEAM).maybeSingle();
      const verifyToken = (st as { whatsapp_verify_token?: string } | null)?.whatsapp_verify_token || '';
      const appSub = await fetch(`${GRAPH}/${appId}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          object: 'whatsapp_business_account',
          callback_url: `${SUPABASE_URL}/functions/v1/wa-webhook`,
          verify_token: verifyToken,
          fields: 'messages',
          access_token: `${appId}|${appSecret}`,
        }),
      });
      const appSubData = await appSub.json().catch(() => ({}));
      const appSubOk = appSub.ok && !!(appSubData as { success?: boolean }).success;
      const wabaSub = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, { method: 'POST', headers: graphHeaders });
      const wabaSubData = await wabaSub.json().catch(() => ({}));
      const wabaSubOk = wabaSub.ok && !!(wabaSubData as { success?: boolean }).success;
      webhookSubscribed = appSubOk && wabaSubOk;
      if (!appSubOk) webhookError = metaError(appSubData, appSub.status);
      else if (!wabaSubOk) webhookError = metaError(wabaSubData, wabaSub.status);
    }
    await admin.from('settings').update({
      whatsapp_display_number: d.display_phone_number || '',
      whatsapp_verified_name: d.verified_name || '',
    }).eq('profile_id', TEAM);
    return json({
      configured: true, ok: true,
      displayNumber: d.display_phone_number, verifiedName: d.verified_name, quality: d.quality_rating,
      webhookSubscribed, webhookError,
    });
  }

  // ── Business profile (what clients see when they open the chat) ──────────
  if (body.getBusinessProfile) {
    const r = await fetch(
      `${GRAPH}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,vertical,websites`,
      { headers: graphHeaders },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, error: metaError(data, r.status) }, 502);
    return json({ ok: true, profile: (data as { data?: unknown[] }).data?.[0] || {} });
  }
  if (body.setBusinessProfile) {
    const p = body.setBusinessProfile;
    const payload: Record<string, unknown> = { messaging_product: 'whatsapp' };
    for (const k of ['about', 'address', 'description', 'email', 'vertical'] as const) {
      if (typeof p[k] === 'string') payload[k] = p[k];
    }
    if (Array.isArray(p.websites)) payload.websites = p.websites.map((w) => String(w || '').trim()).filter(Boolean).slice(0, 2);
    const r = await fetch(`${GRAPH}/${phoneNumberId}/whatsapp_business_profile`, {
      method: 'POST', headers: graphJson, body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[wa-send] setBusinessProfile failed:', JSON.stringify(data));
      return json({ ok: false, error: metaError(data, r.status) }, 502);
    }
    return json({ ok: true });
  }

  // ── Commerce catalog (the WABA's connected Meta catalog) ─────────────────
  // The catalog id is resolved fresh per request — one cheap Graph call, no
  // state to go stale when the team reconnects a different catalog.
  async function connectedCatalogId(): Promise<{ id: string | null; error: string | null }> {
    if (!wabaId) return { id: null, error: 'Falta el WhatsApp Business Account ID (WABA).' };
    const r = await fetch(`${GRAPH}/${wabaId}/product_catalogs?fields=id,name`, { headers: graphHeaders });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { id: null, error: metaError(data, r.status) };
    const id = (data as { data?: { id?: string }[] }).data?.[0]?.id || null;
    return {
      id,
      error: id ? null : 'La cuenta de WhatsApp no tiene un catálogo conectado. Conéctalo en Meta → WhatsApp Manager → Catálogo.',
    };
  }

  if (body.listCatalog) {
    const cat = await connectedCatalogId();
    if (!cat.id) return json({ ok: false, error: cat.error }, 502);
    const q = String(body.listCatalog.q || '').trim();
    const after = String(body.listCatalog.after || '').trim();
    const params = new URLSearchParams({
      fields: 'retailer_id,name,description,price,image_url,availability',
      limit: '24',
    });
    if (q) params.set('filter', JSON.stringify({ name: { i_contains: q } }));
    if (after) params.set('after', after);
    const r = await fetch(`${GRAPH}/${cat.id}/products?${params}`, { headers: graphHeaders });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[wa-send] listCatalog failed:', JSON.stringify(data));
      return json({ ok: false, error: metaError(data, r.status) }, 502);
    }
    const d = data as {
      data?: { retailer_id?: string; name?: string; description?: string; price?: string; image_url?: string; availability?: string }[];
      paging?: { cursors?: { after?: string }; next?: string };
    };
    return json({
      ok: true,
      products: (d.data || []).map((p) => ({
        retailerId: p.retailer_id || '',
        name: p.name || '',
        description: p.description || '',
        price: p.price || '',
        imageUrl: p.image_url || '',
        availability: p.availability || '',
      })).filter((p) => p.retailerId),
      after: d.paging?.next ? (d.paging?.cursors?.after || '') : '',
    });
  }

  // ── Template management (needs the WABA id) ───────────────────────────────
  if (body.listTemplates || body.createTemplate || body.deleteTemplate) {
    if (!wabaId) {
      return json({
        ok: false, needWaba: true,
        error: 'Falta el WhatsApp Business Account ID (WABA). Pégalo en Configuración → WhatsApp (Meta → WhatsApp → API Setup, "WhatsApp Business Account ID").',
      }, 400);
    }

    if (body.listTemplates) {
      const r = await fetch(
        `${GRAPH}/${wabaId}/message_templates?fields=name,status,category,language,components,quality_score&limit=200`,
        { headers: graphHeaders },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[wa-send] listTemplates failed:', JSON.stringify(data));
        return json({ ok: false, error: metaError(data, r.status) }, 502);
      }
      type RawTpl = {
        name?: string; status?: string; category?: string; language?: string;
        components?: { type?: string; text?: string; format?: string; buttons?: { type?: string; text?: string; url?: string }[] }[];
        quality_score?: { score?: string };
      };
      const templates = (((data as { data?: RawTpl[] }).data) || []).map((t) => {
        const find = (type: string) => (t.components || []).find((c) => (c.type || '').toUpperCase() === type);
        const bodyText = find('BODY')?.text || '';
        // {{1}}, {{2}}… in the body — how many parameters a send must supply.
        const varCount = new Set([...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
        // A URL button whose url carries {{1}} takes the link as its SUFFIX
        // (buttonParams in a send) — the quote-template picker keys on this.
        const urlBtn = (find('BUTTONS')?.buttons || []).find((b) => (b.type || '').toUpperCase() === 'URL');
        return {
          name: t.name || '',
          status: (t.status || '').toUpperCase(),
          category: (t.category || '').toUpperCase(),
          language: t.language || '',
          headerText: find('HEADER')?.format === 'TEXT' ? (find('HEADER')?.text || '') : '',
          bodyText,
          footerText: find('FOOTER')?.text || '',
          varCount,
          buttonText: urlBtn?.text || '',
          buttonUrlVar: !!urlBtn && /\{\{1\}\}/.test(urlBtn.url || ''),
          quality: t.quality_score?.score || null,
        };
      });
      return json({ ok: true, templates });
    }

    if (body.createTemplate) {
      const t = body.createTemplate;
      const name = String(t.name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      const bodyText = String(t.bodyText || '').trim();
      if (!name) return json({ ok: false, error: 'Falta el nombre de la plantilla (minúsculas, números y _).' }, 400);
      if (!bodyText) return json({ ok: false, error: 'Falta el texto del cuerpo de la plantilla.' }, 400);
      const category = ['MARKETING', 'UTILITY'].includes(String(t.category || '').toUpperCase())
        ? String(t.category).toUpperCase() : 'MARKETING';
      const language = String(t.language || 'es').trim() || 'es';
      const vars = new Set([...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]));
      // Meta requires example values when the body carries variables.
      const example = vars.size
        ? { body_text: [Array.from({ length: vars.size }, (_, i) => String((t.exampleParams || [])[i] || `Ejemplo ${i + 1}`))] }
        : undefined;
      const components: Record<string, unknown>[] = [];
      if (String(t.headerText || '').trim()) {
        components.push({ type: 'HEADER', format: 'TEXT', text: String(t.headerText).trim() });
      }
      components.push({ type: 'BODY', text: bodyText, ...(example ? { example } : {}) });
      if (String(t.footerText || '').trim()) {
        components.push({ type: 'FOOTER', text: String(t.footerText).trim() });
      }
      // Optional URL button — Meta appends the {{1}} suffix to buttonUrlBase
      // at send time. Reviewers need a filled-in sample URL.
      const btnText = String(t.buttonText || '').trim();
      const btnUrlBase = String(t.buttonUrlBase || '').trim();
      if (btnText && btnUrlBase) {
        components.push({
          type: 'BUTTONS',
          buttons: [{
            type: 'URL',
            text: btnText.slice(0, 25),
            url: `${btnUrlBase}{{1}}`,
            example: [`${btnUrlBase}cliente-cotizacion-1001/a1b2c3d4`],
          }],
        });
      }
      const r = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
        method: 'POST', headers: graphJson,
        body: JSON.stringify({ name, language, category, components }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[wa-send] createTemplate failed:', JSON.stringify(data));
        return json({ ok: false, error: metaError(data, r.status) }, 502);
      }
      const d = data as { id?: string; status?: string };
      return json({ ok: true, id: d.id || null, status: (d.status || 'PENDING').toUpperCase(), name });
    }

    // deleteTemplate
    const name = String(body.deleteTemplate?.name || '').trim();
    if (!name) return json({ ok: false, error: 'Falta el nombre de la plantilla a eliminar.' }, 400);
    const r = await fetch(`${GRAPH}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: graphHeaders,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[wa-send] deleteTemplate failed:', JSON.stringify(data));
      return json({ ok: false, error: metaError(data, r.status) }, 502);
    }
    return json({ ok: true });
  }

  // ── Read receipt (+ optional typing indicator) on an inbound message ──────
  if (body.markRead) {
    const messageId = String(body.markRead.messageId || '');
    if (!messageId) return json({ ok: false, error: 'Falta el messageId.' }, 400);
    const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: 'POST', headers: graphJson,
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        ...(body.markRead.typing ? { typing_indicator: { type: 'text' } } : {}),
      }),
    });
    // Best-effort: an expired wamid is normal (old threads) — report, don't 5xx.
    const data = await r.json().catch(() => ({}));
    return json({ ok: r.ok, ...(r.ok ? {} : { error: metaError(data, r.status) }) });
  }

  // ── The send-and-log core (single sends and broadcast share it) ───────────
  type SendSpec = {
    to: string;
    payload: Record<string, unknown>;
    logKind: string;
    logBody: string;
    /** Extra structure the thread renders from (quoted-reply context, the
     *  reaction target, interactive buttons) — same column wa-webhook fills
     *  for inbound, so resolveThread reads one shape for both directions. */
    logPayload?: Record<string, unknown> | null;
    templateName?: string | null;
    mediaPath?: string | null;
    mediaMime?: string | null;
    customerId?: string | null;
    professionalId?: string | null;
    quoteId?: string | null;
    campaignId?: string | null;
  };
  async function sendOne(spec: SendSpec): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: 'POST', headers: graphJson, body: JSON.stringify(spec.payload),
    });
    const data = await r.json().catch(() => ({}));
    const waId = (data as { messages?: { id?: string }[] }).messages?.[0]?.id || null;
    const ok = r.ok && !!waId;
    const errorMsg = ok ? null : metaError(data, r.status);
    // Log the attempt either way — a failed send is part of the conversation's
    // truth (the inbox shows it with the reason instead of silently dropping it).
    const { error: insErr } = await admin.from('wa_messages').insert({
      id: crypto.randomUUID(),
      profile_id: TEAM,
      direction: 'out',
      wa_id: waId,
      phone: spec.to,
      customer_id: spec.customerId || null,
      professional_id: spec.professionalId || null,
      quote_id: spec.quoteId || null,
      campaign_id: spec.campaignId || null,
      kind: spec.logKind,
      body: spec.logBody,
      template_name: spec.templateName || null,
      media_path: spec.mediaPath || null,
      media_mime: spec.mediaMime || null,
      payload: spec.logPayload || null,
      status: ok ? 'accepted' : 'failed',
      error: errorMsg,
      created_at: new Date().toISOString(),
    });
    if (insErr) console.error('[wa-send] log insert failed:', insErr.message);
    return { ok, id: waId, error: errorMsg };
  }

  function templatePayload(
    to: string, template: string, lang: string | undefined,
    params: string[] | undefined, buttonParams?: string[],
  ): Record<string, unknown> {
    const components: Record<string, unknown>[] = [];
    if (Array.isArray(params) && params.length) {
      components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) });
    }
    // Dynamic URL button: the param fills the {{1}} suffix Meta appends to
    // the URL registered on the template's button.
    if (Array.isArray(buttonParams) && buttonParams.length) {
      components.push({
        type: 'button', sub_type: 'url', index: '0',
        parameters: buttonParams.map((p) => ({ type: 'text', text: String(p) })),
      });
    }
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: lang || 'es' },
        ...(components.length ? { components } : {}),
      },
    };
  }

  // ── Broadcast: one approved template → many recipients (a campaign) ───────
  if (body.broadcast) {
    const b = body.broadcast;
    const template = String(b.template || '').trim();
    if (!template) return json({ ok: false, error: 'Falta la plantilla de la campaña.' }, 400);
    const recipients = (Array.isArray(b.recipients) ? b.recipients : [])
      .map((r) => ({ ...r, to: String(r.to || '').replace(/\D/g, '') }))
      .filter((r) => r.to);
    if (!recipients.length) return json({ ok: false, error: 'La campaña no tiene destinatarios.' }, 400);
    if (recipients.length > MAX_BROADCAST) {
      return json({ ok: false, error: `Máximo ${MAX_BROADCAST} destinatarios por envío.` }, 400);
    }

    const campaignId = crypto.randomUUID();
    await admin.from('wa_campaigns').insert({
      id: campaignId,
      profile_id: TEAM,
      name: String(b.name || '').trim() || template,
      template_name: template,
      template_lang: b.lang || 'es',
      audience: String(b.audience || ''),
      recipient_count: recipients.length,
      created_at: new Date().toISOString(),
    });

    let sent = 0;
    let failed = 0;
    const errors: { to: string; error: string }[] = [];
    for (const rcp of recipients) {
      const res = await sendOne({
        to: rcp.to,
        payload: templatePayload(rcp.to, template, b.lang, rcp.params),
        logKind: 'template',
        logBody: Array.isArray(rcp.params) ? rcp.params.join(' · ') : '',
        templateName: template,
        customerId: rcp.customerId || null,
        professionalId: rcp.professionalId || null,
        campaignId,
      });
      if (res.ok) sent += 1;
      else {
        failed += 1;
        if (errors.length < 10 && res.error) errors.push({ to: rcp.to, error: res.error });
      }
    }
    await admin.from('wa_campaigns').update({
      sent_count: sent, failed_count: failed, updated_at: new Date().toISOString(),
    }).eq('id', campaignId);
    return json({ ok: failed < recipients.length, campaignId, sent, failed, errors });
  }

  // ── Single sends ───────────────────────────────────────────────────────────
  const to = String(body.to || '').replace(/\D/g, '');
  if (!to) return json({ ok: false, error: 'Falta el número de destino.' }, 400);
  const replyTo = String(body.replyTo || '').trim();
  const contextPart = replyTo ? { context: { message_id: replyTo } } : {};
  const contextLog = replyTo ? { context: { id: replyTo } } : null;

  // React to a message (their bubble shows the emoji; empty emoji removes it).
  if (body.reaction) {
    const messageId = String(body.reaction.messageId || '').trim();
    const emoji = String(body.reaction.emoji ?? '');
    if (!messageId) return json({ ok: false, error: 'Falta el mensaje al que reaccionar.' }, 400);
    const res = await sendOne({
      to,
      payload: { messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id: messageId, emoji } },
      logKind: 'reaction',
      logBody: emoji,
      // Same shape wa-webhook stores for inbound reactions, so resolveThread
      // folds ours onto the target bubble identically.
      logPayload: { reaction: { message_id: messageId, emoji } },
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  // Free-form interactive (24h window rules apply): quick-reply buttons, a
  // list menu, or a CTA-URL button. One Graph payload shape per sub-type; the
  // log payload mirrors what the client saw so the thread renders it.
  if (body.interactive) {
    const text = String(body.interactive.text || '').trim();
    if (!text) return json({ ok: false, error: 'Falta el texto del mensaje.' }, 400);
    let inner: Record<string, unknown>;
    let logInteractive: Record<string, unknown>;
    if (body.interactive.cta) {
      const displayText = String(body.interactive.cta.displayText || '').trim().slice(0, 20);
      const url = String(body.interactive.cta.url || '').trim();
      if (!displayText || !/^https?:\/\//i.test(url)) {
        return json({ ok: false, error: 'Faltan el texto del botón o un enlace válido (https://…).' }, 400);
      }
      inner = { type: 'cta_url', body: { text }, action: { name: 'cta_url', parameters: { display_text: displayText, url } } };
      logInteractive = { text, cta: { displayText, url } };
    } else if (body.interactive.list) {
      const button = String(body.interactive.list.button || '').trim().slice(0, 20) || 'Ver opciones';
      const rows = (Array.isArray(body.interactive.list.rows) ? body.interactive.list.rows : [])
        .map((r, i) => {
          const description = String(r?.description || '').trim().slice(0, 72);
          return {
            id: `ls_${i + 1}`,
            title: String(r?.title || '').trim().slice(0, 24),
            ...(description ? { description } : {}),
          };
        })
        .filter((r) => r.title)
        .slice(0, 10);
      if (!rows.length) return json({ ok: false, error: 'Agrega al menos una opción a la lista.' }, 400);
      inner = { type: 'list', body: { text }, action: { button, sections: [{ rows }] } };
      logInteractive = { text, listButton: button, rows: rows.map((r) => r.title) };
    } else {
      const titles = (Array.isArray(body.interactive.buttons) ? body.interactive.buttons : [])
        .map((t) => String(t || '').trim().slice(0, 20)).filter(Boolean).slice(0, 3);
      if (!titles.length) return json({ ok: false, error: 'Faltan el texto o los botones de respuesta.' }, 400);
      inner = {
        type: 'button',
        body: { text },
        action: { buttons: titles.map((t, i) => ({ type: 'reply', reply: { id: `qr_${i + 1}`, title: t } })) },
      };
      logInteractive = { text, buttons: titles };
    }
    const res = await sendOne({
      to,
      payload: { messaging_product: 'whatsapp', to, type: 'interactive', ...contextPart, interactive: inner },
      logKind: 'interactive',
      logBody: text,
      logPayload: { ...(contextLog || {}), interactive: logInteractive },
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

<<<<<<< HEAD
  // Location pin.
  if (body.location) {
    const lat = Number(body.location.latitude);
    const lng = Number(body.location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ ok: false, error: 'Faltan las coordenadas.' }, 400);
    const name = String(body.location.name || '').trim();
    const address = String(body.location.address || '').trim();
    const res = await sendOne({
      to,
      payload: {
        messaging_product: 'whatsapp', to, type: 'location', ...contextPart,
        location: { latitude: lat, longitude: lng, ...(name ? { name } : {}), ...(address ? { address } : {}) },
      },
      logKind: 'location',
      logBody: name || address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      logPayload: { ...(contextLog || {}), location: { latitude: lat, longitude: lng, name, address } },
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  // Contact card (vCard).
  if (body.contact) {
    const cName = String(body.contact.name || '').trim();
    const cPhone = String(body.contact.phone || '').replace(/[^\d+]/g, '');
    if (!cName || !cPhone) return json({ ok: false, error: 'Faltan el nombre o el teléfono del contacto.' }, 400);
    const org = String(body.contact.org || '').trim();
    const res = await sendOne({
      to,
      payload: {
        messaging_product: 'whatsapp', to, type: 'contacts', ...contextPart,
        contacts: [{
          name: { formatted_name: cName, first_name: cName.split(/\s+/)[0] },
          phones: [{ phone: cPhone, type: 'CELL', wa_id: cPhone.replace(/\D/g, '') }],
          ...(org ? { org: { company: org } } : {}),
        }],
      },
      logKind: 'contacts',
      logBody: cName,
      logPayload: { ...(contextLog || {}), contact: { name: cName, phone: cPhone, org } },
=======
  // Product message(s) from the connected Commerce catalog. One item sends a
  // single-product card; several send a product_list (one section). Free-form
  // interactive — same 24h window rule as text.
  if (body.products) {
    const items = (Array.isArray(body.products.items) ? body.products.items : [])
      .map((i) => String(i || '').trim()).filter(Boolean).slice(0, 30);
    if (!items.length) return json({ ok: false, error: 'Faltan los productos a enviar.' }, 400);
    const names = (Array.isArray(body.products.names) ? body.products.names : [])
      .map((n) => String(n || '').trim());
    const text = String(body.products.text || '').trim();
    const cat = await connectedCatalogId();
    if (!cat.id) return json({ ok: false, error: cat.error }, 502);
    const interactive = items.length === 1
      ? {
          type: 'product',
          ...(text ? { body: { text } } : {}),
          action: { catalog_id: cat.id, product_retailer_id: items[0] },
        }
      : {
          type: 'product_list',
          header: { type: 'text', text: 'Selección de productos' },
          body: { text: text || 'Mira esta selección de nuestro catálogo.' },
          action: {
            catalog_id: cat.id,
            sections: [{ title: 'Productos', product_items: items.map((id) => ({ product_retailer_id: id })) }],
          },
        };
    const res = await sendOne({
      to,
      payload: { messaging_product: 'whatsapp', to, type: 'interactive', interactive, ...contextPart },
      logKind: 'product',
      logBody: text || names.filter(Boolean).join(' · ') || `${items.length} producto(s)`,
      logPayload: { ...(contextLog || {}), products: { items, names } },
>>>>>>> a0fae5a (feat(whatsapp): sell from the chat — Commerce catalog product messages)
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  if (body.media) {
    const mime = String(body.media.mime || '').split(';')[0].trim();
    const b64 = String(body.media.base64 || '');
    if (!mime || !b64) return json({ ok: false, error: 'Falta el archivo (base64 + mime).' }, 400);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return json({ ok: false, error: 'El archivo no es base64 válido.' }, 400);
    }
    const kind = waMediaKind(mime);
    const filename = String(body.media.filename || '').trim() || `archivo.${EXT_BY_MIME[mime] || 'bin'}`;
    const caption = String(body.media.caption || '').trim();

    // 1. Upload to Meta (multipart) → media id.
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([bytes], { type: mime }), filename);
    const up = await fetch(`${GRAPH}/${phoneNumberId}/media`, { method: 'POST', headers: graphHeaders, body: form });
    const upData = await up.json().catch(() => ({}));
    const mediaId = (upData as { id?: string }).id;
    if (!up.ok || !mediaId) return json({ ok: false, error: metaError(upData, up.status) }, 502);

    // 2. Mirror into Storage so our own chat renders the media we sent.
    let mediaPath: string | null = null;
    {
      const path = `wa/${crypto.randomUUID()}.${EXT_BY_MIME[mime] || 'bin'}`;
      const { error: upErr } = await admin.storage.from(IMAGES_BUCKET)
        .upload(path, bytes, { contentType: mime, upsert: false });
      if (!upErr) mediaPath = path;
      else console.error('[wa-send] media mirror failed:', upErr.message);
    }

    // 3. Send by media id.
    const mediaObj: Record<string, unknown> = { id: mediaId };
    if (caption && kind !== 'audio') mediaObj.caption = caption;
    if (kind === 'document') mediaObj.filename = filename;
    const res = await sendOne({
      to,
      payload: { messaging_product: 'whatsapp', to, type: kind, [kind]: mediaObj, ...contextPart },
      logKind: kind,
      logBody: caption || (kind === 'document' ? filename : ''),
      logPayload: contextLog,
      mediaPath,
      mediaMime: mime,
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  if (body.template) {
    const res = await sendOne({
      to,
      payload: templatePayload(to, body.template, body.lang, body.params, body.buttonParams),
      logKind: 'template',
      logBody: Array.isArray(body.params) ? body.params.join(' · ') : '',
      templateName: body.template,
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
      campaignId: body.campaignId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  if (typeof body.text === 'string' && body.text.trim()) {
    const logBody = body.text.trim();
    const res = await sendOne({
      to,
      payload: { messaging_product: 'whatsapp', to, type: 'text', text: { body: logBody, preview_url: true }, ...contextPart },
      logKind: 'text',
      logBody,
      logPayload: contextLog,
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  return json({ ok: false, error: 'Falta el mensaje (text), la plantilla (template) o el archivo (media).' }, 400);
});

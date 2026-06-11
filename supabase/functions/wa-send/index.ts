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
  };
  deleteTemplate?: { name?: string };
  markRead?: { messageId?: string; typing?: boolean };
  broadcast?: { name?: string; template?: string; lang?: string; audience?: string; recipients?: Recipient[] };
  to?: string;
  text?: string;
  template?: string;
  params?: string[];
  lang?: string;
  media?: { base64?: string; mime?: string; filename?: string; caption?: string };
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
  'video/mp4': 'mp4', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
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
    .from('whatsapp_config').select('access_token, phone_number_id, waba_id').eq('profile_id', TEAM).maybeSingle();
  const token = (cfg as { access_token?: string } | null)?.access_token;
  const phoneNumberId = (cfg as { phone_number_id?: string } | null)?.phone_number_id;
  const wabaId = (cfg as { waba_id?: string } | null)?.waba_id || '';
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
    await admin.from('settings').update({
      whatsapp_display_number: d.display_phone_number || '',
      whatsapp_verified_name: d.verified_name || '',
    }).eq('profile_id', TEAM);
    return json({ configured: true, ok: true, displayNumber: d.display_phone_number, verifiedName: d.verified_name, quality: d.quality_rating });
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
      if (!r.ok) return json({ ok: false, error: metaError(data, r.status) }, 502);
      type RawTpl = {
        name?: string; status?: string; category?: string; language?: string;
        components?: { type?: string; text?: string; format?: string }[];
        quality_score?: { score?: string };
      };
      const templates = (((data as { data?: RawTpl[] }).data) || []).map((t) => {
        const find = (type: string) => (t.components || []).find((c) => (c.type || '').toUpperCase() === type);
        const bodyText = find('BODY')?.text || '';
        // {{1}}, {{2}}… in the body — how many parameters a send must supply.
        const varCount = new Set([...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
        return {
          name: t.name || '',
          status: (t.status || '').toUpperCase(),
          category: (t.category || '').toUpperCase(),
          language: t.language || '',
          headerText: find('HEADER')?.format === 'TEXT' ? (find('HEADER')?.text || '') : '',
          bodyText,
          footerText: find('FOOTER')?.text || '',
          varCount,
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
      const r = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
        method: 'POST', headers: graphJson,
        body: JSON.stringify({ name, language, category, components }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: metaError(data, r.status) }, 502);
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
    if (!r.ok) return json({ ok: false, error: metaError(data, r.status) }, 502);
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
      status: ok ? 'accepted' : 'failed',
      error: errorMsg,
      created_at: new Date().toISOString(),
    });
    if (insErr) console.error('[wa-send] log insert failed:', insErr.message);
    return { ok, id: waId, error: errorMsg };
  }

  function templatePayload(to: string, template: string, lang: string | undefined, params: string[] | undefined): Record<string, unknown> {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: lang || 'es' },
        ...(Array.isArray(params) && params.length
          ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] }
          : {}),
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
      payload: { messaging_product: 'whatsapp', to, type: kind, [kind]: mediaObj },
      logKind: kind,
      logBody: caption || (kind === 'document' ? filename : ''),
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
      payload: templatePayload(to, body.template, body.lang, body.params),
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
      payload: { messaging_product: 'whatsapp', to, type: 'text', text: { body: logBody, preview_url: true } },
      logKind: 'text',
      logBody,
      customerId: body.customerId || null,
      professionalId: body.professionalId || null,
      quoteId: body.quoteId || null,
    });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, id: res.id });
  }

  return json({ ok: false, error: 'Falta el mensaje (text), la plantilla (template) o el archivo (media).' }, 400);
});

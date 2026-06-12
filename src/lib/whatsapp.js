// Client helpers for the WhatsApp Business (Cloud API) integration.
//
// Mirrors the Shopify pattern (lib/shopifySync.js): the Meta credentials are
// saved through a SECURITY DEFINER RPC into the WRITE-ONLY whatsapp_config
// table (the browser never reads them back) and used server-side by the
// `wa-send` Edge Function. Inbound traffic arrives via the public `wa-webhook`
// function (Meta → Supabase, HMAC-verified). Only non-sensitive status
// (connected-at, display number, verify token) lands on `settings` for the UI.

import { supabase } from '../db/supabaseClient.js';
import { updateSettings, db, newId } from '../db/database.js';
import { waDigits } from './phone.js';

const TEAM_PROFILE_ID = 'team';

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';

/** The callback URL to paste into Meta → WhatsApp → Configuración → Webhook. */
export function waWebhookUrl() {
  return `${SUPABASE_URL}/functions/v1/wa-webhook`;
}

/**
 * Save (or update) the WhatsApp connection. Credentials go to the write-only
 * whatsapp_config table via `save_whatsapp_config`, which MERGES: an empty
 * field means "keep what's saved", so re-pasting one value (a fresh token)
 * never blanks the others. Only the very first connect requires the token +
 * Phone Number ID. The webhook verify token is minted once (it's a handshake
 * string Meta echoes back, not a secret) and lands on settings together with
 * connected-at so the UI can show state without ever reading the token back.
 */
export async function saveWhatsappConfig({ accessToken, phoneNumberId, wabaId, appSecret, settings, profileId = TEAM_PROFILE_ID }) {
  const connected = !!settings?.whatsappConnectedAt;
  const token = String(accessToken || '').trim();
  if (!token && !connected) throw new Error('Pega el token de acceso (empieza con "EAA…"). Meta → tu app → WhatsApp → API Setup.');
  const phoneId = String(phoneNumberId || '').trim();
  if (!phoneId && !connected) throw new Error('Pega el Phone Number ID (Meta → WhatsApp → API Setup, debajo del número).');
  // The classic wrong paste: the phone NUMBER instead of its ID. The ID is a
  // long numeric Meta identifier; a "+", spaces, or a 10/11-digit NANP shape
  // means the dealer copied the number itself.
  if (phoneId && (!/^\d{10,20}$/.test(phoneId) || /^1?8(09|29|49)\d{7}$/.test(phoneId))) {
    throw new Error('Eso parece el número de teléfono, no el Phone Number ID. El ID es el código numérico largo que aparece DEBAJO del número en Meta → WhatsApp → API Setup.');
  }
  const waba = String(wabaId || '').trim();
  // Same wrong-paste guard as the Phone Number ID: the WABA id is a long
  // numeric Meta identifier — an email or a phone number here used to save
  // fine and then break webhook subscription with a cryptic Graph error.
  if (waba && !/^\d{10,20}$/.test(waba)) {
    throw new Error('Eso no parece el WhatsApp Business Account ID — es el código numérico largo que aparece en Meta → WhatsApp → API Setup (no un correo ni un número de teléfono).');
  }
  const secret = String(appSecret || '').trim();
  if (secret && !/^[0-9a-f]{32}$/i.test(secret)) {
    throw new Error('El App Secret es un código de 32 caracteres hexadecimales (Meta → tu app → App settings → Basic → App Secret → Show).');
  }
  if (connected && !token && !phoneId && !waba && !secret) {
    throw new Error('No hay nada que actualizar — los campos vacíos conservan lo guardado.');
  }

  const { error } = await supabase.rpc('save_whatsapp_config', {
    p_access_token: token, p_phone_number_id: phoneId, p_waba_id: waba, p_app_secret: secret,
  });
  if (error) throw new Error(error.message || 'No se pudo guardar la conexión con WhatsApp.');

  // Mint the webhook verify token once; keep it stable across re-saves so a
  // webhook already registered in the Meta portal doesn't break.
  const verifyToken = settings?.whatsappVerifyToken || newVerifyToken();
  await updateSettings(profileId, { whatsappConnectedAt: Date.now(), whatsappVerifyToken: verifyToken });
}

function newVerifyToken() {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/**
 * Invoke the `wa-send` Edge Function and return its JSON body. Non-2xx
 * responses carry the real reason in a JSON body; supabase-js hides it behind
 * a generic message, so read it back (same recovery as invokeShopify).
 */
async function invokeWaSend(body) {
  const { data, error } = await supabase.functions.invoke('wa-send', { body });
  if (!error) return data;
  const ctx = error.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return await ctx.json(); } catch { /* not a JSON body — fall through */ }
  }
  throw new Error(error.message || 'No se pudo contactar con WhatsApp.');
}

/**
 * Verify the saved connection against the Graph API. Returns
 * { configured:false } when nothing is saved, { ok:true, displayNumber,
 * verifiedName, quality } when the token reaches the number, or
 * { ok:false, error } when Meta rejects it.
 */
export async function pingWhatsapp() {
  return invokeWaSend({ test: true });
}

/**
 * Send a free-form text message. Only delivers inside the 24h customer-service
 * window (the recipient wrote within the last 24h); outside it Meta rejects
 * with re-engagement error 131047 — `wa-send` translates that to a clear
 * Spanish message. `replyTo` (a wamid) sends it as a quoted reply. Returns
 * { ok, id } or { ok:false, error }.
 */
export async function sendWhatsappText({ to, text, replyTo, customerId, professionalId, quoteId }) {
  return invokeWaSend({ to: waDigits(to), text, replyTo, customerId, professionalId, quoteId });
}

/**
 * Send a pre-approved template message (the only way to INITIATE a
 * conversation). `params` fill the template's {{1}}, {{2}}… body variables;
 * `buttonParams` fill a URL button's {{1}} suffix (the part Meta appends to
 * the URL registered on the template).
 */
export async function sendWhatsappTemplate({ to, template, params, buttonParams, lang, customerId, professionalId, quoteId }) {
  return invokeWaSend({ to: waDigits(to), template, params, buttonParams, lang, customerId, professionalId, quoteId });
}

/**
 * React to a message (the emoji decorates their bubble, like in the phone
 * app). An empty emoji removes the reaction. `messageId` is the target wamid.
 */
export async function sendWhatsappReaction({ to, messageId, emoji, customerId, professionalId, quoteId }) {
  return invokeWaSend({ to: waDigits(to), reaction: { messageId, emoji: emoji || '' }, customerId, professionalId, quoteId });
}

/**
 * Send a quick-reply buttons message: body text + up to 3 tappable replies
 * (e.g. "Me interesa" / "Tengo preguntas"). Free-form interactive — same 24h
 * window rule as text. The client's tap arrives as a normal inbound message
 * carrying the button title.
 */
export async function sendWhatsappInteractive({ to, text, buttons, replyTo, customerId, professionalId, quoteId }) {
  return invokeWaSend({ to: waDigits(to), interactive: { text, buttons }, replyTo, customerId, professionalId, quoteId });
}

/** Read the number's public business profile (about, address, email, web…). */
export async function getWaBusinessProfile() {
  return invokeWaSend({ getBusinessProfile: true });
}

/** Update the number's public business profile. Only the passed fields change. */
export async function saveWaBusinessProfile(profile) {
  return invokeWaSend({ setBusinessProfile: profile });
}

/**
 * Send a media message (image / video / audio / any file as document). Same
 * 24h-window rule as free text. `file` is a browser File/Blob — it rides to
 * `wa-send` as base64, which uploads it to Meta AND mirrors it into Storage so
 * the chat renders what was sent. Returns { ok, id } or { ok:false, error }.
 */
export async function sendWhatsappMedia({ to, file, caption, replyTo, customerId, professionalId, quoteId }) {
  if (!file) return { ok: false, error: 'Falta el archivo.' };
  if (file.size > 24 * 1024 * 1024) return { ok: false, error: 'El archivo supera el límite de 24 MB.' };
  const base64 = await blobToBase64(file);
  return invokeWaSend({
    to: waDigits(to),
    media: { base64, mime: file.type || 'application/octet-stream', filename: file.name || '', caption: caption || '' },
    replyTo, customerId, professionalId, quoteId,
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // result = "data:<mime>;base64,<payload>" — strip the prefix.
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * List the WABA's message templates (name, status, category, language, body
 * text, variable count). Live from Meta — the picker and the Difusión page
 * always show the current approval state. { ok, templates } or
 * { ok:false, error, needWaba? }.
 */
export async function listWaTemplates() {
  return invokeWaSend({ listTemplates: true });
}

/**
 * Submit a new template for Meta review. Body text carries {{1}}, {{2}}…
 * variables; `exampleParams` give Meta reviewers a filled-in sample (required
 * when variables are present — wa-send defaults them if omitted). Approval is
 * asynchronous: the template lands as PENDING and flips to APPROVED/REJECTED
 * in the list. Categories: MARKETING (promos — the "ads" lever) or UTILITY.
 * `buttonText` + `buttonUrlBase` add a tappable URL button whose link is
 * buttonUrlBase + a {{1}} suffix filled at send time (the quote-link button).
 */
export async function createWaTemplate({ name, category, language, headerText, bodyText, footerText, exampleParams, buttonText, buttonUrlBase }) {
  return invokeWaSend({ createTemplate: { name, category, language, headerText, bodyText, footerText, exampleParams, buttonText, buttonUrlBase } });
}

/** Delete a template by name (all its languages). */
export async function deleteWaTemplate(name) {
  return invokeWaSend({ deleteTemplate: { name } });
}

/**
 * Send the customer-side read receipt (their ticks turn blue) for the thread's
 * latest inbound message. Fire-and-forget from the chat view — an expired
 * wamid on an old thread is normal and not worth surfacing.
 */
export async function sendWhatsappReadReceipt(messageId) {
  if (!messageId) return { ok: false };
  return invokeWaSend({ markRead: { messageId } }).catch(() => ({ ok: false }));
}

/**
 * Show "escribiendo…" on the customer's side (Meta auto-expires it after ~25s
 * or when the message lands). The API addresses typing through the read
 * receipt of an inbound message, so this rides the latest inbound wamid.
 * Fire-and-forget like the read receipt.
 */
export async function sendWhatsappTyping(messageId) {
  if (!messageId) return { ok: false };
  return invokeWaSend({ markRead: { messageId, typing: true } }).catch(() => ({ ok: false }));
}

/**
 * Send one approved template to many recipients as a named campaign
 * (Difusión). `recipients` = [{ to, params?, customerId?, professionalId? }].
 * The server creates the wa_campaigns row, sends sequentially, logs each
 * attempt into wa_messages (campaign-tagged) and returns
 * { ok, campaignId, sent, failed, errors }.
 */
export async function sendWhatsappBroadcast({ name, template, lang, audience, recipients }) {
  return invokeWaSend({ broadcast: { name, template, lang, audience, recipients } });
}

/**
 * Resolve a wa/<uuid> Storage path into an object URL the chat can render
 * (img/video/audio src or download link). Goes through the authenticated
 * Storage download like every other image in the app; the caller owns the
 * object URL lifecycle (revoke on unmount).
 */
export async function fetchWaMediaUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from('images').download(path);
  if (error || !data) return null;
  return URL.createObjectURL(data);
}

/**
 * Send a quote's public client link over the business number. Uses the
 * approved template picked in Settings so it works outside the 24h window;
 * with no template configured it falls back to free-form text (24h window
 * only). Two template shapes, told apart by the metadata the picker stored:
 *   • body-variable — {{1}} in the body carries the full link.
 *   • URL button    — the link rides the button's {{1}} as the share-path
 *     suffix (everything after `/#/q/`); the body's {{1}}, if any, gets the
 *     client's first name.
 */
export async function sendQuoteLink({ to, url, settings, customer, quoteId }) {
  const template = (settings?.whatsappQuoteTemplate || '').trim();
  const name = (customer?.name || '').trim().split(/\s+/)[0];
  if (template) {
    const lang = (settings?.whatsappQuoteTemplateLang || '').trim() || 'es';
    if (settings?.whatsappQuoteTemplateButton) {
      const suffix = url.split('/#/q/')[1] || url;
      const varCount = Number(settings?.whatsappQuoteTemplateVars) || 0;
      return sendWhatsappTemplate({
        to, template, lang,
        params: varCount > 0 ? [name || 'cliente'] : [],
        buttonParams: [suffix],
        customerId: customer?.id, quoteId,
      });
    }
    return sendWhatsappTemplate({ to, template, lang, params: [url], customerId: customer?.id, quoteId });
  }
  const text = `Hola${name ? ` ${name}` : ''}, aquí está su cotización de ${settings?.companyName || 'ALCOVER'}: ${url}`;
  return sendWhatsappText({ to, text, customerId: customer?.id, quoteId });
}

/**
 * Send the quote's PDF as a WhatsApp document from the business number. The
 * blob comes from the same generator Exportar uses (the caller builds it), so
 * what lands in the chat is byte-for-byte the exported file; wa-send uploads
 * it to Meta, mirrors it into Storage for our own thread, and logs it tagged
 * with the quote. Documents are free-form media — they only deliver inside
 * the 24h customer-service window (the link path covers outside it via the
 * approved template).
 */
export async function sendQuotePdf({ to, blob, filename, customer, quoteId }) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  return sendWhatsappMedia({ to, file, customerId: customer?.id, quoteId });
}

/**
 * Mark a thread's inbound messages as read (the unread badge source). Fire and
 * forget from the chat view; failures only delay the badge.
 */
export async function markThreadRead(messages) {
  const unread = (messages || []).filter((m) => m.direction === 'in' && !m.readAt);
  const now = Date.now();
  await Promise.all(unread.map((m) => db.waMessages.update(m.id, { readAt: now })));
}

/**
 * Optimistic outbound row for the chat view (the server writes the durable
 * one; this renders instantly while wa-send round-trips).
 */
export function draftOutboundMessage({ phone, text, customerId, professionalId, profileId = TEAM_PROFILE_ID }) {
  return {
    id: newId(),
    profileId,
    direction: 'out',
    phone: waDigits(phone),
    customerId: customerId || null,
    professionalId: professionalId || null,
    kind: 'text',
    body: text,
    status: 'sending',
    createdAt: Date.now(),
  };
}

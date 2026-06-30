// Gmail inbox client Model — the CRM email surface's writes.
//
// The heavy lifting lives elsewhere: OAuth + the gmailSync pull are in
// lib/google.js (the google-api client), and the inbox READS straight off
// db.gmailMessages in the View. This module adds only the inbox-local
// mutations — marking a thread read and re-filing it under a brand — plus the
// "open in Gmail" / "create gasto" link builders the View hangs off a thread.
//
// No core imports (architecture wall): the deep-link takes plain values, so the
// View can pass amounts the ViewModel parsed without this module reaching into
// either core.

import { db, invalidate } from '../db/database.js';
import { syncGmail, gmailReply, gmailAttachment } from './google.js';

// Re-exported so the inbox imports its whole Model surface from one place.
export { syncGmail };

/**
 * Flatten a rich-HTML signature into plain text for the email's text/plain
 * alternative (what text-only clients show) — line/block boundaries become
 * newlines, tags are stripped and entities decoded.
 */
export function gmailSignatureToText(html) {
  const s = String(html || '');
  if (!s.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    // Non-DOM env (tests/SSR): a crude but safe strip.
    return s
      .replace(/<br\s*\/?>(?=)/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  // DOMParser does NOT load remote resources (images) for text extraction.
  const doc = new DOMParser().parseFromString(s, 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, h5, h6').forEach((el) => el.append('\n'));
  return (doc.body?.textContent || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip a self-authored signature's HTML of anything executable before we render
 * it inside the app (the live preview in settings / the composer). The signature
 * is the dealer's own content, but we still drop <script>/<style>, inline event
 * handlers and javascript: URLs so a bad paste can't run in our DOM. The RAW
 * html is what we SEND — email clients sandbox it themselves.
 */
export function sanitizeSignatureHtml(html) {
  const s = String(html || '');
  if (!s.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    return s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  }
  const doc = new DOMParser().parseFromString(s, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(String(attr.value || ''))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body?.innerHTML || '';
}

/**
 * A branded starter signature in the app's aesthetic (Lausanne, ink + muted
 * grey, brand-blue contact line, wordmark), matching the dealer's letterhead
 * block. Pre-filled from the company's real data (name, RNC, address, phone,
 * website) when available so "Plantilla" lands their exact signature ready to
 * edit; blanks fall back to obvious placeholders. `lang` swaps the role line and
 * placeholder copy.
 */
export function defaultSignatureHtml(lang = 'es', {
  company = 'ALCOVER', name = '', title = '', rnc = '', address = '', phone = '', website = '',
} = {}) {
  const en = lang === 'en';
  const co = String(company || 'ALCOVER').trim();
  const nm = String(name || '').trim() || (en ? 'Full Name' : 'Nombre Apellido');
  const role = String(title || '').trim() || (en ? 'President' : 'Presidente');
  const id = String(rnc || '').trim() || '0-00-00000-0';
  const addr = String(address || '').trim() || (en ? '000 Street' : 'C/ Dirección 000');
  const tel = String(phone || '').trim() || '+1 000 000 0000';
  const site = String(website || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '') || 'alcover.do';
  const wordmark = co.toUpperCase();
  const e = escapeForHtml;
  return [
    '<div style="font-family:Lausanne,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b1b;font-size:13px;line-height:1.45">',
    `<div style="font-weight:700;font-size:15px">${e(nm)}</div>`,
    `<div style="font-weight:700;margin-bottom:12px">${e(role)}</div>`,
    `<div style="color:#8a8a8a">${e(co)} S.R.L. RNC: ${e(id)}</div>`,
    `<div style="color:#8a8a8a">${e(addr)}</div>`,
    `<div style="color:#8a8a8a;margin-bottom:12px"><span style="color:#2563eb;font-weight:700">M</span> ${e(tel)} &nbsp;/&nbsp; <a href="https://${e(site)}" style="color:#2563eb;text-decoration:none">${e(site)}</a></div>`,
    `<div style="font-weight:800;letter-spacing:.04em;font-size:22px;color:#111">${e(wordmark)}</div>`,
    '</div>',
  ].join('');
}

/** Escape a plain string for safe interpolation into HTML. */
function escapeForHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Assemble a reply email from the typed plain-text body + the chosen signature
 * HTML. Returns `{ html, text }`: the HTML wraps the body in the app's Lausanne
 * type (newlines → <br>) and appends the signature; the text alternative is the
 * body plus the signature flattened to text. Both go to gmailReply (multipart).
 */
export function buildReplyContent({ body = '', signatureHtml = '' } = {}) {
  const sig = String(signatureHtml || '').trim();
  const bodyHtml = escapeForHtml(body).replace(/\r?\n/g, '<br>');
  const html =
    '<div style="font-family:Lausanne,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
    + 'font-size:14px;line-height:1.55;color:#1b1b1b">'
    + bodyHtml
    + (sig ? `<br><br>${sig}` : '')
    + '</div>';
  const text = sig ? `${body}\n\n${gmailSignatureToText(sig)}` : body;
  return { html, text };
}

/**
 * Send a reply into a thread, then pull it back so it appears in the reading
 * pane. `messageId`/`threadId` come from the message being replied to; `text`
 * is the composed body (signature already folded in by the View). The sync is
 * best-effort — the send already succeeded — and we invalidate either way so
 * the next poll/refresh reconciles.
 */
export async function sendGmailReply({ to, cc, subject, text, html, fromName, messageId, threadId }) {
  const res = await gmailReply({ to, cc, subject, text, html, fromName, messageId, threadId });
  try { await syncGmail(); } catch { /* the reply is sent; the inbox catches up on next sync */ }
  invalidate();
  return res;
}

/** Can this MIME type be previewed inline (image or PDF)? Everything else downloads. */
export function isPreviewable(mimeType) {
  const t = String(mimeType || '').toLowerCase();
  return t.startsWith('image/') || t === 'application/pdf';
}

/** A standard-base64 string → Blob of the given type (browser-side, no fetch). */
function base64ToBlob(base64, mimeType) {
  const bin = atob(String(base64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

/**
 * Load one attachment's bytes (on demand) and hand back a Blob + an object URL
 * the View can drop into an <img>/<iframe> or a download link. The caller owns
 * the URL and must URL.revokeObjectURL it when the preview closes.
 *
 *   loadGmailAttachment(messageId, { attachmentId, mimeType, filename })
 *     → { blob, url, mimeType, filename }
 */
export async function loadGmailAttachment(messageId, attachment) {
  const att = attachment || {};
  const { base64 } = await gmailAttachment({ messageId, attachmentId: att.attachmentId });
  const blob = base64ToBlob(base64, att.mimeType);
  return { blob, url: URL.createObjectURL(blob), mimeType: att.mimeType || blob.type, filename: att.filename || 'archivo' };
}

/** Open a message/thread in Gmail's web UI (new tab). */
export function gmailWebUrl(message) {
  const id = message?.threadId || message?.id;
  return id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}` : 'https://mail.google.com/';
}

/**
 * A deep-link to the accounting "nuevo gasto" editor, prefilled (best-effort)
 * from an invoice email. This is a URL the View navigates to — NOT a code import
 * — so the CRM inbox never reaches into the Accounting core. The editor reads
 * whatever query params it understands and ignores the rest.
 */
export function expenseDeepLink({ proveedor = '', monto = '', fecha = '', concepto = '' } = {}) {
  const p = new URLSearchParams();
  if (proveedor) p.set('proveedor', proveedor);
  if (monto) p.set('monto', String(monto));
  if (fecha) p.set('fecha', fecha);
  if (concepto) p.set('concepto', concepto);
  const qs = p.toString();
  return `/accounting/compras-gastos/nuevo${qs ? `?${qs}` : ''}`;
}

/** Mark every unread inbound message in a thread as read (local read state). */
export async function markGmailThreadRead(messages) {
  const unread = (messages || []).filter((m) => m.direction === 'in' && !m.isRead);
  if (!unread.length) return;
  await Promise.all(unread.map((m) => db.gmailMessages.update(m.id, { isRead: true }).catch(() => {})));
  invalidate();
}

/**
 * Re-file a whole thread under a brand — a manual override written onto every
 * message in the thread (pass null/'' to clear it and fall back to the rules).
 */
export async function setGmailThreadBrand(messages, brand) {
  const rows = messages || [];
  if (!rows.length) return;
  const value = brand || null;
  await Promise.all(rows.map((m) => db.gmailMessages.update(m.id, { brand: value }).catch(() => {})));
  invalidate();
}

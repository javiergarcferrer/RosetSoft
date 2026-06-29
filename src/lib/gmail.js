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

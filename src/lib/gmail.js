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
import { syncGmail } from './google.js';

// Re-exported so the inbox imports its whole Model surface from one place.
export { syncGmail };

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

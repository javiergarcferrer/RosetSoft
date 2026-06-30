// ViewModel for the Gmail inbox (the CRM email surface).
//
// Pure projections over gmail_messages — no React, no db. The View fetches the
// stored mail (synced server-side by the google-api `gmailSync` action), calls
// these in useMemo, and renders. Two derivations the inbox is built around:
//
//   • BRAND categorization — each thread is filed under Ligne Roset /
//     LifestyleGarden / Otros by matching the counterpart's email against a
//     rule list (sender domain → brand). A per-message manual override
//     (gmail_messages.brand) always wins, so the dealer can re-file a thread.
//   • INVOICE detection — a message that reads like a bill AND carries a
//     document (or whose attachment names an invoice) feeds the Facturas tab.
//
// Nothing here reaches into the Accounting core — the invoice tab is a filtered
// view; turning one into a gasto is a navigation deep-link the View builds, so
// the CRM↔Accounting wall (tests/architecture.test.js) stays intact.

import { BRAND_LIGNE_ROSET, BRAND_LIFESTYLEGARDEN, BRAND_NAMES } from '../../../lib/constants.ts';

/** The catch-all bucket for mail that matches no brand rule. */
export const GMAIL_BRAND_OTHER = 'otros';

/**
 * Default sender→brand rules. A message is filed under the FIRST rule whose
 * `match` substring appears in the sender's email (so a domain or a full
 * address both work). Order matters — put the most specific matches first.
 */
export const DEFAULT_GMAIL_BRAND_RULES = [
  { match: 'ligne-roset', brand: BRAND_LIGNE_ROSET },
  { match: 'ligneroset', brand: BRAND_LIGNE_ROSET },
  { match: 'roset', brand: BRAND_LIGNE_ROSET },
  { match: 'lifestylegarden', brand: BRAND_LIFESTYLEGARDEN },
  { match: 'alcoversrl', brand: BRAND_LIFESTYLEGARDEN },
];

/** The inbox's top-level tabs, in display order (the Facturas tab is separate). */
export const GMAIL_BRAND_TABS = [
  { id: BRAND_LIGNE_ROSET, label: BRAND_NAMES[BRAND_LIGNE_ROSET] || 'Ligne Roset' },
  { id: BRAND_LIFESTYLEGARDEN, label: BRAND_NAMES[BRAND_LIFESTYLEGARDEN] || 'LifestyleGarden' },
  { id: GMAIL_BRAND_OTHER, label: 'Otros' },
];

/** The domain part of an email address ('' when there's no @). */
export function senderDomain(email) {
  const s = String(email || '').toLowerCase();
  const at = s.indexOf('@');
  return at >= 0 ? s.slice(at + 1) : '';
}

/**
 * The brand a single message belongs to. A manual override (message.brand) wins;
 * otherwise the first matching rule against the sender email; otherwise 'otros'.
 */
export function classifyBrand(message, rules = DEFAULT_GMAIL_BRAND_RULES) {
  if (message?.brand) return message.brand;
  const hay = String(message?.fromEmail || '').toLowerCase();
  if (hay) {
    for (const r of rules || []) {
      if (r?.match && hay.includes(String(r.match).toLowerCase())) return r.brand;
    }
  }
  return GMAIL_BRAND_OTHER;
}

// Reads like a bill (subject/snippet/attachment name) …
const INVOICE_RE = /\b(factura|facturaci[oó]n|invoice|recibo|receipt|nota de cr[eé]dito|statement|estado de cuenta|cobro|pago|payment)\b/i;
// … and carries a document (invoices arrive as PDF/XML attachments here).
const INVOICE_FILE_RE = /\.(pdf|xml)$/i;

/**
 * Whether a message belongs in the Facturas tab. True when it both reads like an
 * invoice and carries an attachment, or when an attachment's own filename names
 * an invoice (a "Factura-001.pdf" with a terse covering note still counts).
 */
export function isInvoiceEmail(message) {
  if (!message) return false;
  const attachments = message.attachments || [];
  const text = `${message.subject || ''} ${message.snippet || ''}`;
  const readsLikeInvoice = INVOICE_RE.test(text);
  if (readsLikeInvoice && message.hasAttachment) return true;
  return attachments.some((a) => INVOICE_FILE_RE.test(a?.filename || '') && INVOICE_RE.test(a?.filename || ''));
}

const _MONEY_RE = /(US\$|RD\$|EUR|USD|DOP|€|\$)\s?([0-9][0-9.,]{0,15})|([0-9][0-9.,]{0,15})\s?(USD|DOP|EUR)/gi;
function _currency(tok) {
  const t = String(tok || '').toUpperCase();
  if (t === 'RD$' || t === 'DOP') return 'DOP';
  if (t === '€' || t === 'EUR') return 'EUR';
  return 'USD';
}
function _amount(raw) {
  const n = Number(String(raw || '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Best-effort amount on an invoice email — the LARGEST money figure found in the
 * subject/snippet/body (the total usually dominates the line items). Returns
 * `{ amount, currency }` or null; purely cosmetic (a hint in the Facturas list),
 * never posted to the books.
 */
export function parseInvoiceAmount(message) {
  const body = `${message?.subject || ''} ${message?.snippet || ''} ${message?.bodyText || ''}`;
  let best = null;
  let m;
  const re = new RegExp(_MONEY_RE);
  while ((m = re.exec(body))) {
    const sym = m[1] || m[4] || '$';
    const amt = _amount(m[2] || m[3]);
    if (amt > 0 && (!best || amt > best.amount)) best = { amount: amt, currency: _currency(sym) };
  }
  return best;
}

/**
 * Group the message log into a thread list, newest-activity first.
 *
 *   resolveGmailThreads(messages, { needle, rules, now })
 *     → [{ threadId, subject, fromName, fromEmail, snippet, brand, lastAt,
 *          lastDirection, count, unread, hasInvoice }]
 *
 * Threads group by Gmail's `threadId`. A thread's brand follows its latest
 * INBOUND counterpart (so our own replies don't re-file it), unless any message
 * carries a manual override. `needle` filters by subject / sender / snippet.
 * The View filters the returned rows by the active brand tab.
 */
export function resolveGmailThreads(messages, { needle = '', rules = DEFAULT_GMAIL_BRAND_RULES } = {}) {
  const threads = new Map();
  for (const m of messages || []) {
    const key = m.threadId || m.id;
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        threadId: key, subject: '', fromName: '', fromEmail: '', snippet: '',
        lastAt: 0, lastDirection: null, count: 0, unread: 0, hasInvoice: false,
        brand: GMAIL_BRAND_OTHER, _msgs: [],
      };
      threads.set(key, t);
    }
    t.count += 1;
    t._msgs.push(m);
    if (m.direction === 'in' && !m.isRead) t.unread += 1;
    if (isInvoiceEmail(m)) t.hasInvoice = true;
    const at = m.receivedAt || m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.subject = m.subject || t.subject;
      t.fromName = m.fromName || '';
      t.fromEmail = m.fromEmail || '';
      t.snippet = m.snippet || '';
      t.lastDirection = m.direction;
    }
  }

  const out = [];
  for (const t of threads.values()) {
    const override = t._msgs.find((m) => m.brand)?.brand;
    if (override) {
      t.brand = override;
    } else {
      const inbound = t._msgs.filter((m) => m.direction === 'in');
      const pool = inbound.length ? inbound : t._msgs;
      const rep = pool.slice().sort((a, b) => (b.receivedAt || b.createdAt || 0) - (a.receivedAt || a.createdAt || 0))[0];
      t.brand = classifyBrand(rep, rules);
    }
    out.push({
      threadId: t.threadId,
      subject: t.subject || '(sin asunto)',
      fromName: t.fromName,
      fromEmail: t.fromEmail,
      snippet: t.snippet,
      brand: t.brand,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      count: t.count,
      unread: t.unread,
      hasInvoice: t.hasInvoice,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const q = needle.trim().toLowerCase();
  if (!q) return out;
  return out.filter((t) =>
    t.subject.toLowerCase().includes(q)
    || (t.fromName || '').toLowerCase().includes(q)
    || (t.fromEmail || '').toLowerCase().includes(q)
    || (t.snippet || '').toLowerCase().includes(q));
}

/**
 * One thread, oldest-first — the reading pane's content.
 *
 *   resolveGmailThread(messages, { threadId })
 *     → { items, threadId, subject, lastInboundAt }
 */
export function resolveGmailThread(messages, { threadId } = {}) {
  const items = (messages || [])
    .filter((m) => (m.threadId || m.id) === threadId)
    .sort((a, b) => (a.receivedAt || a.createdAt || 0) - (b.receivedAt || b.createdAt || 0));
  let lastInboundAt = 0;
  let subject = '';
  for (const m of items) {
    if (m.direction === 'in') lastInboundAt = Math.max(lastInboundAt, m.receivedAt || m.createdAt || 0);
    if (!subject && m.subject) subject = m.subject;
  }
  return { items, threadId: threadId || null, subject: subject || '(sin asunto)', lastInboundAt: lastInboundAt || null };
}

/** A reply subject — "Re: …" once, never stacking a second prefix. */
export function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re: (sin asunto)';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The seed for a reply composer over a thread.
 *
 *   resolveReplyDraft(thread, { selfEmail })
 *     → { to, subject, inReplyToId, threadId } | null
 *
 * `to` is the counterpart — the latest INBOUND sender (so we answer whoever
 * wrote last), falling back to the last message's other party when the thread is
 * all outbound. `inReplyToId` is the message the reply chains onto (the latest),
 * and `threadId` nests it in the conversation. `selfEmail` (the connected
 * account) is excluded so we never address a reply back to ourselves.
 */
export function resolveReplyDraft(thread, { selfEmail = '' } = {}) {
  const items = thread?.items || [];
  if (!items.length) return null;
  const self = String(selfEmail || '').toLowerCase();
  const last = items[items.length - 1];

  let to = '';
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const m = items[i];
    const from = String(m.fromEmail || '').toLowerCase();
    if (m.direction === 'in' && from && from !== self) { to = m.fromEmail; break; }
  }
  if (!to) {
    const fallback = last.direction === 'out' ? last.toEmail : last.fromEmail;
    if (String(fallback || '').toLowerCase() !== self) to = fallback || '';
  }

  return {
    to: to || '',
    subject: replySubject(thread.subject || last.subject),
    inReplyToId: last.id,
    threadId: thread.threadId || last.threadId || null,
  };
}

/** "Fwd: …" once, never stacking the prefix (case-insensitive on Fwd:/Fw:/Re:). */
export function forwardSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Fwd: (sin asunto)';
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Whether a string is a syntactically valid single email address. */
export function isEmailAddress(s) {
  return _EMAIL_RE.test(String(s || '').trim());
}

/**
 * Recipient suggestions for the composer's To/Cc/Bcc autocomplete — the union of
 * CRM contacts (customers + professionals with an email) and people the inbox has
 * corresponded with (synced gmail_messages), deduped by address. CRM contacts
 * rank first (a known name beats a bare correspondent), then by name.
 *
 *   resolveEmailRecipients(customers, professionals, messages, { needle, limit, exclude })
 *     → [{ name, email, kind: 'customer'|'professional'|'contact' }]
 */
export function resolveEmailRecipients(customers, professionals, messages, { needle = '', limit = 8, exclude = [] } = {}) {
  const byEmail = new Map();
  const add = (email, name, kind, rank) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !_EMAIL_RE.test(e)) return;
    const existing = byEmail.get(e);
    if (!existing || rank < existing.rank) {
      byEmail.set(e, { email: e, name: String(name || '').trim() || (existing?.name || ''), kind, rank });
    } else if (!existing.name && name) {
      existing.name = String(name).trim();
    }
  };
  for (const c of customers || []) add(c.email, c.name || c.company, 'customer', 0);
  for (const p of professionals || []) add(p.email, p.name || p.company, 'professional', 1);
  // People we've exchanged mail with — the counterpart of each message.
  for (const m of messages || []) {
    if (m.direction === 'out') add(m.toEmail, '', 'contact', 3);
    else add(m.fromEmail, m.fromName, 'contact', 2);
  }
  const skip = new Set((exclude || []).map((e) => String(e || '').trim().toLowerCase()));
  const q = needle.trim().toLowerCase();
  return [...byEmail.values()]
    .filter((r) => !skip.has(r.email))
    .filter((r) => !q || r.email.includes(q) || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.rank - b.rank || (a.name || a.email).localeCompare(b.name || b.email))
    .slice(0, Math.max(1, limit))
    .map(({ name, email, kind }) => ({ name, email, kind }));
}

/**
 * The Facturas tab — every invoice-like message, newest first, decorated with
 * its brand and a best-effort amount. `brand` (optional) narrows to one bucket.
 *
 *   resolveGmailInvoices(messages, { needle, brand, rules })
 *     → [{ ...message, brand, amount }]
 */
export function resolveGmailInvoices(messages, { needle = '', brand = null, rules = DEFAULT_GMAIL_BRAND_RULES } = {}) {
  const q = needle.trim().toLowerCase();
  return (messages || [])
    .filter(isInvoiceEmail)
    .map((m) => ({ ...m, brand: classifyBrand(m, rules), amount: parseInvoiceAmount(m) }))
    .filter((m) => (brand ? m.brand === brand : true))
    .filter((m) => !q
      || (m.subject || '').toLowerCase().includes(q)
      || (m.fromName || '').toLowerCase().includes(q)
      || (m.fromEmail || '').toLowerCase().includes(q))
    .sort((a, b) => (b.receivedAt || b.createdAt || 0) - (a.receivedAt || a.createdAt || 0));
}

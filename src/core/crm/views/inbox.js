// ViewModel for the WhatsApp inbox (the CRM conversations surface).
//
// Pure projections over wa_messages + customers + professionals — no React,
// no db. The View fetches, calls these in useMemo, renders. Threads group by
// phoneKey (last 10 digits) so country-code variants of the same number land
// in one conversation, and each thread is linked to a customer/professional
// either by the id stamped on a message at write time or by phone match here
// (covers messages logged before the contact existed).

import { phoneKey, displayPhone } from '../../../lib/phone.js';

/** Meta's customer-service window: free-form replies are allowed for 24h
 *  after the contact's LAST inbound message; outside it only approved
 *  templates deliver. The composer renders off this. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Group the message log into a conversation list, newest-activity first.
 *
 *   resolveConversations(messages, customers, professionals, { needle, now })
 *     → [{ key, phone, name, contactKind, customerId, professionalId,
 *          lastBody, lastAt, lastDirection, lastStatus, unread, windowOpen }]
 *
 * `needle` filters by contact name / phone digits. `now` is injectable for
 * tests; defaults to Date.now().
 */
export function resolveConversations(messages, customers, professionals, { needle = '', now = Date.now() } = {}) {
  const customerByKey = indexByPhone(customers);
  const professionalByKey = indexByPhone(professionals);

  const threads = new Map();
  for (const m of messages || []) {
    const key = phoneKey(m.phone);
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = { key, phone: '', profileName: null, customerId: null, professionalId: null,
            lastBody: '', lastAt: 0, lastDirection: null, lastStatus: null, lastInboundAt: 0, unread: 0 };
      threads.set(key, t);
    }
    const at = m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.phone = m.phone;
      t.lastBody = m.templateName && !m.body ? `Plantilla · ${m.templateName}` : (m.body || labelForKind(m.kind));
      t.lastDirection = m.direction;
      t.lastStatus = m.status || null;
    }
    if (m.direction === 'in') {
      if (at > t.lastInboundAt) t.lastInboundAt = at;
      if (!m.readAt) t.unread += 1;
      if (m.profileName) t.profileName = m.profileName;
    }
    if (m.customerId && !t.customerId) t.customerId = m.customerId;
    if (m.professionalId && !t.professionalId) t.professionalId = m.professionalId;
  }

  const out = [];
  for (const t of threads.values()) {
    const customer = (t.customerId && (customers || []).find((c) => c.id === t.customerId)) || customerByKey.get(t.key) || null;
    const professional = customer ? null
      : ((t.professionalId && (professionals || []).find((p) => p.id === t.professionalId)) || professionalByKey.get(t.key) || null);
    const name = customer?.name || customer?.company
      || professional?.name || professional?.company
      || t.profileName || displayPhone(t.phone);
    out.push({
      key: t.key,
      phone: t.phone,
      name,
      contactKind: customer ? 'customer' : professional ? 'professional' : null,
      customerId: customer?.id || null,
      professionalId: professional?.id || null,
      lastBody: t.lastBody,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      lastStatus: t.lastStatus,
      unread: t.unread,
      windowOpen: !!t.lastInboundAt && now - t.lastInboundAt < WA_WINDOW_MS,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const q = needle.trim().toLowerCase();
  if (!q) return out;
  const qDigits = q.replace(/\D/g, '');
  return out.filter((c) =>
    c.name.toLowerCase().includes(q)
    || (qDigits && (c.phone || '').replace(/\D/g, '').includes(qDigits)));
}

/**
 * One conversation, oldest-first, plus the state the composer needs:
 *
 *   resolveThread(messages, { key, now })
 *     → { items, lastInboundAt, windowOpen, windowExpiresAt }
 *
 * `windowOpen` ⇒ free-form text delivers; closed ⇒ only an approved template
 * will (Meta error 131047 otherwise).
 *
 * WhatsApp affordances resolved here (not in the View):
 *   • reactions — an inbound `reaction` row decorates its TARGET message
 *     (matched by wamid) as `reactions: [emoji]` instead of rendering as its
 *     own bubble; an empty emoji (the user removed the reaction) clears it.
 *   • quoted replies — a message sent in reply to another (Meta's `context`)
 *     carries `quoted: { direction, body, kind }`, the snippet the bubble
 *     shows above the text.
 */
export function resolveThread(messages, { key, now = Date.now() } = {}) {
  const raw = (messages || [])
    .filter((m) => phoneKey(m.phone) === key)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let lastInboundAt = 0;
  for (const m of raw) {
    if (m.direction === 'in' && (m.createdAt || 0) > lastInboundAt) lastInboundAt = m.createdAt || 0;
  }

  // wamid → message, the join key reactions and quoted replies resolve on.
  const byWaId = new Map();
  for (const m of raw) {
    if (m.waId) byWaId.set(m.waId, m);
  }

  // Reactions fold onto their target in arrival order (last one wins per
  // sender — in a 1:1 thread that's simply the latest). Unknown targets (the
  // reacted-to message predates our log) keep the reaction as its own row so
  // the emoji isn't silently lost.
  const reactionsByWaId = new Map();
  const rows = [];
  for (const m of raw) {
    if (m.kind === 'reaction') {
      const r = m.payload?.reaction;
      const targetId = r?.message_id;
      const emoji = r?.emoji || m.body || '';
      if (targetId && byWaId.has(targetId)) {
        if (emoji) reactionsByWaId.set(targetId, [emoji]);
        else reactionsByWaId.delete(targetId); // reaction removed
        continue;
      }
      if (!emoji) continue;
    }
    rows.push(m);
  }

  const items = rows.map((m) => {
    const reactions = (m.waId && reactionsByWaId.get(m.waId)) || null;
    const ctxId = m.payload?.context?.id;
    const target = ctxId ? byWaId.get(ctxId) : null;
    const quoted = target
      ? { direction: target.direction, body: target.body || labelForKind(target.kind), kind: target.kind }
      : null;
    if (!reactions && !quoted) return m;
    return { ...m, reactions, quoted };
  });

  const windowOpen = !!lastInboundAt && now - lastInboundAt < WA_WINDOW_MS;
  return {
    items,
    lastInboundAt: lastInboundAt || null,
    windowOpen,
    windowExpiresAt: windowOpen ? lastInboundAt + WA_WINDOW_MS : null,
  };
}

/**
 * Contacts a new conversation can start with: every customer/professional
 * that has a phone, minus those already in a thread. Powers the "Nuevo chat"
 * picker (the full client + decorator list, searchable).
 */
export function resolveNewChatContacts(customers, professionals, conversations, { needle = '' } = {}) {
  const taken = new Set((conversations || []).map((c) => c.key));
  const q = needle.trim().toLowerCase();
  const pick = (rows, contactKind) => (rows || [])
    .filter((r) => phoneKey(r.phone) && !taken.has(phoneKey(r.phone)))
    .filter((r) => !q
      || (r.name || '').toLowerCase().includes(q)
      || (r.company || '').toLowerCase().includes(q)
      || (r.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000'))
    .map((r) => ({
      key: phoneKey(r.phone),
      phone: r.phone,
      name: r.name || r.company || displayPhone(r.phone),
      contactKind,
      customerId: contactKind === 'customer' ? r.id : null,
      professionalId: contactKind === 'professional' ? r.id : null,
    }));
  const out = [...pick(customers, 'customer'), ...pick(professionals, 'professional')];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The thread target for an inbox deep-link (/chats?chat=<phone>) — how the
 * CRM pages' WhatsApp quick actions land on a conversation. Returns the
 * EXISTING conversation when the phone already has a thread; otherwise a
 * draft contact target (same shape as the Nuevo-chat picker rows, so the
 * first send materializes the thread identically); null when the phone is
 * unusable or matches no contact.
 */
export function resolveChatTarget(customers, professionals, conversations, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const existing = (conversations || []).find((c) => c.key === key);
  if (existing) return { key, existing: true, target: existing };
  const find = (rows, contactKind) => {
    const r = (rows || []).find((row) => phoneKey(row.phone) === key);
    if (!r) return null;
    return {
      key,
      phone: r.phone,
      name: r.name || r.company || displayPhone(r.phone),
      contactKind,
      customerId: contactKind === 'customer' ? r.id : null,
      professionalId: contactKind === 'professional' ? r.id : null,
    };
  };
  const target = find(customers, 'customer') || find(professionals, 'professional');
  return target ? { key, existing: false, target } : null;
}

/**
 * The Click-to-WhatsApp ad referral of an inbound message, normalized for the
 * chat bubble, or null. Meta stamps `referral` on the FIRST message a user
 * sends after tapping a CTWA ad / sponsored post — the inbox surfaces it so
 * the team knows the lead came from a paid placement (and which one).
 */
export function resolveReferral(message) {
  const r = message?.payload?.referral;
  if (!r || typeof r !== 'object') return null;
  return {
    sourceType: r.source_type || 'ad',
    headline: r.headline || '',
    body: r.body || '',
    sourceUrl: r.source_url || '',
  };
}

/**
 * Fill a quick-reply snippet's named placeholders. Supported (case-insensitive):
 *   {{nombre}}  → the contact's name
 *   {{negocio}} → the dealer's business name
 * An UNKNOWN placeholder is left intact (so a typo is visible, not silently
 * dropped); a known key with no value collapses to ''. Distinct from
 * fillTemplateBody's numeric {{1}} scheme — quick replies are free text the
 * dealer authors, so named tokens read better than positional ones.
 */
export function fillQuickReply(text, { nombre = '', negocio = '' } = {}) {
  const map = { nombre, negocio };
  return String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? String(map[k] ?? '') : whole;
  });
}

function indexByPhone(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = phoneKey(r.phone);
    if (key && !map.has(key)) map.set(key, r);
  }
  return map;
}

function labelForKind(kind) {
  const labels = {
    image: '📷 Imagen', video: '🎬 Video', audio: '🎤 Audio', document: '📄 Documento',
    sticker: 'Sticker', location: '📍 Ubicación', contacts: 'Contacto', reaction: 'Reacción',
  };
  return labels[kind] || (kind && kind !== 'text' ? `Mensaje (${kind})` : 'Mensaje');
}

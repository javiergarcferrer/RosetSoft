// ViewModel for the Instagram Direct inbox (the CRM's second conversation
// channel, beside the WhatsApp inbox in core/crm/views/inbox.js).
//
// Pure projections over ig_messages rows — no React, no db. Threads group by
// `threadKey` (the counterpart's IG-scoped id, IGSID): a contact's inbound DMs
// and our outbound replies carry the same key, so they land in one thread.
// There's no phone/contact linking here (IG users aren't keyed by phone); the
// thread's display name is the counterpart's @-handle (or name) resolved from
// the webhook. Mirrors the WhatsApp inbox's shapes so the View can render both
// channels with the same components.

/** Instagram's standard-messaging window: free-form replies are allowed for 24h
 *  after the contact's LAST inbound message; outside it Meta rejects the send
 *  (only message tags / the human-agent escalation deliver). The composer
 *  renders off this — the same rule as WhatsApp. */
export const IG_WINDOW_MS = 24 * 60 * 60 * 1000;

function labelForKind(kind) {
  const labels = {
    image: '📷 Imagen', video: '🎬 Video', audio: '🎤 Audio',
    share: '↗️ Publicación compartida', story_mention: 'Mención en historia',
    story_reply: 'Respuesta a tu historia', deleted: 'Mensaje eliminado',
  };
  return labels[kind] || (kind && kind !== 'text' ? `Mensaje (${kind})` : 'Mensaje');
}

/** Display name for a thread: the @-handle, else the stored name, else the id. */
function threadName(username, name, threadKey) {
  if (username) return `@${username}`;
  if (name) return name;
  return threadKey || 'Instagram';
}

/**
 * Group the Instagram message log into a conversation list, newest-activity
 * first.
 *
 *   resolveIgConversations(messages, { needle, now })
 *     → [{ key, threadKey, name, username, lastBody, lastAt, lastDirection,
 *          lastStatus, unread, awaitingReply, windowOpen }]
 *
 * `needle` filters by @-handle / name; `now` is injectable for tests.
 */
export function resolveIgConversations(messages, { needle = '', now = Date.now() } = {}) {
  const threads = new Map();
  for (const m of messages || []) {
    const key = (m.threadKey || '').trim();
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        key, threadKey: key, username: null, name: null,
        lastBody: '', lastAt: 0, lastDirection: null, lastStatus: null,
        lastInboundAt: 0, unread: 0,
      };
      threads.set(key, t);
    }
    const at = m.createdAt || 0;
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.lastBody = m.body || labelForKind(m.kind);
      t.lastDirection = m.direction;
      t.lastStatus = m.status || null;
    }
    if (m.direction === 'in') {
      if (at > t.lastInboundAt) t.lastInboundAt = at;
      if (!m.readAt) t.unread += 1;
    }
    // The counterpart's identity rides inbound rows; keep the freshest non-empty.
    if (m.username) t.username = m.username;
    if (m.name) t.name = m.name;
  }

  const out = [];
  for (const t of threads.values()) {
    out.push({
      key: t.key,
      threadKey: t.threadKey,
      name: threadName(t.username, t.name, t.threadKey),
      username: t.username,
      lastBody: t.lastBody,
      lastAt: t.lastAt,
      lastDirection: t.lastDirection,
      lastStatus: t.lastStatus,
      unread: t.unread,
      // The contact wrote last and we haven't answered — the "ball in our court"
      // signal (distinct from `unread`, which clears on open).
      awaitingReply: t.lastDirection === 'in',
      windowOpen: !!t.lastInboundAt && now - t.lastInboundAt < IG_WINDOW_MS,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const q = needle.trim().toLowerCase();
  if (!q) return out;
  return out.filter((c) =>
    c.name.toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q));
}

/**
 * One Instagram conversation, oldest-first, plus the state the composer needs:
 *
 *   resolveIgThread(messages, { threadKey, now })
 *     → { items, threadKey, lastInboundAt, windowOpen, windowExpiresAt }
 *
 * `windowOpen` ⇒ a free-form reply delivers; closed ⇒ Meta rejects it (the
 * composer disables and explains, same as WhatsApp's 24h gate).
 */
export function resolveIgThread(messages, { threadKey, now = Date.now() } = {}) {
  const key = (threadKey || '').trim();
  const items = (messages || [])
    .filter((m) => (m.threadKey || '').trim() === key)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    // `displayBody` carries the label fallback so a bubble never renders a bare
    // "—": a media / text-less row shows its kind label, the same rule the
    // conversation list uses for `lastBody`.
    .map((m) => ({ ...m, displayBody: m.body || labelForKind(m.kind) }));
  let lastInboundAt = 0;
  for (const m of items) {
    if (m.direction === 'in' && (m.createdAt || 0) > lastInboundAt) lastInboundAt = m.createdAt || 0;
  }
  const windowOpen = !!lastInboundAt && now - lastInboundAt < IG_WINDOW_MS;
  return {
    items,
    threadKey: key || null,
    lastInboundAt: lastInboundAt || null,
    windowOpen,
    windowExpiresAt: windowOpen ? lastInboundAt + IG_WINDOW_MS : null,
  };
}

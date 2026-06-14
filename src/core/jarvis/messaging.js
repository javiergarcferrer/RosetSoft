/**
 * JARVIS messaging — Instagram Direct + Facebook Messenger DM ViewModels.
 *
 * Pure projection of the meta-social Edge Function's `readDms` / `readDmThread`
 * payloads into what the Messaging inbox renders: a conversation list (who,
 * preview, relative time, unread) and a single thread (bubbles with direction
 * + ago labels). Graph mixes ISO strings and unix-ish timestamps and nests the
 * participant/sender under `participants`/`from`; all of that normalizing lives
 * here, not in the View. No React, no db — the page fetches and passes rows in.
 *
 * Direction is resolved against the dealer's own account ids (`selfIds`): a
 * message whose sender is one of OUR ids is outbound ("out"), everything else
 * is inbound ("in"). When selfIds are unknown the thread VM accepts the
 * `participantId` (the customer) instead — a message FROM the customer is "in",
 * anything else is "out" — which is exactly what the conversation list already
 * carries, so the View never has to know the dealer's own account ids.
 */
import { agoLabel } from './board.js';

/** ISO string or unix (s or ms) → JS ms (null when unparseable). */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 10_000_000_000 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const str = (v) => (v == null ? '' : String(v));

// The set of ids that mean "us" (the IG business account + the FB Page).
function selfSet(selfIds) {
  const s = new Set();
  for (const id of [].concat(selfIds || [])) {
    const v = str(id).trim();
    if (v) s.add(v);
  }
  return s;
}

/**
 * The DM conversation list. `rows` = the edge fn's `conversations` array (each
 * tagged with `platform`, carrying `participants`, `updated_time`,
 * `unread_count` and a 1-deep `messages` preview). Newest activity first.
 */
export function resolveDmConversations(rows, { now = Date.now(), selfIds = [] } = {}) {
  const self = selfSet(selfIds);
  return (rows || [])
    .map((c) => {
      const participants = c?.participants?.data || c?.participants || [];
      // The other party: the first participant that isn't us (else the first).
      const other = participants.find((p) => !self.has(str(p?.id))) || participants[0] || {};
      const preview = (c?.messages?.data || c?.messages || [])[0] || null;
      const lastFrom = str(preview?.from?.id);
      const lastDirection = preview ? (self.has(lastFrom) ? 'out' : 'in') : null;
      const at = toMs(preview?.created_time) ?? toMs(c?.updated_time);
      return {
        id: str(c?.id),
        platform: c?.platform || 'instagram',
        participantId: str(other?.id) || null,
        participantName: str(other?.username || other?.name) || 'Sin nombre',
        lastText: str(preview?.message) || '(sin texto)',
        lastDirection,
        at,
        ago: agoLabel(at, now),
        unread: Number(c?.unread_count) || 0,
      };
    })
    .filter((c) => c.id)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * One conversation's thread. `messages` = the edge fn's `messages` array (Meta
 * returns newest-first; we sort oldest→newest so the bubbles read top-down
 * like a chat). Each item gets a direction + ago label and a flattened first
 * attachment (image/file url).
 */
export function resolveDmThread(messages, { now = Date.now(), selfIds = [], participantId = null } = {}) {
  const self = selfSet(selfIds);
  const customer = str(participantId).trim();
  // Direction rule: if we know the customer's id, a message FROM them is "in";
  // otherwise fall back to the self-id set (a message from us is "out").
  const directionOf = (fromId) =>
    (customer ? (fromId === customer ? 'in' : 'out') : (self.has(fromId) ? 'out' : 'in'));
  const items = (messages || [])
    .map((m) => {
      const fromId = str(m?.from?.id);
      const att = (m?.attachments?.data || m?.attachments || [])[0] || null;
      const mediaUrl = att
        ? str(att?.image_data?.url || att?.file_url || att?.image_data?.preview_url) || null
        : null;
      const at = toMs(m?.created_time);
      return {
        id: str(m?.id),
        direction: directionOf(fromId),
        authorId: fromId || null,
        authorName: str(m?.from?.username || m?.from?.name) || null,
        text: str(m?.message),
        mediaUrl,
        mediaType: att ? str(att?.mime_type) || null : null,
        at,
        ago: agoLabel(at, now),
      };
    })
    .filter((m) => m.id)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  return { items, count: items.length };
}

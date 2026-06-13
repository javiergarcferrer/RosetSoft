// AI draft-reply Model — turns a resolved WhatsApp thread into the compact
// transcript the `wa-draft` Edge Function relays to Claude. Pure (no React, no
// supabase): the View calls it, POSTs the result, and drops the returned text
// into the composer — never auto-sending (human-in-the-loop, see CLAUDE.md).
//
// The transcript is intentionally minimal: only the recent turns, each capped,
// media folded to a short placeholder so a photo/voice note still gives the
// model context without shipping bytes. Reactions/system rows carry no reply
// signal and are dropped. This lives ONLY on the client — the function is a
// thin relay over the turns, so there's nothing to keep in parity across the
// Deno↔Vite wall.

const MEDIA_LABELS = {
  image: '[imagen]', video: '[video]', audio: '[nota de voz]', document: '[documento]',
  sticker: '[sticker]', location: '[ubicación]', contacts: '[contacto]',
  order: '[pedido]', template: '[plantilla]',
};

/** One transcript line for the model, or null if the row carries no reply signal. */
function turnFor(m, maxChars) {
  if (!m || m.kind === 'reaction' || m.kind === 'system') return null;
  const role = m.direction === 'in' ? 'customer' : 'agent';
  let text = (m.body || '').trim();
  if (!text) {
    text = m.templateName ? `[plantilla · ${m.templateName}]` : (MEDIA_LABELS[m.kind] || null);
  }
  if (!text) return null;
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`;
  return { role, text };
}

/**
 * Build the transcript turns for an AI reply suggestion.
 * @param {Array} items - thread.items from resolveThread (chronological).
 * @returns {{turns: Array<{role:'customer'|'agent', text:string}>, canDraft: boolean}}
 *   canDraft is true only when the conversation has an inbound message to answer
 *   (no point drafting a reply to a thread the customer never wrote in).
 */
export function buildDraftTurns(items, { maxTurns = 16, maxChars = 600 } = {}) {
  const all = (items || []).map((m) => turnFor(m, maxChars)).filter(Boolean);
  const turns = all.slice(-maxTurns);
  const canDraft = turns.some((t) => t.role === 'customer');
  return { turns, canDraft };
}

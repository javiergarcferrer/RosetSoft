// Client helpers for the Instagram Direct (DM) inbox — the CRM inbox's second
// channel, beside lib/whatsapp.js.
//
// Inbound DMs arrive via the public `meta-webhook` (Meta → Supabase, HMAC-
// verified) into ig_messages; outbound goes through the `meta-social` Edge
// Function (igSendDm), which holds the Instagram token server-side and writes
// the durable outbound row. This file only triggers those and keeps the local
// read state — the token never reaches the browser.

import { supabase } from '../db/supabaseClient.js';
import { db } from '../db/database.js';

/**
 * Send a Direct reply to a contact (within Meta's 24h standard-messaging
 * window). The server inserts the durable outbound row; the caller refetches
 * ig_messages after (the inbox polls / re-runs its live query).
 */
export async function sendInstagramDm(recipientId, text) {
  const body = String(text || '').trim();
  if (!recipientId || !body) return { ok: false, error: 'Falta el destinatario o el texto.' };
  const { data, error } = await supabase.functions.invoke('meta-social', {
    body: { igSendDm: { recipientId, text: body } },
  });
  if (error) return { ok: false, error: error.message || 'sin respuesta' };
  if (!data?.ok) return { ok: false, error: data?.error || 'No se pudo enviar' };
  return { ok: true, id: data.id || null };
}

/**
 * Pull recent Direct conversations into ig_messages (history backfill), so the
 * inbox isn't empty before/independent of live webhooks.
 */
export async function backfillInstagramDms() {
  const { data, error } = await supabase.functions.invoke('meta-social', { body: { igBackfill: true } });
  if (error) return { ok: false, error: error.message || 'sin respuesta' };
  if (!data?.ok) return { ok: false, error: data?.error || 'No se pudo sincronizar' };
  return { ok: true, count: data.count || 0 };
}

/** Mark a thread's inbound messages read (local state; clears the unread badge). */
export async function markIgThreadRead(messages) {
  const unread = (messages || []).filter((m) => m.direction === 'in' && !m.readAt);
  const now = Date.now();
  await Promise.all(unread.map((m) => db.igMessages.update(m.id, { readAt: now })));
}

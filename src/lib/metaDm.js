/**
 * meta-social DM invoke helpers — the Vite-side client for the Instagram
 * Direct + Facebook Messenger inbox. Thin wrappers over the meta-social Edge
 * Function (the Meta token never reaches the browser — same pattern as
 * lib/whatsapp.js for WhatsApp). Each returns the function's JSON, or
 * { ok:false, error } on a transport failure.
 *
 * Replies are HUMAN-TRIGGERED only: `sendMetaDm` is called from an explicit
 * send button in the View, never wired to any automation (the same
 * human-in-the-loop rule the WhatsApp inbox follows).
 */
import { supabase } from '../db/supabaseClient.js';

async function invokeMeta(body) {
  try {
    const { data, error } = await supabase.functions.invoke('meta-social', { body });
    if (error) return { ok: false, error: error.message || 'No se pudo contactar el servidor.' };
    return data || { ok: false, error: 'Respuesta vacía del servidor.' };
  } catch (e) {
    return { ok: false, error: e?.message || 'No se pudo contactar el servidor.' };
  }
}

/** List IG + FB Messenger DM conversations (newest first). */
export const readMetaDms = (opts = {}) => invokeMeta({ readDms: opts });

/** Read one conversation's messages. */
export const readMetaDmThread = ({ conversationId, after, platform } = {}) =>
  invokeMeta({ readDmThread: { conversationId, after, platform } });

/** Send a reply within the 24h window (explicit user action only). */
export const sendMetaDm = ({ conversationId, recipientId, text, platform } = {}) =>
  invokeMeta({ sendDm: { conversationId, recipientId, text, platform } });
